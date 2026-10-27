'use strict';
// Authenticated same-origin readback. Never cache or store receipt payloads.
async function agentReceipt(){try{const r=await fetch('/bridge/bootstrap',{cache:'no-store',headers:{Authorization:'PWA'}});if(!r.ok)return;const b=await r.json();let panel=document.getElementById('agent-receipt');if(!panel){panel=document.createElement('aside');panel.id='agent-receipt';panel.setAttribute('aria-label','Agent save receipt');document.body.append(panel);}panel.textContent=(b.agentReceipts||[]).slice(0,1).map(x=>`Agent saved ${x.date} • version ${x.version} • approval digest ${x.digest} • plan digest ${x.planDigest}`).join('');}catch{}}
agentReceipt();document.addEventListener('visibilitychange',()=>{if(!document.hidden)agentReceipt();});
