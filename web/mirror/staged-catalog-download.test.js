import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {stageCatalogExport} from './staged-catalog-download.server.js';
import {createJsonlIngestionService} from './jsonl-ingestion.server.js';
function fixture(lines){
 const claim={shopId:'staged.myshopify.com',generationId:'generation'},runId='1',op={id:'gid://shopify/BulkOperation/1',status:'COMPLETED',url:'https://storage.googleapis.com/immutable',objectCount:String(lines.length)};
 const raw=Buffer.from(lines.join('\n')+'\n');const state={download:null,chunks:[],processed:0n,ingested:[],fetches:[],etag:'"export-1"'};
 const rows=value=>({rows:value,rowCount:value.length});
 const query=async(sql,p=[])=>{
  if(sql.includes('INSERT INTO mirror.catalog_downloads')){state.download??={shop_id:p[0],run_id:p[1],generation_id:p[2],operation_id:p[3],url_hash:p[4],etag:p[5],total_bytes:p[6],next_byte:0,line_count:'0',pending:Buffer.alloc(0),complete:false};return rows([]);}
  if(sql.includes('SELECT * FROM mirror.catalog_downloads'))return rows(state.download?[{...state.download}]:[]);
  if(sql.includes('INSERT INTO mirror.catalog_download_chunks')){state.chunks.push({byte_start:p[2],byte_end:p[3],line_start:p[4],line_count:p[5],lines:JSON.parse(p[6]),checksum:p[7]});return rows([]);}
  if(sql.includes('UPDATE mirror.catalog_downloads')){Object.assign(state.download,{next_byte:p[2],line_count:p[3],pending:p[4],complete:p[5]});return rows([{...state.download}]);}
  if(sql.includes('SELECT r.processed_lines'))return rows([{processed_lines:state.processed.toString(),ordinal:state.ingested.length}]);
  if(sql.includes('SELECT * FROM mirror.catalog_download_chunks'))return rows(state.chunks.filter(c=>BigInt(c.line_start)<=BigInt(p[2])&&BigInt(c.line_start)+BigInt(c.line_count)>BigInt(p[2])).slice(-1));
  if(sql.includes('SELECT ordinal,checksum'))return rows(state.ingested.filter(c=>c.ordinal>=p[2]&&c.ordinal<p[3]));
  if(sql.includes('SELECT pg_catalog.pg_advisory')||sql.includes('SELECT set_config')||/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|LOCK TABLE)/.test(sql))return rows([]);
  throw Error(sql);
 };
 const database={query,async connect(){return {query,release(){}};}};
 const fetchImpl=async(url,{headers})=>{
  state.fetches.push({url,headers});const start=Number(/^bytes=(\d+)-/.exec(headers.Range)[1]),end=Math.min(start+1048575,raw.length-1);
  return {ok:true,status:206,headers:new Headers({etag:state.etag,'content-range':`bytes ${start}-${end}/${raw.length}`}),body:Readable.from([raw.subarray(start,end+1)])};
 };
 const stage=()=>stageCatalogExport({op,claim,runId,owned:work=>work({query}),fetchImpl});
 let eof=false;
 const ingestion=createJsonlIngestionService({database,bulkSyncService:{getStatus:async()=>op},syncRunService:{
  getSyncRun:async()=>({generationId:claim.generationId,fence:1n,status:'RUNNING',bulkOperationId:op.id,leaseToken:'worker',processedLines:state.processed}),
  renewRunLease:async()=>{},completeIngestionRun:async({processedLines,eofVerified})=>{assert.equal(processedLines,BigInt(lines.length));assert.equal(eofVerified,true);eof=true;},transitionGenerationToReconciling:async()=>{}
 },ingestionWriter:{writeStagingBatch:async({records,ordinal})=>{
  const count=records.reduce((n,p)=>n+1+p.variants.length,0);state.processed+=BigInt(count);
  state.ingested.push({ordinal,checksum:createHash('sha256').update(JSON.stringify(records)).digest('hex'),line_count:String(count)});
 }}});
 return {state,stage,op,claim,ingest:lines=>ingestion.ingestJsonlLines({...claim,runId,fence:1n,lines,batchSize:100,maxNewChunks:5}),eof:()=>eof};
}
test('1200 product families resume from durable staging without replaying committed JSONL prefixes',async()=>{
 const lines=Array.from({length:1200},(_,i)=>[JSON.stringify({id:`gid://shopify/Product/${i+1}`,title:'Product',handle:`p-${i+1}`}),JSON.stringify({id:`gid://shopify/ProductVariant/${i+1}`,__parentId:`gid://shopify/Product/${i+1}`,title:'Variant',price:'1.00'})]).flat();
 const f=fixture(lines);let reads=0,passes=0,receipt;
 do{const source=await f.stage();assert.equal(source.complete,true);const original=source.lines[Symbol.asyncIterator].bind(source.lines);
  source.lines[Symbol.asyncIterator]=async function*(){for await(const line of {[Symbol.asyncIterator]:original}){reads++;yield line;}};
  receipt=await f.ingest(source.lines);passes++;
 }while(!receipt.succeeded&&passes<5);
 assert.equal(receipt.succeeded,true);assert.equal(passes,3);assert.ok(reads<=2404,`read ${reads} lines`);
 assert.equal(f.state.fetches.length,1);assert.equal(f.state.processed,2400n);assert.equal(f.eof(),true);
});
test('staged source corruption and changed operation identity are rejected before resume',async()=>{
 const f=fixture([JSON.stringify({id:'gid://shopify/Product/1',title:'One',handle:'one'})]);await f.stage();
 f.state.chunks[0].lines[0]='tampered';const next=await f.stage();await assert.rejects(()=>f.ingest(next.lines),/checksum/);
 f.op.id='gid://shopify/BulkOperation/2';await assert.rejects(()=>f.stage(),/identity/);
});


test('download steps bound new bytes, pin If-Match identity, and resume after process restart',async()=>{
 const f=fixture(Array.from({length:8},()=> 'x'.repeat(800000)));
 assert.equal((await f.stage()).complete,false);assert.equal(f.state.fetches.length,5);
 const offset=f.state.download.next_byte;assert.equal(offset,5*1048576);
 f.state.etag='"changed"';await assert.rejects(()=>f.stage(),/changed/);
 assert.equal(f.state.download.next_byte,offset);assert.equal(f.state.fetches.at(-1).headers['If-Match'],'"export-1"');
 f.state.etag='"export-1"';const source=await f.stage();assert.equal(source.complete,true);
 assert.equal(f.state.fetches.at(-2).headers.Range,`bytes=${offset}-${offset+1048575}`);
 const restored=[];for await(const line of source.lines)restored.push(line);assert.equal(restored.length,8);
});
test('old checkpoints without an immutable staged source require a fresh import',async()=>{
 const f=fixture(['one']);f.state.processed=1n;await assert.rejects(()=>f.stage(),/restart import/);assert.equal(f.state.fetches.length,0);
});
