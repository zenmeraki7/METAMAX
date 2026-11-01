/** Durable immutable range download; no remote prefix is replayed between steps. */
import {createHash} from 'node:crypto';
import {openBulkExport} from './shopify-catalog-source.server.js';
import {invalid} from './transactions.server.js';
const proofs=new WeakMap(),size=1024*1024;
const hash=value=>createHash('sha256').update(value).digest('hex');
export function stagedResume(lines,scope){
 const proof=proofs.get(lines);if(!proof)return null;
 if(proof.shopId!==scope.shopId||proof.generationId!==scope.generationId||String(proof.runId)!==String(scope.runId))invalid('Staged source identity changed');
 return proof;
}
export async function stageCatalogExport({op,claim,runId,owned,fetchImpl=fetch,signal}){
 if(op.status!=='COMPLETED'||!/^gid:\/\/shopify\/BulkOperation\/[1-9][0-9]*$/.test(op.id)||!(/^(0|[1-9][0-9]*)$/).test(String(op.objectCount)))invalid('Owned completed export required');
 const scoped=work=>owned(async c=>{await c.query("SELECT set_config('app.shop_id',$1,true)",[claim.shopId]);return work(c);});
 const identity=hash(String(op.url??''));
 let state=await scoped(async c=>(await c.query('SELECT * FROM mirror.catalog_downloads WHERE shop_id=$1 AND run_id=$2',[claim.shopId,runId])).rows[0]);
 if(!state){
  const run=await scoped(async c=>(await c.query('SELECT r.processed_lines FROM mirror.ingestion_runs r WHERE r.shop_id=$1 AND r.id=$2 AND r.generation_id=$3',[claim.shopId,runId,claim.generationId])).rows[0]);
  if(!run||BigInt(run.processed_lines)!==0n)invalid('Existing ingestion checkpoint has no verified staged source; restart import');
 }
 for(let step=0;!state?.complete&&step<5;step++){
  signal?.throwIfAborted();const start=Number(state?.next_byte??0);
  if(state&&(state.operation_id!==op.id||state.url_hash!==identity))invalid('Staged export identity changed');
  const empty=String(op.objectCount)==='0'&&op.url==null;
  const response=empty?null:await openBulkExport(op,{fetchImpl,signal,returnResponse:true,
   headers:{'Accept-Encoding':'identity',Range:`bytes=${start}-${start+size-1}`,...(state?{'If-Match':state.etag}:{})}});
  const etag=empty?'"empty"':response.headers.get('etag');
  const range=empty?['',String(start),'0','0']:/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')??'');
  if(!empty&&(response.status!==206||!range||Number(range[1])!==start||!etag||!/^"[^"\r\n]+"$/.test(etag)))invalid('Immutable ranged export required');
  const total=Number(range[3]),end=Number(range[2]);
  if(!Number.isSafeInteger(total)||total>2147483647||!empty&&(end<start||end>=total||end-start+1>size))invalid('Bounded export range required');
  if(state&&(state.etag!==etag||Number(state.total_bytes)!==total))invalid('Export changed during staging');
  const chunks=[];let bytes=0;
  if(response)for await(const chunk of response.body){signal?.throwIfAborted();const part=Buffer.from(chunk);bytes+=part.length;if(bytes>size)invalid('Export range exceeds budget');chunks.push(part);}
  if(!empty&&bytes!==end-start+1)invalid('Truncated export range');
  const body=Buffer.concat(chunks),buffer=Buffer.concat([state?.pending??Buffer.alloc(0),body]);
  const lines=[],decoder=new TextDecoder('utf-8',{fatal:true});let cursor=0;
  for(let i=0;i<buffer.length;i++)if(buffer[i]===10){let line=buffer.subarray(cursor,i);if(line.at(-1)===13)line=line.subarray(0,line.length-1);if(line.length>size)invalid('Bounded staged line required');if(line.length)lines.push(decoder.decode(line));cursor=i+1;}
  const complete=empty||end+1===total;let pending=buffer.subarray(cursor);
  if(pending.length>size)invalid('Bounded staged line required');
  if(complete&&pending.length){lines.push(decoder.decode(pending));pending=Buffer.alloc(0);}
  const lineStart=BigInt(state?.line_count??0),lineCount=lineStart+BigInt(lines.length);
  if(lineCount>BigInt(op.objectCount)||complete&&lineCount!==BigInt(op.objectCount))invalid('Staged export record count mismatch');
  const expectedStart=start;
  state=await scoped(async c=>{
   await c.query(`INSERT INTO mirror.catalog_downloads(shop_id,run_id,generation_id,operation_id,url_hash,etag,total_bytes)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[claim.shopId,runId,claim.generationId,op.id,identity,etag,total]);
   const current=(await c.query('SELECT * FROM mirror.catalog_downloads WHERE shop_id=$1 AND run_id=$2 FOR UPDATE',[claim.shopId,runId])).rows[0];
   if(current.operation_id!==op.id||current.url_hash!==identity||current.etag!==etag||Number(current.next_byte)!==expectedStart)invalid('Staged download checkpoint changed');
   if(bytes)await c.query(`INSERT INTO mirror.catalog_download_chunks(shop_id,run_id,byte_start,byte_end,line_start,line_count,lines,checksum,source_checksum)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,[claim.shopId,runId,start,end,lineStart.toString(),lines.length,JSON.stringify(lines),hash(JSON.stringify(lines)),hash(body)]);
   return (await c.query(`UPDATE mirror.catalog_downloads SET next_byte=$3,line_count=$4,pending=$5,complete=$6 WHERE shop_id=$1 AND run_id=$2 RETURNING *`,
    [claim.shopId,runId,empty?0:end+1,lineCount.toString(),pending,complete])).rows[0];
  });
 }
 if(!state.complete)return {complete:false};
 if(state.operation_id!==op.id||state.url_hash!==identity||BigInt(state.line_count)!==BigInt(op.objectCount))invalid('Completed staged export identity mismatch');
 const progress=await scoped(async c=>(await c.query(`SELECT r.processed_lines,COALESCE((SELECT max(ordinal)+1 FROM mirror.ingestion_chunks WHERE shop_id=r.shop_id AND run_id=r.id),0) AS ordinal
  FROM mirror.ingestion_runs r WHERE r.shop_id=$1 AND r.id=$2 AND r.generation_id=$3`,[claim.shopId,runId,claim.generationId])).rows[0]);
 if(!progress)invalid('Owned staged ingestion run required');
 const offset=BigInt(progress.processed_lines);if(offset>BigInt(state.line_count))invalid('Staged checkpoint exceeds EOF');
 const lines={async *[Symbol.asyncIterator](){let next=offset;
  while(next<BigInt(state.line_count)){
   const chunk=await scoped(async c=>(await c.query(`SELECT * FROM mirror.catalog_download_chunks WHERE shop_id=$1 AND run_id=$2 AND line_start<=$3 AND line_start+line_count>$3 ORDER BY line_start DESC LIMIT 1`,[claim.shopId,runId,next.toString()])).rows[0]);
   if(!chunk||hash(JSON.stringify(chunk.lines))!==chunk.checksum||chunk.lines.length!==chunk.line_count)invalid('Staged input checksum mismatch');
   const skip=Number(next-BigInt(chunk.line_start));for(const line of chunk.lines.slice(skip)){signal?.throwIfAborted();yield line;next++;}
  }
 }};
 proofs.set(lines,Object.freeze({shopId:claim.shopId,generationId:claim.generationId,runId,processedLines:offset,ordinal:Number(progress.ordinal)}));
 return {complete:true,lines};
}
