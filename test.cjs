'use strict';
const fs=require('fs'),http=require('http'),https=require('https'),assert=require('assert/strict'),{execFileSync}=require('child_process');
const credential='/app/data/agent-cli.json',origin='https://workouts.example.com';
const app=(ep,b,cookie)=>new Promise((resolve,reject)=>{const r=http.request({socketPath:'/run/gymbro/app.sock',path:ep,method:b?'POST':'GET',headers:{Host:'workouts.example.com','X-Gymbro-Client-IP':'192.0.2.10','X-Forwarded-Proto':'https',Origin:origin,...(cookie?{Cookie:cookie,Authorization:'PWA'}:{}),'Content-Type':'application/json'}},res=>{let x='';res.on('data',b=>x+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(x),headers:res.headers}));});r.on('error',reject);r.end(b?JSON.stringify(b):undefined);});
const cli=(cmd,b,key)=>JSON.parse(execFileSync('node',['/app/cli.cjs',cmd,...(key?[key]:[])],{input:b?JSON.stringify(b):undefined,encoding:'utf8'}));
(async()=>{
 if(process.argv[2]==='enroll'){
 const secret=fs.readFileSync(0,'utf8').trim();assert((await app('/auth/claim',{secret,password:'synthetic-password-123'})).body.ok);
 assert.equal((await app('/auth/reset-recovery',{password:'synthetic-password-123'})).status,403);
 const recoveryReset=await app('/auth/reset-recovery',{password:'synthetic-password-123'},'stale=1');assert(recoveryReset.body.ok);assert(recoveryReset.body.recoverySecret);assert.equal(recoveryReset.headers['cache-control'],'no-store');
 const db=new(require('/app/node_modules/better-sqlite3'))('/app/data/workout.sqlite');
 const insert=db.prepare('INSERT INTO sessions(started_at,identity_source,external_user_id,notes) VALUES(?,?,?,?)');
 const recent=insert.run('2026-10-20','standalone','local-owner','PRIVATE_OWNER_NOTE').lastInsertRowid;
 insert.run('2026-10-21','standalone','foreign-owner','PRIVATE_FOREIGN_NOTE');
 for(let i=0;i<151;i++)insert.run('2020-01-01','standalone','local-owner','PRIVATE_BACKFILL');
 insert.run('2026-02-30','standalone','local-owner','PRIVATE_INVALID');
 for(let i=0;i<601;i++)db.prepare('INSERT INTO sets(session_id,exercise,measurement_type,reps,rpe,created_at,identity_source,external_user_id,notes) VALUES(?,?,?,?,?,?,?,?,?)').run(recent,'bodyweight squat','reps',8,9,'2026-10-20T12:00:00Z','standalone','local-owner','PRIVATE_SET_NOTE');
 db.close();return;
 }
 if(process.argv[2]==='public'){
 const c=JSON.parse(fs.readFileSync(credential));
 const get=p=>new Promise((resolve,reject)=>{const q=https.request('https://127.0.0.1:443'+p,{ca:c.ca,servername:'workouts.example.com',headers:{Host:'workouts.example.com',Authorization:'Bearer '+c.token,Forwarded:'proto=http','X-Forwarded-Host':'evil.example.com','X-Forwarded-For':'1.2.3.4','X-Forwarded-Proto':'http'}},s=>{s.resume();s.on('end',()=>resolve(s.statusCode));});q.on('error',reject);q.end();});
 // Caddy must overwrite the spoofed dedicated identity even as the attacker rotates headers.
 const loginSpoof=i=>new Promise((resolve,reject)=>{const q=https.request('https://127.0.0.1:443/auth/login',{ca:c.ca,servername:'workouts.example.com',method:'POST',headers:{Host:'workouts.example.com',Origin:origin,'Content-Type':'application/json','X-Gymbro-Client-IP':'198.51.100.'+i,'X-Forwarded-For':'203.0.113.'+i}},s=>{s.resume();s.on('end',()=>resolve(s.statusCode));});q.on('error',reject);q.end(JSON.stringify({password:'wrong-password-123'}));});
 for(let i=1;i<=5;i++)assert.equal(await loginSpoof(i),403);assert.equal(await loginSpoof(6),429);
 assert.equal(await get('/auth/status'),200);assert.equal(await get('/agent/context'),404);console.log('Public pinned TLS proxy: canonical host/header enforcement and agent denial passed');return;
 }
 if(process.argv[2]==='restored'){
 const login=await app('/auth/login',{password:'synthetic-password-123'});assert.equal(login.status,200);
 const cookie=login.headers['set-cookie'][0].split(';')[0];const bootstrap=(await app('/bridge/bootstrap',null,cookie)).body;
 assert(bootstrap.savedPlans.length===2);assert(bootstrap.agentReceipts.some(x=>x.key==='synthetic-commit-0001'));
 assert((await app('/bridge/readback',null,cookie)).body.sessions.every(x=>x.external_user_id==='local-owner'));
 console.log('Restored owner login, plans, receipts and owner-scoped history passed');return;
 }
 const c=JSON.parse(fs.readFileSync(credential));
 const call=(ep,b,extra={})=>new Promise((resolve,reject)=>{const r=https.request('https://127.0.0.1:9443/agent/'+ep,{ca:c.ca,servername:c.serverName,method:b?'POST':'GET',headers:{Host:c.serverName,Authorization:'Bearer '+c.token,...extra}},res=>{let x='';res.on('data',b=>x+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(x)}));});r.on('error',reject);r.end(b?JSON.stringify(b):undefined);});
 const bad='/tmp/wrong-ca.json';fs.writeFileSync(bad,JSON.stringify({...c,ca:''}),{mode:0o600});
 assert.throws(()=>execFileSync('node',['/app/cli.cjs','context'],{env:{...process.env,GYMBRO_AGENT_CREDENTIAL:bad},stdio:'pipe'}));fs.unlinkSync(bad);
 const context=cli('context');assert(context.scope);assert.equal(context.training.sessions.length,100);assert.equal(context.training.sets.length,500);assert(context.training.diagnostics.requiresHold);assert(!JSON.stringify(context).includes('PRIVATE_'));assert(context.training.sessions.every(x=>x.id!==2));assert.equal((await app('/agent/context')).status,404);
 for(const h of [{Origin:origin},{Cookie:'x=y'},{'Sec-Fetch-Site':'same-origin'}])assert.equal((await call('context',undefined,h)).status,403);
 const input={contextDigest:context.contextDigest,date:'2026-10-27',goal:'general',durationMin:30,equipment:['bodyweight'],exclude:[],maxLoadLb:0,progression:'hold',calibrationLoads:{},units:'lb_total_external',timeZone:'America/Chicago',constraintsConfirmed:true};
 assert.equal((await call('draft',{...input,owner:'other'})).status,400);
 const d=cli('draft',input);assert(d.draft.historyAssessment.requiresHold);assert(d.plan.exercises.every(x=>x.notes.includes('progression held')));const approval={id:d.id,digest:d.digest,date:d.date,version:d.version,approved:true,idempotencyKey:'synthetic-commit-0001'};
 assert.equal((await call('commit',{...approval,digest:'bad'})).status,409);
 const concurrent=await Promise.all([call('commit',approval),call('commit',approval)]);assert(concurrent.every(x=>x.status===200));assert.deepEqual(concurrent[0],concurrent[1]);
 const receipt=cli('commit',approval);assert.deepEqual(receipt,concurrent[0].body);assert.deepEqual(cli('readback',null,approval.idempotencyKey).plan,d.plan);
 const login=await app('/auth/login',{password:'synthetic-password-123'});const cookie=login.headers['set-cookie'][0].split(';')[0];
 const bootstrap=(await app('/bridge/bootstrap',null,cookie)).body;assert.deepEqual(bootstrap.savedPlans.find(x=>x.id===d.id),d.plan);assert.deepEqual(bootstrap.agentReceipts[0],receipt);
 const a=cli('draft',input),b=cli('draft',input);const commit=x=>({...approval,id:x.id,digest:x.digest,idempotencyKey:'synthetic-'+x.id});
 const race=await Promise.all([call('commit',commit(a)),call('commit',commit(b))]);assert.deepEqual(race.map(x=>x.status).sort(),[200,409]);
 assert.equal((await call('commit',{...approval,owner:'other'})).status,400);
 assert(cli('revoke').revoked);assert.equal((await call('context')).status,401);
 // A new token is separately tested after the stopped-server re-pair phase.
 console.log(JSON.stringify({passed:['TLS-pinned real CLI context/draft/commit/retry/readback','public app denies agent','browser headers denied on private proxy','owner override denied','concurrent identical commits and competing draft conflict','authenticated app exact plan and receipt','explicit revocation']}));
})().catch(e=>{console.error('Synthetic integration assertion failed',e.code||e.name,e.stack?.split('\n').filter(x=>x.trim().startsWith('at ')).join('\n'));process.exitCode=1;});
