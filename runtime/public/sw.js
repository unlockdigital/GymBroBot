// Build/version must change whenever any public shell byte changes.
const VERSION = '7b20c416e20bbe51';
const CACHE = 'gymbro-public-shell-' + VERSION;
const ASSETS = ["/agent-receipt.js","/core/api.js", "/core/app.js", "/core/index.html", "/core/offline.js", "/core/styles.css", "/device.js", "/entry.js", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest", "/overlay/config.js", "/overlay/mobility.js", "/overlay/sample-workout.js", "/overlay/telemetry.js", "/owner.css", "/owner.js", "/privacy.js", "/safety.js", "/"];
const allowed = new Set(ASSETS);
self.addEventListener('install', event => event.waitUntil((async()=>{
 const cache=await caches.open(CACHE);
 // A failed install leaves the old worker active. No snapshot/outbox is touched.
 await cache.addAll(ASSETS.map(url=>new Request(url,{cache:'reload'})));
})()));
// Explicit UI-approved activation; no automatic skipWaiting during a workout.
let activating=false;
self.addEventListener('message',event=>{if(event.data?.type!=='ACTIVATE_PUBLIC_SHELL'||activating)return;activating=true;
 event.waitUntil((async()=>{try{
  const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  const safe=await Promise.all(clients.map(client=>new Promise(resolve=>{
   const channel=new MessageChannel();const timer=setTimeout(()=>resolve(false),2500);
   channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();resolve(e.data?.safe===true);};
   client.postMessage({type:'CHECK_SNAPSHOT_DURABILITY'},[channel.port2]);
  })));
  if(safe.every(Boolean))await self.skipWaiting();
  else event.source?.postMessage({type:'UPDATE_BLOCKED'});
 }finally{activating=false;}})());
});
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 for(const key of await caches.keys())if(key.startsWith('gymbro-public-shell-')&&key!==CACHE)await caches.delete(key);
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 const r=event.request,u=new URL(r.url);
 if(r.method!=='GET'||u.origin!==self.location.origin)return;
 // Exact public paths only. Auth, API, health/media and arbitrary navigations pass through.
 const shell=r.mode==='navigate'&&(u.pathname==='/core/index.html'||u.pathname==='/');
 if(!shell&&!allowed.has(u.pathname))return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  const hit=await cache.match(shell?(u.pathname==='/'?'/': '/core/index.html'):u.pathname);
  return hit||fetch(r);
 })());
});
