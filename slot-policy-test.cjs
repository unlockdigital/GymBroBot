'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const home='/app',Database=require(path.join(home,'node_modules/better-sqlite3'));process.umask(0o077);
const tmp=fs.mkdtempSync(path.join(require('os').tmpdir(),'gymbro-synthetic-slot-'));fs.chmodSync(tmp,0o700);const file=path.join(tmp,'workout.sqlite');
const db=new Database(file),control=new Database(':memory:'),other=new Database(file,{timeout:1});let checks=0;
try{
 db.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY,started_at TEXT,status TEXT,identity_source TEXT,external_user_id TEXT); CREATE TABLE workout_plans(id INTEGER PRIMARY KEY,plan_date TEXT,plan_json TEXT,status TEXT,source TEXT,identity_source TEXT,external_user_id TEXT)');control.exec('CREATE TABLE drafts(id TEXT PRIMARY KEY,body TEXT,approved INTEGER)');
 const id={identitySource:'synthetic',externalUserId:'owner'},policy=require(home+'/plan-policy.cjs').create({db,id,control,timeZone:'America/Chicago'});
 const api=require(home+'/agent.cjs').create({control,owner:{status:()=>({claimed:true}),epoch:()=>1},id,training:()=>({sessions:[],sets:[],diagnostics:{requiresHold:false}}),planner:require(home+'/planner/planner.cjs'),bridge:require(home+'/planner/bridge.cjs'),slotState:policy.state,withPlanGuard:policy.withLock});
 const headers=new Headers({Authorization:'Bearer '+api.issue()}),call=(p,b={},method='POST')=>api.handle(method,p,headers,b);
 const input=date=>({contextDigest:call('context',{},'GET').contextDigest,date,goal:'general',durationMin:30,equipment:['bodyweight'],exclude:[],maxLoadLb:0,progression:'hold',units:'lb_total_external',timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,constraintsConfirmed:true,proposal:{schemaVersion:1,exercises:[{exerciseId:'wall push up',sets:2,reps:7,loadLb:0,rpeCap:6,restSeconds:60,reason:'Synthetic owner-approved prescription.'}]}});
 const commit=(d,key)=>call('commit',{id:d.id,date:d.date,version:d.version,digest:d.digest,approved:true,idempotencyKey:key});
 const addSession=(n,date,owner='owner',status='active')=>db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(n,date,status,'synthetic',owner);
 const addPlan=(n,date,owner='owner')=>db.prepare('INSERT INTO workout_plans VALUES(?,?,?,\'approved\',\'private\',\'synthetic\',?)').run(n,date,'{"strength":[]}',owner);
 assert(!policy.state('2026-11-01').locked);checks++;
 addSession(1,'2026-11-01T15:00:00Z');assert.throws(()=>call('draft',input('2026-11-01')),e=>e.status===409);checks++;
 for(const [n,status] of [[2,'paused'],[3,'completed']]){addSession(n,'2026-11-0'+n+'T15:00:00Z','owner',status);assert(policy.state('2026-11-0'+n).locked);checks++;}
 addPlan(1,'2026-11-04');assert.throws(()=>call('draft',input('2026-11-04')),e=>e.status===409);checks++;
 control.prepare('INSERT INTO drafts VALUES(?,?,1)').run('ui-plan',JSON.stringify({date:'2026-11-05'}));assert.throws(()=>call('draft',input('2026-11-05')),e=>e.status===409);checks++;
 addSession(6,'2026-11-06T15:00:00Z','other');addPlan(6,'2026-11-06','other');assert.equal(call('draft',input('2026-11-06')).date,'2026-11-06');checks++;
 let d=call('draft',input('2026-11-07'));addSession(7,'2026-11-07T15:00:00Z');assert.throws(()=>commit(d,'synthetic-after-start-01'),e=>e.status===409);assert(!control.prepare('SELECT id FROM drafts WHERE id=?').get(d.id));checks++;
 d=call('draft',input('2026-11-08'));addPlan(8,'2026-11-08');assert.throws(()=>commit(d,'synthetic-after-plan-01'),e=>e.status===409);checks++;
 d=call('draft',input('2026-11-09'));const receipt=commit(d,'synthetic-before-start-01');addSession(9,'2026-11-09T15:00:00Z');assert.deepEqual(commit(d,'synthetic-before-start-01'),receipt);checks++;
 const raceA=call('draft',input('2026-11-10')),raceB=call('draft',input('2026-11-10'));commit(raceA,'synthetic-race-first-01');assert.throws(()=>commit(raceB,'synthetic-race-second-01'),e=>e.status===409);checks++;
 policy.withLock(()=>{assert.throws(()=>other.prepare('INSERT INTO sessions VALUES(99,\'2026-12-01\',\'active\',\'synthetic\',\'owner\')').run(),e=>e.code==='SQLITE_BUSY');});checks++;
 addSession(11,'2026-11-12T01:00:00Z');assert(policy.state('2026-11-11').locked);assert(policy.state('2026-11-12').locked);checks++;
 assert.throws(()=>policy.withLock(()=>{addSession(12,'2026-12-02');throw Error('synthetic rollback');}));assert(!db.prepare('SELECT id FROM sessions WHERE id=12').get());checks++;
 const manualBody=date=>({status:'draft',date,loadCapLb:0,exercises:[]});
 const addManual=(key,date)=>control.prepare('INSERT INTO drafts VALUES(?,?,0)').run(key,JSON.stringify(manualBody(date)));
 const approve=key=>policy.approveDraft({draftId:key,approve:true,plan:(p,key)=>({id:key,date:p.date})});
 addManual('manual-started','2026-11-01');assert.equal(approve('manual-started').status,409);checks++;
 addManual('manual-private','2026-11-04');assert.equal(approve('manual-private').status,409);checks++;
 addManual('manual-open','2026-11-20');assert.equal(approve('manual-open').status,200);addSession(20,'2026-11-20T15:00:00Z');assert.equal(approve('manual-open').status,200);checks++;
 addManual('manual-second','2026-11-20');assert.equal(approve('manual-second').status,409);checks++;
 // A deferred native SQLite failure at COMMIT never returns a successful manual result.
 control.exec("PRAGMA foreign_keys=ON; CREATE TABLE synthetic_parent(id INTEGER PRIMARY KEY); CREATE TABLE synthetic_child(parent_id INTEGER REFERENCES synthetic_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER synthetic_commit_fault AFTER UPDATE OF approved ON drafts WHEN NEW.id='manual-fail' BEGIN INSERT INTO synthetic_child VALUES(999); END");
 addManual('manual-fail','2026-11-21');let delivered;assert.throws(()=>{delivered=approve('manual-fail');},e=>e.code==='SQLITE_CONSTRAINT_FOREIGNKEY');assert.equal(delivered,undefined);assert.equal(control.prepare('SELECT approved FROM drafts WHERE id=?').get('manual-fail').approved,0);assert.equal(control.prepare('SELECT count(*) n FROM synthetic_child').get().n,0);checks++;
 console.log('PASS '+checks+' slot-policy checks');
}finally{other.close();control.close();db.close();fs.rmSync(tmp,{recursive:true,force:true});}
