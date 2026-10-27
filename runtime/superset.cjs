 'use strict';
// Caller authenticates and checks origin before invoking. Owner always comes from server config.
exports.save=(db,owner,b)=>{
 const fail=()=>({status:400,body:{error:'Invalid superset'}});
 if(!b||!Number.isSafeInteger(b.sessionId)||b.sessionId<=0||typeof b.superset_group!=='string'||! /^[A-Za-z0-9_-]{1,32}$/.test(b.superset_group)||!['superset','circuit'].includes(b.kind)||typeof b.label!=='string'||b.label.length>80||!Array.isArray(b.exercises)||b.exercises.length<2||b.exercises.length>50||b.exercises.some(x=>typeof x!=='string'||!x.trim()||x.length>200)||new Set(b.exercises).size!==b.exercises.length)return fail();
 const args=[owner.identitySource,owner.externalUserId];
 return db.transaction(()=>{
  if(!db.prepare('SELECT id FROM sessions WHERE id=? AND identity_source=? AND external_user_id=?').get(b.sessionId,...args))return {status:404,body:{error:'Session absent'}};
  const rows=db.prepare('SELECT id FROM supersets WHERE session_id=? AND superset_group=? AND identity_source=? AND external_user_id=? ORDER BY id').all(b.sessionId,b.superset_group,...args);
  const values=[JSON.stringify(b.exercises),b.label,b.kind];
  if(rows.length){for(const row of rows)db.prepare('UPDATE supersets SET exercises_json=?,label=?,kind=? WHERE id=? AND identity_source=? AND external_user_id=?').run(...values,row.id,...args);}
  else db.prepare('INSERT INTO supersets(session_id,superset_group,exercises_json,label,kind,created_at,identity_source,external_user_id) VALUES(?,?,?,?,?,?,?,?)').run(b.sessionId,b.superset_group,...values,new Date().toISOString(),...args);
  return {status:200,body:{ok:true}};
 })();
};
