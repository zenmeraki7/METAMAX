/** Active export_engine control DTO. Manifest compatibility storage is rejected. */
export function createExportControlAdapter(repository){
 if(repository?.storageContract!=='export_engine.v2'||typeof repository.getJob!=='function'||typeof repository.requestCancellation!=='function')
  throw TypeError('Active export_engine lifecycle repository required');
 const dto=row=>row?Object.freeze({id:row.id,shopId:row.shop_id,installationId:row.installation_id,state:row.state,manifest:row.manifest,
  rowsCommitted:String(row.rows_committed??0),bytesCommitted:String(row.bytes_committed??0),attempts:Number(row.attempts),failureCode:row.failure_code??null}):null;
 return Object.freeze({getJob:async input=>dto(await repository.getJob(input)),requestCancellation:async input=>dto(await repository.requestCancellation(input))});
}
