'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),cp=require('child_process'),crypto=require('crypto'),Database=require('/app/node_modules/better-sqlite3');
const file='/app/data/owner.sqlite',origin='https://workouts.example.com',password='synthetic-sanitization-password',marker='SYNTHETIC_PRIVATE_MARKER_783291';
const open=()=>require('/app/owner.cjs').open({file,origin,approval:'PRIVATE_STANDALONE'}),req=()=>new Request(origin,{method:'POST',headers:{Origin:origin,Authorization:'PWA','x-gymbro-client-ip':'192.0.2.9'}});
const run=(input,ops=false,inject)=>cp.spawnSync(ops?'python3':'node',ops?['/app/ops.py','recover-local']:inject?['-e',inject]:['/app/recover-local.cjs'],{input,encoding:'utf8'});
const denied=r=>{assert.notEqual(r.status,0);assert.equal(r.stdout,'');assert.equal(r.stderr,'Recovery failed\n');};
try {
let o=open(),c=o.provision(),secret=o.claim(req(),c.claimSecret,password).recoverySecret;o.close();fs.writeFileSync('/app/data/config.json',JSON.stringify({origin}),{mode:0o600});
for(const ops of [false,true])for(const input of ['{"currentPassword":"'+marker+'",','null','[]','"'+marker+'"',JSON.stringify({password:marker}),JSON.stringify({secret:marker,password:{nested:marker}}),JSON.stringify({currentPassword:marker,replacementSecret:marker,extra:marker})])denied(run(input,ops));
for(const method of ['recoverLocal','resetRecoveryLocal'])denied(run(JSON.stringify(method==='recoverLocal'?{secret,password}:{currentPassword:password,replacementSecret:crypto.randomBytes(32).toString('base64url')}),false,`const m=require('/app/owner.cjs'),old=m.open;m.open=x=>{const o=old(x);o.${method}=()=>{throw Error('${marker}')};return o};require('/app/recover-local.cjs');`));
for(const ops of [false,true])denied(run(JSON.stringify({currentPassword:marker,replacementSecret:crypto.randomBytes(32).toString('base64url')}),ops));
fs.writeFileSync('/app/data/config.json','{"origin":"'+marker+'",');for(const ops of [false,true])denied(run(JSON.stringify({secret,password}),ops));fs.writeFileSync('/app/data/config.json',JSON.stringify({origin}));
// Exercise wrapper suppression when the child operation throws sensitive text.
fs.writeFileSync('/app/data/inject.cjs',`const m=require('/app/owner.cjs'),old=m.open;m.open=x=>{const o=old(x);o.recoverLocal=()=>{throw Error('${marker}')};return o};`,{mode:0o600});
const injected=cp.spawnSync('python3',['/app/ops.py','recover-local'],{input:JSON.stringify({secret,password}),encoding:'utf8',env:{...process.env,NODE_OPTIONS:'--require=/app/data/inject.cjs'}});denied(injected);fs.unlinkSync('/app/data/inject.cjs');
// Authorized legacy capability stdout stays in memory and is never logged.
const r=run(JSON.stringify({secret,password}),true);assert.equal(r.status,0);assert.equal(r.stderr,'');const result=JSON.parse(r.stdout);assert(result.ok);assert.match(result.recoverySecret,/^[A-Za-z0-9_-]{43}$/);o=open();assert(o.recoverLocal(result.recoverySecret,password).ok);o.close();
let db=new Database(file);db.exec('DROP TABLE rate_identity');db.close();o=open();for(let i=0;i<5;i++)assert.equal(o.login(req(),'synthetic-wrong-password').ok,false);o.close();db=new Database(file);const key=db.prepare('SELECT key FROM rate_identity').get().key;db.close();
o=open();assert.equal(o.login(req(),password).status,429);const replacement=crypto.randomBytes(32).toString('base64url');assert(o.resetRecoveryLocal(password,replacement).ok);o.close();db=new Database(file);assert.equal(db.prepare('SELECT key FROM rate_identity').get().key,key);db.close();o=open();assert.equal(o.login(req(),password).status,429);for(let i=0;i<4;i++)assert(o.resetRecoveryLocal(password,replacement).ok);assert.equal(o.resetRecoveryLocal(password,replacement).status,429);o.close();o=open();assert.equal(o.resetRecoveryLocal(password,replacement).status,429);o.close();
console.log('PASS sanitized parse/structure/operation errors, private legacy success, rate migration/reopen/rotation and independent console quota');
} catch {console.error('FAIL sanitization synthetic checks (details suppressed)');process.exitCode=1;}
