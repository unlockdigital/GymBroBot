'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const Database=require('/app/node_modules/better-sqlite3');
const {create,timestamp}=require('/app/history.cjs');
const db=new Database(':memory:');
db.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY,started_at TEXT,identity_source TEXT,external_user_id TEXT); CREATE TABLE sets(id INTEGER PRIMARY KEY,session_id INTEGER,exercise TEXT,measurement_type TEXT,weight REAL,reps INTEGER,rpe REAL,created_at TEXT,notes TEXT,duration_seconds INTEGER,identity_source TEXT,external_user_id TEXT)');
const session=db.prepare('INSERT INTO sessions VALUES(?,?,?,?)'),set=db.prepare("INSERT INTO sets VALUES(?,?,'bodyweight squat','reps',NULL,8,10,'2026-10-26T12:00:00Z','PRIVATE_NOTE',NULL,?,?)");
session.run(1,'2026-10-26T12:00:00Z','s','owner');set.run(1,1,'s','owner');
for(let i=2;i<=152;i++){session.run(i,'2020-01-01','s','owner');set.run(i,i,'s','owner');}
session.run(200,'2026-10-26T12:00:00Z','s','owner');session.run(201,'2026-10-27','s','other');set.run(201,201,'s','other');
const read=create(db,{identitySource:'s',externalUserId:'owner'});let x=read();
assert.deepEqual(x.sessions.slice(0,2).map(s=>s.id),[200,1]);assert.equal(x.sessions.length,100);assert(x.sets.some(s=>s.id===1));assert(x.sets.every(s=>x.sessions.some(p=>p.id===s.session_id)));assert(x.diagnostics.sessionsTruncated);assert(x.diagnostics.requiresHold);assert(!JSON.stringify(x).includes('PRIVATE'));
for(let i=300;i<900;i++)set.run(i,1,'s','owner');x=read();assert.equal(x.sets.length,500);assert(x.diagnostics.setsTruncated);assert(x.diagnostics.requiresHold);
session.run(300,'2026-02-30','s','owner');session.run(301,'invalid','s','owner');set.run(901,9999,'s','owner');x=read();assert.equal(x.diagnostics.invalidSessionDates,2);assert.equal(x.diagnostics.unknownParentSets,1);assert(x.diagnostics.requiresHold);
for(const d of ['2026-02-30','2026-10-26garbage','2026-10-26T25:00:00Z'])assert.equal(timestamp(d),null);
assert.equal(timestamp('2026-10-26T12:00:00Z'),timestamp('2026-10-26T07:00:00-05:00'));
db.close();console.log('PASS: 151 backfills, timestamp/id ties, parent coherence, both caps, owner scope, malformed dates, orphan sets, bounded privacy projection');
