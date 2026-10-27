'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const Database=require('better-sqlite3');
const {createBoundary}=require('./vendor/owner-boundary/contract.cjs');
const {clientKey}=require('./rate.cjs');
const base=path.join(__dirname,'data');
const random=()=>crypto.randomBytes(32).toString('base64url');
const digest=s=>crypto.createHash('sha256').update(typeof s==='string'&&s.length<=1024?s:'').digest();
const equal=(a,b)=>crypto.timingSafeEqual(digest(a),Buffer.from(b,'hex'));
function password(p,salt){return crypto.scryptSync(p,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024}).toString('hex');}
const validPassword=p=>typeof p==='string'&&Buffer.byteLength(p)>=16&&Buffer.byteLength(p)<=256;
function open({file,origin,now=Date.now,approval}){
 if(approval!=='PRIVATE_STANDALONE')throw Error('Private standalone approval required');
 if(new URL(origin).protocol!=='https:'||new URL(origin).origin!==origin)throw Error('HTTPS origin required');
 const root=path.dirname(file);
 if(!path.isAbsolute(file)||root!==base||path.basename(file)!=='owner.sqlite')throw Error('Isolated path required');
 for(const p of [base]){const s=fs.lstatSync(p);if(s.isSymbolicLink()||!s.isDirectory()||(s.mode&0o777)!==0o700)throw Error('Private directory required');}
 if(!fs.existsSync(file))fs.closeSync(fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600));
 const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||(st.mode&0o777)!==0o600)throw Error('Private file required');
 const db=new Database(file);db.pragma('busy_timeout=5000');db.pragma('journal_mode=DELETE');db.pragma('synchronous=FULL');
 db.exec(`CREATE TABLE IF NOT EXISTS lifecycle(id INTEGER PRIMARY KEY CHECK(id=1),claim TEXT,expires INTEGER,claimed INTEGER NOT NULL DEFAULT 0,salt TEXT,hash TEXT,recovery TEXT,generation INTEGER NOT NULL DEFAULT 0,key TEXT);
 CREATE TABLE IF NOT EXISTS throttle(kind TEXT PRIMARY KEY,started INTEGER NOT NULL,attempts INTEGER NOT NULL);`);
 db.exec('CREATE TABLE IF NOT EXISTS rate_identity(id INTEGER PRIMARY KEY CHECK(id=1),key TEXT NOT NULL)');
 db.prepare('INSERT OR IGNORE INTO rate_identity VALUES(1,?)').run(random());
 const tx=fn=>db.transaction(fn).immediate();
 function allowed(req){try{return new URL(req.url).origin===origin&&req.headers.get('origin')===origin&&[null,'same-origin'].includes(req.headers.get('sec-fetch-site'));}catch{return false;}}
 const denied=()=>({ok:false,status:403});
 // Persistent, bounded buckets; raw addresses never enter the database.
 let rateKey;
 function rowKey(){return db.prepare('SELECT key FROM rate_identity WHERE id=1').get().key;}
 function limit(kind,req,max=5){
  const t=now(),client=req?clientKey(req.headers.get('x-gymbro-client-ip')):'global';if(!client)return false;
  rateKey ||= crypto.createHash('sha256').update('rate:'+rowKey()).digest();
  const key=kind+':'+crypto.createHmac('sha256',rateKey).update(client).digest('hex');
  db.prepare('DELETE FROM throttle WHERE started<=?').run(t-60000);
  const r=db.prepare('SELECT * FROM throttle WHERE kind=?').get(key);
  if(r){if(r.attempts>=max)return false;db.prepare('UPDATE throttle SET attempts=attempts+1 WHERE kind=?').run(key);}
  else {if(db.prepare('SELECT count(*) n FROM throttle').get().n>=4096)return false;db.prepare('INSERT INTO throttle VALUES (?,?,1)').run(key,t);}
  return true;
 }
 const prune=()=>db.prepare('DELETE FROM throttle WHERE started<=?').run(now()-60000);prune();
 const reaper=setInterval(prune,30000);reaper.unref();
 let cached,cacheEpoch;
 const row=()=>db.prepare('SELECT * FROM lifecycle WHERE id=1').get();
 function boundary(r){const epoch=r.key+':'+r.generation;if(cacheEpoch===epoch)return cached;const next=createBoundary({origin,sessionSecret:crypto.createHmac('sha256',r.key).update('session:'+r.generation).digest('hex'),gatewayToken:crypto.createHmac('sha256',r.key).update('gateway:'+r.generation).digest('hex'),owner:{identitySource:'standalone',externalUserId:'local-owner'},isKnownUser:()=>Boolean(row()?.claimed),Clock:class extends Date{static now(){return now();}}});cached=next;cacheEpoch=epoch;return cached;}
 return {
 // Local administrative capability: never expose through an HTTP route.
 status(){const r=row();return {provisioned:!!r,claimed:!!r?.claimed};},
 renewClaim(){return tx(()=>{const r=row();if(!r||r.claimed)throw Error('Unclaimed installation required');const secret=random();db.prepare('UPDATE lifecycle SET claim=?,expires=? WHERE id=1').run(digest(secret).toString('hex'),now()+600000);return {claimSecret:secret};});},
 provision(){return tx(()=>{if(row())throw Error('Already provisioned');const secret=random();db.prepare('INSERT INTO lifecycle(id,claim,expires,key) VALUES(1,?,?,?)').run(digest(secret).toString('hex'),now()+600000,random());return {claimSecret:secret,expiresAt:now()+600000};});},
 claim(req,secret,p){if(req.method!=='POST'||!allowed(req))return denied();return tx(()=>{const r=row();const proof=equal(secret,r?.claim||'00'.repeat(32));if(!r||r.claimed||now()>=r.expires||!proof||!validPassword(p))return denied();if(!limit('claim-proof',null,5))return denied();const salt=random(),recovery=random();db.prepare('UPDATE lifecycle SET claimed=1,claim=NULL,expires=NULL,salt=?,hash=?,recovery=?,generation=generation+1 WHERE id=1 AND claimed=0').run(salt,password(p,salt),digest(recovery).toString('hex'));return {ok:true,recoverySecret:recovery};});},
 login(req,p){if(req.method!=='POST'||!allowed(req))return denied();return tx(()=>{if(!limit('login',req)||!limit('password-work',null,30))return {ok:false,status:429};const r=row();const candidate=password(validPassword(p)?p:'synthetic invalid password',r?.salt||'synthetic dummy salt');const proof=crypto.timingSafeEqual(Buffer.from(candidate,'hex'),Buffer.from(r?.hash||'00'.repeat(32),'hex'));if(!r?.claimed||!validPassword(p)||!proof)return denied();const gateway=crypto.createHmac('sha256',r.key).update('gateway:'+r.generation).digest('hex');const headers=new Headers(req.headers);headers.set('x-gymbro-gateway-token',gateway);return boundary(r).issue(new Request(req.url,{method:'POST',headers}));});},
 recover(req,secret,p){if(req.method!=='POST'||!allowed(req))return denied();return tx(()=>{const r=row(),proof=equal(secret,r?.recovery||'00'.repeat(32));if(!r?.claimed||!proof||!validPassword(p))return denied();if(!limit('recovery-proof',req,5))return {ok:false,status:429};const salt=random(),recovery=random();db.prepare('UPDATE lifecycle SET salt=?,hash=?,recovery=?,generation=generation+1,key=? WHERE id=1').run(salt,password(p,salt),digest(recovery).toString('hex'),random());return {ok:true,recoverySecret:recovery};});},
 recoverLocal(secret,p){const r=row();if(!r?.claimed||!equal(secret,r.recovery)||!validPassword(p))return denied();return tx(()=>{const salt=random(),recovery=random();db.prepare('UPDATE lifecycle SET salt=?,hash=?,recovery=?,generation=generation+1,key=? WHERE id=1').run(salt,password(p,salt),digest(recovery).toString('hex'),random());return {ok:true,recoverySecret:recovery};});},
 // Password reauthentication deliberately works without a session cookie: delivery loss
 // and revoked/stale sessions must remain recoverable. Same-origin PWA only.
 resetRecovery(req,p){if(req.method!=='POST'||!allowed(req)||req.headers.get('authorization')!=='PWA')return denied();return tx(()=>{
  if(!limit('login',req)||!limit('password-work',null,30))return {ok:false,status:429};
  const r=row(),candidate=password(validPassword(p)?p:'synthetic invalid password',r?.salt||'synthetic dummy salt');
  if(!r?.claimed||!validPassword(p)||!crypto.timingSafeEqual(Buffer.from(candidate,'hex'),Buffer.from(r.hash,'hex')))return denied();
  const recovery=random();db.prepare('UPDATE lifecycle SET recovery=?,generation=generation+1 WHERE id=1').run(digest(recovery).toString('hex'));
  return {ok:true,recoverySecret:recovery};
 });},
 // Stopped-app, exclusive-lock path. Caller retains a randomly generated replacement
 // before invoking this operation; stdout never needs to carry a recovery capability.
 resetRecoveryLocal(p,replacement){return tx(()=>{
  const r=row();if(!r?.claimed||!validPassword(p)||typeof replacement!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(replacement))return denied();
  if(!limit('console-password',null,5))return {ok:false,status:429};
  if(!crypto.timingSafeEqual(Buffer.from(password(p,r.salt),'hex'),Buffer.from(r.hash,'hex')))return denied();
  db.prepare('UPDATE lifecycle SET recovery=?,generation=generation+1 WHERE id=1').run(digest(replacement).toString('hex'));return {ok:true};
 });},
 authenticate(req){if(req.headers.get('authorization')!=='PWA'||!/(?:^|;\s*)gymbro_pwa_session=/.test(req.headers.get('cookie')||''))return denied();return tx(()=>{const r=row();return r?.claimed?boundary(r).authenticate(req):denied();});},
 epoch(){const r=row();return r.key+':'+r.generation;},
 logout(){db.prepare('UPDATE lifecycle SET generation=generation+1 WHERE id=1').run();},
 close(){clearInterval(reaper);db.close();}
 };
}
module.exports={open};
