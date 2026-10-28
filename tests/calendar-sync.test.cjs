const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../calendar-sync-core.js');
const sourceId = 'a'.repeat(32);
const initial = () => ({ sourceId, deviceId: 'device-a', calendarId: 'dedicated@group.calendar.google.com', revision: '' });
const snapshot = () => ({ today: '2026-09-01', cases: [
  { name: '案件A', deadline: '2026-09-04', paydue: '2026-08-31', paymentStatus: 'paid', contact: 'do-not-export', price: 999999, detail: '青い衣装・笑顔\nhttps://example.test/reference', memo: 'internal-only' },
  { name: '案件B', deadline: '2026-09-04', paydue: '2026-09-02', paymentStatus: 'unpaid', detail: '立ち絵' }
], schedule: {
  '2026-09-01': { morning: { idx: 0, kind: 'rough', caseName: '案件A' }, night: null, wait: [{ idx: 1, caseName: '案件B' }] },
  '2026-09-02': { morning: null, night: { idx: 0, kind: 'clean', caseName: '案件A' }, wait: [] }
} });
function fakeApi() {
  const db = new Map(), calls = [];
  let serial = 0, fail = null;
  async function api(path, opt = {}) {
    const method = opt.method || 'GET';
    calls.push({ path, ...opt, method });
    if (fail && fail(path, opt)) throw new Error('simulated network interruption');
    if (method === 'GET') return { items: [...db.values()].map(v => structuredClone(v)) };
    const id = method === 'POST' ? opt.body.id : decodeURIComponent(path.split('/').at(-1).split('?')[0]);
    const old = db.get(id);
    if (method === 'POST' && old) throw Object.assign(new Error('conflict'), { status: 409 });
    if (opt.etag && old?.etag !== opt.etag) throw Object.assign(new Error('etag'), { status: 412 });
    if (method === 'DELETE') { db.delete(id); return {}; }
    const body = structuredClone(opt.body);
    const next = { ...(old || {}), ...body, id, etag: 'e' + ++serial };
    // Google PATCH merges EventDateTime subfields instead of replacing the object.
    if (method === 'PATCH' && old) {
      for (const field of ['start', 'end']) {
        if (!body[field]) continue;
        next[field] = { ...(old[field] || {}), ...body[field] };
        for (const [key, value] of Object.entries(next[field])) if (value === null) delete next[field][key];
      }
    }
    db.set(id, next);
    return structuredClone(next);
  }
  return { api, db, calls, fail: fn => { fail = fn; } };
}
const sync = (server, state, data = snapshot(), options = {}) => Core.synchronize({
  api: server.api, state, snapshot: data, save() {},
  now: options.now || (() => new Date('2026-09-01T12:00:00Z')), takeover: options.takeover || false
});

test('exports the displayed slots and grouped dates, with no billing or contact data', () => {
  const data = snapshot();
  data.profile = { bankInfo: 'bank-secret' };
  const events = Core.buildEvents(data).map(e => Core.body(e, sourceId));
  assert.equal(events.length, 4);
  const morning = events.find(e => e.summary.startsWith('☀️'));
  assert.equal(morning.summary, '☀️ 案件A｜大ラフ');
  assert.match(morning.description, /工程：大ラフ\n納期：2026-09-04\n\n依頼詳細：\n青い衣装・笑顔/);
  assert.ok(!morning.description.includes('編集元') && !morning.description.includes('枠：'));
  const deadline = events.find(e => e.summary.startsWith('🔴'));
  const paymentDue = events.find(e => e.summary.startsWith('🟡'));
  assert.equal(deadline.summary, '🔴 案件A／案件B');
  assert.match(deadline.description, /納期：2026-09-04\n案件A\n案件B/);
  assert.equal(paymentDue.summary, '🟡 案件B');
  assert.match(paymentDue.description, /支払期限：2026-09-02\n案件B/);
  assert.ok(!events.some(event => event.summary.includes('返信待ち')));
  const text = JSON.stringify(events);
  assert.ok(text.includes('https://example.test/reference'));
  for (const secret of ['do-not-export', '999999', 'internal-only', 'bank-secret']) assert.ok(!text.includes(secret));
  for (const event of events) {
    assert.equal(event.transparency, 'transparent');
    assert.deepEqual(event.reminders, { useDefault: false, overrides: [] });
    assert.equal(event.visibility, 'private');
    assert.equal(Date.parse(event.end.date) - Date.parse(event.start.date), 86400000);
  }
});
test('delivered unpaid cases retain only their payment due event', () => {
  const data = { today: '2026-09-01', cases: [{ name: '納品済み後払い', step: '5', deadline: '2026-09-04', paydue: '2026-09-18', paymentStatus: 'unpaid' }], schedule: {} };
  const events = Core.buildEvents(data);
  assert.deepEqual(events.map(event => event.title), ['🟡 納品済み後払い']);
});
test('uses a custom client label when available and otherwise a Google event color', () => {
  const custom = Core.body({ key: 'work:x', date: '2026-09-01', title: '予定', detail: '',
    labelId: '12345678-1234-4234-8234-123456789abc', colorId: '7' }, sourceId);
  assert.equal(custom.eventLabelId, '12345678-1234-4234-8234-123456789abc');
  assert.ok(!custom.colorId);
  const standard = Core.body({ key: 'work:y', date: '2026-09-01', title: '予定', detail: '', colorId: '7' }, sourceId);
  assert.equal(standard.colorId, '7');
});
test('removes an existing custom label when falling back to a standard event color', async () => {
  const server = fakeApi(), state = initial(), custom = snapshot();
  custom.cases[0].calendarLabelId = '12345678-1234-4234-8234-123456789abc';
  custom.cases[0].calendarColorId = '7';
  await sync(server, state, custom);
  const standard = snapshot();
  standard.cases[0].calendarColorId = '7';
  await sync(server, state, standard);
  assert.ok(server.calls.some(call => call.method === 'PATCH' && call.body?.eventLabelId === '' &&
    call.path.includes('eventLabelVersion=1')));
});
test('restores a timed managed event to all-day without leaving conflicting time fields', async () => {
  const server = fakeApi(), state = initial();
  await sync(server, state);
  const managed = [...server.db.values()].find(event => event.summary?.startsWith('☀️'));
  managed.start = { dateTime: '2026-09-01T11:00:00+09:00', timeZone: 'Asia/Tokyo' };
  managed.end = { dateTime: '2026-09-01T12:00:00+09:00', timeZone: 'Asia/Tokyo' };
  managed.etag = 'manually-timed';
  const result = await sync(server, state);
  assert.equal(result.updated, 1);
  assert.equal(server.db.get(managed.id).start.date, '2026-09-01');
  assert.equal(server.db.get(managed.id).end.date, '2026-09-02');
  assert.ok(!server.db.get(managed.id).start.dateTime && !server.db.get(managed.id).end.dateTime);
  const call = server.calls.findLast(item => item.method === 'PATCH' && item.body?.summary?.startsWith('☀️'));
  assert.equal(call.body.start.dateTime, null);
  assert.equal(call.body.end.dateTime, null);
});
test('all-day boundaries handle month/year/leap rollover and reject invalid dates', () => {
  assert.equal(Core.nextDay('2026-12-31'), '2027-01-01');
  assert.equal(Core.nextDay('2028-02-28'), '2028-02-29');
  assert.equal(Core.nextDay('2028-02-29'), '2028-03-01');
  assert.throws(() => Core.nextDay('2026-02-30'));
});
test('repeated sync does not duplicate or rewrite unchanged work events', async () => {
  const server = fakeApi(), state = initial();
  const first = await sync(server, state);
  assert.equal(first.created, 4);
  const second = await sync(server, state);
  assert.deepEqual(second, { count: 4, created: 0, updated: 0, removed: 0 });
  assert.equal(server.db.size, 5); // Four events and the freshness/status record.
});
test('replaces legacy deadline labels with emoji without duplicating events', async () => {
  const server = fakeApi(), state = initial();
  await sync(server, state);
  for (const event of server.db.values()) {
    if (event.summary?.startsWith('🔴 ')) event.summary = event.summary.replace('🔴 ', '［納期］');
    if (event.summary?.startsWith('🟡 ')) event.summary = event.summary.replace('🟡 ', '［支払期限］');
  }
  const beforeSize = server.db.size;
  const result = await sync(server, state);
  assert.equal(result.created, 0);
  assert.equal(result.updated, 2);
  assert.equal(result.removed, 0);
  assert.equal(server.db.size, beforeSize);
  const summaries = [...server.db.values()].map(event => event.summary);
  assert.ok(summaries.includes('🔴 案件A／案件B'));
  assert.ok(summaries.includes('🟡 案件B'));
  assert.ok(!summaries.some(summary => /^［(?:納期|支払期限)］/.test(summary || '')));
});
test('changes and deletion affect only this source; manual and unrelated events survive', async () => {
  const server = fakeApi(), state = initial();
  await sync(server, state);
  server.db.set('manual', { id: 'manual', summary: '手入力の予定' });
  server.db.set('foreign', { id: 'foreign', ...Core.body({ key: 'other', date: '2026-09-01', title: '別の元データ', detail: '' }, 'b'.repeat(32)) });
  const data = snapshot();
  data.schedule['2026-09-01'].morning.kind = 'line';
  delete data.schedule['2026-09-02'];
  const result = await sync(server, state, data);
  assert.equal(result.updated, 1);
  assert.equal(result.removed, 1);
  assert.ok(server.db.has('manual') && server.db.has('foreign'));
});
test('a deleted and subsequently reintroduced logical slot gets a fresh valid ID', async () => {
  const server = fakeApi(), state = initial();
  await sync(server, state);
  const original = [...server.db.values()].find(e => e.summary?.startsWith('☀️')).id;
  const data = snapshot(); data.schedule['2026-09-01'].morning = null;
  await sync(server, state, data);
  await sync(server, state);
  const restored = [...server.db.values()].find(e => e.summary?.startsWith('☀️')).id;
  assert.notEqual(original, restored);
  assert.match(restored, /^[a-v0-9]{5,1024}$/);
});
test('an older snapshot from another device cannot overwrite newer cloud state', async () => {
  const server = fakeApi(), state = initial(), oldState = { ...initial(), deviceId: 'device-b' };
  await sync(server, state);
  const before = server.calls.length;
  await assert.rejects(sync(server, oldState), /別の端末で更新/);
  assert.ok(server.calls.slice(before).every(call => call.method === 'GET'));
});
test('failed replacement does not delete obsolete events; same device can resume', async () => {
  const server = fakeApi(), state = initial();
  await sync(server, state);
  const data = snapshot(); delete data.schedule['2026-09-02'];
  data.schedule['2026-09-03'] = { morning: { kind: 'clean', caseName: '案件A' }, wait: [] };
  const before = server.calls.length;
  server.fail((path, opt) => opt.method === 'POST');
  await assert.rejects(sync(server, state, data), /network/);
  assert.ok(server.calls.slice(before).every(call => call.method !== 'DELETE'));
  await assert.rejects(sync(server, { ...state, deviceId: 'device-b' }, data), /別の端末が転記中/);
  server.fail(null);
  const result = await sync(server, state, data);
  assert.equal(result.removed, 1);
  assert.equal(result.created, 1);
});
test('a stale interrupted sync can be conditionally taken over by the device holding the latest JSON', async () => {
  const server = fakeApi(), state = initial();
  await sync(server, state);
  const data = snapshot();
  delete data.schedule['2026-09-02'];
  data.schedule['2026-09-03'] = { morning: { idx: 0, kind: 'clean', caseName: '案件A' }, wait: [] };
  server.fail((path, opt) => opt.method === 'POST');
  await assert.rejects(sync(server, state, data), /network/);
  server.fail(null);
  const imported = { ...state, deviceId: 'device-b', pendingRevision: '' };
  await assert.rejects(sync(server, imported, data, {
    takeover: true, now: () => new Date('2026-09-01T12:03:00Z')
  }), error => error.code === 'DASHBOARD_SYNC_BUSY' && error.canTakeover === false);
  const result = await sync(server, imported, data, {
    takeover: true, now: () => new Date('2026-09-01T12:06:00Z')
  });
  assert.equal(result.created, 1);
  assert.equal(result.removed, 1);
  const marker = [...server.db.values()].find(event => event.extendedProperties?.private?.dashboardKey === 'status');
  assert.equal(marker.extendedProperties.private.busy, '');
});
test('an explicitly confirmed stale takeover can recover when Google advanced after the saved JSON', async () => {
  const server = fakeApi(), safari = initial();
  await sync(server, safari);
  const savedJson = { ...structuredClone(safari), deviceId: 'chrome-device', pendingRevision: '' };

  const newer = snapshot();
  newer.schedule['2026-09-01'].morning.kind = 'line';
  await sync(server, safari, newer);

  const interrupted = structuredClone(newer);
  interrupted.schedule['2026-09-03'] = { morning: { idx: 0, kind: 'clean', caseName: '案件A' }, wait: [] };
  server.fail((path, opt) => opt.method === 'POST');
  await assert.rejects(sync(server, safari, interrupted), /network/);
  server.fail(null);

  const result = await sync(server, savedJson, snapshot(), {
    takeover: true, now: () => new Date('2026-09-01T12:06:00Z')
  });
  assert.ok(result.updated > 0);
  const marker = [...server.db.values()].find(event => event.extendedProperties?.private?.dashboardKey === 'status');
  assert.equal(marker.extendedProperties.private.busy, '');
  assert.equal(savedJson.revision, marker.extendedProperties.private.revision);
});
test('recovers a cleared revision only when the last completed sync time still matches Google', async () => {
  const server = fakeApi(), state = initial();
  await sync(server, state);
  const committedRevision = state.revision;
  const committedTime = state.lastSyncedAt;
  state.revision = '';
  const result = await sync(server, state);
  assert.equal(result.created, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.removed, 0);
  assert.notEqual(state.revision, committedRevision);

  const stale = { ...state, revision: '', lastSyncedAt: committedTime };
  const newer = snapshot();
  newer.schedule['2026-09-01'].morning.kind = 'line';
  await sync(server, state, newer, { now: () => new Date('2026-09-01T12:01:00Z') });
  const before = server.calls.length;
  await assert.rejects(sync(server, stale), /最新のJSON/);
  assert.equal(server.calls.length, before + 1); // Read only; no remote write.
});
test('lost local acknowledgement recovers the committed remote revision', async () => {
  const server = fakeApi(), state = initial();
  let saves = 0, persisted;
  await assert.rejects(Core.synchronize({ api: server.api, state, snapshot: snapshot(), save(value) {
    if (++saves === 2) throw new Error('local-write-failure');
    persisted = structuredClone(value);
  } }), /local-write-failure/);
  const result = await sync(server, persisted);
  assert.equal(result.created, 0);
  assert.equal(result.removed, 0);
});
test('empty current dataset removes managed copies, while invalid data performs no writes', async () => {
  const server = fakeApi(), state = initial();
  await sync(server, state);
  const bad = snapshot(); bad.cases[0].deadline = 'invalid';
  const before = server.calls.length;
  await assert.rejects(sync(server, state, bad), /期日/);
  assert.equal(server.calls.length, before);
  const result = await sync(server, state, { today: '2026-09-01', cases: [], schedule: {} });
  assert.equal(result.removed, 4);
  assert.equal(server.db.size, 1);
});
