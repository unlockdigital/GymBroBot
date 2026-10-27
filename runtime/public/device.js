import {assertDurable,retryStorage,memorySnapshot} from './safety.js';
import {authorize,consentOffline,logout} from './privacy.js';
export function mountDevice(){
 const old=document.getElementById('logout');if(old)old.remove();
 const box=document.createElement('details');box.id='device-controls';const title=document.createElement('summary');title.textContent='Device privacy, install and updates';box.append(title);
 const info=document.createElement('p');info.textContent='Workout snapshots and pending writes use plaintext browser storage. Enable offline access only on a private device. Anyone with device access may read it. Offline access cannot verify remote revocation or cookie expiry until reconnect. Keep this browser profile to preserve unsynced work.';box.append(info);
 const msg=document.createElement('p');msg.id='device-status';msg.setAttribute('role','status');
 const action=(id,label,fn)=>{const b=document.createElement('button');b.id=id;b.textContent=label;b.onclick=async()=>{try{await fn();}catch(e){msg.textContent=e.message;}};box.append(b);};
 action('offline-enable','Enable private-device offline access',async()=>{const owner=await authorize({requireOnline:true});if(!navigator.onLine)throw Error('Connect before giving consent');consentOffline(owner);msg.textContent='Offline access enabled for this verified owner.';});
 action('offline-disable','Require online identity at next open',()=>{localStorage.removeItem('gymbro.pwa.offline-consent.v1');msg.textContent='Online identity required at next open. Pending work preserved.';});
 action('logout','Sync first / logout',()=>logout());
 action('retry-storage','Retry browser storage',()=>{retryStorage();msg.textContent='Current snapshot saved to browser storage.';});
 action('export-local','Export local recovery copy',async()=>{await authorize();const data={};try{for(const k of Object.keys(localStorage).filter(k=>k==='gymbro.miniapp.session.v1'||k.startsWith('gymbro.offline.v1.')||k.startsWith('gymbro.miniapp.mobility')))data[k]=localStorage.getItem(k);}catch(e){data.storageReadError='Browser storage unavailable; only foreground data included';}data.foregroundSnapshot=memorySnapshot();const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'}));a.download='private-workout-recovery.json';a.click();URL.revokeObjectURL(a.href);msg.textContent='Keep the plaintext recovery copy private.';});
 action('discard-logout','Discard unsynced work and logout',async()=>{if(confirm('Permanently discard unsynced workout changes after server logout succeeds? Export a recovery copy first if needed.'))await logout({discardPending:true});});
 let prompt;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();prompt=e;msg.textContent='Install available.';});
 action('install-app','Install app / instructions',async()=>{if(prompt){await prompt.prompt();prompt=null;}else msg.textContent='Use your browser Install menu when available. iOS Safari: Share → Add to Home Screen. Trusted local TLS and platform support are required.';});
 let registration;
 action('check-update','Check shell update',async()=>{await registration.update();msg.textContent=registration.waiting?'Update ready. Apply checks browser persistence before reload.':'Shell checked.';});
 action('apply-update','Apply waiting update and reload',()=>{assertDurable();if(!registration?.waiting)throw Error('No waiting update');navigator.serviceWorker.addEventListener('controllerchange',()=>{try{assertDurable();location.reload();}catch(e){msg.textContent=e.message;}},{once:true});registration.waiting.postMessage({type:'ACTIVATE_PUBLIC_SHELL'});});
 box.append(msg);document.body.prepend(box);
 if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}).then(r=>{registration=r;}).catch(e=>msg.textContent=e.message);
}
