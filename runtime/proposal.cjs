'use strict';
const {findExerciseAnchors}=require('./planner/core/anchors.js');
function fail(){throw Error('Invalid custom proposal');}
function object(x,keys){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).sort().join(',')!==[...keys].sort().join(','))fail();}
function number(x,min,max,integer=false){if(typeof x!=='number'||!Number.isFinite(x)||x<min||x>max||(integer&&!Number.isInteger(x)))fail();}
function validate({proposal,input,history,baseline,requiresHold,catalog}){
 object(proposal,['schemaVersion','exercises']);if(proposal.schemaVersion!==1||!Array.isArray(proposal.exercises)||proposal.exercises.length<1||proposal.exercises.length>6)fail();
 const sessions=history.map(s=>({started_at:s.date,day_type:'full body',sets:s.sets.filter(x=>x.loadMode!=='assisted').map(x=>({...x,exercise:x.exercise}))}));
 const anchors=findExerciseAnchors({todayDate:input.date,recentSessions:sessions}).byCanonical;
 const seen=new Set(),exercises=[];let count=0,seconds=480;
 const downshift=baseline.trainingLoad.downshift;
 for(const p of proposal.exercises){
  object(p,['exerciseId','sets','reps','loadLb','rpeCap','restSeconds','reason']);
  const e=catalog.find(e=>e.id===p.exerciseId);if(!e||seen.has(e.id)||!input.equipment.includes(e.equipment)||input.exclude.includes(e.id))fail();seen.add(e.id);
  const latestMode=history.flatMap(s=>s.sets).filter(s=>s.exercise===e.id&&s.measurement_type!=='duration_seconds').at(-1)?.loadMode;
  if(latestMode==='assisted')fail(); // V1 has no assistance/calibration-mode contract; use V2.
  number(p.sets,1,downshift?1:5,true);number(p.reps,1,30,true);number(p.loadLb,0,input.maxLoadLb);number(p.rpeCap,1,downshift?6:8);number(p.restSeconds,30,300,true);
  if(typeof p.reason!=='string'||p.reason.length<1||p.reason.length>300||/[<>&\x00-\x1f]/.test(p.reason))fail();
  const anchor=anchors[e.id],age=anchor?.lastSessionDate?(Date.parse(input.date)-Date.parse(anchor.lastSessionDate))/86400000:Infinity;
  const anchored=e.equipment==='dumbbell'&&anchor&&age>=0&&age<=28&&anchor.lastWorkingWeight>0;
  let ceiling=0,rule='agent_bodyweight';
  if(e.equipment==='bodyweight'){if(p.loadLb!==0)fail();}
  else if(anchored){
   const recent=anchor.recentSets.slice(0,3);const progress=!requiresHold&&input.progression==='conservative'&&!downshift&&anchor.trend==='progressing'&&recent.length===3&&recent.every(s=>s.rpe!==null&&s.rpe<=7&&s.reps>=p.reps);
   ceiling=anchor.lastWorkingWeight*(downshift||anchor.trend==='overreaching'?0.9:progress?1.025:1);ceiling=Math.floor(ceiling*2)/2;
   if(p.loadLb>ceiling)fail();rule=downshift?'agent_downshift':'agent_anchor_bound';
  }else{const chosen=input.calibrationLoads?.[e.id];number(chosen,0,input.maxLoadLb);if(p.loadLb!==chosen||p.sets!==1||p.rpeCap>6)fail();rule='agent_explicit_calibration';}
  count+=p.sets;if(count>20)fail();seconds+=p.sets*(p.reps*5+p.restSeconds)+60;
  exercises.push({name:e.id,sets:p.sets,reps:p.reps,targetLoadLb:p.loadLb,loadUnit:'lb_total_external',rpeCap:p.rpeCap,restSeconds:p.restSeconds,rule,explanation:p.reason+(requiresHold?'; HISTORY INCOMPLETE: progression held':''),anchorAgeDays:Number.isFinite(age)?age:null});
 }
 if(seconds>input.durationMin*60)fail();
 return {...baseline,policy:'agent-proposal/1',status:'draft',estimatedMinutes:Math.ceil(seconds/60),exercises,omitted:[],proposalSource:'external-agent',guidance:[...baseline.guidance,'Owner-approved agent prescription validated against catalog, equipment, exclusions, load anchors, volume and time bounds.']};
}
module.exports={validate};
