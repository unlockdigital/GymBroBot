'use strict';
const fs=require('fs'),assert=require('assert/strict'),cp=require('child_process');
const origin='https://workouts.example.com',password='synthetic-password-123';
const owner=require('/app/owner.cjs').open({file:'/app/data/owner.sqlite',origin,approval:'PRIVATE_STANDALONE'});owner.provision();
fs.writeFileSync('/app/data/config.json',JSON.stringify({origin,transport:'caddy-unix'}),{mode:0o600});const Database=require('/app/node_modules/better-sqlite3');let db=new Database('/app/data/control.sqlite');db.close();fs.chmodSync('/app/data/control.sqlite',0o600);
const run=code=>cp.spawnSync('node',['-e',code],{encoding:'utf8'}),file='/app/data/agent-cli.json';
assert(run("require('/app/provision.cjs')").status);assert(!fs.existsSync(file));
// Local claim through a freshly renewed synthetic capability.
const claim=owner.renewClaim();assert(owner.claim(new Request(origin,{method:'POST',headers:{Origin:origin,'x-gymbro-client-ip':'192.0.2.1'}}),claim.claimSecret,password).ok);owner.close();
assert(run("const fs=require('fs'),read=fs.readFileSync;fs.readFileSync=(p,...a)=>p==='/pairing/root.crt'?'invalid-ca':read(p,...a);require('/app/provision.cjs');").status);assert(!fs.existsSync(file));
for(const stage of ['writeFileSync','fsyncSync','linkSync','directory']){
 const patch=stage==='directory'?"const orig=fs.fsyncSync;let calls=0;fs.fsyncSync=(fd)=>{if(++calls===2)throw Error('injected');return orig(fd);};":`fs.${stage}=()=>{throw Error('injected');};`;
 const p=run("const fs=require('fs');"+patch+"require('/app/provision.cjs');");assert(p.status,stage);assert(!fs.existsSync(file),stage);assert(!fs.readdirSync('/app/data').some(x=>x.startsWith('.agent-cli-')),stage);
 db=new Database('/app/data/control.sqlite');assert.equal(db.prepare('SELECT count(*) n FROM agent_tokens').get().n,0);db.close();
}
assert.equal(run("require('/app/provision.cjs')").status,0);const before=fs.readFileSync(file);assert.equal(fs.statSync(file).mode&0o777,0o600);assert(run("require('/app/provision.cjs')").status);assert.deepEqual(fs.readFileSync(file),before);
console.log('PASS provision unclaimed owner, write/fsync/link/directory-sync faults clean temp/file/token; successful 0600 publication; existing credential remains unchanged');
