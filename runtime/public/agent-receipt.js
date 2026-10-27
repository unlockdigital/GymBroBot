// Authenticated same-origin readback, held only in this page's memory.
let latest = null, generation = 0, mounted = false;
function renderReceipt() {
  let panel = document.getElementById('agent-receipt');
  if (!latest) { panel?.remove(); return; }
  const host = document.getElementById('workspace') || document.querySelector('#app .body') || document.getElementById('app');
  if (!host || panel?.parentElement === host) return;
  panel?.remove();
  panel = document.createElement('aside'); panel.id = 'agent-receipt';
  panel.setAttribute('aria-label', 'Agent save receipt');
  panel.style.cssText = 'margin:8px 0;padding:8px;border:1px solid currentColor;border-radius:8px;overflow-wrap:anywhere;font-size:12px;flex-shrink:0';
  const details = document.createElement('details'), summary = document.createElement('summary'), text = document.createElement('p');
  summary.textContent = `Agent saved ${latest.date} · View receipt`;
  text.textContent = `Version ${latest.version} · approval digest ${latest.digest} · plan digest ${latest.planDigest}`;
  details.append(summary, text); panel.append(details); host.prepend(panel);
}
export function clearAgentReceipt() { generation++; latest = null; renderReceipt(); }
export async function refreshAgentReceipt() {
  const request = ++generation;
  try {
    const r = await fetch('/bridge/bootstrap', {cache:'no-store', headers:{Authorization:'PWA'}});
    if (request !== generation) return;
    if (!r.ok) { latest = null; renderReceipt(); return; }
    const b = await r.json(); if (request !== generation) return;
    const value = Array.isArray(b.agentReceipts) ? b.agentReceipts[0] : null;
    latest = value && ['date','version','digest','planDigest'].every(k => ['string','number'].includes(typeof value[k])) ? Object.fromEntries(['date','version','digest','planDigest'].map(k => [k,String(value[k]).slice(0,256)])) : null;
    renderReceipt();
  } catch { if (request === generation) { latest = null; renderReceipt(); } }
}
export async function mountAgentReceipt() {
  if (!mounted) {
    mounted = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAgentReceipt(); });
    new MutationObserver(renderReceipt).observe(document.body, {childList:true, subtree:true});
  }
  await refreshAgentReceipt();
}
