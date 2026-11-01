import {hasCurrentProductRead} from '../middleware/product-permission.server.js';
import { randomUUID } from "node:crypto";
import { createSyncRunService } from "../mirror/sync-run-service.server.js";
import { createIngestionWriter } from "../mirror/ingestion-writer.server.js";
import { createBulkOperationRunner } from "../mirror/bulk-operation-runner.server.js";
import { createReconciliationService } from "../mirror/reconciliation-service.server.js";
import { transaction, invalid, shop } from "../mirror/transactions.server.js";
import { createShopifyCatalogClient, readCompleteProduct, openBulkExport } from "../mirror/shopify-catalog-source.server.js";
import { catalogImportProgress } from "./catalog-import-progress.server.js";
import { isValidShopifySession } from "../middleware/session-validation.js";
import { CatalogImportError, IMPORT_ERROR_CODES as C, withImportErrors } from "./catalog-import-errors.server.js";
import { requireCatalogImportId } from "./catalog-import-id.server.js";

function requireImportSession(session, shopId) {
  if (!isValidShopifySession(session) || session.shop !== shopId) {
    throw new CatalogImportError(C.UNAUTHENTICATED);
  }
  if (!hasCurrentProductRead(session)) {
    throw new CatalogImportError(C.FORBIDDEN);
  }
  return session;
}

const publicJob = row => row && Object.freeze({ id: row.id, status: row.status, generationId: row.generation_id,
  attempts: row.execution_attempt ?? row.attempts, cancelRequested: row.cancel_requested,
  cancelPending: Boolean(row.cancel_requested && row.status !== "CANCELLED" && row.status !== "SUCCEEDED"),
  ...(row.cancel_requested?{cancellationState:row.status==='CANCELLED'?'CANCELLED':row.last_error==='REMOTE_CANCEL_PENDING'?'CANCELLING':'CANCELLATION_REQUESTED'}:{}),
  retryAt: row.phase ? row.execution_retry_at : row.next_attempt_at, error: row.last_error,
  ...(row.phase ? {phase:row.phase,outcomeUncertain:row.outcome_uncertain,reviewRequired:row.review_required} : {}),
  progress:catalogImportProgress(row) });

const progressJoins = `LEFT JOIN mirror.catalog_import_executions e ON e.id=j.id AND e.shop_id=j.shop_id AND e.generation_id=j.generation_id
  LEFT JOIN mirror.ingestion_runs r ON r.id=j.run_id AND r.shop_id=j.shop_id AND r.generation_id=j.generation_id
  LEFT JOIN mirror.generations g ON g.id=j.generation_id AND g.shop_id=j.shop_id`;
const progressColumns = `j.*,e.phase,e.attempt AS execution_attempt,e.next_eligible_at AS execution_retry_at,
  e.outcome_uncertain,e.review_required,r.processed_lines::text,r.expected_lines::text,g.status AS generation_status`;

export function createCatalogImportService({ database, shopify, fetchImpl = fetch, logger = console,
  phaseRuntime,
  clientFactory = input => createShopifyCatalogClient({ database, shopify, ...input }) }) {
  const sync = createSyncRunService({ database });
  const reconciliation = createReconciliationService({ database });
  let timer, running, stopping = false, initialScanCursor = "", refreshScanCursor = "";
  const controllers = new Map();

  async function authenticate(session) {
    if (!session?.id || !session?.shop) throw new CatalogImportError(C.UNAUTHENTICATED);
    const stored = await shopify.config.sessionStorage.loadSession(session.id);
    if (stored?.id !== session.id) throw new CatalogImportError(C.UNAUTHENTICATED);
    return requireImportSession(stored, session.shop);
  }
  async function owner(client, job) {
    const row = (await client.query(`SELECT j.* FROM mirror.catalog_import_jobs j
      JOIN mirror.shops s ON s.id=j.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
      WHERE j.id=$1 AND j.shop_id=$2 AND j.fence=$3 AND j.status='RUNNING'
        AND j.lease_until>clock_timestamp() AND NOT j.cancel_requested FOR UPDATE OF j`,
    [job.id,job.shop_id,job.fence])).rows[0];
    if (!row) invalid("Import lease, installation or cancellation fence changed");
    return row;
  }
  async function enqueue(session, { initial = false, activate = false, installationVersion, refresh = false } = {}) {
    const stored = await authenticate(session);
    if (initial && !activate && !installationVersion) {
      // Status polling usually needs no scheduling transaction. This read is
      // not an authorization grant; the status/coverage service verifies again.
      const previous = (await database.query(`SELECT j.* FROM mirror.catalog_import_jobs j
        JOIN mirror.shops s ON s.id=j.shop_id AND s.installation_version=j.installation_version
        WHERE j.shop_id=$1 AND s.uninstalled_at IS NULL ORDER BY j.created_at,j.id LIMIT 1`, [stored.shop])).rows[0];
      if (previous) {await authenticate(session);return publicJob(previous);}
    }
    // Reload credentials from storage; never retain an OAuth request/token in a worker closure.
    const offline = (await shopify.config.sessionStorage.findSessionsByShop(stored.shop))
      .find(s => s.isOnline === false && s.shop === stored.shop);
    requireImportSession(offline, stored.shop);
    return transaction(database, async client => {
      // Uninstall may have removed credentials while this transaction waited.
      await authenticate(session);
      const currentOffline = (await shopify.config.sessionStorage.findSessionsByShop(stored.shop))
        .find(s => s.isOnline === false && s.shop === stored.shop);
      requireImportSession(currentOffline, stored.shop);
      if (!installationVersion) await client.query("INSERT INTO mirror.shops(id,installation_version) VALUES ($1,$2) ON CONFLICT(id) DO NOTHING", [stored.shop,randomUUID()]);
      let installed = (await client.query("SELECT installation_version,uninstalled_at FROM mirror.shops WHERE id=$1 FOR UPDATE", [stored.shop])).rows[0];
      if (!installed) return null;
      await authenticate(session);
      if (installationVersion && installed.installation_version !== installationVersion) return null;
      // Only the verified OAuth callback may reactivate an uninstalled tenant.
      if (installed.uninstalled_at !== null && activate) {
        // This is a local observation cache, never a billing cancellation.
        await client.query("DELETE FROM mirror.subscriptions WHERE shop_id=$1", [stored.shop]);
        installed = (await client.query(`UPDATE mirror.shops SET installation_version=$2,
          installed_at=clock_timestamp(),uninstalled_at=NULL WHERE id=$1 RETURNING installation_version,uninstalled_at`,
        [stored.shop,randomUUID()])).rows[0];
        await client.query(`UPDATE mirror.catalog_import_jobs SET cancel_requested=true,updated_at=now()
          WHERE shop_id=$1 AND installation_version<>$2 AND status IN ('QUEUED','RUNNING','RETRY')`,
        [stored.shop,installed.installation_version]);
      }
      if (installed.uninstalled_at !== null) throw new CatalogImportError(C.FORBIDDEN, { message: "Active installation required" });
      const refreshRequest = (await client.query(`SELECT requested_revision,scheduled_revision FROM mirror.catalog_refresh_requests
        WHERE shop_id=$1 AND installation_version=$2 AND requested_revision>scheduled_revision
          AND attempts<8 AND next_attempt_at<=clock_timestamp() FOR UPDATE`, [stored.shop,installed.installation_version])).rows[0];
      if (refresh && !refreshRequest) return null;
      if (initial) {
        // Any durable job for this installation is its initial request, including
        // terminal jobs: a repeated callback must not reset exhausted retries.
        const previous = (await client.query(`SELECT * FROM mirror.catalog_import_jobs
          WHERE shop_id=$1 AND installation_version=$2 ORDER BY created_at,id LIMIT 1`,
        [stored.shop,installed.installation_version])).rows[0];
        if (previous) return publicJob(previous);
      }
      const existing = (await client.query(
        "SELECT * FROM mirror.catalog_import_jobs WHERE shop_id=$1 AND (status IN ('QUEUED','RUNNING','RETRY') OR (cancel_requested AND status NOT IN ('CANCELLED','SUCCEEDED')))",
        [stored.shop],
      )).rows[0];
      if (existing) {
        if (existing.installation_version === installed.installation_version) return publicJob(existing);
        if (initial) return null; // The startup scanner retries after old work drains.
        throw new CatalogImportError(C.UNAVAILABLE);
      }
      if ((initial || refresh) && (await client.query(`SELECT 1 FROM mirror.generations WHERE shop_id=$1
        AND status IN ('INGESTING','RECONCILING','VERIFIED') LIMIT 1`, [stored.shop])).rowCount) return null;
      const current = (await client.query("SELECT generation_id FROM mirror.publications WHERE shop_id=$1", [stored.shop])).rows[0]?.generation_id ?? null;
      await authenticate(session);
      const job = phaseRuntime
        ? await phaseRuntime.enqueue({client,shopId:stored.shop,installationVersion:installed.installation_version,expectedGenerationId:current})
        : (await client.query(`INSERT INTO mirror.catalog_import_jobs(id,shop_id,installation_version,expected_generation_id)
          VALUES ($1,$2,$3,$4) RETURNING *`, [randomUUID(),stored.shop,installed.installation_version,current])).rows[0];
      if (refreshRequest) await client.query(`UPDATE mirror.catalog_refresh_requests SET scheduled_revision=$3,attempts=0,review_required=false,last_error=NULL,updated_at=clock_timestamp()
        WHERE shop_id=$1 AND installation_version=$2 AND requested_revision=$3`,
      [stored.shop,installed.installation_version,refreshRequest.requested_revision]);
      return publicJob(job);
    }, stored.shop);
  }
  const service = Object.freeze({
    enqueue: session => enqueue(session),
    onInstall: session => enqueue(session, {initial:true,activate:true}),
    ensureInitialSync: session => enqueue(session, {initial:true}),
    async ensurePendingCatalogRefreshes() {
      const exhausted=await database.query(`UPDATE mirror.catalog_refresh_requests SET review_required=true,last_error='REFRESH_RETRY_EXHAUSTED'
        WHERE shop_id IN(SELECT shop_id FROM mirror.catalog_refresh_requests WHERE requested_revision>scheduled_revision AND attempts>=8 AND NOT review_required
          ORDER BY shop_id LIMIT 25 FOR UPDATE SKIP LOCKED) RETURNING shop_id,requested_revision`);
      for(const row of exhausted.rows){try{logger.error?.({code:'REFRESH_RETRY_EXHAUSTED',shopId:row.shop_id,revision:String(row.requested_revision)},'Catalog refresh requires review');}catch{}}
      const candidates = (await database.query(`SELECT r.shop_id,r.installation_version,r.requested_revision
        FROM mirror.catalog_refresh_requests r JOIN mirror.shops s ON s.id=r.shop_id
          AND s.installation_version=r.installation_version AND s.uninstalled_at IS NULL
        WHERE r.shop_id>$1 AND r.requested_revision>r.scheduled_revision AND r.attempts<8 AND NOT r.review_required
          AND r.next_attempt_at<=clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM mirror.catalog_import_jobs j WHERE j.shop_id=r.shop_id
            AND (j.status IN ('QUEUED','RUNNING','RETRY') OR j.cancel_requested AND j.status NOT IN ('CANCELLED','SUCCEEDED')))
          AND NOT EXISTS(SELECT 1 FROM mirror.generations g WHERE g.shop_id=r.shop_id AND g.status IN ('INGESTING','RECONCILING','VERIFIED'))
        ORDER BY r.shop_id LIMIT 10`, [refreshScanCursor])).rows;
      refreshScanCursor = candidates.at(-1)?.shop_id ?? "";
      for (const candidate of candidates) {
        try {
          const session = (await shopify.config.sessionStorage.findSessionsByShop(candidate.shop_id))
            .find(s => s.isOnline === false && s.shop === candidate.shop_id);
          if (!session) throw new CatalogImportError(C.UNAUTHENTICATED);
          await enqueue(session, {refresh:true,installationVersion:candidate.installation_version});
        } catch (error) {
          // New deliveries reset the budget. A stale scheduler cannot penalize
          // a new revision or a reinstallation after its credential lookup.
          const failed=await database.query(`UPDATE mirror.catalog_refresh_requests SET attempts=attempts+1,
            review_required=attempts+1>=8,last_error='REFRESH_SCHEDULING_FAILED',
            next_attempt_at=clock_timestamp()+LEAST(3600,5*power(2,attempts))::integer*interval '1 second'
            WHERE shop_id=$1 AND installation_version=$2 AND requested_revision=$3 AND requested_revision>scheduled_revision AND attempts<8 RETURNING review_required`,
          [candidate.shop_id,candidate.installation_version,candidate.requested_revision]);
          try{logger.error?.({code:failed.rows[0]?.review_required?'REFRESH_RETRY_EXHAUSTED':error.code,shopId:candidate.shop_id}, "Catalog refresh scheduling requires retry or review");}catch{}
        }
      }
    },
    async requeueCatalogRefresh(session,{expectedRevision,reason}={}){
      if(typeof expectedRevision!=='string'||!/^\d{1,19}$/.test(expectedRevision)||BigInt(expectedRevision)>9223372036854775807n||typeof reason!=='string'||!reason.trim()||reason.length>512)throw new CatalogImportError(C.INVALID_REQUEST);
      const stored=await authenticate(session);
      return transaction(database,async client=>{
        const installed=(await client.query('SELECT installation_version FROM mirror.shops WHERE id=$1 AND uninstalled_at IS NULL FOR SHARE',[stored.shop])).rows[0];
        const changed=await client.query(`UPDATE mirror.catalog_refresh_requests SET review_required=false,last_error=NULL,attempts=0,next_attempt_at=clock_timestamp()
          WHERE shop_id=$1 AND installation_version=$2 AND requested_revision=$3 AND requested_revision>scheduled_revision AND review_required RETURNING shop_id`,[stored.shop,installed?.installation_version,expectedRevision]);
        if(changed.rowCount!==1)throw new CatalogImportError(C.UNAVAILABLE);
        await authenticate(session);
        await client.query(`INSERT INTO mirror.audit_events(shop_id,operation_id,action,actor_id,outcome,summary) VALUES($1,$2,'catalog_refresh_requeued','authorized_session','PENDING',$3::jsonb)`,
          [stored.shop,expectedRevision,JSON.stringify({reason})]);
        return Object.freeze({requeued:true,revision:expectedRevision});
      },stored.shop);
    },
    async ensurePendingInitialSyncs() {
      // Shops are the durable installation intent. Keyset rotation bounds each
      // pass and prevents a shop with unavailable credentials hiding later shops.
      const candidates = (await database.query(`SELECT s.id,s.installation_version FROM mirror.shops s
        WHERE s.uninstalled_at IS NULL AND s.id>$1 AND NOT EXISTS(SELECT 1 FROM mirror.catalog_import_jobs j
          WHERE j.shop_id=s.id AND (j.installation_version=s.installation_version OR j.status IN ('QUEUED','RUNNING','RETRY')))
        AND NOT EXISTS(SELECT 1 FROM mirror.generations g WHERE g.shop_id=s.id AND g.status IN ('INGESTING','RECONCILING','VERIFIED'))
        ORDER BY s.id LIMIT 10`, [initialScanCursor])).rows;
      initialScanCursor = candidates.at(-1)?.id ?? "";
      for (const candidate of candidates) {
        try {
          const session = (await shopify.config.sessionStorage.findSessionsByShop(candidate.id))
            .find(s => s.isOnline === false && s.shop === candidate.id);
          if (session) await enqueue(session, {initial:true,installationVersion:candidate.installation_version});
        } catch (error) { logger.error?.({code:error.code}, "Initial mirror sync remains pending"); }
      }
    },
    async status(session, id) {
      const stored = await authenticate(session);
      requireCatalogImportId(id);
      const result=publicJob((await database.query(`SELECT ${progressColumns} FROM mirror.catalog_import_jobs j ${progressJoins}
        WHERE j.shop_id=$1 AND j.id=$2`, [stored.shop,id])).rows[0]);
      await authenticate(session);return result;
    },
    async current(session) {
      const stored = await authenticate(session);
      const read = () => database.query(`SELECT ${progressColumns} FROM mirror.catalog_import_jobs j
        JOIN mirror.shops s ON s.id=j.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
        ${progressJoins} WHERE j.shop_id=$1
        ORDER BY (j.status IN ('QUEUED','RUNNING','RETRY')) DESC,j.created_at DESC,j.id DESC LIMIT 1`, [stored.shop]);
      let row = (await read()).rows[0];
      if (!row) {
        await service.ensureInitialSync(session);
        row = (await read()).rows[0];
        if (!row) return publicJob({id:null,status:'QUEUED'});
      }
      await authenticate(session);return publicJob(row);
    },
    async cancel(session, id) {
      const stored = await authenticate(session);
      requireCatalogImportId(id);
      const result = await transaction(database, async client => {await authenticate(session);return (await client.query(`UPDATE mirror.catalog_import_jobs SET cancel_requested=true,
        status=CASE WHEN generation_id IS NULL AND status<>'RUNNING' THEN 'CANCELLED' ELSE status END,
        next_attempt_at=now(),updated_at=now() WHERE shop_id=$1 AND id=$2 AND status IN ('QUEUED','RUNNING','RETRY','FAILED') RETURNING *`, [stored.shop,id])).rows[0];}, stored.shop);
      if (result) controllers.get(id)?.abort();
      return publicJob(result);
    },
    async processOne() {
      const phaseResult = phaseRuntime ? await phaseRuntime.processOne() : null;
      if (phaseResult) return phaseResult;
      const cancelling = (await database.query(`WITH due_cancel AS (
        SELECT id FROM mirror.catalog_import_jobs WHERE
          execution_mode='LEGACY' AND cancel_requested
          AND status IN ('QUEUED','RETRY','RUNNING','FAILED')
          AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<=now())
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE mirror.catalog_import_jobs j SET fence=fence+1,
          lease_until=clock_timestamp()+interval '60 seconds',updated_at=now()
        FROM due_cancel WHERE j.id=due_cancel.id RETURNING j.*`)).rows[0];
      if (cancelling) {
        shop(cancelling.shop_id);
        const client = clientFactory({ shopId: cancelling.shop_id, installationVersion: cancelling.installation_version });
        const runner = createBulkOperationRunner({ database, shopifyClient: client, syncRunService: sync,
          ingestionWriter: createIngestionWriter({ syncRunService: sync }) });
        try {
          if (cancelling.run_id) {
            const cleanup=await runner.cancelBulkCatalogExport({shopId:cancelling.shop_id,runId:cancelling.run_id,reconcile:true});
            if(cleanup?.cancelled!==true){
              const saved=await database.query(`UPDATE mirror.catalog_import_jobs SET lease_until=NULL,last_error=$4,
                next_attempt_at=clock_timestamp()+interval '10 seconds',updated_at=now()
                WHERE id=$1 AND shop_id=$2 AND fence=$3 AND cancel_requested AND lease_until>clock_timestamp()`,
                [cancelling.id,cancelling.shop_id,cancelling.fence,cleanup?.outcomeUncertain!==false?'REMOTE_CANCEL_OUTCOME_UNKNOWN':'REMOTE_CANCEL_PENDING']);
              return {id:cancelling.id,status:cancelling.status,cancelPending:true,cancellationState:cleanup?.state??'CANCELLATION_REQUESTED',outcomeUncertain:cleanup?.outcomeUncertain!==false,superseded:saved.rowCount!==1};
            }
          }
          else if (cancelling.generation_id) await sync.cancelGeneration({ shopId: cancelling.shop_id, generationId: cancelling.generation_id });
          const completed=await database.query(`UPDATE mirror.catalog_import_jobs SET status='CANCELLED',lease_until=NULL,updated_at=now()
            WHERE id=$1 AND shop_id=$2 AND fence=$3 AND cancel_requested AND lease_until>clock_timestamp()`, [cancelling.id,cancelling.shop_id,cancelling.fence]);
          return { id: cancelling.id, status: completed.rowCount===1?"CANCELLED":"SUPERSEDED" };
        } catch (error) {
          logger.error?.({ code: error.code }, "Remote import cancellation requires retry");
          await database.query(`UPDATE mirror.catalog_import_jobs SET lease_until=NULL,
            last_error=$4,next_attempt_at=clock_timestamp()+interval '10 seconds',updated_at=now()
            WHERE id=$1 AND shop_id=$2 AND fence=$3 AND cancel_requested`,
            [cancelling.id,cancelling.shop_id,cancelling.fence,String(error.message ?? "Cancellation cleanup failed").slice(0,1000)]);
          return { id: cancelling.id, status: cancelling.status, cancelPending: true };
        }
      }
      const job = (await database.query(`WITH due AS (
        SELECT id FROM mirror.catalog_import_jobs WHERE
          NOT cancel_requested
          AND ((status IN ('QUEUED','RETRY') AND next_attempt_at<=now()) OR (status='RUNNING' AND lease_until<=now()))
          AND execution_mode='LEGACY' AND attempts<8 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE mirror.catalog_import_jobs j SET status='RUNNING',attempts=attempts+1,fence=fence+1,
          lease_until=clock_timestamp()+interval '60 seconds',updated_at=now()
        FROM due WHERE j.id=due.id AND NOT j.cancel_requested RETURNING j.*`)).rows[0];
      if (!job) {
        // A crash during the final attempt must not strand a RUNNING row forever.
        await database.query("UPDATE mirror.catalog_import_jobs SET status='FAILED',lease_until=NULL,last_error='Import attempt limit reached',updated_at=now() WHERE status='RUNNING' AND NOT cancel_requested AND lease_until<=now() AND attempts>=8");
        return null;
      }
      shop(job.shop_id);
      const controller = new AbortController();
      controllers.set(job.id, controller);
      const signal = controller.signal;
      const workerId = `import-${job.id}-${job.fence}`;
      let run, heartbeatBusy = false, heartbeatError, stoppedByShutdown = false;
      const client = clientFactory({ shopId: job.shop_id, installationVersion: job.installation_version });
      const runner = createBulkOperationRunner({ database, shopifyClient: client, syncRunService: sync,
        ingestionWriter: createIngestionWriter({ syncRunService: sync }) });
      const check = () => { if (heartbeatError) throw heartbeatError; signal.throwIfAborted(); };
      const heartbeat = setInterval(async () => {
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        try {
          const renewed = await database.query(`UPDATE mirror.catalog_import_jobs SET lease_until=clock_timestamp()+interval '60 seconds',updated_at=now()
            WHERE id=$1 AND fence=$2 AND status='RUNNING' AND lease_until>clock_timestamp() AND NOT cancel_requested RETURNING id`, [job.id,job.fence]);
          if (!renewed.rowCount) invalid("Import lease lost or cancellation requested");
          if (run?.status === "RUNNING") {
            const persisted = await sync.getSyncRun({ shopId: job.shop_id, runId: run.runId });
            if (persisted?.status === "SUCCEEDED") run.status = "FINISHED";
            else {
              try { await sync.renewRunLease({ shopId: job.shop_id, runId: run.runId, fence: run.fence, workerId }); }
              catch (error) {
                // Completion can commit between the read and renewal.
                const latest = await sync.getSyncRun({ shopId: job.shop_id, runId: run.runId });
                if (latest?.status === "SUCCEEDED") run.status = "FINISHED";
                else throw error;
              }
            }
          }
        } catch (error) { heartbeatError = error; controller.abort(); }
        finally { heartbeatBusy = false; }
      }, 10000);
      heartbeat.unref?.();
      try {
        if (job.cancel_requested) {
          if (job.run_id) {
            const cleanup=await runner.cancelBulkCatalogExport({shopId:job.shop_id,runId:job.run_id,reconcile:true});
            if(cleanup?.cancelled!==true)throw Object.assign(Error('Remote cancellation pending'),{code:cleanup?.outcomeUncertain!==false?'REMOTE_CANCEL_OUTCOME_UNKNOWN':'REMOTE_CANCEL_PENDING'});
          }
          else if (job.generation_id) await sync.cancelGeneration({ shopId: job.shop_id, generationId: job.generation_id });
          const completed=await database.query("UPDATE mirror.catalog_import_jobs SET status='CANCELLED',lease_until=NULL,updated_at=now() WHERE id=$1 AND fence=$2 AND shop_id=$3 AND cancel_requested AND lease_until>clock_timestamp()", [job.id,job.fence,job.shop_id]);
          return { id: job.id, status: completed.rowCount===1?"CANCELLED":"SUPERSEDED" };
        }
        await transaction(database, c => owner(c, job), job.shop_id);
        let generation = job.generation_id ? (await database.query("SELECT status FROM mirror.generations WHERE shop_id=$1 AND id=$2", [job.shop_id,job.generation_id])).rows[0] : null;
        if (!generation || generation.status === "INGESTING") {
          run = await sync.startIngestionRun({ shopId: job.shop_id, workerId });
          job.generation_id = run.generationId;
          job.run_id = run.runId;
          await transaction(database, async c => {
            await owner(c, job);
            await c.query("UPDATE mirror.catalog_import_jobs SET generation_id=$3,run_id=$4 WHERE id=$1 AND fence=$2", [job.id,job.fence,run.generationId,run.runId]);
          }, job.shop_id);
          await runner.initiateBulkCatalogExport({ shopId: job.shop_id, syncRun: run });
          const op = await runner.bulkSync.monitorBulkOperation({ shopId: job.shop_id, runId: run.runId, signal });
          check();
          if (op.status !== "COMPLETED") {
            await sync.cancelGeneration({ shopId: job.shop_id, generationId: job.generation_id });
            throw Object.assign(new Error("Remote bulk export did not complete"), { code: "IMPORT_REMOTE_TERMINAL" });
          }
          const lines = await openBulkExport(op, { fetchImpl, signal });
          try { await runner.ingestJsonlLines({ shopId: job.shop_id, ...run, lines, signal, cancelOnAbort: false }); }
          finally { run.status = "FINISHED"; }
          generation = { status: "RECONCILING" };
        }
        if (generation.status === "RECONCILING") {
          // Drain only eligible rows. Pending backoff/dead-letter rows prevent
          // verification below; a failed import retries rather than publishing.
          for (let batch = 0; batch < 10000; batch++) {
            check();
            const due = await reconciliation.scanDueDirtyProducts({ shopId: job.shop_id, limit: 50 });
            if (!due.length) break;
            for (const row of due) {
              check();
              await reconciliation.reconcileLatestProduct({ shopId: job.shop_id, generationId: job.generation_id,
                productId: row.productId, workerId, signal,
                fetchProduct: ({ productId,signal:productSignal }) => readCompleteProduct({ client, productId, signal:productSignal }) });
            }
          }
        } else if (generation.status !== "VERIFIED") invalid("Import generation cannot be published");
        check();
        await transaction(database, async c => {
          await owner(c, job);
          await client.authorize();
          if (generation.status === "RECONCILING") await sync.completeCoverageAndVerify({ client: c, shopId: job.shop_id, generationId: job.generation_id });
          await sync.publishGeneration({ client: c, shopId: job.shop_id, generationId: job.generation_id, expectedGenerationId: job.expected_generation_id });
          await c.query("UPDATE mirror.catalog_import_jobs SET status='SUCCEEDED',lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND fence=$2", [job.id,job.fence]);
        }, job.shop_id);
        return { id: job.id, status: "SUCCEEDED", generationId: job.generation_id };
      } catch (error) {
        stoppedByShutdown = stopping;
        // Release a still-owned ingestion lease when polling or downloading
        // fails before the importer can record its own failure. A new attempt
        // must not burn retries waiting for this worker's abandoned lease.
        if (run?.status === "RUNNING") {
          await sync.failIngestionRun({ shopId: job.shop_id, runId: run.runId, fence: run.fence, error }).catch(() => {});
        }
        const current = (await database.query("SELECT cancel_requested FROM mirror.catalog_import_jobs WHERE id=$1 AND fence=$2 AND status='RUNNING'", [job.id,job.fence])).rows[0];
        if (!current) return { id: job.id, status: "SUPERSEDED" };
        let cancelPending = false,cancelUncertain = false;
        if (current.cancel_requested) {
          if (job.run_id) {
            try { const cleanup=await runner.cancelBulkCatalogExport({shopId:job.shop_id,runId:job.run_id,reconcile:true});cancelPending=cleanup?.cancelled!==true;cancelUncertain=cleanup?.outcomeUncertain!==false; }
            catch (cancelError) { cancelPending = true;cancelUncertain=true; logger.error?.({ code: cancelError.code }, "Remote import cancellation requires retry"); }
          } else if (job.generation_id) await sync.cancelGeneration({ shopId: job.shop_id, generationId: job.generation_id });
        }
        const status = cancelPending ? job.attempts >= 8 ? "FAILED" : "RETRY"
          : current.cancel_requested ? "CANCELLED" : job.attempts >= 8 || error.code === "IMPORT_REMOTE_TERMINAL" ? "FAILED" : "RETRY";
        await database.query(`UPDATE mirror.catalog_import_jobs SET status=$3,lease_until=NULL,last_error=$4,
          next_attempt_at=clock_timestamp()+$5::integer*interval '1 second',updated_at=now() WHERE id=$1 AND fence=$2 AND status='RUNNING'`,
        [job.id,job.fence,status,cancelPending ? cancelUncertain?"REMOTE_CANCEL_OUTCOME_UNKNOWN":"REMOTE_CANCEL_PENDING" : stoppedByShutdown ? "Worker shutdown; resume pending" : String(error.message ?? "Import failed").slice(0,1000),Math.min(3600,2 ** job.attempts * 5)]);
        return { id: job.id, status,...(cancelPending?{cancelPending:true,outcomeUncertain:cancelUncertain}:{}) };
      } finally {
        clearInterval(heartbeat);
        controllers.delete(job.id);
      }
    },
    async verifyStorage() {
      await database.query("SELECT id,execution_mode FROM mirror.catalog_import_jobs LIMIT 0");
      await database.query("SELECT shop_id,requested_revision,scheduled_revision,attempts FROM mirror.catalog_refresh_requests LIMIT 0");
      await phaseRuntime?.verifyStorage();
    },
    start() {
      if (timer) return;
      stopping = false;
      phaseRuntime?.start();
      const tick = () => {
        if (running || stopping) return;
        running = service.ensurePendingInitialSyncs().then(() => service.ensurePendingCatalogRefreshes()).then(() => service.processOne()).catch(error => logger.error?.({ code: error.code }, "Import worker failed"))
          .finally(() => { running = null; });
      };
      timer = setInterval(tick, 2000); timer.unref?.(); tick();
    },
    async stop() {
      stopping = true; clearInterval(timer); timer = null;
      await phaseRuntime?.stop();
      // Preserve replayable ingestion on shutdown; explicit cancellation is
      // distinguished by the durable cancel flag in the worker catch path.
      for (const controller of controllers.values()) controller.abort();
      await running;
    },
  });
  return Object.freeze({ ...service,
    enqueue: withImportErrors(service.enqueue),
    current: withImportErrors(service.current),
    status: withImportErrors(service.status),
    cancel: withImportErrors(service.cancel),
  });
}
