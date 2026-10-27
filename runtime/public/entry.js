import {assertDurable} from './safety.js';
import {authorize} from './privacy.js';
import {mountDevice} from './device.js';
mountDevice();
// Revalidate the same bound owner before every transport write/read. Identity
// failure preserves the outbox and returns to the gated entry document.
const transport=window.fetch.bind(window);
window.fetch=async(input,options)=>{
 const url=new URL(typeof input==='string'?input:input.url,location.href);
 if(url.origin===location.origin&&url.pathname.startsWith('/bridge/')){
  try{await authorize({requireOnline:true});}catch(e){
   if(/Authentication required|Invalid identity|Private snapshots/.test(e.message)){assertDurable();location.replace('/core/index.html');}
   if(navigator.onLine){transport('/auth/identity',{headers:{Authorization:'PWA'},cache:'no-store'}).then(r=>{if(!r.ok){assertDurable();location.replace('/core/index.html');}}).catch(()=>{});}
   throw e;
  }
 }
 return transport(input,options);
};
window.addEventListener('offline',()=>{try{assertDurable();if(!localStorage.getItem('gymbro.pwa.offline-consent.v1'))location.reload();}catch(e){document.getElementById('device-status').textContent=e.message;}});

try { await authorize(); await import('./core/app.js');document.documentElement.dataset.runtimeReady='true'; } catch(e) { document.getElementById('app').textContent=e.message; }
