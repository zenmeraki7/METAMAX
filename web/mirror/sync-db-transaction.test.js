import test from "node:test";
import assert from "node:assert/strict";
import { runSyncDbTransaction, SyncOutcomeUnknownError } from "./sync-db-transaction.server.js";
import { createSyncRunDbAdapter, verifySyncRunDbMapping } from "./sync-run-db-adapter.server.js";

function prismaFixture(failure) {
  let attempts=0,work=0;const calls=[];
  const tx={
    $queryRawUnsafe:async(sql,...values)=>{calls.push({method:"query",sql,values});return [{value:1}];},
    $executeRawUnsafe:async(sql,...values)=>{calls.push({method:"execute",sql,values});return 0;},
  };
  const prisma={ $queryRawUnsafe:tx.$queryRawUnsafe,async $transaction(callback,options){
    attempts++;calls.push({method:"transaction",options});
    if(failure?.before)await failure.before(attempts);
    const result=await callback(tx);
    if(failure?.after)await failure.after(attempts);
    return result;
  }};
  return {prisma,calls,attempts:()=>attempts,work:async db=>{work++;return (await db.$queryRawUnsafe("SELECT $1::integer AS value",1))[0].value;},workCount:()=>work};
}

test("Prisma uses Serializable and commands for timeout configuration before the barrier and first read",async()=>{
  const f=prismaFixture();assert.equal(await runSyncDbTransaction({prisma:f.prisma,work:f.work}),1);
  assert.deepEqual(f.calls[0].options,{isolationLevel:"Serializable",maxWait:5000,timeout:10000});
  const sql=f.calls.filter(c=>c.sql);
  assert.match(sql[0].sql,/SET LOCAL statement_timeout/);assert.equal(sql[0].method,"execute");
  assert.match(sql[1].sql,/SET LOCAL lock_timeout/);
  assert.match(sql[2].sql,/LOCK TABLE "mirror"\."publications" IN ACCESS SHARE MODE/);
  assert.equal(sql[3].method,"query");assert.deepEqual(sql[3].values,[1]);
});

test("read-only catalog transactions preserve the reader-compatible barrier",async()=>{
  const f=prismaFixture();await runSyncDbTransaction({prisma:f.prisma,work:f.work,readOnly:true});
  const sql=f.calls.filter(c=>c.sql);
  assert.equal(sql[0].sql,"SET TRANSACTION READ ONLY");
  assert.match(sql[3].sql,/ACCESS SHARE MODE/);
});

for(const error of [{code:"P2034"},{code:"40001"},{code:"P2010",meta:{code:"40P01"}},{cause:{code:"40001"}}]) {
  test(`known aborted database conflicts retry: ${JSON.stringify(error)}`,async()=>{
    const f=prismaFixture({after:async attempt=>{if(attempt===1)throw Object.assign(new Error("conflict"),error);}});
    assert.equal(await runSyncDbTransaction({prisma:f.prisma,work:f.work}),1);assert.equal(f.attempts(),2);assert.equal(f.workCount(),2);
  });
}

test("bounded retry exhaustion and non-conflict errors propagate without extra attempts",async()=>{
  const error=Object.assign(new Error("conflict"),{code:"P2034"});
  const f=prismaFixture({before:async()=>{throw error;}});
  await assert.rejects(()=>runSyncDbTransaction({prisma:f.prisma,work:f.work,maxRetries:1}),e=>e===error);assert.equal(f.attempts(),2);
  const other=prismaFixture({after:async()=>{throw Object.assign(new Error("check"),{code:"23514"});}});
  await assert.rejects(()=>runSyncDbTransaction({prisma:other.prisma,work:other.work}),{code:"23514"});assert.equal(other.attempts(),1);
});

for(const timing of ["before","after"]) {
  for(const error of [{code:"ECONNRESET"},{code:"P1017"},{code:"P2010",meta:{code:"EPIPE"}},{code:"P2034",cause:{code:"ETIMEDOUT"}}]) {
    test(`ambiguous ${timing} callback outcome never retries: ${JSON.stringify(error)}`,async()=>{
      const f=prismaFixture({[timing]:async()=>{throw Object.assign(new Error("connection"),error);}});
      await assert.rejects(()=>runSyncDbTransaction({prisma:f.prisma,work:f.work}),e=>e instanceof SyncOutcomeUnknownError&&e.outcomeUncertain===true);
      assert.equal(f.attempts(),1);assert.equal(f.workCount(),timing==="after"?1:0);
    });
  }
}

test("a nested explicitly uncertain failure is never treated as a serialization retry",async()=>{
  const error=new SyncOutcomeUnknownError("unknown");error.code="P2034";
  const f=prismaFixture({after:async()=>{throw error;}});
  await assert.rejects(()=>runSyncDbTransaction({prisma:f.prisma,work:f.work}),e=>e===error);assert.equal(f.attempts(),1);
});

test("uncertainty anywhere in a cause chain wins over a wrapper's retryable conflict code",async()=>{
  const cause=new SyncOutcomeUnknownError("Acknowledgment lost");
  const error=Object.assign(new Error("Wrapped conflict",{cause}),{code:"P2034"});
  for(const timing of ["before","after"]) {
    const f=prismaFixture({[timing]:async()=>{throw error;}});
    await assert.rejects(()=>runSyncDbTransaction({prisma:f.prisma,work:f.work}),e=>e.outcomeUncertain===true);
    assert.equal(f.attempts(),1);
  }
});

test("transaction settings reject invalid or ambiguous driver configuration",async()=>{
  await assert.rejects(()=>runSyncDbTransaction(),/one PostgreSQL/);
  const f=prismaFixture();
  for(const settings of [{database:{connect(){}},prisma:f.prisma},{maxRetries:6},{statementTimeoutMs:99},{lockTimeoutMs:NaN},{transactionTimeoutMs:30001},{readOnly:"yes"}]) {
    await assert.rejects(()=>runSyncDbTransaction({prisma:f.prisma,work:f.work,...settings}));
  }
  assert.equal(f.attempts(),0);
});

test("adapter refuses unverified physical mappings before a transaction can execute",async()=>{
  const f=prismaFixture();
  assert.throws(()=>createSyncRunDbAdapter({prisma:f.prisma,mapping:{runs:{table:"mirror.catalog_import_jobs"}}}),{code:"SYNC_SCHEMA_MISMATCH"});
  assert.equal(f.attempts(),0);
});

test("mapping accessors and unsafe identifiers are rejected before database access",async()=>{
  const f=prismaFixture();
  const bad={get runs(){assert.fail("Mapping getter invoked");}};
  await assert.rejects(()=>verifySyncRunDbMapping({prisma:f.prisma,mapping:bad}),{code:"SYNC_SCHEMA_MISMATCH"});
  assert.equal(f.attempts(),0);
});

test("a hung COMMIT is bounded, uncertain, and discards its connection without queuing rollback",{timeout:2000},async()=>{
  const commands=[];let released;
  const database={connect:async()=>({
    query:async sql=>{commands.push(sql);if(sql==="COMMIT")return new Promise(()=>{});return {rows:[],rowCount:0};},
    release:error=>{released=error;},
  })};
  await assert.rejects(()=>runSyncDbTransaction({database,transactionTimeoutMs:100,work:async()=>"done"}),error=>error.outcomeUncertain===true);
  assert.ok(commands.includes("COMMIT"));assert.equal(commands.includes("ROLLBACK"),false);assert.equal(released.code,"TRANSACTION_DEADLINE");
});

test("a hung BEGIN is bounded before any callback or COMMIT can execute",{timeout:2000},async()=>{
  const commands=[];let released,invoked=false;
  const database={connect:async()=>({
    query:async sql=>{commands.push(sql);return new Promise(()=>{});},release:error=>{released=error;},
  })};
  await assert.rejects(()=>runSyncDbTransaction({database,transactionTimeoutMs:100,work:async()=>{invoked=true;}}),{code:"TRANSACTION_DEADLINE"});
  assert.equal(invoked,false);assert.equal(commands.length,1);assert.match(commands[0],/^BEGIN/);
  assert.equal(released.code,"TRANSACTION_DEADLINE");
});

test("rollback cleanup cannot extend a failed transaction beyond its deadline",{timeout:2000},async()=>{
  let released;
  const database={connect:async()=>({
    query:async sql=>sql==="ROLLBACK"?new Promise(()=>{}):{rows:[],rowCount:0},release:error=>{released=error;},
  })};
  await assert.rejects(()=>runSyncDbTransaction({database,transactionTimeoutMs:100,work:async()=>{throw new Error("Callback failed");}}),error=>error.outcomeUncertain===true);
  assert.equal(released.code,"TRANSACTION_DEADLINE");
});
