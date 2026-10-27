import {assertLogout,pending} from './safety.js';
// The host supplies /auth/identity and /auth/logout, both authenticated/no-store.
// This gate protects the retained UI's origin-scoped snapshots on a private device.
const OWNER='gymbro.pwa.snapshot-owner.v1', CONSENT='gymbro.pwa.offline-consent.v1';
let verifiedOwner=null, identityDenied=false;
function denyIdentity(){identityDenied=true;try{localStorage.removeItem(CONSENT);}catch(_){}}
const keys=()=>Object.keys(localStorage).filter(k=>k==='gymbro.miniapp.session.v1'||k.startsWith('gymbro.offline.v1.')||k.startsWith('gymbro.miniapp.mobility'));
export function consentOffline(owner) {
 if(localStorage.getItem(OWNER)!==owner)throw Error('Verified owner required');
 localStorage.setItem(CONSENT,owner);
}
export async function authorize({requireOnline=false}={}) {
 let r;
 try {r=await fetch('/auth/identity',{credentials:'same-origin',headers:{Authorization:'PWA'},cache:'no-store'});}catch(e){
  const owner=localStorage.getItem(OWNER);
  if(!requireOnline&&!identityDenied&&owner&&localStorage.getItem(CONSENT)===owner)return owner;
  throw Error('Connect and verify identity before opening private snapshots');
 }
 if(!r.ok){denyIdentity();throw Error('Authentication required');}
 let identity;try{identity=await r.json();}catch(e){denyIdentity();throw Error('Invalid identity');}
 const {owner}=identity||{};if(typeof owner!=='string'||!owner){denyIdentity();throw Error('Invalid identity');}
 let previous;try{previous=localStorage.getItem(OWNER);}catch(e){if(verifiedOwner===owner)return owner;throw Error('Storage unavailable; matching retained identity cannot be verified');}
 if((previous&&previous!==owner)||(!previous&&keys().length)){denyIdentity();throw Error('Private snapshots belong to another or unknown owner; sign in as the matching owner or explicitly discard them');}
 identityDenied=false;verifiedOwner=owner;try{localStorage.setItem(OWNER,owner);}catch(e){if(previous!==owner)throw e;}return owner;
}
export async function logout({discardPending=false}={}) {
 if(!discardPending){
  assertLogout();
  try {
   const snap=JSON.parse(localStorage.getItem('gymbro.miniapp.session.v1')||'null');
   const queue=JSON.parse(localStorage.getItem('gymbro.offline.v1.mobility-outbox')||'[]');
   if(!Array.isArray(queue))throw Error('Invalid queue');
   if(pending(snap?.session)||queue.length)throw Error('Pending writes require sync or explicit discard');
  }catch(e){throw Error('Logout blocked: '+e.message+'. Retry, export after identity verification, or explicitly discard.');}
 }
 const r=await fetch('/auth/logout',{method:'POST',credentials:'same-origin',headers:{Authorization:'PWA'}});
 if(!r.ok)throw Error('Reconnect to revoke the server session');
 try { for(const k of keys())localStorage.removeItem(k);
 localStorage.removeItem(OWNER);localStorage.removeItem(CONSENT);
 }catch(e){throw Error('Server session revoked. Browser storage could not be cleared. Use browser site-data settings to remove retained private data.');}
 location.replace('/');
}
