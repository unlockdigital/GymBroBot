'use strict';
const crypto=require('node:crypto');
const validDate=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
function create({db,id,control,timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone}){
 const args=[id.identitySource,id.externalUserId];
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
 const localDay=value=>{const parts=formatter.formatToParts(new Date(value));return ['year','month','day'].map(k=>parts.find(x=>x.type===k).value).join('-');};
 function state(date){
  if(!validDate(date))throw Object.assign(Error('Invalid plan date'),{status:400});
  const sessions=db.prepare('SELECT id,started_at,status FROM sessions WHERE identity_source=? AND external_user_id=? ORDER BY id').all(...args);
  // Lock either observed date when historical timezone semantics are uncertain.
  const matching=sessions.filter(s=>typeof s.started_at==='string'&&(s.started_at.slice(0,10)===date||(Number.isFinite(Date.parse(s.started_at))&&localDay(s.started_at)===date)));
  const exists=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workout_plans'").get();
  const privatePlans=exists?db.prepare('SELECT id,plan_date,plan_json,status,source FROM workout_plans WHERE identity_source=? AND external_user_id=? AND plan_date=? ORDER BY id').all(...args,date):[];
  const localPlans=control.prepare('SELECT id,body FROM drafts WHERE approved=1 ORDER BY id').all().filter(p=>JSON.parse(p.body).date===date);
  return {locked:matching.length>0,occupied:privatePlans.length>0||localPlans.length>0,version:crypto.createHash('sha256').update(JSON.stringify({matching,privatePlans,localPlans})).digest('hex')};
 }
 function withLock(fn){return db.transaction(fn).immediate();}
 function approveDraft({draftId,approve,calibrationLoads,plan}){return withLock(()=>control.transaction(()=>{
  if(approve!==true)return {status:400,body:{error:'Explicit approval required'}};
  const d=control.prepare('SELECT * FROM drafts WHERE id=?').get(draftId);if(!d||JSON.parse(d.body).status!=='draft')return {status:404,body:{error:'Draft absent or blocked'}};
  const approved=JSON.parse(d.body);if(d.approved)return {status:200,body:{ok:true,plan:plan(approved,draftId)}};
  const slot=state(approved.date);if(slot.locked||slot.occupied)return {status:409,body:{error:'Plan date occupied or workout already started'}};
  for(const e of approved.exercises.filter(e=>e.targetLoadLb===null)){const chosen=calibrationLoads?.[e.name];if(typeof chosen!=='number'||!Number.isFinite(chosen)||chosen<0||chosen>approved.loadCapLb)return {status:400,body:{error:'Choose each calibration load within the cap'}};e.selectedCalibrationLoadLb=chosen;}
  control.prepare('UPDATE drafts SET approved=1,body=? WHERE id=?').run(JSON.stringify(approved),draftId);return {status:200,body:{ok:true,plan:plan(approved,draftId)}};
 })());}
 return {state,withLock,approveDraft};
}
module.exports={create};
