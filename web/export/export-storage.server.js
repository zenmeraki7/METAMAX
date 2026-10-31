/** Private versioned S3 storage. Receipts are derived from bytes, never metadata.
 * All writes use immutable attempt namespaces and conditional create. Stale
 * attempts can only leave unregistered objects; they cannot overwrite versions.
 */
import {createHash,randomUUID} from "node:crypto";
import {createReadStream,createWriteStream} from "node:fs";
import {mkdtemp,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname,basename,resolve} from "node:path";
import {Readable} from "node:stream";
import {once} from "node:events";
import {finished} from "node:stream/promises";
import {createInterface} from "node:readline";
import {GetObjectCommand,PutObjectCommand,GetBucketVersioningCommand,GetPublicAccessBlockCommand} from "@aws-sdk/client-s3";
import ExcelJS from "exceljs";
import {parse} from "csv-parse";
import {EXPORT_LIMITS as L,EXPORT_ERROR_CODES as C,ExportContractError} from "./export-contract.js";

const fail=(message,code=C.ARTIFACT_INTEGRITY_FAILED)=>{throw new ExportContractError(code,message);};
const hash=bytes=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const MAX_PART=64*1024*1024;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const version=value=>typeof value==="string"&&value.length>0&&value!=="null";
const scalar=value=>value==null?null:value instanceof Date?value.toISOString():typeof value==="object"?JSON.stringify(value):String(value);
const safeCell=value=>{const text=value??"";return /^[\s\u0000-\u001f]*[=+\-@]/.test(text)||/^[\t\r\n]/.test(text)?`'${text}`:text;};
const csv=value=>`"${safeCell(value).replace(/"/g,'""')}"`;
export const exportPartSetHash=parts=>hash(JSON.stringify(parts.map(p=>({partNumber:p.part_number,storageKey:p.storage_key,
  storageVersion:p.storage_version,checksum:p.checksum,rowCount:String(p.row_count),byteCount:String(p.byte_count)}))));

export function createExportStorage({client,bucket,loadJob,loadParts,prefix="metamax-exports"}={}) {
  if(typeof client?.send!=="function"||typeof loadJob!=="function"||typeof loadParts!=="function"||
    typeof bucket!=="string"||!bucket||!/^[-a-zA-Z0-9_/]{1,128}$/.test(prefix)||prefix.includes(".."))throw new TypeError("Versioned private S3 client, bucket and trusted job/part loaders required");
  function namespace(identity,jobId) {
    if(typeof identity?.shopId!=="string"||!identity.shopId||typeof identity.installationId!=="string"||!identity.installationId||typeof jobId!=="string"||!uuid.test(jobId))fail("Invalid storage identity");
    const tenant=createHash("sha256").update(JSON.stringify([identity.shopId,identity.installationId])).digest("hex");
    return `${prefix}/${tenant}/${jobId}/`;
  }
  function checkKey(identity,jobId,key,kind) {
    const base=namespace(identity,jobId);
    if(typeof key!=="string"||!key.startsWith(`${base}${kind}/`)||!/^[-a-zA-Z0-9_/.]+$/.test(key)||key.includes(".."))fail("Object namespace mismatch");
  }
  async function jobFor(identity,jobId) {
    const job=await loadJob({identity,jobId});
    if(!job||job.shop_id!==identity.shopId||job.installation_id!==identity.installationId||!Array.isArray(job.manifest?.fields)||!job.manifest.fields.length)fail("Stored export manifest required");
    return job;
  }
  async function body(key,storageVersion,signal) {
    if(!version(storageVersion))fail("Immutable S3 version required");
    const response=await client.send(new GetObjectCommand({Bucket:bucket,Key:key,VersionId:storageVersion}),{abortSignal:signal});
    if(response.VersionId!==storageVersion||!response.Body)fail("S3 returned a different object version");
    return response.Body;
  }
  async function* bounded(stream,max,summary,signal) {
    const digest=createHash("sha256");let bytes=0;
    try {
      for await(const chunk of stream) {
        signal?.throwIfAborted();const buffer=Buffer.from(chunk);bytes+=buffer.length;
        if(bytes>max)fail("Stored export object exceeds budget",C.TOO_LARGE);
        digest.update(buffer);yield buffer;
      }
      Object.assign(summary,{byteCount:bytes,checksum:`sha256:${digest.digest("hex")}`});
    } finally {stream.destroy?.();}
  }
  async function* lines(stream) {
    const input=createInterface({input:stream,crlfDelay:Infinity});
    try {for await(const line of input)yield line;} finally {input.close();stream.destroy();}
  }
  async function* partRows({identity,jobId,part,summary={},signal}) {
    checkKey(identity,jobId,part.storage_key,"parts");
    const job=await jobFor(identity,jobId),stream=Readable.from(bounded(await body(part.storage_key,part.storage_version,signal),MAX_PART,summary,signal));
    let rows=0;
    try {
      for await(const line of lines(stream)) {
        let row;try{row=JSON.parse(line);}catch{fail("Malformed stored intermediate row");}
        if(!Array.isArray(row)||row.length!==job.manifest.fields.length||row.some(v=>v!==null&&typeof v!=="string"))fail("Intermediate projection mismatch");
        rows++;if(rows>L.MAX_BATCH_SIZE)fail("Intermediate row budget exceeded",C.TOO_LARGE);
        yield row;
      }
      summary.rowCount=rows;
      if(summary.checksum!==part.checksum||String(summary.byteCount)!==String(part.byte_count)||String(rows)!==String(part.row_count))fail("Stored part content differs from durable receipt");
    } finally {stream.destroy();}
  }
  async function* allRows(identity,jobId,parts,signal) {
    for(const [index,part] of parts.entries()) {
      if(part.part_number!==index)fail("Non-contiguous assembly parts");
      yield* partRows({identity,jobId,part,signal});
    }
  }
  async function verifyStoredPart({identity,jobId,partNumber,storageKey,storageVersion,checksum,rowCount,byteCount,signal}) {
    const summary={};for await(const row of partRows({identity,jobId,signal,summary,part:{part_number:partNumber,storage_key:storageKey,
      storage_version:storageVersion,checksum,row_count:rowCount,byte_count:byteCount}})){void row;}
    return {verified:true,immutable:true,rowCountVerified:true,storageKey,storageVersion,...summary};
  }
  async function upload({key,bytes,file,signal,maxBytes}) {
    const summary={};
    if(file){for await(const chunk of bounded(createReadStream(file),maxBytes,summary,signal)){void chunk;}}
    else Object.assign(summary,{checksum:hash(bytes),byteCount:bytes.length});
    if(summary.byteCount>maxBytes)fail("Export output budget exceeded",C.TOO_LARGE);
    const response=await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:file?createReadStream(file):bytes,
      ContentLength:summary.byteCount,IfNoneMatch:"*",ContentType:"application/octet-stream"}),{abortSignal:signal});
    if(!version(response.VersionId))fail("S3 versioning is required; upload returned no immutable version");
    return {storageKey:key,storageVersion:response.VersionId,...summary};
  }
  async function verifyFinalArtifact({identity,jobId,artifact,parts,partSetHash,signal}) {
    const job=await jobFor(identity,jobId),fields=job.manifest.fields.map(f=>f.id);
    checkKey(identity,jobId,artifact.storageKey,"final");
    if(artifact.format!==job.manifest.format||exportPartSetHash(parts)!==partSetHash)fail("Final assembly contract mismatch");
    const expected=allRows(identity,jobId,parts,signal)[Symbol.asyncIterator]();
    const summary={},stream=Readable.from(bounded(await body(artifact.storageKey,artifact.storageVersion,signal),L.MAX_OUTPUT_BYTES,summary,signal));
    let count=0,header=artifact.format!=="JSONL"&&job.manifest.includeHeader;
    async function compare(actual) {
      const next=header?{done:false,value:fields}:await expected.next();
      const target=header?fields:artifact.format==="CSV"?next.value?.map(safeCell):next.value?.map(v=>v??"");
      if(next.done||!Array.isArray(actual)||actual.length!==fields.length||JSON.stringify(actual)!==JSON.stringify(target))fail("Final artifact differs from ordered immutable parts");
      if(header)header=false;else count++;
    }
    try {
      if(artifact.format==="JSONL") {
        for await(const line of lines(stream)) {
          let object;try{object=JSON.parse(line);}catch{fail("Malformed JSONL artifact");}
          if(!object||Array.isArray(object)||JSON.stringify(Object.keys(object))!==JSON.stringify(fields))fail("JSONL field projection differs");
          const next=await expected.next();if(next.done||JSON.stringify(fields.map(f=>object[f]))!==JSON.stringify(next.value))fail("JSONL row differs from immutable parts");
          count++;
        }
      } else if(artifact.format==="CSV") {
        const parser=stream.pipe(parse({bom:false,relax_column_count:false,max_record_size:MAX_PART}));
        stream.on("error",error=>parser.destroy(error));
        try{for await(const row of parser)await compare(row);}finally{parser.destroy();}
      } else if(artifact.format==="XLSX") {
        let sheets=0;
        const reader=new ExcelJS.stream.xlsx.WorkbookReader(stream,{worksheets:"emit",sharedStrings:"cache",hyperlinks:"ignore",styles:"cache"});
        for await(const sheet of reader) {
          if(++sheets>1)fail("Unexpected XLSX worksheet");
          for await(const row of sheet) {
            if(row.cellCount>fields.length)fail("Unexpected XLSX columns");
            const values=Array.from({length:fields.length},(_,i)=>row.getCell(i+1).value??"");
            if(values.some(v=>typeof v!=="string"))fail("Unexpected XLSX formula or cell type");
            await compare(values);
          }
        }
        if(sheets!==1)fail("Missing XLSX worksheet");
      } else fail("Unsupported artifact format");
      if(header||!(await expected.next()).done)fail("Truncated final artifact");
      if(summary.checksum!==artifact.checksum||summary.byteCount!==artifact.byteCount||count!==artifact.rowCount)fail("Final artifact size, digest or row count differs");
      return {verified:true,immutable:true,rowCountVerified:true,storageKey:artifact.storageKey,storageVersion:artifact.storageVersion,
        format:artifact.format,...summary,rowCount:count,partSetHash,
        sourceByteCount:parts.reduce((n,p)=>n+BigInt(p.byte_count),0n).toString(),
        accountingVersion:{CSV:"csv-assembled-v1",JSONL:"jsonl-assembled-v1",XLSX:"xlsx-packaged-v1"}[artifact.format]};
    } finally {await expected.return?.();stream.destroy();}
  }
  return Object.freeze({
    verifyStoredPart,verifyFinalArtifact,
    async openRegisteredArtifact({identity,jobId,artifact,signal}) {
      await jobFor(identity,jobId);checkKey(identity,jobId,artifact.storage_key,"final");
      return body(artifact.storage_key,artifact.storage_version,signal);
    },
    async verifyConfiguration() {
      const config=await client.send(new GetBucketVersioningCommand({Bucket:bucket}));
      if(config.Status!=="Enabled")throw new TypeError("Export S3 bucket versioning must be Enabled");
      const privacy=await client.send(new GetPublicAccessBlockCommand({Bucket:bucket}));
      if(["BlockPublicAcls","IgnorePublicAcls","BlockPublicPolicy","RestrictPublicBuckets"].some(key=>privacy.PublicAccessBlockConfiguration?.[key]!==true))
        throw new TypeError("Export S3 bucket must block all public access");
    },
    async writePart({identity,jobId,claim,partNumber,rows,signal}) {
      const job=await jobFor(identity,jobId);
      if(!Array.isArray(rows)||rows.length>L.MAX_BATCH_SIZE||rows.some(r=>!Array.isArray(r)||r.length!==job.manifest.fields.length))fail("Invalid source projection");
      const bytes=Buffer.from(rows.map(r=>JSON.stringify(r.map(scalar))+"\n").join(""));
      const key=`${namespace(identity,jobId)}parts/${partNumber}-${claim.fenceEpoch}-${randomUUID()}.jsonl`;
      return {...await upload({key,bytes,signal,maxBytes:MAX_PART}),partNumber,rowCount:rows.length};
    },
    async assemble({identity,jobId,claim,signal}) {
      const job=await jobFor(identity,jobId),parts=await loadParts({identity,jobId});
      const fields=job.manifest.fields.map(f=>f.id),format=job.manifest.format;
      const directory=await mkdtemp(join(tmpdir(),"metamax-export-")),file=join(directory,"artifact");
      let rowCount=0;
      try {
        if(format==="XLSX") {
          const workbook=new ExcelJS.stream.xlsx.WorkbookWriter({filename:file,useSharedStrings:false,useStyles:false});
          const sheet=workbook.addWorksheet("Products");
          if(job.manifest.includeHeader)sheet.addRow(fields).commit();
          try{for await(const row of allRows(identity,jobId,parts,signal)){sheet.addRow(row.map(v=>v??"")).commit();if(++rowCount>L.MAX_XLSX_ROWS_PER_SHEET)fail("XLSX row budget exceeded",C.TOO_LARGE);}}
          finally{sheet.commit();await workbook.commit();}
        } else {
          const output=createWriteStream(file,{flags:"wx"}),completion=finished(output);completion.catch(()=>{});let bytes=0;
          const write=async text=>{if(output.errored)throw output.errored;bytes+=Buffer.byteLength(text);if(bytes>L.MAX_OUTPUT_BYTES)fail("Output budget exceeded",C.TOO_LARGE);if(!output.write(text))await once(output,"drain");};
          try {
            if(format==="CSV"&&job.manifest.includeHeader)await write(fields.map(csv).join(",")+"\r\n");
            for await(const row of allRows(identity,jobId,parts,signal)) {
              await write(format==="CSV"?row.map(csv).join(",")+"\r\n":JSON.stringify(Object.fromEntries(fields.map((f,i)=>[f,row[i]])))+"\n");rowCount++;
            }
            output.end();await completion;
          } finally {output.destroy();}
        }
        if((await stat(file)).size>L.MAX_OUTPUT_BYTES)fail("Final output budget exceeded",C.TOO_LARGE);
        const key=`${namespace(identity,jobId)}final/${claim.fenceEpoch}-${randomUUID()}.${format.toLowerCase()}`;
        return {...await upload({key,file,signal,maxBytes:L.MAX_OUTPUT_BYTES}),format,rowCount,partCount:parts.length,
          expiresAt:new Date(Date.now()+L.DEFAULT_ARTIFACT_RETENTION_MS).toISOString()};
      } finally {
        const target=resolve(directory);
        if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith("metamax-export-"))throw new Error("Unsafe export staging cleanup path");
        await rm(target,{recursive:true,force:true});
      }
    },
    async verifyRecoveryEvidence({identity,job,parts,partSetHash,checkpointVersion,checkpointHash}) {
      const current=await jobFor(identity,job.id);
      if(current.state!=="RECOVERING"||current.fence_epoch!==job.fence_epoch||exportPartSetHash(parts)!==partSetHash)fail("Recovery ownership changed");
      // Late uploads from an old fence are immutable and use a disjoint key.
      // They cannot become committed parts or the registered final artifact.
      return {verified:true,safeToResume:true,artifactStatus:"FENCED_UNREGISTERED",fencedNamespaceVerified:true,
        fenceEpoch:job.fence_epoch,partSetHash,checkpointVersion,checkpointHash};
    },
  });
}
