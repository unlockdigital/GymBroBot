'use strict';
const {findExerciseAnchors} = require('./core/anchors');
const {computeTrainingLoad} = require('./core/training-load');
const VERSION = 'general-prescription/0.2.0';
// Invented generic catalog. Loaded values always mean total external pounds.
const CATALOG = Object.freeze([
  {id:'goblet squat', equipment:'dumbbell', pattern:'squat'},
  {id:'bodyweight squat', equipment:'bodyweight', pattern:'squat'},
  {id:'dumbbell floor press', equipment:'dumbbell', pattern:'push'},
  {id:'wall push up', equipment:'bodyweight', pattern:'push'},
  {id:'dumbbell row', equipment:'dumbbell', pattern:'pull'},
  {id:'prone arm raise', equipment:'bodyweight', pattern:'pull'},
].map(Object.freeze));
const GOALS = Object.freeze({
  general: Object.freeze({reps:8, sets:2, rest:90}),
  strength: Object.freeze({reps:5, sets:3, rest:150}),
  hypertrophy: Object.freeze({reps:10, sets:3, rest:90}),
  muscular_endurance: Object.freeze({reps:12, sets:2, rest:60}),
});
function fail() { throw new Error('Invalid general planner input'); }
function keys(o, allowed) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || ![Object.prototype,null].includes(Object.getPrototypeOf(o))) fail();
  if (Object.keys(o).some(k=>!allowed.includes(k))) fail();
}
function date(x) { if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x)||!Number.isFinite(Date.parse(x))||new Date(x).toISOString().slice(0,10)!==x) fail(); }
function num(x,min,max,integer=false) { if(typeof x!=='number'||!Number.isFinite(x)||x<min||x>max||(integer&&!Number.isInteger(x))) fail(); }
function list(x,values,max) { if(!Array.isArray(x)||x.length>max||new Set(x).size!==x.length||x.some(v=>!values.includes(v))) fail(); }
function validate(i,catalog=CATALOG) {
  keys(i,['owner','date','goal','durationMin','equipment','history','constraints']);
  if(typeof i.owner!=='string'||!/^[a-z][a-z0-9-]{1,40}$/.test(i.owner)) fail();
  date(i.date); if(!Object.hasOwn(GOALS,i.goal)) fail(); num(i.durationMin,15,60,true);
  list(i.equipment,require('../catalog.cjs').equipment,8); if(!i.equipment.length) fail();
  keys(i.constraints,['owner','exclude','maxLoadLb','progression']);
  if(i.constraints.owner!==i.owner) fail();
  list(i.constraints.exclude,catalog.map(e=>e.id),2000); num(i.constraints.maxLoadLb,0,500);
  if(!['hold','conservative'].includes(i.constraints.progression)) fail();
  if(!Array.isArray(i.history)||i.history.length>100) fail();
  for(const s of i.history) {
    keys(s,['owner','date','sets']); if(s.owner!==i.owner) fail(); date(s.date); if(s.date>=i.date) fail();
    if(!Array.isArray(s.sets)||s.sets.length>50) fail();
    for(const x of s.sets) {
      keys(x,['exercise','weight','unit','reps','rpe','id','created_at','setType','measurement_type','duration_seconds']);
      if(x.id!==undefined&&(!Number.isSafeInteger(x.id)||x.id<1)) fail();
      if(x.created_at!==undefined&&(typeof x.created_at!=='string'||!Number.isFinite(Date.parse(x.created_at)))) fail();
      const e=catalog.find(e=>e.id===x.exercise); if(!e||x.unit!=='lb_total_external') fail();
      num(x.weight,0,500); if(e.equipment==='bodyweight'&&!e.bodyweightCapable&&x.weight!==0) fail(); if(x.measurement_type==='duration_seconds'){num(x.duration_seconds,1,7200,true);if(x.reps!==null)fail();}else num(x.reps,1,200,true);
      if(x.rpe!==null) num(x.rpe,1,10);
    }
  }
}
function draft(i,{catalog=CATALOG}={}) {
  validate(i,catalog);
  // Allowlisted projection prevents owner identifiers, notes or arbitrary text reaching core/output.
  const sessions=i.history.map(s=>({started_at:s.date,day_type:'full body',sets:s.sets.map(x=>({exercise:x.exercise,weight:x.weight,reps:x.reps,rpe:x.rpe,id:x.id,created_at:x.created_at,setType:x.setType,measurement_type:x.measurement_type,duration_seconds:x.duration_seconds}))}));
  const context={todayDate:i.date,recentSessions:sessions};
  const anchors=findExerciseAnchors({...context,recentSessions:sessions.map(s=>({...s,sets:s.sets.filter(x=>x.measurement_type!=='duration_seconds'&&(!x.setType||x.setType==='working'))}))}).byCanonical;
  const load=computeTrainingLoad(context);
  const downshift=load.lastNDaysFatigueIndex>=40;
  const goal=GOALS[i.goal];
  const exercises=[]; let seconds=480; // five-minute preparation + three-minute finish
  const omitted=[];
  for(const pattern of ['squat','push','pull']) {
    const candidates=catalog.filter(e=>e.measurement!=='duration'&&e.pattern===pattern&&i.equipment.includes(e.equipment)&&!i.constraints.exclude.includes(e.id));
    const e=candidates[0]; if(!e) {omitted.push(pattern+': equipment or exclusion'); continue;}
    const a=anchors[e.id]; const age=a?.lastSessionDate?(Date.parse(i.date)-Date.parse(a.lastSessionDate))/86400000:Infinity;
    const fresh=a&&age<=28&&a.lastWorkingWeight>0&&(e.equipment!=='bodyweight'||e.bodyweightCapable);
    let reason='cold_start_calibrate', weight=null, sets=1, rpeCap=6;
    if(e.equipment==='bodyweight') {weight=0; reason='bodyweight_technique';}
    if(fresh) {
      sets=goal.sets; rpeCap=7; weight=a.lastWorkingWeight; reason='hold_anchor';
      const recent=a.recentSets.slice(0,3);
      if(downshift||a.trend==='overreaching') {weight*=0.9; sets=Math.max(1,sets-1); rpeCap=6; reason='downshift';}
      else if(i.constraints.progression==='conservative'&&a.trend==='progressing'&&recent.length===3&&recent.every(s=>s.rpe!==null&&s.rpe<=7&&s.reps>=goal.reps)) {weight*=1.025; reason='progress_2_5_percent';}
      // Conservative 0.5 lb total arithmetic granularity; operator must round DOWN to available equipment.
      weight=Math.floor(weight*2)/2;
    }
    if(downshift) {sets=1; rpeCap=6; if(!fresh) reason+=';volume_downshift';}
    if(weight!==null&&weight>i.constraints.maxLoadLb) {weight=Math.floor(i.constraints.maxLoadLb*2)/2; reason+=';owner_load_cap';}
    const cost=sets*(goal.reps*5+goal.rest)+60;
    if(seconds+cost>i.durationMin*60) {omitted.push(pattern+': duration budget');continue;}
    seconds+=cost;
    exercises.push({name:e.id,bodyweightCapable:e.bodyweightCapable||e.equipment==='bodyweight',sets,reps:goal.reps,targetLoadLb:weight,loadUnit:'lb_total_external',historicalAverageRpe:a?.recentSets.some(s=>s.rpe!==null)?a.averageRpe:null,rpeCap,restSeconds:goal.rest,rule:reason,
      explanation:fresh?`Last working load ${a.lastWorkingWeight} lb total; trend ${a.trend}; rule ${reason}.`:`Calibration: ${reason}; choose an easy technique load within the owner cap, round down to available equipment, stop before effort exceeds ${rpeCap}.`,
      anchorAgeDays:Number.isFinite(age)?age:null});
  }
  return {policy:VERSION,compatibility:'standalone-draft-v1; live schema adapter required',status:exercises.length?'draft':'blocked',goal:i.goal,date:i.date,durationBudgetMin:i.durationMin,estimatedMinutes:Math.ceil(seconds/60),preparationMinutes:5,finishMinutes:3,loadCapLb:i.constraints.maxLoadLb,trainingLoad:{weeklyTotalSets:load.weeklyTotalSets,index:load.lastNDaysFatigueIndex,downshift},exercises,omitted,
    guidance:['Review technique and equipment before starting.','Round every load down to available equipment; retain the owner load cap.','Stop with pain, dizziness or unfamiliar symptoms and seek appropriate qualified guidance.','Early candidate: medical guarantees and clinical assessment remain outside scope.']};
}
module.exports={draft,VERSION,CATALOG,GOALS};
