'use strict';
const {CATALOG}=require('./planner.cjs');
const validDate=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
const bounded=(x,a,b)=>typeof x==='number'&&Number.isFinite(x)&&x>=a&&x<=b;
// Storage weight semantics are total external pounds. Request units never reinterpret rows.
function historyFromRows(rows,date,owner='local-owner',catalog=CATALOG) {
 const diagnostics={excluded:{},normalizedBodyweightSets:0,sessionTimestampFallbackSets:0,assistedSets:0};
 const omit=reason=>{diagnostics.excluded[reason]=(diagnostics.excluded[reason]||0)+1;};
 const sessions=[];
 for(const s of rows.sessions) {
  const day=typeof s.started_at==='string'?s.started_at.slice(0,10):'';
  if(!validDate(day)){omit('invalid_session_date');continue;}
  if(day>=date)continue;
  const sets=[];
  for(const x of rows.sets.filter(x=>x.session_id===s.id)) {
   const e=require('../catalog.cjs').resolve(catalog,x.exercise);
   const timed=x.measurement_type==='duration_seconds';
   let reason=!e?'unknown_exercise':!['reps','duration_seconds'].includes(x.measurement_type)?'unsupported_measurement':null;
   const createdAt=x.created_at??s.started_at;
   const assistance=require('../assistance.cjs').parse(x);
   if(!reason && assistance.assisted && (assistance.invalid||!(e.bodyweightCapable??(e.equipment==='bodyweight'))))reason='invalid_assistance';
   if(!reason && x.unit!==undefined&&x.unit!=='lb_total_external'&&x.unit!=='lb')reason='unsupported_units';
   if(!reason && (!Number.isSafeInteger(x.id)||x.id<1))reason='invalid_set_id';
   if(!reason && (typeof createdAt!=='string'||!Number.isFinite(Date.parse(createdAt))))reason='invalid_set_time';
   if(!reason && ((timed?(!Number.isInteger(x.duration_seconds)||!bounded(x.duration_seconds,1,7200)):(!Number.isInteger(x.reps)||!bounded(x.reps,1,200)))||!(x.rpe==null||bounded(x.rpe,1,10))))reason='invalid_reps_or_rpe';
   let weight=x.weight;
   if(!reason&&assistance.assisted){if(weight!==null)reason='assistance_weight_conflict';else{weight=0;diagnostics.assistedSets++;}}
   // Catalog verification plus absence of assistance matches the core pure_bw representation.
   if(!reason && weight===null&&(e.equipment==='bodyweight'||e.bodyweightCapable)){weight=0;diagnostics.normalizedBodyweightSets++;}
   if(!reason && (!bounded(weight,0,500)||(catalog===CATALOG&&e.equipment==='bodyweight'&&weight!==0)))reason='incompatible_load';
   if(reason){omit(reason);continue;}
   if(x.created_at===null)diagnostics.sessionTimestampFallbackSets++;
   const rawType=x.planned_set_type||/^planned_set_type=(warmup|working|backoff|drop|calibration)(?:;|$)/.exec(x.notes||'')?.[1];
   sets.push({exercise:e.id,weight,reps:timed?null:x.reps,...(timed?{measurement_type:'duration_seconds',duration_seconds:x.duration_seconds}:{}),rpe:x.rpe??null,unit:'lb_total_external',id:x.id,created_at:createdAt,...(rawType?{setType:rawType}:{}),...(assistance.assisted?{loadMode:'assisted',assistanceLb:assistance.assistanceLb}:{})});
  }
  sets.sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)||a.id-b.id);
  if(sets.length>50)omit('set_limit');
  sessions.push({owner,date:day,sets:sets.slice(-50),_startedAt:s.started_at,_id:s.id});
 }
 sessions.sort((a,b)=>Date.parse(a._startedAt)-Date.parse(b._startedAt)||(Number(a._id)||0)-(Number(b._id)||0));
 if(sessions.length>100)omit('session_limit');
 return {history:sessions.slice(-100).map(({_startedAt,_id,...s})=>s),diagnostics,requiresHold:Object.keys(diagnostics.excluded).length>0};
}
function plan(d,key) {if(d.policy==='agent-proposal/2')return require('../rich-plan.cjs').plan(d,key);return {id:key,plannedAt:d.date,dayName:'Approved general plan',dayType:'full',source:'owner-approved-general',exercises:d.exercises.map(e=>({id:e.name,name:e.name,measurement:'reps',bodyweight_capable:e.bodyweightCapable??(CATALOG.find(x=>x.id===e.name)?.equipment==='bodyweight'),targetSets:e.sets,targetRepsLow:e.reps,targetRepsHigh:e.reps,targetWeight:e.targetLoadLb??e.selectedCalibrationLoadLb,unit:'lb',notes:e.explanation,...(e.loadMode==='assisted'?{setPlan:Array.from({length:e.sets},()=>({reps:e.reps,repsLow:e.reps,repsHigh:e.reps,weight:e.targetLoadLb,loadMode:'assisted',rpe:e.rpeCap})),restSeconds:e.restSeconds}:{}),...(d.proposalSource==='external-agent'?{rpeTarget:String(e.rpeCap),restHint:String(e.restSeconds)+'s',coachNote:e.explanation+'; RPE cap '+e.rpeCap+'; rest '+e.restSeconds+' seconds.',setPlan:Array.from({length:e.sets},()=>({reps:e.reps,repsLow:e.reps,repsHigh:e.reps,weight:e.targetLoadLb,rpe:e.rpeCap})),restSeconds:e.restSeconds,rpeCap:e.rpeCap}:{}),defaults:{sets:e.sets,repsLow:e.reps,repsHigh:e.reps,weight:e.targetLoadLb??e.selectedCalibrationLoadLb}}))};}
function ownerLocalDate(now=new Date()) {return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;}
// Input is newest-created first; retain that precedence only among same-day plans.
function bootstrap(saved,today=ownerLocalDate()) {return {todaysPlan:saved.find(p=>p.plannedAt===today)||null,savedPlans:saved};}
module.exports={historyFromRows,plan,bootstrap,ownerLocalDate};
