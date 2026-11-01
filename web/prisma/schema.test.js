import {recordCompletedCatalogImport} from '../security/test-support/catalog-ready.js';
import {testAuditSixTen} from '../mirror/integration/audit-six-ten.js';
import {testTenantDatabase} from '../security/tenant-db.integration.js';
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { createMirrorSqlSchema } from "../filters/mirror-schema.js";
import { verifyMirrorSqlSchema, assertCursorOrdering } from "../services/mirror-schema.server.js";
import { getInstalledFilterSchemaOptions, verifyInstalledFilterSchema, createInstalledFilterCompiler } from "../services/filter-schema.server.js";
import { createFieldService } from "../fields/resolve.js";
import { createFilterExecutor } from "../filters/execute.js";
import { createMirrorCoverageService } from "../mirror/coverage.js";
import { createMirrorPublicationService } from "../mirror/publication-service.server.js";
import { createPublicationRepository } from "../mirror/publication-repository.server.js";
import { createCursorService } from "../filters/pagination.js";
import { createInstalledFilterHttpRuntime } from "../services/filter-engine.server.js";
import { randomBytes } from "node:crypto";
import { testSyncHardening } from "../mirror/integration/sync-hardening.js";
import { testCatalogHttp } from "../mirror/integration/catalog-http.js";
import { testTags } from "../mirror/integration/tags.js";
import { testSelection } from "../mirror/integration/selection.js";
import { testCatalogImports } from "../mirror/integration/catalog-import.js";
import { testSyncDbAdapter } from "../mirror/integration/sync-db-adapter.js";
import { testCatalogPhases } from "../mirror/integration/catalog-phases.js";
import { testHistoryHttp } from "../edit-history/integration/history-http.js";
import { createExportRepository } from "../export/export-repository.server.js";
import { EXPORT_ERROR_CODES, EXPORT_STATES, exportRequestFingerprint, normalizeExportRequest } from "../export/export-contract.js";

test("METAMAX schema enforces tenancy, ingestion, publication and approval boundaries", async t => {
  const target = process.env.FILTER_TEST_DATABASE_URL;
  assert.ok(target && process.env.FILTER_TEST_DATABASE_ISOLATED === "1", "Use npm run test:schema");
  const url = new URL(target);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.pathname === "/metamax_filter_test");
  const pool = new pg.Pool({ connectionString: target });
  const query = (text, values) => pool.query(text, values);
  try {
    const migrations = new URL("./migrations/", import.meta.url);
    const directories = (await readdir(migrations, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^\d+_/.test(entry.name))
      .map(entry => entry.name).sort();
    for (const directory of directories) {
      if(directory==='20261029000400_sync_dispatch_lifecycle') {
        await query(`INSERT INTO mirror.sync_dispatch_shops(shop_id,last_served)
          VALUES('dispatch-migration.myshopify.com',42) ON CONFLICT(shop_id) DO UPDATE SET last_served=42;
          INSERT INTO mirror.shops(id,installation_version,uninstalled_at)
          VALUES('dispatch-removed-before-migration.myshopify.com','removed',now())`);
      }
      if (directory === '20261029000300_sync_dispatch_ledger') {
        // Seed the previous real schema to prove that consolidation preserves
        // existing reservations, logical identities, tokens and queue evidence.
        await query(`INSERT INTO mirror.shops(id,installation_version) VALUES ('dispatch-migration.myshopify.com','migration-install');
          INSERT INTO mirror.generations(shop_id,id,coverage_revision,mirror_schema_version,source_contract_version,mapping_version)
            VALUES ('dispatch-migration.myshopify.com','dispatch-migration-generation','migration-coverage','metamax_mirror_v1','metamax_sources_v1','mapping_v1');
          INSERT INTO mirror.ingestion_runs(shop_id,generation_id,dataset)
            VALUES ('dispatch-migration.myshopify.com','dispatch-migration-generation','products');
          INSERT INTO mirror.catalog_import_jobs(id,shop_id,installation_version,generation_id,run_id,execution_mode)
            SELECT 'dispatch-migration-run',shop_id,'migration-install',generation_id,id,'PHASE' FROM mirror.ingestion_runs
            WHERE shop_id='dispatch-migration.myshopify.com';
          INSERT INTO mirror.catalog_import_executions(id,shop_id,generation_id,review_required)
            VALUES ('dispatch-migration-run','dispatch-migration.myshopify.com','dispatch-migration-generation',true);
          UPDATE mirror.ingestion_runs SET execution_id='dispatch-migration-run',execution_fence=0
            WHERE shop_id='dispatch-migration.myshopify.com';
          INSERT INTO mirror.sync_dispatch_deliveries(id,shop_id,run_id,generation_id,delivery_revision,kind,delivery_key,
            state,reservation_token,reservation_fence,reserved_until,job_id,last_error)
            SELECT 'migration-dispatch-'||n,'dispatch-migration.myshopify.com','dispatch-migration-run','dispatch-migration-generation',
              n,'SYNC','migration-delivery-'||n,state,'migration-token-'||n,n+1,now()+interval '1 hour',
              CASE WHEN state='DISPATCHED' THEN 'retained-bullmq-job' END,'OLD_REDIS_ERROR'
            FROM (VALUES (0,'RESERVED'),(1,'UNCERTAIN'),(2,'DISPATCHED'),(3,'EXPIRED'),(4,'SUPERSEDED')) v(n,state)`);
      }
      if (directory === "20261028000300_execution_reliability") {
        await query(`INSERT INTO mirror.selection_snapshots(shop_id,id,generation_id,coverage_revision,mapping_version,operation,operation_id,
          filter_ast,filter_fingerprint,registry_version,definition_revisions,expires_at)
          VALUES ('legacy.myshopify.com','legacy-select','legacy','r1','mapping_v1','bulk_edit','legacy-edit','{}','hash','registry','[]',now()+interval '1 hour');
          INSERT INTO mirror.execution_contracts(shop_id,id,snapshot_id,operation,approval_revision,contract,contract_hash,expires_at)
          VALUES ('legacy.myshopify.com','legacy-contract','legacy-select','bulk_edit','legacy-approval','{}','hash',now()+interval '30 minutes');
          INSERT INTO mirror.job_commands(shop_id,contract_id,idempotency_key,kind,updated_at)
          VALUES ('legacy.myshopify.com','legacy-contract','legacy-before','bulk_edit',now());
          INSERT INTO mirror.job_items(shop_id,command_id,resource_id,before_values,intended_values)
          SELECT shop_id,id,'gid://shopify/Product/9','{"title":"Before"}','{"title":"After"}' FROM mirror.job_commands
          WHERE shop_id='legacy.myshopify.com' AND idempotency_key='legacy-before'`);
      }
      if (directory === "20261028000200_typed_metafield_values") {
        await query(`INSERT INTO mirror.shops(id,installation_version) VALUES ('legacy.myshopify.com','legacy-install');
          INSERT INTO mirror.generations(shop_id,id,coverage_revision,mirror_schema_version,source_contract_version,mapping_version)
          VALUES ('legacy.myshopify.com','legacy','r1','mirror_v1','sources_v1','mapping_v1');
          INSERT INTO mirror.products(shop_id,generation_id,shopify_id,title,handle,status,created_at,updated_at)
          VALUES ('legacy.myshopify.com','legacy','gid://shopify/Product/9','Legacy','legacy','ACTIVE',now(),now());
          INSERT INTO mirror.metafield_definitions(shop_id,field_id,shopify_definition_id,locator_id,owner_entity,namespace,key,
            shopify_type,canonical_type,label,definition_token,status,definition_verified,verified_at,verification_expires_at,precision,scale)
          VALUES ('legacy.myshopify.com','product.metafield.m00000001','gid://shopify/MetafieldDefinition/9','locator:legacy',
            'product','custom','rating','number_decimal','decimal','Rating','definition_token_123','ACTIVE',true,now(),now()+interval '1 hour',18,4);
          INSERT INTO mirror.product_metafields(shop_id,generation_id,product_id,definition_id,definition_token,value)
          SELECT p.shop_id,p.generation_id,p.id,d.id,d.definition_token,'"12.5000"'::jsonb
          FROM mirror.products p JOIN mirror.metafield_definitions d ON d.shop_id=p.shop_id
          WHERE p.shop_id='legacy.myshopify.com' AND p.generation_id='legacy'`);
      }
      await query(await readFile(new URL(`${directory}/migration.sql`, migrations), "utf8"));
    }
    await t.test('dispatch ledger migration preserves history and binds the existing execution, shop and bigint SyncRun',async()=>{
      const names=(await query("SELECT to_regclass('mirror.sync_dispatch_deliveries') AS old,to_regclass('mirror.sync_dispatches') AS ledger")).rows[0];
      assert.equal(names.old,null);assert.equal(names.ledger,'mirror.sync_dispatches');
      const rows=(await query("SELECT * FROM mirror.sync_dispatches WHERE shop_id='dispatch-migration.myshopify.com' ORDER BY delivery_revision")).rows;
      assert.deepEqual(rows.map(r=>r.state),['RESERVED','UNKNOWN','ENQUEUED','PENDING','REVIEW_REQUIRED']);
      assert.equal(rows.length,5);
      for(let n=0;n<rows.length;n++) {
        assert.equal(rows[n].id,`migration-dispatch-${n}`);assert.equal(rows[n].dispatch_token,`migration-token-${n}`);
        assert.equal(rows[n].delivery_key,`migration-delivery-${n}`);assert.equal(rows[n].reservation_fence,String(n+1));
        assert.equal(rows[n].attempt,n+1);assert.equal(typeof rows[n].sync_run_id,'string');
        assert.equal(rows[n].last_error_code,'OLD_REDIS_ERROR');assert.ok(rows[n].next_attempt_at);
      }
      assert.equal(rows[2].job_id,'retained-bullmq-job');assert.ok(rows[2].enqueued_at);
      const insert=`INSERT INTO mirror.sync_dispatches(id,shop_id,run_id,generation_id,sync_run_id,delivery_revision,kind,
        delivery_key,dispatch_token,reservation_fence,state,reserved_until)
        VALUES('migration-invalid','dispatch-migration.myshopify.com','dispatch-migration-run','dispatch-migration-generation',
          $1,999,'SYNC','invalid-migration-key','token',1,$2,NULL)`;
      await assert.rejects(()=>query(insert,['9223372036854775807','PENDING']),{code:'23503'});
      await assert.rejects(()=>query(insert,[rows[0].sync_run_id,'RESERVED']),{code:'23514'});
    });
    await t.test('dispatch lifecycle migration reuses and backfills scheduling authority and preserves tenant relationships',async()=>{
      assert.equal((await query("SELECT to_regclass('mirror.sync_dispatch_shops') AS old")).rows[0].old,null);
      assert.equal((await query(`SELECT count(*) FROM mirror.shops s WHERE NOT EXISTS(
        SELECT 1 FROM mirror.sync_dispatch_schedule schedule WHERE schedule.shop_id=s.id)`)).rows[0].count,'0');
      const schedule=(await query("SELECT * FROM mirror.sync_dispatch_schedule WHERE shop_id='dispatch-migration.myshopify.com'")).rows[0];
      assert.equal(schedule.last_served,'42');assert.ok(schedule.last_dispatched_at);assert.ok(schedule.next_eligible_at);
      assert.equal((await query("SELECT isfinite(next_eligible_at) AS enabled FROM mirror.sync_dispatch_schedule WHERE shop_id='dispatch-removed-before-migration.myshopify.com'")).rows[0].enabled,false);
      for(const state of ['PENDING','RESERVED','UNKNOWN','ENQUEUED','RECONCILING','RETRY_ELIGIBLE','CONSUMED','REVIEW_REQUIRED','CANCELLED']) {
        await query("UPDATE mirror.sync_dispatches SET state=$1 WHERE id='migration-dispatch-4'",[state]);
      }
      await assert.rejects(()=>query("UPDATE mirror.sync_dispatches SET state='INVALID' WHERE id='migration-dispatch-4'"),{code:'23514'});
      await query("UPDATE mirror.sync_dispatches SET state='REVIEW_REQUIRED' WHERE id='migration-dispatch-4'");
      assert.ok((await query("SELECT reviewed_at FROM mirror.sync_dispatches WHERE id='migration-dispatch-4'")).rows[0].reviewed_at);
      const indexes=(await query(`SELECT indexname FROM pg_indexes WHERE schemaname='mirror' AND indexname IN
        ('sync_dispatch_recovery_idx','sync_dispatch_due_idx','sync_dispatch_schedule_due_idx')`)).rows;
      assert.equal(indexes.length,3);
    });
    await t.test('shop install, soft removal, reinstall and physical deletion maintain dispatch scheduling rows',async()=>{
      const shop='dispatch-shop-lifecycle.myshopify.com';
      await query("INSERT INTO mirror.shops(id,installation_version) VALUES($1,'initial')",[shop]);
      assert.equal((await query('SELECT count(*) FROM mirror.sync_dispatch_schedule WHERE shop_id=$1',[shop])).rows[0].count,'1');
      await query("UPDATE mirror.sync_dispatch_schedule SET next_eligible_at=clock_timestamp()+interval '1 hour' WHERE shop_id=$1",[shop]);
      await query('UPDATE mirror.shops SET installed_at=installed_at WHERE id=$1',[shop]);
      assert.equal((await query('SELECT next_eligible_at>clock_timestamp() AS throttled FROM mirror.sync_dispatch_schedule WHERE shop_id=$1',[shop])).rows[0].throttled,true);
      await query('UPDATE mirror.shops SET uninstalled_at=clock_timestamp() WHERE id=$1',[shop]);
      assert.equal((await query('SELECT isfinite(next_eligible_at) AS enabled FROM mirror.sync_dispatch_schedule WHERE shop_id=$1',[shop])).rows[0].enabled,false);
      await query("UPDATE mirror.shops SET uninstalled_at=NULL,installation_version='replacement' WHERE id=$1",[shop]);
      assert.equal((await query('SELECT next_eligible_at<=clock_timestamp() AS due FROM mirror.sync_dispatch_schedule WHERE shop_id=$1',[shop])).rows[0].due,true);
      await query('DELETE FROM mirror.shops WHERE id=$1',[shop]);
      assert.equal((await query('SELECT count(*) FROM mirror.sync_dispatch_schedule WHERE shop_id=$1',[shop])).rows[0].count,'0');
    });
    await t.test("typed metafield consolidation preserves exact legacy decimals and enforces owner/type/token boundaries", async () => {
      const legacy = (await query(`SELECT * FROM mirror.metafield_values WHERE shop_id='legacy.myshopify.com'`)).rows[0];
      assert.equal(legacy.decimal_value, "12.5000");
      assert.equal(legacy.value_type, "decimal");
      const insert = `INSERT INTO mirror.metafield_values(shop_id,generation_id,product_id,definition_id,owner_entity,
        definition_token,value_type,decimal_value) VALUES ($1,'legacy',$2,$3,'product',$4,'decimal',$5)`;
      await assert.rejects(() => query(insert, [legacy.shop_id,legacy.product_id,legacy.definition_id,legacy.definition_token,"1"]), { code: "23505" });
      await assert.rejects(() => query(`UPDATE mirror.metafield_values SET product_id=NULL WHERE id=$1`, [legacy.id]), { code: "23514" });
      await assert.rejects(() => query(`UPDATE mirror.metafield_values SET text_value='wrong' WHERE id=$1`, [legacy.id]), { code: "23514" });
      await assert.rejects(() => query(`UPDATE mirror.metafield_values SET definition_token='stale_token_123456' WHERE id=$1`, [legacy.id]), { code: "23514" });
      await assert.rejects(() => query(`UPDATE mirror.metafield_values SET value_type='string',decimal_value=NULL,text_value='wrong' WHERE id=$1`, [legacy.id]), { code: "23514" });
      await query(`UPDATE mirror.metafield_values SET decimal_value=9007199254740993.0001 WHERE id=$1`, [legacy.id]);
      assert.equal((await query(`SELECT decimal_value FROM mirror.metafield_values WHERE id=$1`, [legacy.id])).rows[0].decimal_value, "9007199254740993.0001");
      await query(`UPDATE mirror.metafield_values SET is_null=true,decimal_value=NULL WHERE id=$1`, [legacy.id]);
      assert.equal((await query(`SELECT is_null FROM mirror.metafield_values WHERE id=$1`, [legacy.id])).rows[0].is_null, true);
      await query(`UPDATE mirror.metafield_values SET is_null=false,decimal_value=12.5 WHERE id=$1`, [legacy.id]);
    });
    await t.test("typed metafields round-trip every supported representation and enforce variant ownership", async () => {
      const legacy = (await query(`SELECT product_id FROM mirror.metafield_values WHERE shop_id='legacy.myshopify.com'`)).rows[0];
      const cases = [
        ["string","single_line_text_field","text_value","Cotton"],
        ["boolean","boolean","boolean_value",false],
        ["integer","number_integer","integer_value","9007199254740993"],
        ["decimal","number_decimal","decimal_value","0.0001"],
        ["date","date","date_value","2026-10-28"],
        ["datetime","date_time","datetime_value","2026-10-28T10:20:30.123456Z"],
        ["string_list","list.single_line_text_field","string_list_value",[]],
        ["json","json","json_value","null"],
      ];
      let ordinal = 10;
      async function definition(type, shopifyType, owner = "product") {
        ordinal++;
        return (await query(`INSERT INTO mirror.metafield_definitions(shop_id,field_id,shopify_definition_id,locator_id,owner_entity,
          namespace,key,shopify_type,canonical_type,label,definition_token,status,definition_verified,nullable,verified_at,verification_expires_at)
          VALUES ('legacy.myshopify.com',$1,$2,$3,$4,'custom',$5,$6,$7,'Test','definition_token_123','ACTIVE',true,false,now(),now()+interval '1 hour') RETURNING id`,
        [`${owner}.metafield.m${String(ordinal).padStart(8,"0")}`, `gid://shopify/MetafieldDefinition/${100+ordinal}`,
          `locator:${ordinal}`,owner,`test_${ordinal}`,shopifyType,type])).rows[0].id;
      }
      for (const [type,shopifyType,column,value] of cases) {
        const id = await definition(type,shopifyType);
        // Column names come solely from the fixed test cases above.
        const row = (await query(`INSERT INTO mirror.metafield_values(shop_id,generation_id,product_id,definition_id,owner_entity,
          definition_token,value_type,${column}) VALUES ('legacy.myshopify.com','legacy',$1,$2,'product','definition_token_123',$3,$4) RETURNING id`,
        [legacy.product_id,id,type,value])).rows[0].id;
        if (type === "json") assert.equal((await query(`SELECT jsonb_typeof(json_value) AS kind FROM mirror.metafield_values WHERE id=$1`,[row])).rows[0].kind,"null");
        if (type === "datetime") assert.equal((await query(`SELECT to_char(datetime_value,'US') AS fraction FROM mirror.metafield_values WHERE id=$1`,[row])).rows[0].fraction,"123456");
        if (type === "integer") assert.equal((await query(`SELECT integer_value FROM mirror.metafield_values WHERE id=$1`,[row])).rows[0].integer_value,value);
        await assert.rejects(() => query(`UPDATE mirror.metafield_values SET is_null=true,${column}=DEFAULT WHERE id=$1`,[row]), {code:"23514"});
      }
      const variant = (await query(`INSERT INTO mirror.variants(shop_id,generation_id,shopify_id,product_id,title,price,
        inventory_policy,inventory_quantity,taxable,requires_components,position,created_at,updated_at)
        VALUES ('legacy.myshopify.com','legacy','gid://shopify/ProductVariant/9',$1,'Legacy',1,'DENY',0,true,false,1,now(),now()) RETURNING id`,[legacy.product_id])).rows[0].id;
      const id = await definition("string","single_line_text_field","variant");
      await query(`INSERT INTO mirror.metafield_values(shop_id,generation_id,variant_id,definition_id,owner_entity,definition_token,value_type,text_value)
        VALUES ('legacy.myshopify.com','legacy',$1,$2,'variant','definition_token_123','string','Variant')`,[variant,id]);
      await assert.rejects(() => query(`UPDATE mirror.metafield_values SET product_id=$1 WHERE shop_id='legacy.myshopify.com' AND variant_id=$2`,[legacy.product_id,variant]),{code:"23514"});
    });
    await query(`INSERT INTO mirror.shops(id, installation_version) VALUES ('a.myshopify.com','install-a'),('b.myshopify.com','install-b');
      INSERT INTO mirror.generations(shop_id,id,coverage_revision,mirror_schema_version,source_contract_version,mapping_version)
      VALUES ('a.myshopify.com','g1','r1','mirror_v1','sources_v1','mapping_v1'),
             ('b.myshopify.com','g1','r1','mirror_v1','sources_v1','mapping_v1')`);
    await assert.rejects(() => query(`INSERT INTO mirror.subscriptions(shop_id,installation_version,updated_at)
      VALUES ('a.myshopify.com','old-installation',now())`), { code: "23503" });
    await query(`INSERT INTO mirror.subscriptions(shop_id,installation_version,updated_at)
      VALUES ('a.myshopify.com','install-a',now())`);
    await assert.rejects(() => query(`UPDATE mirror.subscriptions SET status='ACTIVE',verification_revision=1
      WHERE shop_id='a.myshopify.com'`), { code: "23514" });
    await query(`UPDATE mirror.subscriptions SET status='ACTIVE',plan_handle='pro',provider_subscription_id='provider-1',
      verification_revision=1,verified_at=now(),verification_expires_at=now()+interval '5 minutes'
      WHERE shop_id='a.myshopify.com'`);
    await assert.rejects(() => query(`UPDATE mirror.subscriptions SET status='CANCELLED'
      WHERE shop_id='a.myshopify.com'`), { code: "23514" });
    await query(`UPDATE mirror.subscriptions SET status='CANCELLED',verification_revision=2 WHERE shop_id='a.myshopify.com'`);
    await assert.rejects(() => query(`UPDATE mirror.shops SET installation_version='install-new'
      WHERE id='a.myshopify.com'`), error => ['23001','23503'].includes(error.code) &&
        error.constraint === 'subscriptions_shop_id_installation_version_fkey');
    await query(`DELETE FROM mirror.subscriptions WHERE shop_id='a.myshopify.com'`);
    await query(`UPDATE mirror.shops SET installation_version='install-new' WHERE id='a.myshopify.com'`);
    await assert.rejects(() => query(`INSERT INTO mirror.subscriptions(shop_id,installation_version,updated_at)
      VALUES ('a.myshopify.com','install-a',now())`), { code: "23503" });
    const product = (await query(`INSERT INTO mirror.products(shop_id,generation_id,shopify_id,title,handle,status,created_at,updated_at)
      VALUES ('a.myshopify.com','g1','gid://shopify/Product/1','One','one','ACTIVE',now(),now()) RETURNING id`)).rows[0].id;
    const variantInsert = `INSERT INTO mirror.variants(shop_id,generation_id,shopify_id,product_id,title,price,
      inventory_policy,inventory_quantity,taxable,requires_components,position,created_at,updated_at)
      VALUES ($1,'g1','gid://shopify/ProductVariant/1',$2,'One',12.50,'DENY',0,true,false,1,now(),now())`;
    await assert.rejects(() => query(`UPDATE mirror.products SET shopify_id='unvalidated' WHERE shop_id='a.myshopify.com' AND id=$1`, [product]), { code: "23514" });
    await assert.rejects(() => query(variantInsert, ["b.myshopify.com", product]), { code: "23503" });
    await query(variantInsert, ["a.myshopify.com", product]);
    await query(`INSERT INTO mirror.generations(shop_id,id,coverage_revision,mirror_schema_version,source_contract_version,mapping_version)
      VALUES ('a.myshopify.com','g2','r2','mirror_v1','sources_v1','mapping_v1')`);
    await assert.rejects(() => query(`INSERT INTO mirror.variants(shop_id,generation_id,shopify_id,product_id,title,price,
      inventory_policy,inventory_quantity,taxable,requires_components,position,created_at,updated_at)
      VALUES ('a.myshopify.com','g2','gid://shopify/ProductVariant/2',$1,'Other',1,'DENY',0,true,false,1,now(),now())`, [product]), { code: "23503" });
    await assert.rejects(() => query(`UPDATE mirror.generations SET status='RECONCILING' WHERE shop_id='a.myshopify.com' AND id='g1'`), { code: "23514" });
    await assert.rejects(() => query(`INSERT INTO mirror.ingestion_runs(shop_id,generation_id,dataset,status,expected_lines,processed_lines)
      VALUES ('a.myshopify.com','g1','products','SUCCEEDED',1,1)`), { code: "23514" });
    for (const dataset of ["products", "variants"]) {
      await query(`INSERT INTO mirror.ingestion_runs(shop_id,generation_id,dataset,status,expected_lines,processed_lines,eof_verified,writes_finished_at)
        VALUES ('a.myshopify.com','g1',$1,'SUCCEEDED',1,1,true,now())`, [dataset]);
      await query(`INSERT INTO mirror.coverage(shop_id,generation_id,name,status,durable_rows,verified_at,verification_hash)
        VALUES ('a.myshopify.com','g1',$1,'COMPLETE',1,now(),'checked')`, [dataset]);
    }
    await query(`UPDATE mirror.generations SET status='RECONCILING' WHERE shop_id='a.myshopify.com' AND id='g1'`);
    await query(`UPDATE mirror.generations SET status='VERIFIED', verified_at=now() WHERE shop_id='a.myshopify.com' AND id='g1'`);
    await query(`UPDATE mirror.generations SET status='PUBLISHED', published_at=now() WHERE shop_id='a.myshopify.com' AND id='g1'`);
    await query(`INSERT INTO mirror.publications(shop_id,generation_id,coverage_revision,mapping_version)
      VALUES ('a.myshopify.com','g1','r1','mapping_v1')`);
    await assert.rejects(() => query(`UPDATE mirror.products SET title='Changed' WHERE shop_id='a.myshopify.com'`), { code: "23514" });
    await assert.rejects(() => query(`UPDATE mirror.generations SET status='RETIRED' WHERE shop_id='a.myshopify.com' AND id='g1'`), { code: "23514" });
    await assert.rejects(() => query(`INSERT INTO mirror.catalog_changes(shop_id,product_id,revision,applied_revision,dirty,updated_at)
      VALUES ('a.myshopify.com','gid://shopify/Product/1',2,1,false,now())`), { code: "23514" });

    const physical = await verifyMirrorSqlSchema({ database: pool,
      schema: createMirrorSqlSchema({
        products: { schema: "mirror", table: "products", id: "id", shop: "shop_id", generation: "generation_id" },
        variants: { schema: "mirror", table: "variants", productId: "product_id", shop: "shop_id", generation: "generation_id" },
      }), mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1",
      fieldMappings: [{ fieldId: "product.title", entity: "product", column: "title", type: "text" },
        { fieldId: "variant.price", entity: "variant", column: "price", type: "numeric" }],
    });
    assert.equal(physical.productIdType, "bigint");
    assertCursorOrdering(physical);

    await query(`INSERT INTO mirror.selection_snapshots(shop_id,id,generation_id,coverage_revision,mapping_version,operation,operation_id,
      filter_ast,filter_fingerprint,registry_version,definition_revisions,expires_at)
      VALUES ('a.myshopify.com','s1','g1','r1','mapping_v1','bulk_edit','op1','{}','hash','registry','[]',now()+interval '1 hour')`);
    await query(`INSERT INTO mirror.selection_items(shop_id,snapshot_id,generation_id,product_id) VALUES ('a.myshopify.com','s1','g1',$1)`, [product]);
    await query(`UPDATE mirror.selection_snapshots SET selected_count=1,selection_hash='hash',frozen_at=now(),status='APPROVED' WHERE id='s1'`);
    await assert.rejects(() => query(`DELETE FROM mirror.selection_items WHERE snapshot_id='s1'`), { code: "23514" });
    await assert.rejects(() => query(`UPDATE mirror.selection_snapshots SET filter_ast='{"changed":true}' WHERE id='s1'`), { code: "23514" });
    await recordCompletedCatalogImport(pool,'a.myshopify.com');
    await query(`INSERT INTO mirror.execution_contracts(shop_id,id,snapshot_id,operation,approval_revision,contract,contract_hash,expires_at)
      VALUES ('a.myshopify.com','e1','s1','bulk_edit','approval1','{}','hash',now()+interval '30 minutes')`);
    await query(`UPDATE mirror.execution_contracts SET status='APPROVED',approved_by='actor',approved_at=now() WHERE id='e1'`);
    await assert.rejects(() => query(`UPDATE mirror.execution_contracts SET contract='{"changed":true}' WHERE id='e1'`), { code: "23514" });
    await assert.rejects(() => query(`INSERT INTO mirror.job_commands(shop_id,contract_id,idempotency_key,kind,updated_at)
      VALUES ('b.myshopify.com','e1','once','bulk_edit',now())`), { code: "55000" });
    await query(`INSERT INTO mirror.job_commands(shop_id,contract_id,idempotency_key,kind,updated_at)
      VALUES ('a.myshopify.com','e1','once','bulk_edit',now())`);
    await assert.rejects(() => query(`INSERT INTO mirror.job_commands(shop_id,contract_id,idempotency_key,kind,updated_at)
      VALUES ('a.myshopify.com','e1','once','bulk_edit',now())`), { code: "23505" });
    await t.test("legacy before-values migrate without claiming verified undo eligibility", async () => {
      const row = (await query(`SELECT s.* FROM mirror.product_snapshots s JOIN mirror.job_items i
        ON i.shop_id=s.shop_id AND i.id=s.edit_item_id WHERE s.shop_id='legacy.myshopify.com'`)).rows[0];
      assert.deepEqual(row.before_values,{title:"Before"});
      assert.equal(row.before_hash,null);
      assert.equal(row.confirmed_at,null);
    });
    await t.test("edit approvals, confirmed snapshots and separately approved undo remain bound to the same merchant and resource", async () => {
      const command = (await query(`SELECT id FROM mirror.job_commands WHERE shop_id='a.myshopify.com' AND idempotency_key='once'`)).rows[0].id;
      const operation = (await query(`INSERT INTO mirror.edit_operations(shop_id,command_id,preview_id)
        VALUES ('a.myshopify.com',$1,'e1') RETURNING id`,[command])).rows[0].id;
      const item = (await query(`INSERT INTO mirror.job_items(shop_id,command_id,resource_id,intended_values)
        VALUES ('a.myshopify.com',$1,'gid://shopify/Product/1','{"title":"After"}') RETURNING id`,[command])).rows[0].id;
      const beforeHash="a".repeat(64), afterHash="b".repeat(64);
      const snapshot = (await query(`INSERT INTO mirror.product_snapshots(shop_id,edit_item_id,before_values,before_hash)
        VALUES ('a.myshopify.com',$1,'{"title":"Before"}',$2) RETURNING id`,[item,beforeHash])).rows[0].id;
      await assert.rejects(() => query(`UPDATE mirror.product_snapshots SET after_hash=$1,confirmed_at=now() WHERE shop_id='a.myshopify.com' AND id=$2`,[afterHash,snapshot]),{code:"23514"});
      await query(`UPDATE mirror.job_items SET status='SUCCEEDED' WHERE shop_id='a.myshopify.com' AND id=$1`,[item]);
      await query(`UPDATE mirror.product_snapshots SET after_hash=$1,confirmed_at=now() WHERE shop_id='a.myshopify.com' AND id=$2`,[afterHash,snapshot]);
      await assert.rejects(() => query(`UPDATE mirror.product_snapshots SET before_values='{"title":"Rewritten"}' WHERE shop_id='a.myshopify.com' AND id=$1`,[snapshot]),{code:"23514"});
      await assert.rejects(() => query(`UPDATE mirror.job_items SET intended_values='{}' WHERE shop_id='a.myshopify.com' AND id=$1`,[item]),{code:"23514"});
      await assert.rejects(() => query(`INSERT INTO mirror.undo_operations(shop_id,source_operation_id,restore_operation_id)
        VALUES ('a.myshopify.com',$1,$1)`,[operation]),{code:"23514"});
      await query(`INSERT INTO mirror.selection_snapshots(shop_id,id,generation_id,coverage_revision,mapping_version,operation,operation_id,
        filter_ast,filter_fingerprint,registry_version,definition_revisions,expires_at)
        VALUES ('a.myshopify.com','undo-select','g1','r1','mapping_v1','undo','undo-1','{}','hash','registry','[]',now()+interval '1 hour');
        INSERT INTO mirror.selection_items(shop_id,snapshot_id,generation_id,product_id)
        SELECT shop_id,'undo-select',generation_id,id FROM mirror.products WHERE shop_id='a.myshopify.com' AND generation_id='g1';
        UPDATE mirror.selection_snapshots SET status='APPROVED',selected_count=1,selection_hash='hash',frozen_at=now() WHERE shop_id='a.myshopify.com' AND id='undo-select';
        INSERT INTO mirror.execution_contracts(shop_id,id,snapshot_id,operation,approval_revision,contract,contract_hash,expires_at)
        VALUES ('a.myshopify.com','undo-contract','undo-select','undo','approval-undo','{}','hash',now()+interval '30 minutes');
        UPDATE mirror.execution_contracts SET status='APPROVED',approved_by='actor',approved_at=now() WHERE shop_id='a.myshopify.com' AND id='undo-contract'`);
      const undoCommand=(await query(`INSERT INTO mirror.job_commands(shop_id,contract_id,idempotency_key,kind,updated_at)
        VALUES ('a.myshopify.com','undo-contract','undo-once','undo',now()) RETURNING id`)).rows[0].id;
      const restore=(await query(`INSERT INTO mirror.edit_operations(shop_id,command_id,preview_id)
        VALUES ('a.myshopify.com',$1,'undo-contract') RETURNING id`,[undoCommand])).rows[0].id;
      await query(`INSERT INTO mirror.undo_operations(shop_id,source_operation_id,restore_operation_id)
        VALUES ('a.myshopify.com',$1,$2)`,[operation,restore]);
      await assert.rejects(() => query(`INSERT INTO mirror.job_items(shop_id,command_id,resource_id,intended_values,restore_snapshot_id)
        VALUES ('a.myshopify.com',$1,'gid://shopify/Product/999','{}',$2)`,[undoCommand,snapshot]),{code:"23514"});
      await query(`INSERT INTO mirror.job_items(shop_id,command_id,resource_id,intended_values,restore_snapshot_id)
        VALUES ('a.myshopify.com',$1,'gid://shopify/Product/1','{"title":"Before"}',$2)`,[undoCommand,snapshot]);
    });
    await t.test("idempotency keys isolate operation and shop, retain results and support fenced recovery", async () => {
      const hash="c".repeat(64);
      const insert=`INSERT INTO mirror.idempotency_records(shop_id,operation,key,request_hash,expires_at)
        VALUES ($1,$2,'same-key',$3,now()+interval '1 hour')`;
      await query(insert,["a.myshopify.com","bulk_edit",hash]);
      await query(insert,["a.myshopify.com","export",hash]);
      await query(insert,["b.myshopify.com","bulk_edit",hash]);
      await assert.rejects(()=>query(insert,["a.myshopify.com","bulk_edit",hash]),{code:"23505"});
      await assert.rejects(()=>query(`UPDATE mirror.idempotency_records SET request_hash=$1 WHERE shop_id='a.myshopify.com' AND operation='bulk_edit'`,["d".repeat(64)]),{code:"23514"});
      const claim=`UPDATE mirror.idempotency_records SET status='RUNNING',lease_token='worker',lease_until=now()+interval '1 minute',fence=fence+1
        WHERE shop_id='a.myshopify.com' AND operation='bulk_edit' AND key='same-key' AND fence=0`;
      assert.equal((await query(claim)).rowCount,1);
      assert.equal((await query(claim)).rowCount,0);
      await query(`UPDATE mirror.idempotency_records SET status='SUCCEEDED',completed_at=now(),response='{"done":true}' WHERE shop_id='a.myshopify.com' AND operation='bulk_edit'`);
      await assert.rejects(()=>query(`UPDATE mirror.idempotency_records SET status='RETRY' WHERE shop_id='a.myshopify.com' AND operation='bulk_edit'`),{code:"23514"});
      await assert.rejects(()=>query(`DELETE FROM mirror.idempotency_records WHERE shop_id='a.myshopify.com' AND operation='bulk_edit'`),{code:"23514"});
    });
    await t.test("journal acknowledgement cannot exceed the durable applied revision", async () => {
      await query(`INSERT INTO mirror.catalog_changes(shop_id,product_id,revision,updated_at) VALUES ('a.myshopify.com','gid://shopify/Product/1',2,now())`);
      const insert=`INSERT INTO mirror.mutation_journal(shop_id,product_id,revision,source_key,source)
        VALUES ('a.myshopify.com','gid://shopify/Product/1',$1,'event-1','WEBHOOK')`;
      await assert.rejects(()=>query(insert,[3]),{code:"23514"});
      await query(insert,[2]);
      await assert.rejects(()=>query(insert,[2]),{code:"23505"});
      await assert.rejects(()=>query(`UPDATE mirror.mutation_journal SET applied_at=now() WHERE shop_id='a.myshopify.com'`),{code:"23514"});
      const acknowledge=`UPDATE mirror.catalog_changes SET applied_revision=2,dirty=false WHERE shop_id='a.myshopify.com'
        AND product_id='gid://shopify/Product/1' AND revision=2 AND applied_revision<2`;
      assert.equal((await query(acknowledge)).rowCount,1);
      await query(`UPDATE mirror.mutation_journal SET applied_at=now() WHERE shop_id='a.myshopify.com'`);
      await query(`UPDATE mirror.catalog_changes SET revision=3,dirty=true WHERE shop_id='a.myshopify.com'`);
      assert.equal((await query(acknowledge)).rowCount,0);
      await assert.rejects(()=>query(`UPDATE mirror.mutation_journal SET deleted=true WHERE shop_id='a.myshopify.com'`),{code:"23514"});
    });
    await t.test("all installed mappings verify PostgreSQL and serve 28 authenticated catalog filters with same-variant matching", async () => {
      const installed = getInstalledFilterSchemaOptions();
      const physicalSchema = await verifyInstalledFilterSchema({ database: pool });
      assert.equal(physicalSchema.fieldMappings.length, 28);
      assertCursorOrdering(physicalSchema);
      const shopId = "installed.myshopify.com", generationId = "installed";
      const repository = createPublicationRepository({ database: pool });
      const publication = createMirrorPublicationService({ repository, barrierTable: { schema:"mirror",table:"publications" } });
      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await publication.lockForWrite(writer,shopId);
        await writer.query(`INSERT INTO mirror.shops(id,installation_version) VALUES ($1,'55555555-5555-4555-8555-555555555555');
        `,[shopId]);
        await writer.query(`INSERT INTO mirror.generations(shop_id,id,coverage_revision,mirror_schema_version,source_contract_version,mapping_version)
          VALUES ($1,$2,'installed-r1',$3,$4,'mapping_v1')`,[shopId,generationId,installed.mirrorSchemaVersion,installed.sourceContractVersion]);
        await writer.query(`INSERT INTO mirror.products(shop_id,generation_id,shopify_id,title,handle,status,vendor,tags,created_at,updated_at)
          VALUES ($1,$2,'gid://shopify/Product/10','Installed','first','ACTIVE','North',ARRAY['Summer','100%_literal'],now(),now()),
                 ($1,$2,'gid://shopify/Product/11','Installed','second','ACTIVE','South',ARRAY[]::text[],now(),now())`,[shopId,generationId]);
        const rows = (await writer.query(`SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 ORDER BY id`,[shopId,generationId])).rows;
        for (const [gid,productId,sku,price] of [[10,rows[0].id,"ABC","50"],[11,rows[0].id,"OTHER","150"],[12,rows[1].id,"ABC","150"]]) {
          await writer.query(`INSERT INTO mirror.variants(shop_id,generation_id,shopify_id,product_id,title,sku,price,inventory_policy,
            inventory_quantity,taxable,requires_components,position,created_at,updated_at)
            VALUES ($1,$2,$3,$4,'Variant',$5,$6,'DENY',0,true,false,1,now(),now())`,[shopId,generationId,`gid://shopify/ProductVariant/${gid}`,productId,sku,price]);
        }
        for (const [dataset,count] of [["products",2],["variants",3]]) {
          await writer.query(`INSERT INTO mirror.ingestion_runs(shop_id,generation_id,dataset,status,expected_lines,processed_lines,eof_verified,writes_finished_at)
            VALUES ($1,$2,$3,'SUCCEEDED',$4,$4,true,now())`,[shopId,generationId,dataset,count]);
          await writer.query(`INSERT INTO mirror.coverage(shop_id,generation_id,name,status,durable_rows,verified_at,verification_hash)
            VALUES ($1,$2,$3,'COMPLETE',$4,now(),'checked')`,[shopId,generationId,dataset,count]);
        }
        for (const state of ["RECONCILING","VERIFIED","PUBLISHED"]) {
          await writer.query(`UPDATE mirror.generations SET status=$3::mirror."GenerationStatus",
            verified_at=CASE WHEN $3='VERIFIED' THEN now() ELSE verified_at END,
            published_at=CASE WHEN $3='PUBLISHED' THEN now() ELSE published_at END WHERE shop_id=$1 AND id=$2`,[shopId,generationId,state]);
        }
        await writer.query(`INSERT INTO mirror.publications(shop_id,generation_id,coverage_revision,mapping_version)
          VALUES ($1,$2,'installed-r1','mapping_v1')`,[shopId,generationId]);
        await writer.query("COMMIT");
      } finally { await writer.query("ROLLBACK"); writer.release(); }
      assert.deepEqual(await repository.getPublishedContext({ shopId }),
        { operationId: "catalog", generationId, coverageRevision: "installed-r1" });
      assert.equal(await repository.getPublishedContext({ shopId: "absent.myshopify.com" }), null);
      assert.equal(await repository.getPublishedSnapshot({ shopId, generationId: "absent", datasets: ["products"] }), null);
      const authContext = Object.freeze({ session: "installed-fixture" });
      const resolveShop = async auth => { assert.strictEqual(auth,authContext); return shopId; };
      const coverage = createMirrorCoverageService({ repository });
      const fieldService = createFieldService({ resolveShop, verifyCoverage: coverage.getVerifiedCoverage,
        authorizeAccess: async ({ access,operation }) => access === "read" && operation === "filter",
        adapter: { resolveOne() { assert.fail("Unexpected dynamic lookup"); },resolveBatch() { assert.fail("Unexpected dynamic lookup"); } },
      });
      const { compiler } = await createInstalledFilterCompiler({ database:pool,fieldService,
        cursorService:createCursorService({secret:randomBytes(32)}) });
      const executor = createFilterExecutor({ database:pool,publicationService:publication,resolveShop,compiler });
      const condition=(field,operator,value)=>({kind:"condition",field,operator,value});
      const validated=await compiler.validateFilter({version:1,root:{kind:"group",operator:"AND",children:[
        condition("variant.sku","eq","ABC"),condition("variant.price","gt","100"),
      ]}},{authContext,operation:"filter",executionContext:{generationId,operationId:"installed-filter"}});
      const compiled=await compiler.compileFilter(validated,{authContext,pageSize:1});
      const result=await executor.execute({query:compiled,authContext});
      const matching=(await query(`SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id='gid://shopify/Product/11'`,[shopId,generationId])).rows[0].id;
      assert.deepEqual(result.productIds,[matching]);
      assert.equal(result.hasMore,false);
      assert.equal((compiled.text.match(/EXISTS/g)??[]).length,1);
      assert.deepEqual(compiled.requiredDatasets,["products","variants"]);
      await testCatalogHttp({ pool, shopId, generationId });
      await assert.rejects(()=>compiler.validateFilter({version:1,root:condition("inventoryItem.unitCost","gt","1")},
        {authContext,operation:"filter",executionContext:{generationId,operationId:"disabled"}}),{code:"FIELD_UNSUPPORTED_OPERATION"});

      // Commit an unavailable approved column so a separate startup connection sees it.
      async function renameSku(from, to) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await publication.lockForWrite(client,"schema-migration.myshopify.com");
          await client.query(`ALTER TABLE mirror.variants RENAME COLUMN ${from} TO ${to}`);
          await client.query("COMMIT");
        } finally { await client.query("ROLLBACK"); client.release(); }
      }
      await renameSku("sku", "sku_unavailable");
      try {
        await assert.rejects(() => createInstalledFilterCompiler({ database:pool,fieldService,
          cursorService:createCursorService({secret:randomBytes(32)}) }), {code:"FIELD_CONTRACT_MISMATCH"});
        const unexpected = () => assert.fail("Unavailable column reached application adapters");
        await assert.rejects(() => createInstalledFilterHttpRuntime({ database:pool,
          sessionStorage:{loadSession:unexpected}, fieldServiceFactory:unexpected,
          coverageRepository:repository, publishedContextRepository:{getPublishedContext:unexpected},
          cursorSecret:randomBytes(32) }), {code:"FIELD_CONTRACT_MISMATCH"});
      } finally { await renameSku("sku_unavailable", "sku"); }
      await createInstalledFilterCompiler({ database:pool,fieldService,
        cursorService:createCursorService({secret:randomBytes(32)}) });
      let started = 0;
      const runtime = await createInstalledFilterHttpRuntime({ database:pool,
        sessionStorage:{loadSession:async()=>null}, fieldServiceFactory:()=>{ started++; return fieldService; },
        coverageRepository:repository, publishedContextRepository:{getPublishedContext:async()=>null},
        cursorSecret:randomBytes(32) });
      assert.equal(started,1);
      assert.equal(typeof runtime.capture,"function");
      assert.equal(typeof runtime.search,"function");
    });
    await testSyncHardening(t,pool);
    await testTags(t,pool);
    await testSelection(t,pool);
    await testCatalogImports(t,pool);
    await testSyncDbAdapter(t,pool);
    await testCatalogPhases(t,pool);
    await testHistoryHttp(t,pool);
    await t.test("export v2 manifest repository enforces atomic idempotency fingerprint check, generation read lease, and outbox creation", async () => {
      const exportShop = "export-v2-manifest.myshopify.com";
      const exportInstall = "export-v2-install";
      const exportGen = "export-v2-gen-1";
      const exportCov = "export-v2-cov-1";
      await query(
        `INSERT INTO mirror.shops(id, installation_version) VALUES ($1, $2)`,
        [exportShop, exportInstall],
      );
      await query(
        `INSERT INTO mirror.generations(shop_id, id, coverage_revision, mirror_schema_version, source_contract_version, mapping_version)
         VALUES ($1, $2, $3, 'metamax_mirror_v1', 'metamax_sources_v1', 'mapping_v1')`,
        [exportShop, exportGen, exportCov],
      );
      for (const dataset of ["products", "variants"]) {
        await query(
          `INSERT INTO mirror.ingestion_runs(shop_id, generation_id, dataset, status, expected_lines, processed_lines, eof_verified, writes_finished_at)
           VALUES ($1, $2, $3, 'SUCCEEDED', 0, 0, true, now())`,
          [exportShop, exportGen, dataset],
        );
        await query(
          `INSERT INTO mirror.coverage(shop_id, generation_id, name, status, durable_rows, verified_at, verification_hash)
           VALUES ($1, $2, $3, 'COMPLETE', 0, now(), 'export-v2-verified')`,
          [exportShop, exportGen, dataset],
        );
      }
      for (const state of ["RECONCILING", "VERIFIED", "PUBLISHED"]) {
        await query(
          `UPDATE mirror.generations
           SET status = $3::mirror."GenerationStatus",
               verified_at = CASE WHEN $3 = 'VERIFIED' THEN now() ELSE verified_at END,
               published_at = CASE WHEN $3 = 'PUBLISHED' THEN now() ELSE published_at END,
               retain_until = CASE WHEN $3 = 'PUBLISHED' THEN now() + interval '25 hours' ELSE retain_until END
           WHERE shop_id = $1 AND id = $2`,
          [exportShop, exportGen, state],
        );
      }
      await query(
        `INSERT INTO mirror.publications(shop_id, generation_id, coverage_revision, mapping_version)
         VALUES ($1, $2, $3, 'mapping_v1')`,
        [exportShop, exportGen, exportCov],
      );

      const exportRepo = createExportRepository({ database: pool });
      const req1 = normalizeExportRequest({ fieldIds: ["product.title", "product.status"] });
      const fp1 = exportRequestFingerprint(req1);
      const prepared1 = {
        contractVersion: 2,
        manifestVersion: 1,
        shopId: exportShop,
        installationId: exportInstall,
        generationId: exportGen,
        coverageRevision: exportCov,
        requestFingerprint: fp1,
        manifestFingerprint: "sha256:manifest-v2-1",
        request: req1,
        authorizedFields: { fields: [{ id: "product.title" }, { id: "product.status" }] },
        validatedFilter: null,
      };

      const first = await exportRepo.createOrGet({
        shopId: exportShop,
        installationId: exportInstall,
        idempotencyKey: "export:v2-key-0001",
        requestFingerprint: fp1,
        manifestFingerprint: "sha256:manifest-v2-1",
        prepared: prepared1,
      });

      assert.equal(first.created, true);
      assert.equal(first.job.state, EXPORT_STATES.QUEUED);

      const outboxRows = (await query("SELECT * FROM mirror.export_dispatch_outbox WHERE shop_id = $1 AND export_job_id = $2", [exportShop, first.job.id])).rows;
      assert.equal(outboxRows.length, 1);

      // Active read lease prevents retiring the generation
      await assert.rejects(
        () => query("UPDATE mirror.generations SET status = 'RETIRED' WHERE shop_id = $1 AND id = $2", [exportShop, exportGen]),
        { code: "23514" },
      );

      // Idempotent replay with same requestFingerprint returns created: false
      const second = await exportRepo.createOrGet({
        shopId: exportShop,
        installationId: exportInstall,
        idempotencyKey: "export:v2-key-0001",
        requestFingerprint: fp1,
        manifestFingerprint: "sha256:manifest-v2-1",
        prepared: prepared1,
      });
      assert.equal(second.created, false);
      assert.equal(second.job.id, first.job.id);

      // Reusing idempotency key with different requestFingerprint fails with EXPORT_IDEMPOTENCY_CONFLICT
      const req2 = normalizeExportRequest({ fieldIds: ["product.title"] });
      const fp2 = exportRequestFingerprint(req2);
      await assert.rejects(
        () =>
          exportRepo.createOrGet({
            shopId: exportShop,
            installationId: exportInstall,
            idempotencyKey: "export:v2-key-0001",
            requestFingerprint: fp2,
            manifestFingerprint: "sha256:manifest-v2-2",
            prepared: { ...prepared1, request: req2, requestFingerprint: fp2 },
          }),
        (err) => err.code === EXPORT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
      );

      // Trigger prevents mutating immutable manifest or fingerprint columns
      await assert.rejects(
        () => query("UPDATE mirror.export_manifest_jobs SET request_fingerprint = 'tampered' WHERE shop_id = $1 AND id = $2", [exportShop, first.job.id]),
        { code: "23514" },
      );
    });
    await testAuditSixTen({t,pool});
    await testTenantDatabase(t,pool,target);
  } finally {
    await pool.end();
  }
});
