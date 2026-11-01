/** Read-only static audit. Requires installed frontend build tooling to parse JSX. */
import {readdir,readFile,stat} from 'node:fs/promises';
import {createRequire,isBuiltin} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,resolve,relative,sep} from 'node:path';
const web=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(web,'..');
const requireParser=createRequire(resolve(web,'frontend/package.json')),{parse}=requireParser('@babel/parser');
const manifests=new Map();
for(const directory of [root,web,resolve(web,'frontend')])manifests.set(directory,JSON.parse(await readFile(resolve(directory,'package.json'),'utf8')));
const files=[];async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){
 if(['node_modules','.git','dist','.codex','.agents'].includes(entry.name))continue;
 const path=resolve(directory,entry.name);if(entry.isDirectory())await walk(path);else if(/\.(?:[cm]?js|jsx)$/.test(entry.name))files.push(path);
}}
await walk(web);
const failures=[],dynamicImports=[],counts={files:0,relativeImports:0,packageImports:0,nonliteralDynamicImports:0};
async function exactCase(path){
 let directory=web;
 const parts=relative(web,path).split(sep);if(parts.includes('..'))return true;
 for(const part of parts){if(!(await readdir(directory)).includes(part))return false;directory=resolve(directory,part);}
 return true;
}
for(const file of files){
 const frontend=file.startsWith(resolve(web,'frontend')+sep),directory=frontend?resolve(web,'frontend'):web,manifest=manifests.get(directory);
 const production=!/(?:^|[\\/])(?:scripts|tests|__tests__|test-support|integration|template-tests)(?:[\\/])|\.test\.[cm]?js$/.test(file);
 const ast=parse(await readFile(file,'utf8'),{sourceType:'unambiguous',plugins:['jsx','importAttributes'],createImportExpressions:true});counts.files++;
 const specs=[];
 function visit(node){if(!node||typeof node!=='object')return;
  if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source)specs.push(node.source.value);
  if(node.type==='ImportExpression'){
   if(node.source.type==='StringLiteral')specs.push(node.source.value);else{counts.nonliteralDynamicImports++;dynamicImports.push({file:relative(root,file),line:node.loc.start.line,production});}
  }
  if(node.type==='CallExpression'&&node.callee?.name==='require'&&node.arguments[0]?.type==='StringLiteral')specs.push(node.arguments[0].value);
  for(const [key,value] of Object.entries(node))if(!['loc','tokens','comments','extra'].includes(key)){
   if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
  }
 }
 visit(ast.program);
 for(const specifier of specs){
  if(typeof specifier!=='string')continue;
  if(specifier.startsWith('.')){
   counts.relativeImports++;const target=resolve(dirname(file),specifier.split('?')[0]);
   const candidates=frontend?[target,...['.js','.jsx','.mjs','.json','.css'].map(ext=>target+ext),resolve(target,'index.js'),resolve(target,'index.jsx')]:[target];
   const found=[];for(const path of candidates){try{if((await stat(path)).isFile())found.push(path);}catch{}}
   if(!found.length)failures.push(`${relative(root,file)}: missing ${specifier}`);
   else if(!await exactCase(found[0]))failures.push(`${relative(root,file)}: filename case mismatch in ${specifier}`);
  }else if(!specifier.startsWith('/')&&!isBuiltin(specifier)){
   counts.packageImports++;const name=specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0];
   const declared=manifest.dependencies?.[name]||(!production&&manifest.devDependencies?.[name]);
   if(!declared)failures.push(`${relative(root,file)}: ${production?'production':'test/tool'} import ${name} is undeclared`);
   try{createRequire(pathToFileURL(file)).resolve(specifier);}catch(error){failures.push(`${relative(root,file)}: cannot resolve ${specifier} (${error.code})`);}
  }
 }
}
console.log(JSON.stringify({counts,dynamicImports,failures},null,2));if(failures.length)process.exitCode=1;
