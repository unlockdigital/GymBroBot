'use strict';
const {resolve}=require('./catalog.cjs');
function fail(m){throw Error('Invalid rich proposal: '+m);}
function obj(x,allowed){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!allowed.includes(k)))fail('shape');}
function num(x,min,max,int=false){if(typeof x!=='number'||!Number.isFinite(x)||x<min||x>max||(int&&!Number.isInteger(x)))fail('number');return x;}
function text(x,max=2000){if(typeof x!=='string'||x.length>max||/[<>&\x00-\x1f]/.test(x))fail('text');return x;}
function validate({proposal,input,history,baseline,requiresHold,catalog}){
 obj(proposal,['schemaVersion','name','dayType','warmup','cooldown','exercises']);if(proposal.schemaVersion!==2||!Array.isArray(proposal.exercises)||!proposal.exercises.length||proposal.exercises.length>40)fail('exercises');
 const excluded=new Set(input.exclude.map(k=>{const e=resolve(catalog,k);if(!e)fail('unknown exclusion');return e.id;}));
 const assigned=e=>{if(e.equipment!=='unknown')return e.equipment;const confirmed=input.equipmentAssignments?.[e.id];if(!require('./catalog.cjs').equipment.includes(confirmed))fail('confirm private exercise equipment');return confirmed;};
 const blocks=['prep','strength','accessory','core'];let total=0,seconds=0;const seen=new Set(),groupMembers=new Map();
 const lines=x=>{if(!Array.isArray(x)||x.length>20)fail('instructions');return x.map(t=>text(t,500));};
 const exercises=proposal.exercises.map((p,idx)=>{
  obj(p,['exerciseId','slotId','block','group','reason','sets','variants','timerSegments']);const e=resolve(catalog,p.exerciseId);if(!e||!input.equipment.includes(assigned(e))||excluded.has(e.id))fail('catalog or constraints');
  const slot=p.slotId===undefined?'slot-'+idx:text(p.slotId,80);if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(slot))fail('slot identifier');if(seen.has(slot))fail('duplicate slot');seen.add(slot);
  if(!blocks.includes(p.block)||!Array.isArray(p.sets)||!p.sets.length||p.sets.length>12)fail('sets');
  const group=p.group===undefined?undefined:text(p.group,40);if(group!==undefined){if(!groupMembers.has(group))groupMembers.set(group,new Set());const members=groupMembers.get(group);const identity=(e.name||e.id).toLowerCase();if(members.has(identity))fail('duplicate grouped exercise');members.add(identity);if(groupMembers.size>26)fail('group limit');}
  const reason=text(p.reason||'',2000);const timerSegments=p.timerSegments===undefined?1:num(p.timerSegments,1,4,true);
  const variants=p.variants===undefined?undefined:p.variants.map(k=>{const v=resolve(catalog,k);if(!v||v.measurement!==e.measurement||assigned(v)!==assigned(e)||!!v.bodyweightCapable!==!!e.bodyweightCapable||!input.equipment.includes(assigned(v))||excluded.has(v.id))fail('variant');return {name:v.name||v.id,canonical:v.id};});if(variants&&(!variants.length||variants.length>8))fail('variants');
  const ownHistory=history.flatMap(s=>s.sets).filter(s=>s.exercise===e.id&&s.measurement_type!=='duration_seconds'&&s.weight>=0);const latest=ownHistory.filter(s=>s.setType==='working').at(-1)||ownHistory.filter(s=>!s.setType).at(-1);const explicit=input.calibrationLoads?.[e.id];
  const sets=p.sets.map((s,index)=>{
   obj(s,['type','repsLow','repsHigh','durationSeconds','loadLb','loadMode','rpe','restSeconds','notes']);
   if(!['warmup','working','backoff','drop','calibration'].includes(s.type))fail('set type');num(s.loadLb,0,input.maxLoadLb);num(s.rpe,1,10);num(s.restSeconds,0,900,true);text(s.notes||'',500);
   const mode=s.loadMode||'added';if(!['added','assisted','pure_bw'].includes(mode)||(mode!=='added'&&!e.bodyweightCapable)||(mode==='pure_bw'&&s.loadLb!==0))fail('load mode');
   if(baseline.trainingLoad.downshift&&(s.rpe>6||p.sets.filter(x=>x.type!=='warmup').length>3))fail('readiness downshift');
   // Load increases are held on incomplete history. Novel weighted exercises require owner-selected calibration cap.
   if(mode==='added'&&s.loadLb>0){const ceiling=latest?latest.weight*(requiresHold?1:1.025):explicit;if(typeof ceiling!=='number'||s.loadLb>ceiling)fail('load anchor or calibration');if(!latest&&s.rpe>6)fail('cold start effort');}
   const timed=e.measurement==='duration';let repsLow=null,repsHigh=null,durationSeconds=null;
   if(timed){durationSeconds=num(s.durationSeconds,1,7200,true);if(s.repsLow!==undefined||s.repsHigh!==undefined)fail('timed reps');}else{repsLow=num(s.repsLow,1,200,true);repsHigh=num(s.repsHigh,repsLow,200,true);if(s.durationSeconds!==undefined)fail('rep duration');}
   total++;if(total>120)fail('session set cap');seconds+=(timed?durationSeconds*timerSegments:repsHigh*5)+s.restSeconds;
   return {set:index+1,type:s.type,weight:s.loadLb,loadMode:mode,repsLow,repsHigh,durationSeconds,rpe:s.rpe,restSeconds:s.restSeconds,notes:s.notes||''};
  });
  seconds+=30;return {name:e.id,displayName:e.name||e.id,slotId:slot,measurement:e.measurement,bodyweightCapable:e.bodyweightCapable,block:p.block,group,variants,timerSegments,setPlan:sets,sets:sets.length,reps:sets[0].repsLow,targetLoadLb:sets[0].weight,rpeCap:Math.max(...sets.map(x=>x.rpe)),restSeconds:sets[0].restSeconds,explanation:reason,rule:'owner-approved-rich-prescription'};
 });
 if(seconds>input.durationMin*60)fail('duration budget');
 return JSON.parse(JSON.stringify({...baseline,policy:'agent-proposal/2',status:'draft',dayName:text(proposal.name||'Approved workout',160),dayType:text(proposal.dayType||'full',40),warmup:lines(proposal.warmup||[]),cooldown:lines(proposal.cooldown||[]),estimatedMinutes:Math.ceil(seconds/60),exercises,proposalSource:'external-agent',omitted:[],guidance:[...baseline.guidance,'Per-set prescriptions and owner catalog metadata are preserved.']}));
}
function baseline(input,history){
 const date=input.date;if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date).toISOString().slice(0,10)!==date)fail('date');
 num(input.durationMin,5,240,true);num(input.maxLoadLb,0,2000);if(!['hold','conservative'].includes(input.progression)||!Array.isArray(input.equipment)||!input.equipment.length||input.equipment.some(x=>!require('./catalog.cjs').equipment.includes(x))||!Array.isArray(input.exclude)||input.exclude.length>2000)fail('constraints');
 const context={todayDate:date,recentSessions:history.map(s=>({started_at:s.date,day_type:'full body',sets:s.sets}))};const load=require('./planner/core/training-load.js').computeTrainingLoad(context);
 return {date,status:'draft',goal:input.goal||'custom',durationBudgetMin:input.durationMin,loadCapLb:input.maxLoadLb,trainingLoad:{weeklyTotalSets:load.weeklyTotalSets,index:load.lastNDaysFatigueIndex,downshift:load.lastNDaysFatigueIndex>=40},exercises:[],guidance:[]};
}
module.exports={validate,baseline};
