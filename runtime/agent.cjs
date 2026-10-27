'use strict';
const crypto=require('node:crypto');
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const hash=x=>crypto.createHash('sha256').update(canonical(x)).digest('hex');
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
function create({control,owner,id,training,planner,bridge,clock=()=>Date.now()}){
 control.exec(`CREATE TABLE IF NOT EXISTS agent_tokens(hash TEXT PRIMARY KEY, epoch TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS agent_drafts(id TEXT PRIMARY KEY, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS agent_receipts(key TEXT PRIMARY KEY, digest TEXT NOT NULL, body TEXT NOT NULL);`);
 const scope=hash(id), epoch=()=>hash(owner.epoch());
 const base=date=>hash(control.prepare('SELECT id,body,approved FROM drafts WHERE approved=1 ORDER BY rowid').all().filter(r=>JSON.parse(r.body).date===date));
 const context=()=>{const data=training();return {scope,policy:'agent-workout/1',training:data,contextDigest:hash({scope,epoch:epoch(),data}),limitations:['Training history only; owner must provide current injury/symptom constraints and confirm timezone and total external pounds.']};};
 const receipts=()=>control.prepare('SELECT body FROM agent_receipts ORDER BY rowid DESC LIMIT 20').all().map(r=>JSON.parse(r.body));
 function issue(){if(!owner.status().claimed)fail(403,'Enroll owner first');const token=crypto.randomBytes(32).toString('base64url');control.prepare('INSERT INTO agent_tokens(hash,epoch,expires) VALUES(?,?,?)').run(hash(token),epoch(),clock()+86400000);return token;}
 function auth(headers){const s=headers.get('authorization')||'';if(!/^Bearer [A-Za-z0-9_-]{43}$/.test(s))fail(401,'Unauthorized');const row=control.prepare('SELECT * FROM agent_tokens WHERE hash=?').get(hash(s.slice(7)));if(!row||row.revoked||row.expires<=clock()||row.epoch!==epoch())fail(401,'Unauthorized');return s.slice(7);}
 function handle(method,path,headers,b={}){const token=auth(headers);
 if(method==='POST'&&path==='revoke'){control.prepare('UPDATE agent_tokens SET revoked=1 WHERE hash=?').run(hash(token));return {revoked:true};}
 if(method==='GET'&&path==='context')return context();
 if(method==='GET'&&path.startsWith('readback/')){const receipt=control.prepare('SELECT body FROM agent_receipts WHERE key=?').get(path.slice(9));if(!receipt)fail(404,'Receipt absent');const r=JSON.parse(receipt.body);const saved=control.prepare('SELECT body,approved FROM drafts WHERE id=?').get(r.id);if(!saved?.approved)fail(409,'Saved plan changed');const executable=bridge.plan(JSON.parse(saved.body),r.id);if(hash(executable)!==r.planDigest)fail(409,'Saved plan changed');return {...r,plan:executable};}
 if(method==='POST'&&path==='draft'){
  if(Object.keys(b).some(k=>!['contextDigest','date','goal','durationMin','equipment','exclude','maxLoadLb','progression','calibrationLoads','units','timeZone','constraintsConfirmed'].includes(k)))fail(400,'Unknown field');
  if(b.units!=='lb_total_external'||b.constraintsConfirmed!==true||b.timeZone!==Intl.DateTimeFormat().resolvedOptions().timeZone)fail(400,'Confirm units, server timezone and current constraints');
  const c=context();if(b.contextDigest!==c.contextDigest)fail(409,'Refresh context');
  const adapted=bridge.historyFromRows(c.training,b.date);
  const completeness=c.training.diagnostics;
  adapted.requiresHold=adapted.requiresHold||!completeness||completeness.requiresHold!==false;
  const historyAssessment={requiresHold:adapted.requiresHold,fatigueStatus:adapted.requiresHold?'unknown_or_incomplete':'available',completeness:completeness||{unknown:true},adaptation:adapted.diagnostics};
  const d=planner.draft({owner:'local-owner',date:b.date,goal:b.goal,durationMin:b.durationMin,equipment:b.equipment,constraints:{owner:'local-owner',exclude:b.exclude,maxLoadLb:b.maxLoadLb,progression:adapted.requiresHold?'hold':b.progression},history:adapted.history});
  if(d.status!=='draft')fail(400,'Blocked draft');
  for(const e of d.exercises){if(e.targetLoadLb===null){const n=b.calibrationLoads?.[e.name];if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>d.loadCapLb)fail(400,'Explicit calibration required');e.selectedCalibrationLoadLb=n;}}
  d.historyAssessment=historyAssessment;
  if(adapted.requiresHold)for(const e of d.exercises)e.explanation+='; HISTORY INCOMPLETE OR EXCLUDED: progression held; fatigue may be underestimated';
  const key=crypto.randomUUID(),plan=bridge.plan(d,key),version=1;
  const envelope={id:key,version,date:d.date,scope,contextDigest:c.contextDigest,base:base(d.date),expires:clock()+600000,timeZone:b.timeZone,units:b.units,policy:'agent-workout/1',draft:d,plan};
  const result={...envelope,digest:hash(envelope)};control.prepare('INSERT INTO agent_drafts(id,body) VALUES(?,?)').run(key,canonical(result));return result;
 }
 if(method==='POST'&&path==='commit')return control.transaction(()=>{
  if(Object.keys(b).sort().join(',')!=='approved,date,digest,id,idempotencyKey,version'||b.approved!==true||!/^[-a-zA-Z0-9_]{16,100}$/.test(b.idempotencyKey))fail(400,'Exact approval required');
  const prev=control.prepare('SELECT * FROM agent_receipts WHERE key=?').get(b.idempotencyKey);
  if(prev){const r=JSON.parse(prev.body);if(r.digest!==b.digest||r.id!==b.id||r.version!==b.version||r.date!==b.date)fail(409,'Idempotency conflict');return r;}
  const row=control.prepare('SELECT body FROM agent_drafts WHERE id=?').get(b.id);if(!row)fail(404,'Draft absent');const d=JSON.parse(row.body);
  if(d.digest!==b.digest||d.date!==b.date||d.version!==b.version)fail(409,'Approval mismatch');
  if(d.expires<=clock()||d.contextDigest!==context().contextDigest||d.base!==base(d.date))fail(409,'Stale draft; refresh and approve revision');
  if(control.prepare('SELECT id FROM drafts WHERE id=?').get(d.id))fail(409,'Already committed; reuse original idempotency key');
  control.prepare('INSERT INTO drafts(id,body,approved) VALUES(?,?,1)').run(d.id,canonical(d.draft));
  const saved=bridge.plan(JSON.parse(control.prepare('SELECT body FROM drafts WHERE id=?').get(d.id).body),d.id);
  if(canonical(saved)!==canonical(d.plan))fail(500,'Readback failed');
  const receipt={approvalMode:"agent_asserted_conversational_approval",id:d.id,digest:d.digest,date:d.date,version:d.version,planDigest:hash(saved),scope,key:b.idempotencyKey,committedAt:new Date(clock()).toISOString()};
  control.prepare('INSERT INTO agent_receipts(key,digest,body) VALUES(?,?,?)').run(b.idempotencyKey,b.digest,canonical(receipt));return receipt;
 })();
 fail(404,'Route absent');
 }
 return {handle,issue,receipts};
}
module.exports={create,canonical,hash};
