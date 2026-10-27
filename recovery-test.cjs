'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process'),http=require('node:http'),crypto=require('node:crypto');
const origin='https://workouts.example.com',file='/app/data/owner.sqlite',password='synthetic-password-recovery-123',nextPassword='synthetic-new-password-456';let time=100000,owner;
const open=()=>require('/app/owner.cjs').open({file,origin,now:()=>time,approval:'PRIVATE_STANDALONE'});
const req=(cookie,extra={})=>new Request(origin+'/auth/reset-recovery',{method:'POST',headers:{Origin:origin,Authorization:'PWA','x-gymbro-client-ip':'192.0.2.1',...(cookie?{Cookie:cookie}:{}),...extra}});
const restart=()=>{owner.close();owner=open();};
(async()=>{
owner=open();const claim=owner.provision();owner.claim(req(),claim.claimSecret,password); // discard committed claim response
restart();let login=owner.login(req(),password);assert(login.ok);let cookie=login.cookie.split(';')[0];
const epoch=owner.epoch();assert.equal(owner.resetRecovery(req(), 'incorrect-password-123').ok,false);assert.equal(owner.epoch(),epoch);
for(const headers of [{Origin:'https://other.example'},{Authorization:'agent'},{'sec-fetch-site':'cross-site'}])assert.equal(owner.resetRecovery(req(cookie,headers),password).ok,false);
let replacement=owner.resetRecovery(req(cookie),password);assert(replacement.ok);assert.equal(owner.authenticate(req(cookie)).ok,false);
// Real connection reset after the transaction committed; response never reaches client.
time+=60001;
const server=http.createServer((r,s)=>{owner.resetRecovery(req(),password);s.destroy();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
await new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:server.address().port},()=>reject(Error('Unexpected response'))).on('error',resolve);});await new Promise(resolve=>server.close(resolve));
restart();replacement=owner.resetRecovery(req(cookie),password);assert(replacement.ok); // stale cookie plus correct password reauth
assert.equal(owner.recover(req(),replacement.recoverySecret,nextPassword).ok,true); // discard recovery response
restart();assert.equal(owner.resetRecovery(req(),password).ok,false);replacement=owner.resetRecovery(req(),nextPassword);assert(replacement.ok);
assert.equal(owner.recover(req(),replacement.recoverySecret,nextPassword).ok,true);
assert.equal(owner.recover(req(),replacement.recoverySecret,nextPassword).ok,false); // replay
// Quota persists across reopen and does not mutate epoch on rejection.
time+=60001;for(let i=0;i<5;i++)owner.resetRecovery(req(),'incorrect-password-123');const before=owner.epoch();restart();assert.equal(owner.resetRecovery(req(),nextPassword).status,429);assert.equal(owner.epoch(),before);
owner.close();fs.writeFileSync('/app/data/config.json',JSON.stringify({origin}),{mode:0o600});
const replacementSecret=crypto.randomBytes(32).toString('base64url');
const input=JSON.stringify({currentPassword:nextPassword,replacementSecret});
// Commit succeeds, stdout raises: caller already retains replacement, retry remains safe.
const injected="process.stdout.write=()=>{throw Error('synthetic output loss')};require('/app/recover-local.cjs');";
const failed=cp.spawnSync('node',['-e',injected],{input,encoding:'utf8'});assert.notEqual(failed.status,0);assert(!failed.stdout.includes(replacementSecret));assert(!failed.stderr.includes(replacementSecret));
const retry=cp.spawnSync('python3',['/app/ops.py','recover-local'],{input,encoding:'utf8'});assert.equal(retry.status,0);assert.deepEqual(JSON.parse(retry.stdout),{ok:true});
const bad=cp.spawnSync('python3',['/app/ops.py','recover-local'],{input:JSON.stringify({currentPassword:'incorrect-password-123',replacementSecret}),encoding:'utf8'});assert.notEqual(bad.status,0);assert(!bad.stderr.includes(replacementSecret));
owner=open();assert(owner.recover(req(),replacementSecret,password).ok);owner.close();
const db=new(require('/app/node_modules/better-sqlite3'))(file);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');const row=db.prepare('SELECT * FROM lifecycle').get();assert.equal(row.claim,null);assert(!JSON.stringify(row).includes(password));assert(!JSON.stringify(row).includes(replacementSecret));db.close();
console.log('PASS lost claim/recovery response, real socket loss after commit, restart/retry, password proof, CSRF/origin/PWA, stale cookie reauthentication, quota persistence, rotation/replay, console stdout fault/retry, DB integrity and secret-output checks');
})().catch(e=>{console.error((e.stack||'').split('\n').filter(x=>x.includes('/test.cjs:')).join('\n'));console.error('FAIL recovery synthetic test (details suppressed to protect secrets)');process.exitCode=1;});
