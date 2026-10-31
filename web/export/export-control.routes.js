import express from "express";
import {pipeline} from "node:stream/promises";
import {ExportContractError,exportMimeType} from "./export-contract.js";
import {FIELD_ERROR_CODES as F} from "../fields/types.js";

export function createExportControlRouter({authentication,source,repository,storage,database}={}) {
  for(const [value,key] of [[authentication,"authenticate"],[source,"resolveShop"],[source,"authorizeDownload"],
    [repository,"getJob"],[repository,"requestCancellation"],[storage,"openRegisteredArtifact"],[database,"query"]])
    if(typeof value?.[key]!=="function")throw new TypeError(`Export control dependency ${key} required`);
  const router=express.Router();
  router.use((_req,res,next)=>{res.setHeader("Cache-Control","private, no-store");next();});
  const handle=action=>async(req,res,next)=>{
    try {
      const authContext=await authentication.authenticate(req);
      if(!authContext)return res.status(401).json({error:"UNAUTHENTICATED"});
      const shop=await source.resolveShop(authContext),common={identity:{shopId:shop.id,installationId:shop.installationId},jobId:req.params.id};
      const job=await repository.getJob(common);if(!job)return res.status(404).json({error:"EXPORT_NOT_FOUND"});
      if(action==="cancel") {
        if(req.body!==undefined&&(!req.body||typeof req.body!=="object"||Array.isArray(req.body)||Object.keys(req.body).length))
          return res.status(400).json({error:"EXPORT_INVALID_REQUEST"});
        const cancelled=await repository.requestCancellation(common);
        return res.status(202).json({data:{id:job.id,state:cancelled?.state??job.state}});
      }
      if(action==="status")return res.json({data:{id:job.id,state:job.state,format:job.manifest.format,
        rowsCommitted:job.rows_committed,bytesCommitted:job.bytes_committed,attempts:job.attempts,failureCode:job.failure_code,
        downloadPath:job.state==="COMPLETED"?`/api/exports/${job.id}/download`:null}});
      if(job.state!=="COMPLETED")return res.status(409).json({error:"EXPORT_NOT_COMPLETED"});
      await source.authorizeDownload({authContext,job});
      const artifact=(await database.query(`SELECT a.* FROM export_engine.artifacts a JOIN export_engine.jobs j ON j.id=a.job_id
        WHERE a.job_id=$1 AND j.shop_id=$2 AND j.installation_id=$3 AND a.expires_at>clock_timestamp()`,[job.id,shop.id,shop.installationId])).rows[0];
      if(!artifact)return res.status(410).json({error:"EXPORT_ARTIFACT_EXPIRED"});
      const stream=await storage.openRegisteredArtifact({...common,artifact});
      res.setHeader("Content-Type",exportMimeType(artifact.format));res.setHeader("Content-Length",String(artifact.byte_count));
      const fileName=job.manifest.fileName||`products.${artifact.format.toLowerCase()}`;
      res.setHeader("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(fileName).replace(/'/g,"%27")}`);
      await pipeline(stream,res);
    }catch(error){
      if(res.headersSent)return next(error);
      if(error instanceof ExportContractError)return res.status(error.status).json(error.toJSON());
      if(error.code===F.PERMISSION_DENIED)return res.status(403).json({error:"EXPORT_UNAUTHORIZED"});
      return res.status(500).json({error:"EXPORT_EXECUTION_FAILED"});
    }
  };
  router.get("/:id",handle("status"));router.get("/:id/download",handle("download"));
  router.post("/:id/cancel",express.json({limit:"4kb",strict:true}),handle("cancel"));
  router.use((error,_req,res,next)=>{
    if(res.headersSent)return next(error);
    if(error.type==="entity.too.large"||error.type==="entity.parse.failed")return res.status(error.type==="entity.too.large"?413:400).json({error:"EXPORT_INVALID_REQUEST"});
    return next(error);
  });
  return router;
}
