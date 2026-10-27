'use strict';
// These names and equipment tags are authored factual metadata, without copied descriptions/media.
const SEED=require('./planner/planner.cjs').CATALOG.map(x=>({...x,name:x.id,measurement:'reps',bodyweightCapable:x.equipment==='bodyweight',aliases:[]}));
const EXTRA=[
 ['barbell squat','barbell','squat'],['barbell deadlift','barbell','hinge'],['barbell bench press','barbell','push'],['barbell row','barbell','pull'],['dumbbell shoulder press','dumbbell','push'],['dumbbell romanian deadlift','dumbbell','hinge'],['dumbbell lunge','dumbbell','squat'],['leg press','machine','squat'],['leg extension','machine','other'],['leg curl','machine','hinge'],['chest press','machine','push'],['lat pulldown','cable','pull'],['seated cable row','cable','pull'],['cable face pull','cable','pull'],['cable curl','cable','other'],['cable triceps pressdown','cable','push'],['pull up','bodyweight','pull'],['dip','bodyweight','push'],['push up','bodyweight','push'],['plank','bodyweight','core','duration'],['side plank','bodyweight','core','duration'],['dead bug','bodyweight','core'],['bird dog','bodyweight','core'],['glute bridge','bodyweight','hinge'],['calf raise','bodyweight','other'],['farmer carry','dumbbell','carry','duration'],['kettlebell deadlift','kettlebell','hinge'],['band row','band','pull'],['band pull apart','band','pull'],['hip flexor stretch','bodyweight','mobility','duration']
 ];
 for(const [id,equipment,pattern,measurement='reps'] of EXTRA)SEED.push({id,name:id,equipment,pattern,measurement,bodyweightCapable:equipment==='bodyweight',aliases:[]});
const equipment=['bodyweight','dumbbell','barbell','machine','cable','kettlebell','band','other'];
function text(s,max=120){if(typeof s!=='string'||!s.trim()||s.length>max||/[<>&\x00-\x1f]/.test(s))throw Error('Invalid catalog text');return s.trim();}
function validate(e){
 if(!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).some(k=>!['id','name','equipment','pattern','measurement','bodyweightCapable','aliases','rights'].includes(k)))throw Error('Invalid catalog entry');
 const id=text(e.id).toLowerCase();if(!/^[a-z0-9][a-z0-9 _-]{0,119}$/.test(id))throw Error('Invalid exercise identifier');
 if(!equipment.includes(e.equipment)||!['reps','duration'].includes(e.measurement)||typeof e.bodyweightCapable!=='boolean'||!['squat','hinge','push','pull','carry','core','mobility','cardio','other'].includes(e.pattern))throw Error('Invalid exercise metadata');
 if(!Array.isArray(e.aliases)||e.aliases.length>12)throw Error('Invalid aliases');
 if(e.rights!=='owner-authored')throw Error('Owner-authored metadata confirmation required');
 return {id,name:text(e.name),equipment:e.equipment,pattern:e.pattern,measurement:e.measurement,bodyweightCapable:e.bodyweightCapable,aliases:[...new Set(e.aliases.map(x=>text(x).toLowerCase()))],rights:e.rights};
}
function create(control,{privateEntries=[]}={}){
 const privateCatalog=privateEntries.map(e=>({...validate({...e,equipment:e.equipment==='unknown'?'other':e.equipment,rights:'owner-authored'}),equipment:e.equipment,rights:'private-overlay'}));
 control.exec('CREATE TABLE IF NOT EXISTS owner_exercises(id TEXT PRIMARY KEY, body TEXT NOT NULL)');
 const list=()=>{const custom=control.prepare('SELECT body FROM owner_exercises ORDER BY id').all().map(x=>validate(JSON.parse(x.body)));const ids=new Set(custom.map(x=>x.id));const merged=new Map([...SEED,...privateCatalog,...custom].map(e=>[e.id,e]));return [...merged.values()];};
 function put(raw){const e=validate(raw),all=list().filter(x=>x.id!==e.id);if(all.length>=2000)throw Error('Catalog limit reached');const keys=new Set([e.id,e.name.toLowerCase(),...e.aliases]);if(all.some(x=>[x.id,(x.name||x.id).toLowerCase(),...x.aliases].some(k=>keys.has(k))))throw Error('Ambiguous catalog alias');control.prepare('INSERT INTO owner_exercises(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(e.id,JSON.stringify(e));return e;}
 return {list,put};
}
function resolve(catalog,key){const k=String(key||'').trim().toLowerCase();const exact=catalog.find(x=>x.id===k);if(exact)return exact;const matches=catalog.filter(x=>(x.name||'').toLowerCase()===k||x.aliases?.includes(k));return matches.length===1?matches[0]:null;}
function ui(catalog){return catalog.map(e=>({id:e.id,name:e.name||e.id,canonicalKey:e.id,measurement:e.measurement||'reps',bodyweight_capable:!!e.bodyweightCapable,defaults:{sets:1,repsLow:6,repsHigh:8,weight:0,durationSeconds:30}}));}
module.exports={create,validate,resolve,ui,SEED,equipment};
