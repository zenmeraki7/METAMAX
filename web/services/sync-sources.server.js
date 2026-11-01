import {hasCurrentProductRead} from '../middleware/product-permission.server.js';
import {FieldError,FIELD_ERROR_CODES as C} from '../fields/types.js';
import {FILTER_SQL_SCHEMA} from '../fields/sources.js';

const unsupported=Object.freeze([
  {id:'collections',name:'Collections',icon:'layers'},
  {id:'inventory',name:'Inventory Levels',icon:'box'},
  {id:'metafields',name:'Metafield Definitions',icon:'receipt'},
]);
export function createSyncSourcesService({repository,authentication}) {
  if(typeof repository?.read!=='function')throw TypeError('Protected source repository required');
  async function authorize(authContext){
    const shopId=await authentication.resolveShop(authContext),session=await authentication.resolveSession(authContext);
    if(session?.shop!==shopId||!hasCurrentProductRead(session))
      throw new FieldError(C.PERMISSION_DENIED,'Current source-read permission required');
    return shopId;
  }
  return Object.freeze({async read({authContext}){
    const shopId=await authorize(authContext);
    const row=await repository.read({authContext});
    if(!row||await authorize(authContext)!==shopId)throw new FieldError(C.PERMISSION_DENIED,'Current installation required');
      const covered=row.generation_status==='PUBLISHED'&&row.products_coverage==='COMPLETE'&&row.variants_coverage==='COMPLETE'&&
        row.mirror_schema_version===FILTER_SQL_SCHEMA.mirrorSchemaVersion&&row.source_contract_version===FILTER_SQL_SCHEMA.sourceContractVersion&&
        row.mapping_version==='mapping_v1'&&Boolean(row.imported_job_id)&&Boolean(row.published_at);
      const progress={QUEUED:'queued',RETRY:'queued',RUNNING:'running',FAILED:'failed',CANCELLED:'cancelled'};
      const status=progress[row.job_status]??(row.job_status==='SUCCEEDED'&&covered?'healthy':'unavailable');
      const timestamp=status!=='unavailable'&&covered?new Date(row.published_at).toISOString():null;
      const isUpToDate=covered&&status==='healthy';
      return {shopTimeZone:'UTC',timeZoneSource:'display-default',isUpToDate,sources:[
        {id:'products',name:'Products & Variants',icon:'bag',syncType:'automatic',supported:true,status,lastFullSyncAt:timestamp},
        ...unsupported.map(source=>({...source,syncType:'unavailable',supported:false,status:'unavailable',lastFullSyncAt:null})),
      ]};
  }});
}
