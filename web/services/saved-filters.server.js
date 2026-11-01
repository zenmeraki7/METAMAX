/** Saved recipes are revalidated input, never persisted authorization grants. */
import {randomUUID,createHash} from "node:crypto";
import {FieldError,FIELD_ERROR_CODES as C} from "../fields/types.js";
import {parseFilterAst} from "../filters/ast.js";
import {fingerprintFilterAst} from '../filters/fingerprint.js';
const fail=(code,message)=>{throw new FieldError(code,message);};
export function createSavedFiltersService({database,compiler,resolveShop,resolveDatasets,resolveSystemExecution}={}) {
  if(typeof database?.query!=="function"||typeof compiler?.validateFilter!=="function"||typeof resolveShop!=="function"||typeof resolveDatasets!=="function")throw new TypeError("Saved filters require trusted semantic validation, shop authentication and published context");
  async function identity(authContext,unsupported) {
    if(!authContext||Object.keys(unsupported).length)fail(C.PERMISSION_DENIED,"Authenticated saved-filter context required; overrides are not accepted");
    const shopId=await resolveShop(authContext);
    if(typeof shopId!=="string"||shopId.trim()!==shopId||shopId.length>255||!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopId))fail(C.PERMISSION_DENIED,"Authenticated saved-filter shop required");
    return shopId;
  }
  async function validate(ast,authContext,shopId) {
    const parsed=parseFilterAst(ast);
    const context=await resolveDatasets({authContext});
    const validated=await compiler.validateFilter(parsed,{authContext,operation:"filter",executionContext:context.executionContext});
    if(!validated||await resolveShop(authContext)!==shopId)fail(C.PERMISSION_DENIED,"Saved-filter authorization changed");
    return {parsed,validated};
  }
  async function load({authContext,filterId,...unsupported}={}) {
    const shopId=await identity(authContext,unsupported);
    if(typeof filterId!=="string"||!filterId||filterId.length>128)fail(C.INVALID_VALUE,"Saved filter ID required");
    const record=(await database.query(`SELECT id,shop_id,name,ast_version,ast,fingerprint FROM mirror.saved_filters WHERE shop_id = $1 AND id = $2`,[shopId,filterId])).rows[0];
    if(!record)fail(C.INVALID_VALUE,"Saved filter not found");
    if(record.ast_version!==1||record.shop_id!==shopId)fail(C.CONTRACT_MISMATCH,"Unsupported saved filter version or shop");
    const {parsed,validated}=await validate(typeof record.ast==="string"?JSON.parse(record.ast):record.ast,authContext,shopId);
    const canonicalFingerprint=fingerprintFilterAst(parsed),legacy=createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
    if(record.fingerprint!==canonicalFingerprint&&record.fingerprint!==legacy)fail(C.CONTRACT_MISMATCH,'Saved filter integrity mismatch');
    return Object.freeze({id:record.id,name:record.name,astVersion:1,ast:parsed,fingerprint:canonicalFingerprint,fingerprintKind:'FILTER_AST',validated});
  }
  return Object.freeze({
    async saveFilter({authContext,name,ast,astVersion=1,...unsupported}={}) {
      const shopId=await identity(authContext,unsupported);
      if(typeof name!=="string"||!name.trim()||name.length>120||astVersion!==1)fail(C.INVALID_VALUE,"Bounded saved filter name and version required");
      const parsed=parseFilterAst(ast);
      if(Buffer.byteLength(JSON.stringify({name,ast:parsed,astVersion}))>131072)fail(C.INVALID_VALUE,"Saved filter request exceeds byte budget");
      await validate(parsed,authContext,shopId);
      const fingerprint=fingerprintFilterAst(parsed);
      return (await database.query(`INSERT INTO mirror.saved_filters(shop_id,id,name,ast_version,ast,fingerprint,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) RETURNING id,shop_id,name,ast_version,fingerprint,updated_at`,
      [shopId,randomUUID(),name.trim(),1,JSON.stringify(parsed),fingerprint])).rows[0];
    },
    loadAndValidateFilter:load,
    async loadForExecution({systemContext,filterId,...unsupported}={}) {
      if(!systemContext||Object.keys(unsupported).length||typeof resolveSystemExecution!=="function")fail(C.PERMISSION_DENIED,"Explicit system execution authorization required");
      const execution=await resolveSystemExecution(systemContext,{operation:"filter",filterId});
      if(!execution||execution.operation!=="filter"||!execution.authContext||await resolveShop(execution.authContext)!==execution.shopId)fail(C.PERMISSION_DENIED,"System execution scope mismatch");
      return load({authContext:execution.authContext,filterId});
    },
    async listFilters({authContext,limit=100,after="",...unsupported}={}) {
      const shopId=await identity(authContext,unsupported);
      if(!Number.isSafeInteger(limit)||limit<1||limit>100||typeof after!=="string"||after.length>128)fail(C.INVALID_VALUE,"Bounded saved filter page required");
      return (await database.query("SELECT id,name,ast_version,fingerprint,updated_at FROM mirror.saved_filters WHERE shop_id=$1 AND id>$2 ORDER BY id LIMIT $3",[shopId,after,limit])).rows;
    },
    async deleteFilter({authContext,filterId,...unsupported}={}) {
      const shopId=await identity(authContext,unsupported);
      if(typeof filterId!=="string"||!filterId||filterId.length>128)fail(C.INVALID_VALUE,"Saved filter ID required");
      return (await database.query("DELETE FROM mirror.saved_filters WHERE shop_id=$1 AND id=$2",[shopId,filterId])).rowCount===1;
    },
  });
}
