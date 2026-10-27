'use strict';
const {CATALOG}=require('./planner.cjs');
const validDate=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
const bounded=(x,a,b)=>typeof x==='number'&&Number.isFinite(x)&&x>=a&&x<=b;
// Storage weight semantics are total external pounds. Request units never reinterpret rows.
function historyFromRows(rows,date,owner='local-owner') {
 const diagnostics={excluded:{},normalizedBodyweightSets:0};
 const omit=reason=>{diagnostics.excluded[reason]=(diagnostics.excluded[reason]||0)+1;};
 const sessions=[];
 for(const s of rows.sessions) {
  const day=typeof s.started_at==='string'?s.started_at.slice(0,10):'';
  if(!validDate(day)){omit('invalid_session_date');continue;}
  if(day>=date)continue;
  const sets=[];
  for(const x of rows.sets.filter(x=>x.session_id===s.id)) {
   const e=CATALOG.find(e=>e.id===x.exercise);
   let reason=!e?'unknown_exercise':x.measurement_type!=='reps'?'unsupported_measurement':null;
   if(!reason && /\bassistance_/i.test(x.notes||''))reason='assisted_load';
   if(!reason && x.unit!==undefined&&x.unit!=='lb_total_external'&&x.unit!=='lb')reason='unsupported_units';
   if(!reason && (!Number.isSafeInteger(x.id)||x.id<1))reason='invalid_set_id';
   if(!reason && (typeof x.created_at!=='string'||!Number.isFinite(Date.parse(x.created_at))))reason='invalid_set_time';
   if(!reason && (!Number.isInteger(x.reps)||!bounded(x.reps,1,30)||!(x.rpe==null||bounded(x.rpe,1,10))))reason='invalid_reps_or_rpe';
   let weight=x.weight;
   // Catalog verification plus absence of assistance matches the core pure_bw representation.
   if(!reason && weight===null&&e.equipment==='bodyweight'){weight=0;diagnostics.normalizedBodyweightSets++;}
   if(!reason && (!bounded(weight,0,500)||(e.equipment==='bodyweight'&&weight!==0)))reason='incompatible_load';
   if(reason){omit(reason);continue;}
   sets.push({exercise:e.id,weight,reps:x.reps,rpe:x.rpe??null,unit:'lb_total_external',id:x.id,created_at:x.created_at});
  }
  sets.sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)||a.id-b.id);
  if(sets.length>50)omit('set_limit');
  sessions.push({owner,date:day,sets:sets.slice(-50)});
 }
 sessions.sort((a,b)=>a.date.localeCompare(b.date));
 if(sessions.length>100)omit('session_limit');
 return {history:sessions.slice(-100),diagnostics,requiresHold:Object.keys(diagnostics.excluded).length>0};
}
function plan(d,key) {return {id:key,plannedAt:d.date,dayName:'Approved general plan',dayType:'full',source:'owner-approved-general',exercises:d.exercises.map(e=>({id:e.name,name:e.name,measurement:'reps',bodyweight_capable:CATALOG.find(x=>x.id===e.name)?.equipment==='bodyweight',targetSets:e.sets,targetRepsLow:e.reps,targetRepsHigh:e.reps,targetWeight:e.targetLoadLb??e.selectedCalibrationLoadLb,unit:'lb',notes:e.explanation,defaults:{sets:e.sets,repsLow:e.reps,repsHigh:e.reps,weight:e.targetLoadLb??e.selectedCalibrationLoadLb}}))};}
function ownerLocalDate(now=new Date()) {return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;}
// Input is newest-created first; retain that precedence only among same-day plans.
function bootstrap(saved,today=ownerLocalDate()) {return {todaysPlan:saved.find(p=>p.plannedAt===today)||null,savedPlans:saved};}
module.exports={historyFromRows,plan,bootstrap,ownerLocalDate};
