/* Pure calendar projection and guarded one-way reconciliation. No account secrets. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DashboardCalendarCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const APP = 'ichilole-dashboard-calendar-v1';
  const TAKEOVER_AFTER_MS = 5 * 60 * 1000;
  const LABELS = { rough: '大ラフ', line: '清書前ラフ', clean: '清書', retouch: 'レタッチ' };
  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
      Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
      new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  }
  function nextDay(value) {
    if (!validDate(value)) throw new Error('予定の日付が不正です。転記を中止しました。');
    const date = new Date(value + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  }
  function name(value) { return String(value || '名称未設定').replace(/[\r\n]/g, ' ').slice(0, 180); }
  function detail(value) { return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, 6000); }
  function caseForTask(snapshot, task) {
    const index = Number(task && task.idx);
    if (Number.isInteger(index) && index >= 0 && snapshot.cases[index]) return snapshot.cases[index];
    return snapshot.cases.find(item => String(item?.name || '') === String(task?.caseName || '')) || null;
  }
  function eventStyle(item) {
    if (!item) return {};
    return { labelId: String(item.calendarLabelId || ''), colorId: String(item.calendarColorId || '') };
  }
  function buildEvents(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.cases) || !snapshot.schedule || !validDate(snapshot.today))
      throw new Error('予定を取得できませんでした。Googleの予定は変更していません。');
    const events = [];
    function add(key, date, title, eventDetail, style = {}) {
      events.push({ key, date, title: title.slice(0, 800), detail: eventDetail, ...style });
    }
    for (const date of Object.keys(snapshot.schedule).sort()) {
      const day = snapshot.schedule[date];
      if (!validDate(date) || !day) throw new Error('作業予定の日付が不正です。');
      if (date < snapshot.today) continue;
      for (const slot of ['morning', 'night']) {
        const task = day[slot];
        if (!task) continue;
        if (!LABELS[task.kind]) throw new Error('未知の制作工程があるため転記を中止しました。');
        const icon = slot === 'morning' ? '☀️' : '🌃';
        const item = caseForTask(snapshot, task);
        const requestDetail = detail(item?.detail);
        const lines = ['工程：' + LABELS[task.kind]];
        if (item?.deadline) lines.push('納期：' + item.deadline);
        if (requestDetail) lines.push('', '依頼詳細：', requestDetail);
        add('work:' + date + ':' + slot, date,
          icon + ' ' + name(task.caseName) + '｜' + LABELS[task.kind], lines.join('\n'), eventStyle(item));
      }
    }
    for (const [field, prefix, icon] of [['deadline', '納期', '🔴'], ['paydue', '支払期限', '🟡']]) {
      const dates = new Map();
      for (const item of snapshot.cases) {
        if (!item[field] || (field === 'paydue' && item.paymentStatus === 'paid') ||
            (field === 'deadline' && String(item.step) === '5')) continue;
        if (!validDate(item[field])) throw new Error('案件の期日が不正です。');
        if (!dates.has(item[field])) dates.set(item[field], []);
        dates.get(item[field]).push(item);
      }
      for (const [date, items] of [...dates].sort()) {
        const names = items.map(item => name(item.name));
        add(field + ':' + date, date, icon + ' ' + names.join('／'),
          prefix + '：' + date + '\n' + names.join('\n'), items.length === 1 ? eventStyle(items[0]) : {});
      }
    }
    if (events.length > 2500) throw new Error('予定が2,500件を超えています。転記範囲の確認が必要です。');
    return events.sort((a, b) => a.key.localeCompare(b.key));
  }
  function body(event, sourceId) {
    const result = {
      summary: event.title,
      description: event.detail,
      start: { date: event.date }, end: { date: nextDay(event.date) },
      transparency: 'transparent', visibility: 'private',
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: { private: { dashboardApp: APP, dashboardSource: sourceId, dashboardKey: event.key } }
    };
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.labelId || ''))
      result.eventLabelId = event.labelId;
    else if (/^\d{1,3}$/.test(event.colorId || '')) result.colorId = event.colorId;
    return result;
  }
  function owned(event, sourceId) {
    const p = event.extendedProperties && event.extendedProperties.private;
    return event.status !== 'cancelled' && p && p.dashboardApp === APP && p.dashboardSource === sourceId;
  }
  function equal(remote, desired) {
    const styleEqual = desired.eventLabelId
      ? remote.eventLabelId === desired.eventLabelId
      : !remote.eventLabelId && (remote.colorId || '') === (desired.colorId || '');
    return remote.summary === desired.summary && remote.description === desired.description &&
      remote.start?.date === desired.start.date && remote.end?.date === desired.end.date &&
      !remote.start?.dateTime && !remote.end?.dateTime &&
      remote.transparency === 'transparent' && remote.visibility === 'private' &&
      remote.reminders?.useDefault === false && !(remote.reminders?.overrides || []).length && styleEqual;
  }
  function diff(remote, desired, sourceId) {
    const byKey = new Map(), changes = { create: [], update: [], remove: [] };
    for (const item of remote) {
      if (!owned(item, sourceId)) continue;
      const key = item.extendedProperties.private.dashboardKey;
      if (key === 'status') continue;
      if (byKey.has(key)) changes.remove.push(item);
      else byKey.set(key, item);
    }
    for (const item of desired) {
      const previous = byKey.get(item.extendedProperties.private.dashboardKey);
      if (!previous) changes.create.push(item);
      else {
        if (!equal(previous, item)) changes.update.push({ previous, item });
        byKey.delete(item.extendedProperties.private.dashboardKey);
      }
    }
    changes.remove.push(...byKey.values());
    return changes;
  }
  function uuid() { return globalThis.crypto.randomUUID().replace(/-/g, ''); }
  async function digest(value) {
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  function statusBody(today, sourceId, properties, complete, timestamp) {
    const item = body({ key: 'status', date: today, title: '制作予定の更新状況',
      detail: complete
        ? '最終同期：' + timestamp + '\nこの日時にダッシュボードから転記された計画です。'
        : '転記処理中です。中断した場合は元の端末で再接続して転記を完了してください。' }, sourceId);
    Object.assign(item.extendedProperties.private, properties);
    return item;
  }
  // api(path, {method, body, etag}) is injected so reconciliation can be tested offline.
  function withLabelVersion(path, item) {
    if (!Object.prototype.hasOwnProperty.call(item, 'eventLabelId')) return path;
    return path + (path.includes('?') ? '&' : '?') + 'eventLabelVersion=1';
  }
  async function synchronize({ api, state, snapshot, save, progress = () => {}, now = () => new Date(), takeover = false }) {
    const desired = buildEvents(snapshot).map(event => body(event, state.sourceId));
    if (!/^[a-f0-9]{32}$/.test(state.sourceId || '') || !state.deviceId)
      throw new Error('転記元の識別情報がありません。');
    if (!state.calendarId || !state.calendarId.endsWith('@group.calendar.google.com'))
      throw new Error('制作予定専用カレンダーを接続してください。');
    const base = '/calendars/' + encodeURIComponent(state.calendarId) + '/events';
    const remote = [];
    let page;
    do {
      const query = new URLSearchParams({ maxResults: '2500', privateExtendedProperty: 'dashboardSource=' + state.sourceId });
      if (page) query.set('pageToken', page);
      const result = await api(base + '?' + query);
      remote.push(...(result.items || []));
      page = result.nextPageToken;
    } while (page);
    const markers = remote.filter(item => owned(item, state.sourceId) && item.extendedProperties.private.dashboardKey === 'status');
    if (markers.length > 1) throw new Error('更新状況の記録が重複しています。予定を変更せず停止しました。');
    let marker = markers[0];
    const props = marker?.extendedProperties.private || {};
    const currentTime = now();
    const timestamp = currentTime.toISOString();
    let confirmedTakeover = false;
    // Recover a successful remote commit whose local acknowledgement was interrupted.
    if (state.pendingRevision && props.revision === state.pendingRevision && !props.busy) {
      state.revision = props.revision;
      state.pendingRevision = '';
      save(state);
    }
    if (props.busy && props.busy !== state.deviceId) {
      const busyAt = Date.parse(props.busySince || marker?.updated || '');
      const canTakeover = Number.isFinite(busyAt) && currentTime.getTime() - busyAt >= TAKEOVER_AFTER_MS;
      if (!takeover || !canTakeover) {
        const error = new Error(canTakeover
          ? '別の端末で中断した転記があります。この端末で引き継いで再開できます。'
          : '別の端末が転記中です。完了後にもう一度転記してください。');
        error.code = 'DASHBOARD_SYNC_BUSY';
        error.canTakeover = canTakeover;
        error.busySince = Number.isFinite(busyAt) ? new Date(busyAt).toISOString() : '';
        throw error;
      }
      confirmedTakeover = true;
    }
    if ((props.revision || '') !== (state.revision || '')) {
      // A cases-only import can clear the local baseline while retaining the
      // last completed sync time. Recover only if Google still has that exact
      // completed snapshot; a newer remote commit must remain guarded.
      if (!confirmedTakeover && !(state.revision === '' && state.lastSyncedAt &&
          props.lastSyncedAt === state.lastSyncedAt && !props.busy))
        throw new Error('Google側に、別の端末で更新した予定があります。最新のJSONを読み込んでから接続してください。');
      // Adopt the last committed remote revision only after a confirmed stale
      // takeover or an exact match of the last completed sync timestamp.
      state.revision = props.revision || '';
      state.pendingRevision = '';
      save(state);
    }
    const changes = diff(remote, desired, state.sourceId);
    const hash = await digest(JSON.stringify(desired));
    const revision = uuid();
    state.pendingRevision = revision;
    save(state);
    const lock = statusBody(snapshot.today, state.sourceId,
      { revision: state.revision || '', busy: state.deviceId, busySince: timestamp }, false, timestamp);
    if (marker) {
      marker = await api(base + '/' + encodeURIComponent(marker.id), { method: 'PATCH', body: lock, etag: marker.etag });
    } else {
      // Deterministic status ID makes two concurrent first-sync attempts conflict safely.
      const id = 'd' + (await digest(APP + state.sourceId + 'status')).slice(0, 48);
      marker = await api(base, { method: 'POST', body: { id, ...lock } });
    }
    let done = 0;
    const total = changes.create.length + changes.update.length + changes.remove.length;
    for (const item of changes.create) {
      await api(withLabelVersion(base + '?sendUpdates=none', item), { method: 'POST', body: { id: uuid(), ...item } });
      progress(++done, total);
    }
    for (const { previous, item } of changes.update) {
      const update = previous.eventLabelId && !item.eventLabelId ? { ...item, eventLabelId: '' } : { ...item };
      // Google PATCH merges EventDateTime objects. Clear timed-event fields explicitly
      // when restoring a dashboard-owned event to an all-day event.
      update.start = { ...item.start, dateTime: null };
      update.end = { ...item.end, dateTime: null };
      await api(withLabelVersion(base + '/' + encodeURIComponent(previous.id) + '?sendUpdates=none', update),
        { method: 'PATCH', body: update, etag: previous.etag });
      progress(++done, total);
    }
    // Do not remove obsolete entries until every replacement has succeeded.
    for (const item of changes.remove) {
      await api(base + '/' + encodeURIComponent(item.id) + '?sendUpdates=none', { method: 'DELETE', etag: item.etag });
      progress(++done, total);
    }
    const complete = statusBody(snapshot.today, state.sourceId,
      { revision, busy: '', busySince: '', snapshotHash: hash, lastSyncedAt: timestamp }, true, timestamp);
    await api(base + '/' + encodeURIComponent(marker.id), { method: 'PATCH', body: complete, etag: marker.etag });
    state.revision = revision;
    state.pendingRevision = '';
    state.lastSyncedAt = timestamp;
    save(state);
    return { count: desired.length, created: changes.create.length, updated: changes.update.length, removed: changes.remove.length };
  }
  return { APP, TAKEOVER_AFTER_MS, validDate, nextDay, buildEvents, body, diff, owned, equal, synchronize, uuid };
});
