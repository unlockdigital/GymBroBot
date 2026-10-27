'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const home='/app';
const Database=require(path.join(home,'node_modules/better-sqlite3'));
const db=new Database(':memory:');db.exec('CREATE TABLE drafts(id TEXT PRIMARY KEY,body TEXT,approved INTEGER)');
let data={sessions:[],sets:[],diagnostics:{requiresHold:false}};
const api=require(home+'/agent.cjs').create({control:db,owner:{status:()=>({claimed:true}),epoch:()=>1},id:{identitySource:'synthetic',externalUserId:'owner'},training:()=>data,planner:require(home+'/planner/planner.cjs'),bridge:require(home+'/planner/bridge.cjs')});
const headers=new Headers({Authorization:'Bearer '+api.issue()});const call=(path,body={},method='POST')=>api.handle(method,path,headers,body);
let targetDate='2026-10-28';
const params=()=>({contextDigest:call('context',{},'GET').contextDigest,date:targetDate,goal:'general',durationMin:30,equipment:['bodyweight'],exclude:[],maxLoadLb:0,progression:'hold',units:'lb_total_external',timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,constraintsConfirmed:true,proposal:{schemaVersion:1,exercises:[{exerciseId:'wall push up',sets:2,reps:7,loadLb:0,rpeCap:6,restSeconds:60,reason:'Agent selected lower repetitions for today.'}]}});
let b=params(),d=call('draft',b);assert.equal(d.plan.exercises.length,1);assert.equal(d.plan.exercises[0].name,'wall push up');assert.equal(d.plan.exercises[0].targetRepsLow,7);assert.equal(d.draft.policy,'agent-proposal/1');assert.equal(d.plan.exercises[0].restSeconds,60);assert.equal(d.plan.exercises[0].rpeCap,6);assert.equal(d.plan.exercises[0].setPlan.length,2);assert(d.plan.exercises[0].coachNote.includes('rest 60 seconds'));
b.proposal.exercises[0].reps=20;const commit={id:d.id,date:d.date,version:d.version,digest:d.digest,approved:true,idempotencyKey:'synthetic-custom-plan-1'};const receipt=call('commit',commit);assert.deepEqual(call('commit',commit),receipt);const saved=call('readback/'+commit.idempotencyKey,{},'GET');assert.deepEqual(saved.plan,d.plan);assert.equal(saved.plan.exercises[0].targetRepsLow,7);
let checks=4;assert.throws(()=>call('draft',params()),e=>e.status===409);checks++;targetDate='2026-10-29';
for(const change of [b=>b.proposal.exercises[0].exerciseId='unknown exercise',b=>b.proposal.exercises[0].loadLb=5,b=>b.proposal.exercises[0].sets=21,b=>b.proposal.exercises[0].reps=1.5,b=>b.proposal.exercises[0].reason='<script>',b=>b.proposal.owner='other',b=>b.proposal.exercises.push({...b.proposal.exercises[0]}),b=>b.exclude=['wall push up'],b=>{b.durationMin=15;b.proposal.exercises[0].sets=5;b.proposal.exercises[0].restSeconds=300;}]){const bad=params();change(bad);assert.throws(()=>call('draft',bad),e=>e.status===400);checks++;}
// A changed history snapshot makes an otherwise exact approved custom draft stale.
d=call('draft',params());data={...data,sessions:[{id:1,started_at:'2026-10-20'}]};assert.throws(()=>call('commit',{...commit,id:d.id,digest:d.digest,idempotencyKey:'synthetic-custom-plan-2'}),e=>e.status===409);checks++;
// Dumbbell cold starts require an explicit single calibration set; equipment/exclusions remain authoritative.
data={sessions:[],sets:[],diagnostics:{requiresHold:false}};b=params();b.equipment=['dumbbell'];b.maxLoadLb=20;b.calibrationLoads={'dumbbell row':10};b.proposal.exercises=[{exerciseId:'dumbbell row',sets:1,reps:8,loadLb:10,rpeCap:6,restSeconds:60,reason:'Conservative owner-confirmed calibration.'}];assert.equal(call('draft',b).draft.exercises[0].targetLoadLb,10);checks++;
b.proposal.exercises[0].sets=2;assert.throws(()=>call('draft',b),e=>e.status===400);checks++;
const plain=params();delete plain.proposal;assert.equal(call('draft',plain).draft.policy,'general-prescription/0.2.0');checks++;
// Known anchor bounds apply independently of an agent's rationale or calibration field.
data={sessions:[{id:1,started_at:'2026-10-27T12:00:00Z'}],sets:[{id:1,session_id:1,exercise:'dumbbell row',measurement_type:'reps',weight:20,reps:8,rpe:7,created_at:'2026-10-27T12:10:00Z',notes:''}],diagnostics:{requiresHold:false}};
b=params();b.equipment=['dumbbell'];b.maxLoadLb=40;b.proposal.exercises=[{exerciseId:'dumbbell row',sets:2,reps:8,loadLb:20,rpeCap:7,restSeconds:60,reason:'Agent preserves the last working load.'}];assert.equal(call('draft',b).draft.exercises[0].targetLoadLb,20);checks++;
b.proposal.exercises[0].loadLb=21;assert.throws(()=>call('draft',b),e=>e.status===400);checks++;
b.proposal.exercises[0].loadLb=20;b.owner='outsider';assert.throws(()=>call('draft',b),e=>e.status===400);checks++;
// An unissued or revoked bearer cannot reach custom proposal validation or persistence.
const before=db.prepare('SELECT count(*) n FROM agent_drafts').get().n;
assert.throws(()=>api.handle('POST','draft',new Headers({Authorization:'Bearer '+'A'.repeat(43)}),params()),e=>e.status===401);assert.equal(db.prepare('SELECT count(*) n FROM agent_drafts').get().n,before);checks++;
call('revoke');assert.throws(()=>call('draft',params()),e=>e.status===401);checks++;

db.close();console.log('PASS '+checks+' synthetic checks');
