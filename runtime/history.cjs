'use strict';
// Accept canonical calendar dates or explicit-zone ISO timestamps; reject rollover dates.
function timestamp(value) {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))return null;
 if(value.length>10&&(Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||Number(value.slice(17,19))>59))return null;
 const day=value.slice(0,10), dayMs=Date.parse(day);
 if(!Number.isFinite(dayMs)||new Date(dayMs).toISOString().slice(0,10)!==day)return null;
 const ms=Date.parse(value);return Number.isFinite(ms)?ms:null;
}
function create(db,id) {
 db.function('agent_session_ms',{deterministic:true},timestamp);
 const args=[id.identitySource,id.externalUserId];
 return db.transaction(()=>{
  const counts=db.prepare('SELECT count(*) AS total,sum(agent_session_ms(started_at) IS NULL) AS invalid FROM sessions WHERE identity_source=? AND external_user_id=?').get(...args);
  const sessions=db.prepare('SELECT id,started_at FROM sessions WHERE identity_source=? AND external_user_id=? AND agent_session_ms(started_at) IS NOT NULL ORDER BY agent_session_ms(started_at) DESC,id DESC LIMIT 100').all(...args);
  const ids=sessions.map(s=>s.id), placeholders=ids.map(()=>'?').join(',')||'NULL';
  const where=`identity_source=? AND external_user_id=? AND session_id IN (${placeholders})`;
  const totalSets=db.prepare(`SELECT count(*) AS n FROM sets WHERE ${where}`).get(...args,...ids).n;
  const sets=db.prepare(`SELECT id,session_id,exercise,measurement_type,weight,reps,rpe,created_at,duration_seconds,CASE substr(notes,1,instr(notes||';',';')-1) WHEN 'planned_set_type=warmup' THEN 'warmup' WHEN 'planned_set_type=working' THEN 'working' WHEN 'planned_set_type=backoff' THEN 'backoff' WHEN 'planned_set_type=drop' THEN 'drop' WHEN 'planned_set_type=calibration' THEN 'calibration' ELSE NULL END AS planned_set_type,CASE WHEN lower(coalesce(notes,'')) LIKE '%assistance_%' THEN 'assistance_flag' ELSE '' END AS notes FROM sets WHERE ${where} ORDER BY (SELECT agent_session_ms(s.started_at) FROM sessions s WHERE s.id=sets.session_id) DESC,session_id DESC,id DESC LIMIT 500`).all(...args,...ids);
  const unknownSets=db.prepare(`SELECT count(*) AS n FROM sets x WHERE x.identity_source=? AND x.external_user_id=? AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id=x.session_id AND s.identity_source=x.identity_source AND s.external_user_id=x.external_user_id)`).get(...args).n;
  const diagnostics={sessionCap:100,setCap:500,totalSessions:counts.total,selectedSessions:sessions.length,invalidSessionDates:counts.invalid||0,sessionsTruncated:counts.total>sessions.length,totalSelectedSessionSets:totalSets,selectedSets:sets.length,setsTruncated:totalSets>sets.length,unknownParentSets:unknownSets};
  diagnostics.requiresHold=diagnostics.sessionsTruncated||diagnostics.setsTruncated||unknownSets>0;
  return {sessions,sets,diagnostics};
 });
}
module.exports={create,timestamp};
