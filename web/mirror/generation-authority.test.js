import test from "node:test";
import assert from "node:assert/strict";
import { createGenerationAuthorityProvider } from "./generation-authority.server.js";
import { GenerationServiceError } from "./generation-service.server.js";

const shopId = "test-store.myshopify.com";

function createMockDbStore() {
  const store = {
    shops: new Map([
      [shopId, { id: shopId, uninstalled_at: null,installation_version:"install-1" }],
    ]),
    ingestionRuns: new Map(),
    jobCommands: new Map(),
  };

  const client = {
    async query(sql, params = []) {
      if (sql.includes("FROM mirror.shops")) {
        const s = store.shops.get(params[0]);
        if (s && s.uninstalled_at === null) {
          return { rows: [s], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("FROM mirror.ingestion_runs")) {
        // [shopId, generationId, leaseToken]
        for (const run of store.ingestionRuns.values()) {
          if (
            run.shop_id === params[0] &&
            run.generation_id === params[1] &&
            run.lease_token === params[2] &&
            new Date(run.lease_until).getTime() > Date.now()
          ) {
            return { rows: [run], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("FROM mirror.job_commands")) {
        // [shopId, leaseToken]
        for (const cmd of store.jobCommands.values()) {
          if (
            cmd.shop_id === params[0] &&
            cmd.lease_token === params[1] &&
            new Date(cmd.lease_until).getTime() > Date.now()
          ) {
            return { rows: [cmd], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  const database = {
    async connect() { return client; },
  };

  return { store, database };
}

test("generation authority: merchant session authentication resolves shopId and enforces active installation", async () => {
  const { store, database } = createMockDbStore();
  const sessions = new Map();
  sessions.set("sess-valid", {
    id: "sess-valid",
    shop: shopId,
    accessToken: "shp_valid_token",
    expires: new Date(Date.now() + 3600000),
  });
  sessions.set("sess-expired", {
    id: "sess-expired",
    shop: shopId,
    accessToken: "shp_expired_token",
    expires: new Date(Date.now() - 1000),
  });

  const sessionStorage = {
    async loadSession(id) { return sessions.get(id) || null; },
  };

  const authority = createGenerationAuthorityProvider({ sessionStorage, database });

  // Valid session authorizes verify action
  const authVerify = await authority.authorize({
    action: "verify",
    context: { sessionId: "sess-valid" },
  });
  assert.equal(authVerify.shopId, shopId);

  // Forged session object not in sessionStorage is rejected
  await assert.rejects(
    () => authority.authorize({
      action: "verify",
      context: {
        session: {
          id: "forged-id",
          shop: "victim-shop.myshopify.com",
          accessToken: "shp_fake_token",
        },
      },
    }),
    (err) => err instanceof GenerationServiceError && err.code === "PERMISSION_DENIED",
  );

  // Supplied session mismatching sessionStorage is rejected
  await assert.rejects(
    () => authority.authorize({
      action: "verify",
      context: {
        sessionId: "sess-valid",
        session: {
          id: "sess-valid",
          shop: "victim-shop.myshopify.com",
          accessToken: "shp_valid_token",
        },
      },
    }),
    (err) => err instanceof GenerationServiceError && err.code === "PERMISSION_DENIED",
  );

  // Missing session ID fails closed
  await assert.rejects(
    () => authority.authorize({ action: "verify", context: {} }),
    (err) => err instanceof GenerationServiceError && err.code === "PERMISSION_DENIED",
  );

  // Expired session fails closed
  await assert.rejects(
    () => authority.authorize({ action: "verify", context: { sessionId: "sess-expired" } }),
    (err) => err instanceof GenerationServiceError && err.code === "PERMISSION_DENIED",
  );

  // Uninstalled shop fails closed
  store.shops.get(shopId).uninstalled_at = new Date();
  await assert.rejects(
    () => authority.authorize({ action: "verify", context: { sessionId: "sess-valid" } }),
    (err) => err instanceof GenerationServiceError && err.code === "PERMISSION_DENIED",
  );
});

test("generation authority: publisher authority resolves fence from durable database ingestion lease", async () => {
  const { store, database } = createMockDbStore();
  const authority = createGenerationAuthorityProvider({ database });

  // Seed active ingestion run lease in database
  store.ingestionRuns.set("run-1", {
    shop_id: shopId,
    generation_id: "gen-1",
    lease_token: "lease-pub-123",
    lease_until: new Date(Date.now() + 60000).toISOString(),
    fence: 42n,
  });

  // Valid worker claim resolves authoritative fence from DB
  const authPub = await authority.authorize({
    action: "publish",
    context: {
      workerClaim: {
        installationVersion:'install-1',
        shopId,
        workerId: "worker-1",
        generationId: "gen-1",
        leaseToken: "lease-pub-123",
      },
    },
  });

  assert.equal(authPub.shopId, shopId);
  assert.equal(authPub.publisherFence, "42");

  // Worker claim with expired lease or invalid token fails closed
  await assert.rejects(
    () =>
      authority.authorize({
        action: "publish",
        context: {
          workerClaim: {
        installationVersion:'install-1',
            shopId,
            workerId: "worker-1",
            generationId: "gen-1",
            leaseToken: "wrong-token",
          },
        },
      }),
    (err) => err instanceof GenerationServiceError && err.code === "PERMISSION_DENIED",
  );
});

test("generation authority: cleanup authority resolves fence from durable database cleanup lease", async () => {
  const { store, database } = createMockDbStore();
  const authority = createGenerationAuthorityProvider({ database });

  // Seed active cleanup command lease
  store.jobCommands.set("cmd-1", {
    shop_id: shopId,
    lease_token: "lease-clean-456",
    lease_until: new Date(Date.now() + 60000).toISOString(),
    fence: 99n,
  });

  const authCleanup = await authority.authorize({
    action: "claimCleanup",
    context: {
      workerClaim: {
        installationVersion:'install-1',
        shopId,
        workerId: "cleaner-1",
        leaseToken: "lease-clean-456",
      },
    },
  });

  assert.equal(authCleanup.shopId, shopId);
  assert.equal(authCleanup.cleanupFence, "99");

  // Rejects unauthenticated caller
  await assert.rejects(
    () =>
      authority.authorize({
        action: "claimCleanup",
        context: {},
      }),
    (err) => err instanceof GenerationServiceError && err.code === "PERMISSION_DENIED",
  );
});

const workerActions = ['publish','claimCleanup','finishCleanup','verify','retain','release'];
const candidateClaim = {installationVersion:"install-1",shopId,workerId:'worker-1',leaseToken:'caller-token',generationId:'gen-1',fence:'999'};

test('generation authority: no worker action accepts a database-free claim, even with a fence',async()=>{
  const authority=createGenerationAuthorityProvider();
  for(const action of workerActions)for(const key of ['workerClaim','claim']){
    await assert.rejects(()=>authority.authorize({action,context:{[key]:candidateClaim}}),
      {code:'PERMISSION_DENIED'},`${action} via ${key}`);
  }
});

test('generation authority: caller fences cannot replace missing or expired durable leases',async()=>{
  const {store,database}=createMockDbStore();
  const authority=createGenerationAuthorityProvider({database});
  for(const expired of [false,true]){
    if(expired){
      const record={shop_id:shopId,generation_id:'gen-1',lease_token:'caller-token',lease_until:new Date(Date.now()-1000),fence:999n};
      store.ingestionRuns.set('expired',record);store.jobCommands.set('expired',record);
    }
    for(const action of workerActions)await assert.rejects(
      ()=>authority.authorize({action,context:{workerClaim:candidateClaim}}),{code:'PERMISSION_DENIED'},action);
  }
});

test('generation authority: all ingestion worker actions require a matching durable lease',async()=>{
  const {store,database}=createMockDbStore();
  store.ingestionRuns.set('run',{shop_id:shopId,generation_id:'gen-1',lease_token:'caller-token',lease_until:new Date(Date.now()+60000),fence:42n});
  const authority=createGenerationAuthorityProvider({database});
  for(const action of ['publish','verify','retain','release']){
    const result=await authority.authorize({action,context:{workerClaim:candidateClaim}});
    assert.equal(result.shopId,shopId);assert.equal(result.installationVersion,'install-1');assert.equal(result.publisherFence,action==='publish'?'42':undefined);
    for(const override of [{shopId:'other.myshopify.com'},{generationId:'other'},{leaseToken:'other'}])await assert.rejects(
      ()=>authority.authorize({action,context:{workerClaim:{...candidateClaim,...override}}}),{code:'PERMISSION_DENIED'});
  }
});

test('generation authority: storage failures propagate and release the connection without trusting the claim',async()=>{
  for(const action of workerActions){
    let released=0;const failure=new Error('storage unavailable');
    const database={async connect(){return {async query(){throw failure;},release(){released++;}};}};
    const authority=createGenerationAuthorityProvider({database});
    await assert.rejects(()=>authority.authorize({action,context:{workerClaim:candidateClaim}}),error=>error===failure);
    assert.equal(released,1);
    const unavailable=createGenerationAuthorityProvider({database:{async connect(){throw failure;}}});
    await assert.rejects(()=>unavailable.authorize({action,context:{workerClaim:candidateClaim}}),error=>error===failure);
  }
});
