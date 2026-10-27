// Private-device snapshots and a durable, ordered outbox for idempotent mobility updates.
const PREFIX = 'gymbro.offline.v1.';
export function localDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: window.MINIAPP_CONFIG?.timeZone || 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(PREFIX + key)) ?? fallback; } catch { return fallback; }
}
export function cachedRead(path) {
  const entry = read('reads', {})[path];
  return entry?.day === localDay() ? entry.data : null;
}
export function cacheRead(path, data) {
  const entries = read('reads', {});
  const day = localDay();
  for (const key of Object.keys(entries)) if (entries[key].day !== day) delete entries[key];
  entries[path] = { day, data };
  try { localStorage.setItem(PREFIX + 'reads', JSON.stringify(entries)); } catch { /* In-memory workout remains usable. */ }
}
export function pendingMobility() { return read('mobility-outbox', []); }
export function enqueueMobility(path, body) {
  const queue = pendingMobility();
  const item = { id: `${Date.now()}-${Math.random()}`, path, body };
  queue.push(item);
  // Propagate storage errors so the UI never claims an unsaved write is queued.
  localStorage.setItem(PREFIX + 'mobility-outbox', JSON.stringify(queue));
  return item;
}
let flushing = null;
export function flushMobility(send) {
  if (flushing) return flushing;
  flushing = (async () => {
    while (pendingMobility().length) {
      const item = pendingMobility()[0];
      await send(item.path, 'POST', item.body);
      localStorage.setItem(PREFIX + 'mobility-outbox', JSON.stringify(pendingMobility().filter(row => row.id !== item.id)));
    }
  })().finally(() => { flushing = null; });
  return flushing;
}
