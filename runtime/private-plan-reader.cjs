'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
// Extracted generic mapper function bytes remain exact. Hooks preserve owner-specific PT/media policy privately.
function mapper(hooks={}){
 const fallback={firstInt:(x,n)=>{const m=String(x??'').match(/\d+/);return m?Number(m[0]):n;},parseRepRange:x=>{const m=String(x??'').match(/(\d+)(?:\s*[-–]\s*(\d+))?/);return m?{low:+m[1],high:+(m[2]||m[1])}:{low:8,high:12};},normalizeDayType:x=>x||null,parseJson:(x,f)=>{try{return JSON.parse(x)||f;}catch{return f;}},slugify:x=>x.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),canonicalizeExerciseKey:x=>x.trim().toLowerCase(),measurementForExercise:(_n,r)=>/\b(sec|second|secs|min|minute|mins)\b/i.test(r||'')?'duration':'reps',normalizePtPrepKey:()=>'',PT_PREP_LIBRARY:{},holdConfigForExercise:()=>({}),exerciseMediaForName:()=>null,isPtPrepExerciseName:()=>false,isBodyweightCapable:()=>false,buildGeneratedPrepExercises:()=>[]};
 const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'legacy-plan-mapper.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports={};vm.runInNewContext(code,{...fallback,...hooks,exports});return exports;
}
function create({db,id,catalog,hooks={}}){
 const generic=mapper({...hooks,isBodyweightCapable:key=>catalog().find(x=>x.id===key)?.bodyweightCapable||hooks.isBodyweightCapable?.(key)||false});
 return (today)=>db.transaction(()=>{
  if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workout_plans'").get())return [];
  // Owner is fixed at adapter construction. No request body can choose another account.
  const rows=db.prepare('SELECT id,plan_date,day_type,goal,plan_json,status,source FROM workout_plans WHERE identity_source=? AND external_user_id=? ORDER BY plan_date DESC,id DESC LIMIT 100').all(id.identitySource,id.externalUserId);
  if(typeof today==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(today)){const current=db.prepare('SELECT id,plan_date,day_type,goal,plan_json,status,source FROM workout_plans WHERE identity_source=? AND external_user_id=? AND plan_date=? LIMIT 1').get(id.identitySource,id.externalUserId,today);if(current&&!rows.some(r=>r.id===current.id))rows.push(current);}
  const kb=new Map(catalog().map(e=>[e.id,{exercise_key:e.id,cues_json:'[]'}]));const aliases=new Map(catalog().flatMap(e=>(e.aliases||[]).map(a=>[a,e.id])));
  if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='exercise_kb'").get()){for(const e of db.prepare('SELECT exercise_key,aliases_json,cues_json,philosophy,pairings_json FROM exercise_kb ORDER BY exercise_key').all()){const key=(hooks.canonicalizeExerciseKey||((x)=>x.toLowerCase()))(e.exercise_key)||e.exercise_key;kb.set(key,e);aliases.set(key,key);let items=[];try{items=JSON.parse(e.aliases_json||'[]');}catch{}if(Array.isArray(items))for(const a of items)if(typeof a==='string')aliases.set((hooks.canonicalizeExerciseKey||((x)=>x.toLowerCase()))(a),key);}}
  return rows.map(row=>generic.mapPlan(row,kb,aliases));
 })();
}
module.exports={create,mapper};
