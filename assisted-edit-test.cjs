'use strict';

// Execute the shipped app's functions/actions with host adapters for UI and I/O.
// Optional source argument supports running this same suite against another tree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const sourcePath = process.argv[2] || path.join(__dirname, 'runtime/public/core/app.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function sourceFunction(name, optional = false) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  if (!start && optional) return '';
  assert.ok(start, `App function exists: ${name}`);
  const rest = source.slice(start.index);
  const end = rest.search(/^}\r?$/m);
  assert.ok(end > 0, `App function closes: ${name}`);
  return rest.slice(0, end + 1);
}

function sourceAction(name, next) {
  const start = source.indexOf(`  '${name}':`);
  const end = source.indexOf(`  '${next}':`, start + 1);
  assert.ok(start >= 0 && end > start, `App action exists: ${name}`);
  return source.slice(start, end);
}

const appCode = [
  ...['cleanUserNote', 'formatSetNotes', 'persistSet', 'renderEditSetSheet',
    'repLabelForExercise', 'fmtTime', 'fmtNum', 'escapeHtml'].map(n => sourceFunction(n)),
  // Baseline performs this serialization inline, so the helper is optional.
  sourceFunction('setWeightForDb', true),
  'globalThis.actions = {',
  sourceAction('open-edit-set', 'close-edit-set'),
  sourceAction('commit-edit-set', 'delete-logged-set'),
  '};',
].join('\n');

const clone = value => JSON.parse(JSON.stringify(value));

async function fixture({ synced, mode = 'assisted', timed = false, capable = true }) {
  const set = {
    clientSetId: 'set-under-edit', dbSetId: synced ? 101 : null,
    loggedAt: 1793181600000, weight: mode === 'added' ? 20 : 0,
    assistanceMode: mode, assistanceLbs: mode === 'assisted' ? 60 : null,
    reps: timed ? null : 8, durationSeconds: timed ? 30 : null, rpe: 6,
    note: 'controlled',
  };
  const untouched = { clientSetId: 'other-set', weight: 12, reps: 10 };
  const ex = {
    id: 'synthetic-slot', name: 'Synthetic station', bodyweight_capable: capable,
    measurement: timed ? 'duration' : 'reps', sets: [set, untouched],
    setPlan: [{ type: 'backoff' }, { type: 'working' }],
  };
  const updates = [];
  const ctx = {
    state: { session: { exercises: [ex], pendingSets: [] } },
    api: { updateSet: async (id, payload) => updates.push({ id, ...clone(payload) }) },
    // UI/storage/network scheduling adapters; serialization runs from app source.
    haptic() {}, hapticNotify() {}, track() {}, renderPreservingScroll() {},
    saveSessionLocal() {}, retryPendingIfResumed: async () => {},
    showToast() {}, isRotateSlot: () => false, canonicalKeyForExercise: e => e.id,
    trackError: (_name, err) => { throw err; },
  };
  vm.createContext(ctx);
  vm.runInContext(appCode, ctx, { filename: 'app-edit-source.js' });
  await ctx.persistSet(ex, set);
  const initial = clone(ctx.state.session.pendingSets[0]);
  if (synced) ctx.state.session.pendingSets.length = 0;
  const otherPending = { client_set_id: 'other-pending', weight: 99, reps: 5 };
  ctx.state.session.pendingSets.push(otherPending);
  const beforeOthers = clone({ untouched, otherPending });

  function open() {
    ctx.actions['open-edit-set'](null, { dataset: { exId: ex.id, setIdx: '0' } });
    assert.ok(ctx.state.editSet);
  }
  async function commit(changes) {
    Object.assign(ctx.state.editSet, changes);
    await ctx.actions['commit-edit-set']();
    assert.equal(ctx.state.editSet, null, 'edit completes');
    assert.deepEqual(clone({ untouched, otherPending }), beforeOthers, 'other sets preserved');
    if (synced) {
      assert.equal(updates.at(-1).id, 101, 'correct server row');
      assert.equal(ctx.state.session.pendingSets.length, 1, 'synced edit creates no outbox entry');
      return updates.at(-1);
    }
    assert.equal(updates.length, 0, 'queued edit sends no PATCH');
    assert.equal(ctx.state.session.pendingSets.length, 2, 'queued edit retains one stable write');
    const pending = ctx.state.session.pendingSets.find(p => p.client_set_id === set.clientSetId);
    assert.equal(pending.measurement_type, timed ? 'duration_seconds' : 'reps');
    return clone(pending);
  }
  return { ctx, set, ex, initial, open, commit };
}

function payloadFields(payload) {
  return Object.fromEntries(['weight', 'reps', 'duration_seconds', 'rpe', 'notes']
    .map(key => [key, payload[key]]));
}

for (const synced of [true, false]) {
  const route = synced ? 'synced PATCH' : 'queued outbox';

  test(`${route}: assisted reps correction preserves NULL external weight and help marker`, async () => {
    const f = await fixture({ synced });
    assert.equal(f.initial.weight, null, 'initial logging convention');
    assert.equal(f.initial.notes, 'planned_set_type=backoff; controlled; assistance_lb=60');
    // Restored bodyweight sets can carry NULL locally as well as zero.
    if (synced) f.set.weight = null;
    f.open();
    const payload = await f.commit({ reps: 9, rpe: 7, note: '  steady   tempo  ' });
    assert.deepEqual(payloadFields(payload), {
      weight: null, reps: 9, duration_seconds: null, rpe: 7,
      notes: 'planned_set_type=backoff; steady tempo; assistance_lb=60',
    });
    assert.equal(f.set.weight, 0);
    assert.equal(f.set.assistanceLbs, 60);
  });

  test(`${route}: assistance correction refreshes marker across successive edits`, async () => {
    const f = await fixture({ synced });
    for (const help of [45, 35, 0]) {
      f.open();
      const payload = await f.commit({ weight: help });
      assert.deepEqual(payloadFields(payload), {
        weight: null, reps: 8, duration_seconds: null, rpe: 6,
        notes: 'planned_set_type=backoff; controlled' + (help ? `; assistance_lb=${help}` : ''),
      });
      assert.equal(f.set.weight, 0);
      assert.equal(f.set.assistanceLbs, help);
    }
    f.open();
    assert.equal(f.ctx.state.editSet.weight, 0, 'reopening reflects corrected help');
  });

  test(`${route}: assistance editor seeds help amount and labels its meaning`, async () => {
    const f = await fixture({ synced });
    f.open();
    assert.equal(f.ctx.state.editSet.weight, 60);
    assert.match(f.ctx.renderEditSetSheet(), /class="es-label">Assistance<\/span>/);
  });

  for (const timed of [false, true]) {
    test(`${route}: pure bodyweight accepts positive added load (${timed ? 'timed' : 'reps'})`, async () => {
      const f = await fixture({ synced, mode: 'pure_bw', timed });
      f.open();
      const payload = await f.commit({ weight: 20 });
      assert.equal(payload.weight, 20, 'editable added load is persisted');
      assert.equal(f.set.weight, 20);
      assert.equal(f.set.assistanceMode, 'added');
      assert.equal(f.set.assistanceLbs, null);
      assert.equal(payload.notes, 'planned_set_type=backoff; controlled');
      assert.equal(payload.reps, timed ? null : 8);
      assert.equal(payload.duration_seconds, timed ? 30 : null);
      f.open();
      assert.equal(f.ctx.state.editSet.weight, 20);
    });
  }

  test(`${route}: zero assistance becomes pure bodyweight and permits later added load`, async () => {
    const f = await fixture({ synced });
    f.set.assistanceLbs = 40;
    f.open();
    assert.equal(f.ctx.state.editSet.weight, 40);
    const payload = await f.commit({ weight: 0 });
    assert.equal(payload.weight, null);
    assert.equal(payload.notes, 'planned_set_type=backoff; controlled');
    assert.equal(f.set.weight, 0);
    assert.equal(f.set.assistanceMode, 'pure_bw');
    f.open();
    assert.equal(f.ctx.state.editSet.weight, 0);
    assert.match(f.ctx.renderEditSetSheet(), /class="es-label">Added weight<\/span>/);
    const added = await f.commit({ weight: 20 });
    assert.equal(added.weight, 20);
    assert.equal(f.set.assistanceMode, 'added');
    assert.equal(added.notes, 'planned_set_type=backoff; controlled');
  });

  for (const control of [
    { name: 'added load', mode: 'added', weight: 25, dbWeight: 25, label: 'Added weight' },
    { name: 'zero added load', mode: 'added', weight: 0, dbWeight: 0, label: 'Added weight' },
    { name: 'pure bodyweight', mode: 'pure_bw', weight: 0, dbWeight: null, label: 'Added weight' },
    { name: 'ordinary resistance', mode: null, capable: false, weight: 40, dbWeight: 40, label: 'Weight' },
    { name: 'timed added load', mode: 'added', timed: true, weight: 10, dbWeight: 10, label: 'Added weight' },
    { name: 'timed bodyweight', mode: 'pure_bw', timed: true, weight: 0, dbWeight: null, label: 'Added weight' },
  ]) {
    test(`${route}: ${control.name} retains its edit semantics`, async () => {
      const f = await fixture({ synced, ...control });
      f.open();
      assert.match(f.ctx.renderEditSetSheet(), new RegExp(`class="es-label">${control.label}<\\/span>`));
      const payload = await f.commit({ weight: control.weight, reps: 11, durationSeconds: 45, rpe: 7 });
      assert.deepEqual(payloadFields(payload), {
        weight: control.dbWeight, reps: control.timed ? null : 11,
        duration_seconds: control.timed ? 45 : null, rpe: 7,
        notes: 'planned_set_type=backoff; controlled',
      });
      assert.equal(f.set.assistanceMode, control.mode);
      assert.equal(f.set.weight, control.weight);
      assert.equal(f.set.reps, control.timed ? null : 11);
      assert.equal(f.set.durationSeconds, control.timed ? 45 : null);
    });
  }
}
