'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {createRoutes}=require('./vendor/route-core-schema-v2/loader.cjs');const {draft,CATALOG}=require('./planner/planner.cjs');
const data=path.join(__dirname,'data');process.umask(0o077);
function start(){
const {check}=require('./storage.cjs');check(data,true);check(path.join(data,'config.json'));const config=JSON.parse(fs.readFileSync(path.join(data,'config.json')));const {origin,port}=config;
if(config.transport!=='caddy-unix'||!/^https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(origin)||new URL(origin).origin!==origin)throw Error('Canonical HTTPS domain required');
for(const n of ['owner.sqlite','control.sqlite']){if(fs.existsSync(path.join(data,n)))check(path.join(data,n));for(const e of ['-journal','-wal','-shm'])if(fs.existsSync(path.join(data,n+e)))check(path.join(data,n+e));}
const owner=require('./owner.cjs').open({file:path.join(data,'owner.sqlite'),origin,approval:'PRIVATE_STANDALONE'});if(!owner.status().provisioned){owner.close();throw Error('Run setup first');}
const id=config.storage?.profile==='private-copy'?Object.freeze({...config.storage.owner}):{identitySource:'standalone',externalUserId:'local-owner'};const db=require('./storage.cjs').open(config.storage);
// Separate private control DB: existing workout table/schema bytes stay intact.
const controlFile=path.join(data,'control.sqlite');if(!fs.existsSync(controlFile))fs.closeSync(fs.openSync(controlFile,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600));check(controlFile);
const control=new(require('better-sqlite3'))(controlFile);control.pragma('journal_mode=DELETE');control.pragma('synchronous=FULL');control.exec('CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, body TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0)');
const auth={requireAuth:r=>{const a=owner.authenticate(r);return a.ok?{...a,owner:id}:a;},resolveOwner:a=>a.ok?a.owner:null,miniappOk:(body,_o,status=200)=>({status,body}),miniappFail:(_e,_o,status)=>({status,body:{error:'Request failed'}}),miniappAuthFail:()=>({status:401,body:{error:'Unauthorized'}}),miniappOwnerMissing:()=>({status:403}),miniappPreflight:()=>({status:204})};
const routes=createRoutes({mode:'candidate',Clock:Date,integrations:{'@/lib/miniapp-auth':auth,'@/lib/gymbro-write-db':{getWriteDb:()=>db,nowIso:()=>new Date().toISOString()},'@/lib/miniapp-events':{recordSystemEvent(){}}}});
const read=()=>Object.fromEntries(['sessions','sets','cardio_blocks'].map(t=>[t,db.prepare(`SELECT * FROM ${t} WHERE identity_source=? AND external_user_id=? ORDER BY id`).all(id.identitySource,id.externalUserId)]));
const {plan,bootstrap,historyFromRows,ownerLocalDate}=require('./planner/bridge.cjs');
let privateHooks={};if(config.storage?.profile==='private-copy'&&config.privatePlanHooks){if(!path.isAbsolute(config.privatePlanHooks)||!config.privatePlanHooks.endsWith('.cjs'))throw Error('Absolute private overlay module required');check(config.privatePlanHooks);const bytes=fs.readFileSync(config.privatePlanHooks);if(crypto.createHash('sha256').update(bytes).digest('hex')!==config.privatePlanHooksSha256)throw Error('Private overlay digest mismatch');privateHooks=require(config.privatePlanHooks);}
const catalog=require('./catalog.cjs').create(control,{privateEntries:privateHooks.catalogMetadata||[]});
const planPolicy=require('./plan-policy.cjs').create({db,id,control});
const agent=require('./agent.cjs').create({control,owner,id,catalog:catalog.list,slotState:planPolicy.state,withPlanGuard:planPolicy.withLock,planner:require('./planner/planner.cjs'),bridge:require('./planner/bridge.cjs'),training:require('./history.cjs').create(db,id)});
const privatePlans=require('./private-plan-reader.cjs').create({db,id,catalog:catalog.list,hooks:privateHooks});
const kb=()=>require('./catalog.cjs').ui(catalog.list());
const staticFiles=new Map();for(const dir of ['core','overlay'])for(const f of fs.readdirSync(path.join(__dirname,'public',dir)))staticFiles.set('/'+dir+'/'+f,path.join(__dirname,'public',dir,f));for(const f of ['agent-receipt.js','index.html','owner.js','owner.css','privacy.js','entry.js','device.js','safety.js','sw.js','manifest.webmanifest','icon-192.png','icon-512.png'])staticFiles.set('/'+f,path.join(__dirname,'public',f));
function send(res,status,body,headers={}){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; worker-src 'self'",...headers});res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));}
const admission=require('./admission.cjs').create();
const server=http.createServer({maxHeaderSize:8192},async(req,res)=>{try{
if(!require('./rate.cjs').clientKey(req.headers['x-gymbro-client-ip']))return send(res,403,{error:'Peer identity required'});
if(req.headers.host!==new URL(origin).host||req.headers['x-forwarded-proto']!=='https'||req.headers['forwarded']||req.headers['x-forwarded-host']||req.headers['x-forwarded-for'])return send(res,403,{error:'Proxy boundary denied'});
if(!admission.allow())return send(res,503,{error:'Overloaded'},{'Retry-After':'1'});
if(req.headers.origin&&req.headers.origin!==origin)return send(res,403,{error:'Origin denied'});
if(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'&& !(['GET','HEAD'].includes(req.method)&&req.headers['sec-fetch-site']==='none'))return send(res,403,{error:'Fetch site denied'});
if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==origin)return send(res,403,{error:'Origin required'});
if(!req.url.startsWith('/')||req.url.startsWith('//'))return send(res,400,{error:'Path denied'});const url=new URL(req.url,origin);let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>32768)return send(res,413,{error:'Body limit'});chunks.push(c);}const raw=Buffer.concat(chunks).toString();const headers=new Headers(req.headers);
if(req.method==='GET'&&!headers.has('origin')&&headers.get('sec-fetch-site')==='same-origin')headers.set('origin',origin);
const r=new Request(url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:raw}:{})});
if(url.pathname.startsWith('/agent/'))return send(res,404,{error:'Absent'});
const body=()=>{if(!req.headers['content-type']?.startsWith('application/json'))throw Error('JSON required');return JSON.parse(raw);};
if(url.pathname==='/auth/identity'&&req.method==='GET'){if(!owner.authenticate(r).ok)return send(res,401,{error:'Unauthorized'});return send(res,200,{owner:crypto.createHash('sha256').update(JSON.stringify(id)+owner.epoch()).digest('hex')});}
if(url.pathname==='/auth/status'&&req.method==='GET')return send(res,200,{claimed:owner.status().claimed,authenticated:owner.authenticate(r).ok===true});
if(url.pathname==='/auth/reset-recovery'&&req.method==='POST'){const result=owner.resetRecovery(r,body().password);return send(res,result.status||200,result);}
if(['/auth/claim','/auth/login','/auth/recover'].includes(url.pathname)&&req.method==='POST'){
const b=body();const result=url.pathname.endsWith('claim')?owner.claim(r,b.secret,b.password):url.pathname.endsWith('recover')?owner.recover(r,b.secret,b.password):owner.login(r,b.password);
return send(res,result.status||200,{ok:result.ok===true,...(result.recoverySecret?{recoverySecret:result.recoverySecret}:{})},result.cookie?{'Set-Cookie':result.cookie}:{});}
if(url.pathname==='/auth/logout'&&req.method==='POST'){if(!owner.authenticate(r).ok)return send(res,401,{error:'Unauthorized'});owner.logout();return send(res,200,{ok:true},{'Set-Cookie':'gymbro_pwa_session=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
if(url.pathname.startsWith('/bridge/')){
if(!owner.authenticate(r).ok)return send(res,401,{error:'Unauthorized'});
const ep=url.pathname.slice(8);if(ep==='catalog'&&req.method==='GET')return send(res,200,{exercises:catalog.list()});if(ep==='catalog'&&req.method==='POST')return send(res,201,{exercise:catalog.put(body())});if(ep==='readback'&&req.method==='GET')return send(res,200,read());
if(ep==='bootstrap'&&req.method==='GET'){const saved=[...control.prepare('SELECT id,body FROM drafts WHERE approved=1 ORDER BY rowid DESC').all().map(x=>plan(JSON.parse(x.body),x.id)),...privatePlans(ownerLocalDate())];return send(res,200,{...bootstrap(saved),agentReceipts:agent.receipts(),privateProjection:{genericMapper:true,privatePrepHooksConfigured:!!config.privatePlanHooks},ownerCalendar:{date:ownerLocalDate(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,source:"server OS timezone; confirm it matches the owner timezone"},exerciseKB:kb(),recentWeights:[]});}
if(ep==='planner/draft'&&req.method==='POST'){
const b=body();if(b.units!=='lb_total_external')return send(res,400,{error:'Confirm total external pounds'});
const rows=read();const adapted=historyFromRows(rows,b.date,'local-owner',catalog.list());const {history}=adapted;
const d=draft({owner:'local-owner',date:b.date,goal:b.goal,durationMin:b.durationMin,equipment:b.equipment,constraints:{owner:'local-owner',exclude:b.exclude,maxLoadLb:b.maxLoadLb,progression:adapted.requiresHold?'hold':b.progression},history},{catalog:catalog.list()});const key=crypto.randomBytes(16).toString('hex');control.prepare('INSERT INTO drafts(id,body) VALUES(?,?)').run(key,JSON.stringify(d));return send(res,201,{id:key,draft:d,historySessions:history.length,historySets:history.reduce((n,s)=>n+s.sets.length,0),historyDiagnostics:adapted.diagnostics,progressionHeld:adapted.requiresHold,omittedUnknownSets:adapted.diagnostics.excluded.unknown_exercise||0});}
if(ep==='planner/approve'&&req.method==='POST'){const b=body();const result=planPolicy.approveDraft({draftId:b.id,approve:b.approve,calibrationLoads:b.calibrationLoads,plan});return send(res,result.status,result.body);}
if(ep==='superset'&&req.method==='POST'){const result=require('./superset.cjs').save(db,id,body());return send(res,result.status,result.body);}
const [kind,num]=ep.split('/');if(!['session','set','cardio'].includes(kind)||ep.split('/').length>2||(num&&!/^\d+$/.test(num)))return send(res,404,{error:'Route absent'});const route=routes[kind+(num?'Item':'')];if(!route?.[req.method])return send(res,405,{error:'Method denied'});const result=await route[req.method](r,{params:Promise.resolve({id:num})});return send(res,result.status,result.body);
}
if(url.pathname==='/today'&&req.method==='GET')return send(res,302,'',{'Location':'/'});
let f=staticFiles.get(url.pathname==='/'?'/index.html':url.pathname);if(!f||req.method!=='GET')return send(res,404,{error:'Absent'});

send(res,200,fs.readFileSync(f),{...(f.endsWith('/sw.js')?{'Cache-Control':'no-cache'}:{}),'Content-Type':f.endsWith('.png')?'image/png':f.endsWith('.webmanifest')?'application/manifest+json':f.endsWith('.html')?'text/html':f.endsWith('.css')?'text/css':'text/javascript'});
}catch(e){send(res,400,{error:'Request rejected'});}});
server.maxConnections=128;server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=3000;
const agentServer=require("./agent-surface.cjs").start(agent);
const close=async()=>{await new Promise(r=>agentServer.close(r));return closeApp();};
const closeApp=()=>new Promise(resolve=>server.close(()=>{control.close();db.close();owner.close();resolve();}));
check('/run/gymbro',true);const socket='/run/gymbro/app.sock';if(fs.existsSync(socket)){const st=fs.lstatSync(socket);if(!st.isSocket()||st.uid!==process.getuid())throw Error('Owned socket required');fs.unlinkSync(socket);}server.listen(socket,()=>{fs.chmodSync(socket,0o600);console.log('Standalone VPS candidate: '+origin);});return {server,close,read};
}
module.exports={start};if(require.main===module){const app=start();let closing=false;for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{if(!closing){closing=true;app.close().then(()=>process.exit(0));}});}
