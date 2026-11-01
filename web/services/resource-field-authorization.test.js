import {createInstallationResolver} from '../security/installation-lifecycle.server.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFieldService} from '../fields/resolve.js';
import {createFieldAuthorizationService} from './field-authorization.server.js';
const shopId='writer.myshopify.com',authContext={};
test('installed variant writers resolve through real field policy and current merchant authorization',async()=>{
 let scopes='read_products,write_products';
 const authorization=createFieldAuthorizationService({resolveTenant:async()=>createInstallationResolver({readInstallation:async()=>({installation_version:'install-1'})})(shopId),database:{async query(){return {rows:[{id:shopId,uninstalled_at:null}]};}},resolveShop:async context=>context===authContext?shopId:null,getShopScopes:async()=>scopes});
 const service=createFieldService({adapter:{resolveOne(){},resolveBatch(){}},resolveShop:async()=>shopId,authorizeAccess:authorization.authorizeAccess,
  verifyCoverage:async()=>({ready:true,generationId:'generation',coverageRevision:'coverage'})});
 const input={authContext,fieldIds:['variant.price','variant.inventoryPolicy'],access:'write',operation:'bulk_edit',executionContext:{operationId:'operation',generationId:'generation',phase:'preview'}};
 assert.equal((await service.requireFields(input)).fields.length,2);
 scopes='read_products';await assert.rejects(()=>service.requireFields(input),{code:'FIELD_PERMISSION_DENIED'});
 scopes='read_products,write_products';await assert.rejects(()=>service.requireFields({...input,fieldIds:['inventoryItem.unitCost']}));
});
