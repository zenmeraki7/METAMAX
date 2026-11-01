import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';

test('tenant modules cannot import the process pool or migration credentials',async()=>{
  const roots=['services','mirror','fields','filters','export','edit-history','workers'];
  async function inspect(directory){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      if(entry.isDirectory()){
        if(!['integration','tests','__tests__','test-support'].includes(entry.name))await inspect(new URL(entry.name+'/',directory));
      }else if(/\.(?:js|mjs)$/.test(entry.name)&&!entry.name.endsWith('.test.js')){
        const file=new URL(entry.name,directory),source=await readFile(file,'utf8');
        assert.doesNotMatch(source,/from\s*['"][^'"]*(?:db\/postgres|migration-environment\.server)/,file.pathname);
        assert.doesNotMatch(source,/(?:from\s*['"]pg['"]|import\(['"]pg['"]\)|new\s+pg\.Pool)/,file.pathname);
      }
    }
  }
  for(const name of roots)await inspect(new URL('../'+name+'/',import.meta.url));
  const privacy=await readFile(new URL('../privacy.js',import.meta.url),'utf8');
  assert.doesNotMatch(privacy,/from\s*['"][^'"]*db\/postgres/);
});
test('bulk business entry points expose fixed gateway methods rather than SQL or pools',async()=>{
 for(const path of ['workers/operation.worker.js','workers/operation-finalization.server.js','workers/operation-recovery-scanner.server.js','workers/operation-outcome.server.js','services/job-dispatch.server.js']){
  const source=await readFile(new URL('../'+path,import.meta.url),'utf8');assert.doesNotMatch(source,/\.query\(|\.connect\(/,path);assert.match(source,/security\//);
 }
});

test('catalog transaction modes account for retention writes',async()=>{
  const {TENANT_OPERATIONS}=await import('../security/tenant-policy.server.js');
  const modes=new Map(TENANT_OPERATIONS.map(item=>[item.operation,item.mode]));
  assert.equal(modes.get('filter'),'WRITE');assert.equal(modes.get('catalog'),'WRITE');
  assert.equal(modes.get('sync_sources.read'),'READ');assert.equal(modes.get('preview'),'WRITE');
});
