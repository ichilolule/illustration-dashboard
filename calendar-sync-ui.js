(function (root) {
  'use strict';
  const Core = root.DashboardCalendarCore;
  const KEY = 'dashboardGoogleCalendar';
  const DEVICE_KEY = 'dashboardGoogleCalendarDevice';
  const SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.calendarlist.readonly';
  const API_ROOT = 'https://www.googleapis.com/calendar/v3';
  const BUILD = 'v69';
  const AUTO_SYNC_DELAY_MS = 2000;
  const CLIENT_COLORS = [
    { backgroundColor: '#7986cb', colorId: '1' }, { backgroundColor: '#33b679', colorId: '2' },
    { backgroundColor: '#8e24aa', colorId: '3' }, { backgroundColor: '#e67c73', colorId: '4' },
    { backgroundColor: '#f6c026', colorId: '5' }, { backgroundColor: '#f5511d', colorId: '6' },
    { backgroundColor: '#039be5', colorId: '7' }, { backgroundColor: '#616161', colorId: '8' },
    { backgroundColor: '#3f51b5', colorId: '9' }, { backgroundColor: '#0b8043', colorId: '10' },
    { backgroundColor: '#d60000', colorId: '11' }
  ];
  function colorFor(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
    return CLIENT_COLORS[Math.abs(hash) % CLIENT_COLORS.length];
  }
  function validLabel(value) {
    return value && typeof value === 'object' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id || '') &&
      /^#[0-9a-f]{6}$/i.test(value.backgroundColor || '') && /^\d{1,3}$/.test(value.colorId || '');
  }
  function cleanClientLabels(value) {
    const result = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    for (const [clientName, label] of Object.entries(value)) if (validLabel(label))
      result[String(clientName).slice(0, 180)] = {
        id: label.id, backgroundColor: label.backgroundColor, colorId: label.colorId
      };
    return result;
  }
  function mount({ element, snapshot, shortcutButton, onSynced }) {
    if (!Core || !element) return null;
    let state;
    try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) { state = {}; }
    let deviceId = localStorage.getItem(DEVICE_KEY);
    if (!deviceId) { deviceId = Core.uuid(); localStorage.setItem(DEVICE_KEY, deviceId); }
    state = { sourceId: Core.uuid(), clientId: '', calendarId: '', revision: '', auto: true, clientLabels: {}, ...state, deviceId };
    state.clientLabels = cleanClientLabels(state.clientLabels);
    let token = '', expiresAt = 0, running = false, pending = false, timer, expiryTimer, preparing = false, staleDocument = false;
    let deferSyncUntil = 0;
    let connecting = false, unsyncedChanges = false, automaticConnectAttempted = false, userChangeGesture = false;
    let autoReconnectPending = false;
    let customLabelsUnavailable = false;
    let scriptPromise;
    const listeners = [];
    element.innerHTML = `
      <h3>Googleカレンダーへ転記</h3>
      <p class="gcal-note">制作予定を専用カレンダーへ送ります。案件名・工程・依頼詳細・期日を転記し、確認待ちはダッシュボード内だけに表示します。</p>
      <p class="gcal-note">変更時は自動反映します。制作状態の変更は1分待ってから送信します。接続が切れている場合は、編集後の画面操作でGoogleへの再接続を試みます。日付変更だけでは再接続しません。上部の「未転記」から手動で転記できます。</p>
      <div class="gcal-actions">
        <button type="button" class="reset-btn" data-action="connect">Googleに接続して転記</button>
        <button type="button" class="reset-btn" data-action="sync" disabled>今すぐ転記</button>
        <button type="button" class="reset-btn" data-action="takeover" hidden disabled>中断した転記をこの端末で引き継ぐ</button>
        <button type="button" class="reset-btn" data-action="disconnect" disabled>接続を停止</button>
      </div>
      <label class="gcal-auto"><input type="checkbox" data-field="auto"> 変更時にGoogleへ自動接続して転記</label>
      <p class="gcal-status" role="status" aria-live="polite"></p>
      <p class="gcal-last"></p>
      <details class="gcal-setup">
        <summary>初回接続の設定</summary>
        <p class="gcal-note">初回のみ、Google連携用のクライアントIDを設定してください。</p>
        <label class="gcal-client">クライアントID<input type="text" data-field="client" autocomplete="off" spellcheck="false" placeholder="…apps.googleusercontent.com"></label>
        <button type="button" class="reset-btn" data-action="save">接続設定を保存</button>
        <p class="gcal-note">設定はJSONバックアップに含まれます。認証情報は含まれません。</p>
      </details>`;
    const q = selector => element.querySelector(selector);
    const connectButton = q('[data-action="connect"]');
    const syncButton = q('[data-action="sync"]');
    const takeoverButton = q('[data-action="takeover"]');
    const disconnectButton = q('[data-action="disconnect"]');
    const shortcutLabel = shortcutButton?.querySelector('.gcal-shortcut-label');
    function setStatus(message, error = false) {
      q('.gcal-status').textContent = message;
      q('.gcal-status').dataset.error = String(error);
      refresh();
    }
    function save() {
      const { deviceId: ignored, ...persisted } = state;
      localStorage.setItem(KEY, JSON.stringify(persisted));
      refresh();
    }
    function authorized() { return !!token && Date.now() < expiresAt; }
    function reconnectMessage() {
      return autoReconnectPending
        ? '未転記の変更があります。次の画面操作でGoogleへの再接続を試みます。'
        : '日付変更による未転記の予定があります。上部の「未転記」からGoogleへ接続して転記してください。';
    }
    function refresh() {
      const connected = authorized();
      syncButton.disabled = !connected || running || connecting;
      takeoverButton.disabled = !connected || running || connecting;
      connectButton.disabled = running || preparing || connecting;
      disconnectButton.disabled = !token || running || connecting;
      q('[data-action="save"]').disabled = running || connecting;
      q('[data-field="auto"]').checked = state.auto;
      if (shortcutButton) {
        const action = connected ? 'Googleカレンダーへ今すぐ転記' : unsyncedChanges
          ? '未転記の変更があります。Googleへ接続して転記' : 'Googleに接続してカレンダーへ転記';
        shortcutButton.disabled = running || preparing || connecting;
        shortcutButton.dataset.connected = String(connected);
        shortcutButton.dataset.pending = String(unsyncedChanges);
        shortcutButton.title = running ? 'Googleカレンダーへ転記しています' : connecting ? 'Googleへ再接続しています' : action;
        shortcutButton.setAttribute('aria-label', running ? 'Googleカレンダーへ転記中' : connecting ? 'Googleへ再接続中' : action);
        if (shortcutLabel) shortcutLabel.textContent = running ? '転記中…' : connecting ? '接続中…' : unsyncedChanges ? '未転記' : 'Google転記';
      }
      q('.gcal-last').textContent = state.lastSyncedAt
        ? '最終同期：' + new Date(state.lastSyncedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + '（日本時間）'
        : 'まだGoogleへ転記していません。';
    }
    function disconnect(message = '接続を停止しました。Googleに転記済みの予定は残っています。', options = {}) {
      token = ''; expiresAt = 0;
      connecting = false;
      automaticConnectAttempted = options.allowAutoReconnect === false;
      clearTimeout(expiryTimer); clearTimeout(timer);
      setStatus(message);
    }
    function loadGoogle() {
      if (root.google?.accounts?.oauth2) return Promise.resolve();
      if (scriptPromise) return scriptPromise;
      scriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.onload = resolve;
        script.onerror = () => { scriptPromise = null; script.remove(); reject(new Error('Googleへの接続準備に失敗しました。通信を確認してください。')); };
        document.head.appendChild(script);
      });
      return scriptPromise;
    }
    async function prepare() {
      if (!state.clientId) {
        setStatus('初回接続の設定が必要です。');
        q('.gcal-setup').open = true;
        return;
      }
      preparing = true; refresh();
      try { await loadGoogle(); setStatus(unsyncedChanges
        ? reconnectMessage()
        : '接続ボタンからGoogleへ転記できます。'); }
      catch (error) { setStatus(error.message, true); }
      finally { preparing = false; refresh(); }
    }
    function operationName(path, method, body) {
      if (path.includes('/calendarList')) return '専用カレンダーの確認';
      if (path === '/calendars' && method === 'POST') return '専用カレンダーの作成';
      if (/^\/calendars\/[^/]+$/.test(path.split('?')[0])) return method === 'PUT' ? 'クライアント色の更新' : 'クライアント色の確認';
      if (method === 'GET') return '転記済み予定の確認';
      const key = body?.extendedProperties?.private?.dashboardKey;
      if (key === 'status') return method === 'POST' ? '同期状態の作成' : '同期状態の更新';
      if (method === 'POST') return '予定の追加';
      if (method === 'PATCH') return '予定の更新';
      if (method === 'DELETE') return '古い予定の削除';
      return 'Googleカレンダーとの通信';
    }
    function formatError(error) {
      const diagnostics = [];
      if (error.operation) diagnostics.push('処理：' + error.operation);
      if (error.status) diagnostics.push('Google ' + error.status);
      if (error.reason) diagnostics.push(String(error.reason).slice(0, 80));
      if (error.googleMessage && error.googleMessage !== error.message)
        diagnostics.push(String(error.googleMessage).replace(/[\r\n]+/g, ' ').slice(0, 180));
      diagnostics.push('アプリ：' + BUILD);
      return error.message + (diagnostics.length ? '\n詳細：' + diagnostics.join('／') : '');
    }
    function retryable(error) {
      return ['TimeoutError', 'TypeError'].includes(error.name) || error.status === 429 ||
        (Number(error.status) >= 500 && Number(error.status) <= 599);
    }
    function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
    async function api(path, options = {}) {
      if (staleDocument) throw new Error('別のタブでデータが更新されました。ページを再読み込みしてください。');
      if (!authorized()) {
        disconnect('認証期限が切れました。「Googleに接続して転記」で再接続してください。');
        throw new Error('再接続が必要です。');
      }
      const method = options.method || 'GET';
      const operation = operationName(path, method, options.body);
      const headers = { Authorization: 'Bearer ' + token };
      if (options.body) headers['Content-Type'] = 'application/json';
      if (options.etag) headers['If-Match'] = options.etag;
      let response;
      try {
        response = await fetch(API_ROOT + path, { method, headers,
          body: options.body ? JSON.stringify(options.body) : undefined, signal: AbortSignal.timeout(30000) });
      } catch (error) {
        error.operation = operation;
        throw error;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) disconnect('Googleの認証が切れました。再接続してください。');
        const messages = {
          400: 'Googleへ送る予定の内容を確認できませんでした。',
          401: 'Googleへ再接続してください。',
          403: 'Googleの権限またはAPI設定を確認してください。',
          404: '転記先が見つかりません。接続先アカウントと専用カレンダーを確認してください。',
          409: '別の処理が同時に転記しました。もう一度転記してください。',
          412: '別の端末または操作によって予定が更新されました。転記を中止しました。',
          429: 'Googleが混み合っています。少し待ってから転記してください。',
          500: 'Google側で一時的な問題が発生しました。',
          502: 'Google側との通信が一時的に不安定です。',
          503: 'Google側が一時的に利用できません。',
          504: 'Google側からの応答に時間がかかっています。'
        };
        const error = new Error(messages[response.status] || 'Googleへの転記に失敗しました。もう一度転記してください。');
        error.status = response.status;
        error.reason = data.error?.errors?.[0]?.reason;
        error.googleMessage = data.error?.message;
        error.operation = operation;
        error.retryAfter = Math.max(0, Number(response.headers.get('Retry-After')) || 0);
        throw error;
      }
      return response.status === 204 ? {} : response.json();
    }
    async function ensureCalendar() {
      if (state.calendarId) return;
      const marker = Core.APP + '; source=' + state.sourceId;
      const found = [];
      let page;
      do {
        const query = new URLSearchParams({ maxResults: '250', minAccessRole: 'owner' });
        if (page) query.set('pageToken', page);
        const result = await api('/users/me/calendarList?' + query);
        found.push(...(result.items || []).filter(item => item.description === marker && !item.primary));
        page = result.nextPageToken;
      } while (page);
      if (found.length > 1) throw new Error('専用カレンダーが重複しています。接続先の確認が必要です。');
      const calendar = found[0] || await api('/calendars', { method: 'POST', body: {
        summary: '制作予定（ダッシュボード）', description: marker, timeZone: 'Asia/Tokyo'
      } });
      state.calendarId = calendar.id;
      save();
    }
    async function ensureClientStyles(current) {
      const names = [...new Set(current.cases.map(item => String(item.name || '名称未設定').replace(/[\r\n]/g, ' ').slice(0, 180)))];
      const previous = state.clientLabels || Object.create(null), next = Object.create(null);
      for (const clientName of names) {
        const stored = previous[clientName];
        const color = colorFor(clientName);
        next[clientName] = validLabel(stored)
          ? { id: stored.id, backgroundColor: stored.backgroundColor, colorId: stored.colorId }
          : { id: crypto.randomUUID(), backgroundColor: color.backgroundColor, colorId: color.colorId };
      }
      state.clientLabels = next;
      for (const item of current.cases) {
        const style = next[String(item.name || '名称未設定').replace(/[\r\n]/g, ' ').slice(0, 180)];
        item.calendarColorId = style?.colorId || '';
        item.calendarLabelId = '';
      }
      if (!names.length || customLabelsUnavailable) { save(); return 'standard'; }
      try {
        const path = '/calendars/' + encodeURIComponent(state.calendarId);
        const calendar = await api(path);
        const existing = calendar.labelProperties?.eventLabels || [];
        const managedIds = new Set(Object.values(previous).filter(validLabel).map(label => label.id));
        const preserved = existing.filter(label => !managedIds.has(label.id));
        const managed = names.map(clientName => ({
          id: next[clientName].id, backgroundColor: next[clientName].backgroundColor, name: clientName
        }));
        if (preserved.length + managed.length > 200) throw Object.assign(new Error('Googleのカラーラベル数が上限に達しています。'), { status: 400 });
        const labels = [...preserved, ...managed];
        const comparableExisting = existing.map(label => ({
          id: label.id, backgroundColor: label.backgroundColor, name: label.name
        }));
        if (JSON.stringify(comparableExisting) !== JSON.stringify(labels)) {
          const body = {
            summary: calendar.summary || '制作予定（ダッシュボード）',
            description: calendar.description || '', timeZone: calendar.timeZone || 'Asia/Tokyo',
            labelProperties: { ...(calendar.labelProperties || {}), eventLabels: labels }
          };
          if (calendar.location) body.location = calendar.location;
          if (calendar.conferenceProperties) body.conferenceProperties = calendar.conferenceProperties;
          await api(path, { method: 'PUT', body, etag: calendar.etag });
        }
        for (const item of current.cases) {
          const clientName = String(item.name || '名称未設定').replace(/[\r\n]/g, ' ').slice(0, 180);
          item.calendarLabelId = next[clientName]?.id || '';
        }
        save();
        return 'custom';
      } catch (error) {
        if (![400, 403].includes(error.status)) throw error;
        customLabelsUnavailable = true;
        save();
        return 'standard';
      }
    }
    async function transfer(current, takeover) {
      let styleMode = 'standard';
      let labelFallbackTried = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await ensureCalendar();
          styleMode = await ensureClientStyles(current);
          const result = await Core.synchronize({ api, state, snapshot: current, save, takeover,
            progress: (done, total) => setStatus('制作予定を転記しています… ' + done + ' / ' + total) });
          return { ...result, styleMode };
        } catch (error) {
          if (error.status === 400 && !labelFallbackTried && current.cases.some(item => item.calendarLabelId)) {
            labelFallbackTried = true;
            customLabelsUnavailable = true;
            setStatus('クライアント色をGoogleの標準色へ切り替えて再試行します…');
            continue;
          }
          if (!retryable(error) || !navigator.onLine || attempt === 2) throw error;
          const delay = Math.min(10000, error.retryAfter ? error.retryAfter * 1000 : [800, 2000][attempt]);
          setStatus('Googleとの通信が一時的に不安定です。自動で再試行します…（' + (attempt + 2) + ' / 3）');
          await wait(delay);
        }
      }
    }
    async function runSync(options = {}) {
      const takeover = options?.takeover === true;
      if (running) { pending = true; return; }
      if (!authorized()) { setStatus('変更をGoogleへ送るには再接続してください。'); return; }
      // Web Locks also prevent concurrent mutations from another tab of this site.
      if (!navigator.locks) { setStatus('このブラウザでは安全に同期できません。最新のSafariまたはChromeを使用してください。', true); return; }
      clearTimeout(timer);
      deferSyncUntil = 0;
      const includedUnsyncedChanges = unsyncedChanges;
      const includedAutoReconnectPending = autoReconnectPending;
      unsyncedChanges = false;
      autoReconnectPending = false;
      running = true; refresh();
      if (takeover) takeoverButton.hidden = true;
      let failed = false;
      try {
        await navigator.locks.request('ichilole-dashboard-google-calendar', { ifAvailable: true }, async lock => {
          if (!lock) throw new Error('別のタブで転記中です。完了後にもう一度転記してください。');
          // Another tab may have completed a sync since this tab was opened.
          const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
          if (stored.sourceId === state.sourceId) state = { ...state, ...stored, deviceId };
          const current = snapshot();
          Core.buildEvents(current); // Validate before creating the destination calendar.
          setStatus('制作予定を転記しています…');
          const result = await transfer(current, takeover);
          takeoverButton.hidden = true;
          setStatus('転記完了：' + result.count + '件（追加' + result.created + '・変更' + result.updated + '・削除' + result.removed + '）');
          try { onSynced?.(result); } catch (_) {}
        });
      } catch (error) {
        failed = true;
        unsyncedChanges = unsyncedChanges || includedUnsyncedChanges;
        autoReconnectPending = autoReconnectPending || includedAutoReconnectPending;
        const networkError = ['TimeoutError', 'TypeError'].includes(error.name);
        if (networkError) error.message = '通信を完了できませんでした。通信状況を確認し、もう一度転記してください。';
        if (error.code === 'DASHBOARD_SYNC_BUSY') {
          takeoverButton.hidden = !error.canTakeover;
          if (error.busySince) error.message += '\n中断日時：' + new Date(error.busySince).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + '（日本時間）';
        }
        setStatus(formatError(error), true);
      } finally {
        running = false; refresh();
        if (pending && !failed) { pending = false; changed({ markDirty: false }); }
        else pending = false;
      }
    }
    function changed(options = {}) {
      clearTimeout(timer);
      const markDirty = options?.markDirty !== false;
      const delayMs = Math.max(0, Number(options?.delayMs) || 0);
      if (delayMs) deferSyncUntil = Math.max(deferSyncUntil, Date.now() + delayMs);
      if (markDirty) {
        unsyncedChanges = true;
        // 日付変更だけでは、閲覧中のクリックによる再接続を予約しない。
        if (options?.autoReconnect !== false) autoReconnectPending = true;
      }
      refresh();
      if (!unsyncedChanges) return;
      if (!state.auto) {
        setStatus('未転記の変更があります。「今すぐ転記」からGoogleへ反映してください。');
        return;
      }
      if (running) { pending = true; return; }
      if (token && !authorized()) disconnect('認証期限が切れました。' + reconnectMessage());
      if (!authorized()) {
        if (!state.clientId) {
          setStatus('未転記の変更があります。Google連携の初回設定を完了してください。');
          return;
        }
        setStatus(reconnectMessage());
        const userGesture = options?.userInitiated === true || userChangeGesture;
        if (!autoReconnectPending || !userGesture || automaticConnectAttempted || connecting || preparing) return;
        if (!root.google?.accounts?.oauth2) { prepare(); return; }
        connect({ automatic: true });
        return;
      }
      timer = setTimeout(runSync, Math.max(AUTO_SYNC_DELAY_MS, deferSyncUntil - Date.now()));
    }
    function connect(options = {}) {
      const automatic = options?.automatic === true;
      if (connecting) return;
      if (staleDocument) { setStatus('別のタブでデータが更新されました。ページを再読み込みしてください。', true); return; }
      if (!state.clientId || !root.google?.accounts?.oauth2) { prepare(); return; }
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        setStatus('Google連携は公開済みのダッシュボードURLから使用してください。', true); return;
      }
      connecting = true;
      automaticConnectAttempted = true;
      setStatus(automatic ? '未転記の変更を送るためGoogleへ再接続しています…' : 'Googleへ接続しています…');
      const config = {
        client_id: state.clientId, scope: SCOPES, include_granted_scopes: false,
        callback: async response => {
          if (response.error || !response.access_token) {
            connecting = false;
            setStatus('Googleへの接続が許可されませんでした。未転記の変更は残っています。', true);
            return;
          }
          if (!root.google.accounts.oauth2.hasGrantedAllScopes(response, ...SCOPES.split(' '))) {
            connecting = false;
            setStatus('制作予定の転記に必要な権限を許可してください。未転記の変更は残っています。', true);
            return;
          }
          token = response.access_token;
          expiresAt = Date.now() + Math.max(0, Number(response.expires_in || 0) - 30) * 1000;
          clearTimeout(expiryTimer);
          expiryTimer = setTimeout(() => disconnect('認証期限が切れました。次の転記時に再接続してください。'), Math.max(0, expiresAt - Date.now()));
          try {
            const result = await fetch('https://www.googleapis.com/oauth2/v3/userinfo',
              { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
            if (!result.ok) throw new Error('Googleアカウントを確認できませんでした。');
            const profile = await result.json();
            if (typeof profile.sub !== 'string' || !profile.sub) throw new Error('Googleアカウントを確認できませんでした。');
            if (state.accountId && state.accountId !== profile.sub) throw new Error('以前と異なるGoogleアカウントです。元のアカウントへ接続してください。');
            state.accountId = profile.sub;
            automaticConnectAttempted = false;
            connecting = false;
            save();
            if (automatic && deferSyncUntil > Date.now()) changed({ markDirty: false });
            else runSync();
          } catch (error) { disconnect(error.message, { allowAutoReconnect: false }); }
        },
        error_callback: () => {
          connecting = false;
          setStatus('接続画面を開けなかったか、接続がキャンセルされました。未転記の変更は残っています。', true);
        }
      };
      if (state.accountId) config.login_hint = state.accountId;
      try { root.google.accounts.oauth2.initTokenClient(config).requestAccessToken({ prompt: '' }); }
      catch (_) {
        connecting = false;
        setStatus('Googleへの接続画面を開けませんでした。上部の「未転記」から再接続してください。', true);
      }
    }
    function useShortcut() { if (authorized()) runSync(); else connect(); }
    connectButton.addEventListener('click', () => connect());
    syncButton.addEventListener('click', () => runSync());
    shortcutButton?.addEventListener('click', useShortcut);
    takeoverButton.addEventListener('click', () => {
      if (!confirm('この端末の現在のダッシュボードを正として、中断したGoogle転記を引き継ぎますか？\nSafariなど別端末でJSON保存前の変更がある場合、その変更はGoogle側から置き換わります。\n専用カレンダー内の自動転記予定だけを更新します。')) return;
      runSync({ takeover: true });
    });
    disconnectButton.addEventListener('click', () => disconnect(undefined, { allowAutoReconnect: false }));
    q('[data-field="auto"]').addEventListener('change', event => { state.auto = event.target.checked; save(); if (state.auto) changed({ markDirty: false }); });
    q('[data-action="save"]').addEventListener('click', () => {
      const clientId = q('[data-field="client"]').value.trim();
      if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
        setStatus('Google連携用のクライアントIDを入力してください。', true); return;
      }
      if (state.clientId && clientId !== state.clientId && state.calendarId) {
        setStatus('接続済みアプリの変更は、転記先の引き継ぎ確認が必要です。', true); return;
      }
      state.clientId = clientId; save(); prepare();
    });
    function on(target, event, callback) { target.addEventListener(event, callback); listeners.push([target, event, callback]); }
    function rememberUserChangeGesture(event) {
      if (!event.isTrusted) return;
      userChangeGesture = true;
      const explicitConnect = event.target?.closest?.('[data-action="connect"], #google-transfer-shortcut');
      if (!explicitConnect && autoReconnectPending && unsyncedChanges && state.auto && !authorized() && state.clientId &&
          !automaticConnectAttempted && !connecting && !preparing && root.google?.accounts?.oauth2) {
        connect({ automatic: true });
      }
      setTimeout(() => { userChangeGesture = false; }, 0);
    }
    document.addEventListener('click', rememberUserChangeGesture, true);
    document.addEventListener('change', rememberUserChangeGesture, true);
    on(root, 'online', () => changed({ markDirty: false }));
    on(root, 'beforeunload', event => {
      if ((!unsyncedChanges && !running && !connecting) || !state.clientId) return;
      event.preventDefault();
      event.returnValue = '';
    });
    on(root, 'storage', event => {
      let dataChanged = ['cases', 'cfg', 'holidays'].includes(event.key);
      if (event.key === KEY) {
        try { dataChanged = JSON.parse(event.newValue || '{}').sourceId !== state.sourceId; }
        catch (_) { dataChanged = true; }
      }
      if (dataChanged) {
        staleDocument = true;
        disconnect('別のタブでデータが更新されました。このページを再読み込みしてから接続してください。');
      }
    });
    q('[data-field="client"]').value = state.clientId;
    save(); prepare();
    return {
      changed,
      exportConfig() {
        const { deviceId: ignored, pendingRevision: ignoredPending, ...backup } = state;
        return backup;
      },
      importConfig(value) {
        if (running) throw new Error('転記中です。完了してからJSONを読み込んでください。');
        disconnect('JSONを読み込みました。Googleへ接続すると、この予定を転記します。');
        takeoverButton.hidden = true;
        if (value && /^[a-f0-9]{32}$/.test(value.sourceId || '')) {
          const allowed = ['sourceId', 'clientId', 'calendarId', 'revision', 'lastSyncedAt', 'accountId'];
          state = { sourceId: value.sourceId, auto: state.auto, clientLabels: Object.create(null), deviceId };
          for (const key of allowed) if (typeof value[key] === 'string') state[key] = value[key];
          state.clientLabels = cleanClientLabels(value.clientLabels);
        } else if (state.calendarId) {
          // Legacy backups carry no baseline. Never silently overwrite a newer cloud snapshot.
          state.revision = '';
        }
        state.pendingRevision = '';
        save(); q('[data-field="client"]').value = state.clientId || '';
        if (state.clientId) prepare();
      },
      isRunning: () => running
    };
  }
  root.DashboardCalendarUI = { mount };
})(window);
