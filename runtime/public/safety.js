// Foreground recovery state; available only after the identity gate opens the app.
let snapshot=null, failed=false, error='', locked=false;
export function pending(s){return !!s && (!s.dbSessionId || !!s.completionPending || ['pendingSets','pendingCardio','pendingSupersets'].some(k=>s[k]?.length));}
export function lockSnapshot(){locked=true;}
export function assertWritable(){if(locked)throw Error('Retained snapshot is unreadable. Use Device privacy controls to export a recovery copy, or choose Discard unsynced work and logout to clear it after server revocation.');}
export function capture(value){snapshot=value;}
export function memorySnapshot(){return snapshot;}
export function storageFailed(e){failed=true;error=String(e?.message||e);announce();}
export function storageSaved(){failed=false;error='';announce();}
export function assertDurable(){if(failed)throw Error('Browser storage failed. Keep this page open; retry storage or export a recovery copy. Closing this page can permanently lose changes.');}
export function assertLogout(){assertDurable();if(pending(snapshot?.session))throw Error('Unsynced session requires sync or explicit discard');}
export function retryStorage(){assertWritable();if(snapshot)localStorage.setItem('gymbro.miniapp.session.v1',JSON.stringify(snapshot));storageSaved();}
function announce(){if(typeof document==='undefined')return;let el=document.getElementById('storage-failure');if(!el){el=document.createElement('p');el.id='storage-failure';el.setAttribute('role','alert');document.body.prepend(el);}el.textContent=failed?'Browser storage failed: '+error+'. Changes remain in this open page only. Retry storage or export recovery. Closing this page can permanently lose changes.':'';}
if(typeof window!=='undefined')window.addEventListener('beforeunload',e=>{if(failed){e.preventDefault();e.returnValue='';}});

if(typeof navigator!=='undefined'&&navigator.serviceWorker)navigator.serviceWorker.addEventListener('message',e=>{
 if(e.data?.type==='CHECK_SNAPSHOT_DURABILITY'){let safe=true;try{assertDurable();}catch(_){safe=false;}e.ports[0]?.postMessage({safe});}
 if(e.data?.type==='UPDATE_BLOCKED'&&typeof document!=='undefined'){const el=document.getElementById('device-status');if(el)el.textContent='Update blocked: another open tab has unsaved changes or could not confirm storage. Keep that tab open and retry storage or export first.';}
});
