'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const runtime=process.env.GYMBRO_TEST_RUNTIME||'/app';
const deps=process.env.GYMBRO_TEST_DEPS||'/app/node_modules';
const Database=require(path.join(deps,'better-sqlite3'));
const history=require(path.join(runtime,'history.cjs'));
const bridge=require(path.join(runtime,'planner/bridge.cjs'));
const db=new Database(':memory:');
try {
db.exec(`CREATE TABLE sessions(id INTEGER,identity_source TEXT,external_user_id TEXT,started_at TEXT); CREATE TABLE sets(id INTEGER,session_id INTEGER,identity_source TEXT,external_user_id TEXT,exercise TEXT,exercise_canonical TEXT,measurement_type TEXT,weight REAL,reps INTEGER,rpe REAL,created_at TEXT,duration_seconds INTEGER,notes TEXT); INSERT INTO sessions VALUES(1,'test','owner','2026-10-20T12:00:00Z'); INSERT INTO sets VALUES(1,1,'test','owner','Unlisted label','synthetic press','reps',10,8,6,'2026-10-20T12:00:00Z',NULL,'');`);
const catalog=[{id:'synthetic press',equipment:'machine',bodyweightCapable:false},{id:'other press',name:'stale name',aliases:['stale alias'],equipment:'machine',bodyweightCapable:false}];
const rows=history.create(db,{identitySource:'test',externalUserId:'owner'})();
assert.equal(rows.sets[0].exercise_canonical,'synthetic press');
assert.equal(bridge.historyFromRows(rows,'2026-10-28','owner',catalog).history[0].sets[0].exercise,'synthetic press');
const conflict={...rows,sets:[{...rows.sets[0],exercise:'other press'}]};
assert.equal(bridge.historyFromRows(conflict,'2026-10-28','owner',catalog).history[0].sets[0].exercise,'other press');
for(const canonical of ['unknown',null,'stale name','stale alias']) {const out=bridge.historyFromRows({...rows,sets:[{...rows.sets[0],exercise_canonical:canonical}]},'2026-10-28','owner',catalog);assert.equal(out.diagnostics.excluded.unknown_exercise,1);assert.equal(out.requiresHold,true);}
const timed={...rows,sets:[{...rows.sets[0],measurement_type:'duration_seconds',duration_seconds:30,reps:null}]};assert.equal(bridge.historyFromRows(timed,'2026-10-28','owner',catalog).history[0].sets[0].duration_seconds,30);
const unit={...rows,sets:[{...rows.sets[0],unit:'unverified'}]};assert.equal(bridge.historyFromRows(unit,'2026-10-28','owner',catalog).diagnostics.excluded.unsupported_units,1);
const old=new Database(':memory:');old.exec(`CREATE TABLE sessions(id INTEGER,identity_source TEXT,external_user_id TEXT,started_at TEXT); CREATE TABLE sets(id INTEGER,session_id INTEGER,identity_source TEXT,external_user_id TEXT,exercise TEXT,measurement_type TEXT,weight REAL,reps INTEGER,rpe REAL,created_at TEXT,duration_seconds INTEGER,notes TEXT);`);
old.exec("INSERT INTO sessions VALUES(1,'test','owner','2026-10-20T12:00:00Z'); INSERT INTO sets VALUES(1,1,'test','owner','Unlisted label','reps',10,8,6,'2026-10-20T12:00:00Z',NULL,'');");
assert.equal(history.create(old,{identitySource:'test',externalUserId:'owner'})().sets[0].exercise_canonical,null);old.close();
// A stored canonical value must identify a catalog ID; names and aliases remain display-label inputs.
const displayAlias={...rows,sets:[{...rows.sets[0],exercise:'stale alias'}]};
assert.equal(bridge.historyFromRows(displayAlias,'2026-10-28','owner',catalog).history[0].sets[0].exercise,'other press');
// Unrelated owner rows remain outside the requested identity scope.
db.prepare("INSERT INTO sessions VALUES(2,'other','owner-2','2026-10-21T12:00:00Z')").run();
db.prepare("INSERT INTO sets VALUES(2,2,'other','owner-2','Private label','synthetic press','reps',99,9,9,'2026-10-21T12:00:00Z',NULL,'private note')").run();
const isolated=history.create(db,{identitySource:'test',externalUserId:'owner'})();assert.equal(isolated.sets.length,1);assert(!JSON.stringify(isolated).includes('private note'));
// Assistance data remains parsed from stored notes and follows the existing bodyweight eligibility rules.
const assistedCatalog=[{id:'push up',equipment:'bodyweight',bodyweightCapable:true}];
const assisted={...rows,sets:[{...rows.sets[0],exercise:'unknown',exercise_canonical:'push up',weight:null,notes:'assistance_lb=20'}]};
const assistedOut=bridge.historyFromRows(assisted,'2026-10-28','owner',assistedCatalog);assert.equal(assistedOut.history[0].sets[0].loadMode,'assisted');assert.equal(assistedOut.history[0].sets[0].assistanceLb,20);
console.log('PASS catalog canonical fallback, label precedence, unknown hold, units, timed rows, legacy schema, isolation, assistance');
} finally { db.close(); }
