'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const base=__dirname, root=path.resolve(base,'../..');
const ts=require('typescript');
const manifest=require('./manifest.json');
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
function read(file,hash){assert(!fs.lstatSync(file).isSymbolicLink(),'Symlink denied');const s=fs.readFileSync(file,'utf8');assert.equal(digest(s),hash,`Source drift: ${file}`);return s;}
function evaluate(source,imports,Clock){
 const exports={};const result=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
 vm.runInNewContext(result.outputText,{exports,Date:Clock,console:{error(){},warn(){}},require(name){assert(Object.hasOwn(imports,name),`Import denied: ${name}`);return imports[name];}},{timeout:1000});return exports;
}
function createRoutes({mode,integrations,Clock}){
 assert(['baseline','candidate'].includes(mode));assert(Clock,'Explicit clock required');
 const contracts={'@/lib/gymbro-write-db':['getWriteDb','nowIso'],'@/lib/miniapp-events':['recordSystemEvent'],'@/lib/miniapp-auth':['requireAuth','resolveOwner','miniappOk','miniappFail','miniappAuthFail','miniappOwnerMissing','miniappPreflight']};
 assert.deepEqual(Object.keys(integrations).sort(),Object.keys(contracts).sort());
 for(const [key,names]of Object.entries(contracts))for(const name of names)assert.equal(typeof integrations[key][name],'function',`Missing ${name}`);
 const imports={...integrations},routes={};
 for(const entry of manifest.entries.filter(e=>e.selection==='leaf helper'))imports['@/lib/'+entry.key]=evaluate(read(path.join(mode==='baseline'?root:base,mode==='baseline'?entry.source:entry.destination),entry.sha256),{},Clock);
 for(const entry of manifest.entries.filter(e=>e.selection==='route'))routes[entry.key]=evaluate(read(path.join(mode==='baseline'?root:base,mode==='baseline'?entry.source:entry.destination),entry.sha256),imports,Clock);
 return routes;
}
module.exports={createRoutes,evaluate,read,manifest,root};
