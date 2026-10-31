import test from "node:test";
import assert from "node:assert/strict";
import {createSavedFiltersService} from "./saved-filters.server.js";
import {encodeCsvCell} from "./export.server.js";
const authContext=Object.freeze({}),ast={version:1,root:{kind:"condition",field:"product.title",operator:"eq",value:"Valid"}};
function fixture({deny=false}={}){
  const writes=[];let stored,validations=0;
  const options={database:{async query(sql,params){if(sql.startsWith("INSERT")){writes.push(params);stored={id:params[1],shop_id:params[0],name:params[2],ast_version:1,ast:params[4],fingerprint:params[5]};return {rows:[stored]};}return {rows:stored?[stored]:[]};}},
    resolveShop:async context=>{if(context!==authContext)throw Error("Unverified context");return "saved.myshopify.com";},
    compiler:{async validateFilter(value){validations++;if(deny)throw Error("Semantic authorization denied");return {ast:value};}},
    resolveDatasets:async()=>({executionContext:{generationId:"gen",coverageRevision:"rev",operationId:"saved"}})};
  return {service:createSavedFiltersService(options),options,writes,get validations(){return validations;}};
}
test("saved filters cannot omit semantic dependencies, forge a tenant or override the compiler",async()=>{
  const f=fixture();
  for(const compiler of [undefined,null,{}])assert.throws(()=>createSavedFiltersService({...f.options,compiler}));
  for(const override of [{authContext:null},{authContext:{}},{shopId:"other.myshopify.com"},{compilerOverride:{validateFilter(){}}}]){
    await assert.rejects(()=>f.service.saveFilter({authContext,name:"Recipe",ast,...override}));
  }
  await assert.rejects(()=>fixture({deny:true}).service.saveFilter({authContext,name:"Recipe",ast}),/Semantic authorization/);
  assert.equal(f.writes.length,0);
});
test("saved filters enforce byte/depth limits before persistence and revalidate every load",async()=>{
  const f=fixture();
  await assert.rejects(()=>f.service.saveFilter({authContext,name:"Recipe",ast:{...ast,root:{...ast.root,value:"x".repeat(131072)}}}));
  let root=ast.root;for(let i=0;i<40;i++)root={kind:"group",operator:"AND",children:[root]};
  await assert.rejects(()=>f.service.saveFilter({authContext,name:"Recipe",ast:{version:1,root}}));
  const saved=await f.service.saveFilter({authContext,name:"Recipe",ast});
  for(let i=0;i<2;i++)await f.service.loadAndValidateFilter({authContext,filterId:saved.id});
  assert.equal(f.validations,3);
  await assert.rejects(()=>f.service.loadAndValidateFilter({filterId:saved.id}));
  await assert.rejects(()=>f.service.loadAndValidateFilter({authContext,filterId:saved.id,compilerOverride:f.options.compiler}));
  await assert.rejects(()=>f.service.loadForExecution({systemContext:{shop:"saved.myshopify.com"},filterId:saved.id}));
});
test("system saved-filter loads require an explicit scoped execution resolver",async()=>{
  const f=fixture(),system=Object.freeze({});
  const saved=await f.service.saveFilter({authContext,name:"Recipe",ast});
  const service=createSavedFiltersService({...f.options,resolveSystemExecution:async context=>{
    if(context!==system)throw Error("Unverified system grant");return {operation:"filter",shopId:"saved.myshopify.com",authContext};
  }});
  assert.equal((await service.loadForExecution({systemContext:system,filterId:saved.id})).id,saved.id);
  await assert.rejects(()=>service.loadForExecution({systemContext:{},filterId:saved.id}));
});
test("CSV cells quote content and neutralize spreadsheet formula prefixes",()=>{
  for(const value of ["=1+1","+cmd","-1","@SUM(A1)","\t=1"," \r=1","\ufeff=1"]){assert.ok(encodeCsvCell(value).startsWith('"\''),value);}
  assert.equal(encodeCsvCell('Text "quoted", comma'),'"Text ""quoted"", comma"');
  assert.equal(encodeCsvCell(null),'""');
  assert.equal(encodeCsvCell(["one","two"]),'"[""one"",""two""]"');
});
