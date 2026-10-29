(function (root) {
  'use strict';

  const DB_NAME = 'ichilole-dashboard-backup-v1';
  const STORE_NAME = 'handles';
  const LEGACY_RECORD = 'icloud-json';
  const TARGET_RECORD = 'dashboard-sync-targets';
  const SETTINGS_KEY = 'dashboardICloudBackup';
  const FILE_NAME = 'dashboard_sync.json';
  const LOCK_NAME = 'ichilole-dashboard-icloud-json';

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('ブラウザ保存領域を読み込めませんでした。'));
    });
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME))
          request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('ブラウザ保存領域を開けませんでした。'));
    });
  }

  async function readRecord(id) {
    const database = await openDatabase();
    try { return await requestResult(database.transaction(STORE_NAME).objectStore(STORE_NAME).get(id)); }
    finally { database.close(); }
  }

  async function writeRecord(id, value) {
    const database = await openDatabase();
    try {
      await requestResult(database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put({ id, ...value }));
    } finally { database.close(); }
  }

  async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  function parseBackup(text) {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || value.kind === 'illustration-dashboard-cases' ||
        (!Array.isArray(value.cases) && !Array.isArray(value.archive)))
      throw new Error('案件管理ダッシュボードの完全バックアップではありません。');
    return value;
  }

  function comparableBackup(value) {
    const copy = JSON.parse(JSON.stringify(value));
    delete copy.exported;
    return JSON.stringify(copy);
  }

  function mount({ element, shortcutButton, snapshot, download, importText, isBusy }) {
    if (!element || typeof snapshot !== 'function') return null;
    const supported = typeof root.showSaveFilePicker === 'function' && !!root.indexedDB && !!root.crypto?.subtle;
    let settings;
    try { settings = { auto: true, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
    catch (_) { settings = { auto: true }; }
    let targets = [], readyDone = false, writing = false, pendingWrite = false, timer = null;
    let changeVersion = 0, message = '';

    element.innerHTML = `
      <h3>バックアップ</h3>
      <p class="gcal-note">案件・設定・休日・Google連携設定を <strong>${FILE_NAME}</strong> に保存します。保存先を複数登録できます。各保存先では同じファイル名を使い、クラウドへの同期完了はFinderや保存先のサービスで確認してください。</p>
      <div class="gcal-actions">
        <input type="text" data-field="new-label" class="backup-label-input" maxlength="40" placeholder="保存先の名前（例：iCloud Drive）" aria-label="追加する保存先の名前">
        <button type="button" class="reset-btn" data-action="choose">保存先を追加</button>
        <button type="button" class="reset-btn" data-action="save">すべて今すぐ保存</button>
        <button type="button" class="reset-btn" data-action="download">通常ダウンロード</button>
      </div>
      <div class="backup-destinations" data-role="targets"></div>
      <label class="gcal-auto"><input type="checkbox" data-field="auto"> 変更時にすべての保存先へ自動保存</label>
      <p class="gcal-status" data-role="status" role="status" aria-live="polite"></p>`;

    const q = selector => element.querySelector(selector);
    const chooseButton = q('[data-action="choose"]');
    const saveButton = q('[data-action="save"]');
    const autoField = q('[data-field="auto"]');
    const labelField = q('[data-field="new-label"]');
    const status = q('[data-role="status"]');
    const list = q('[data-role="targets"]');

    function contentNow() { return comparableBackup(parseBackup(JSON.stringify(snapshot()))); }
    function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
    function setMessage(value) { message = value; refresh(); }
    function targetStatus(target, content) {
      if (target.issue === 'conflict') return '外部で更新されています。この保存先の自動保存を停止しました。内容を確認してください。';
      if (target.issue === 'permission') return 'ファイルへのアクセスを再許可してください。';
      if (target.issue === 'error') return '保存できませんでした。保存先とChromeのアクセス権を確認してください。';
      if (target.verifiedContent === content) return '現在の内容を保存済みです。';
      return '更新待ちです。';
    }
    function makeButton(label, action, disabled = false) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'reset-btn'; button.textContent = label;
      button.disabled = disabled; button.addEventListener('click', action);
      return button;
    }
    function renderTargets(content) {
      list.replaceChildren();
      if (!targets.length) {
        const empty = document.createElement('p'); empty.className = 'gcal-note';
        empty.textContent = supported ? '保存先は未設定です。ファイルを選んで追加してください。' : 'このブラウザでは直接保存できません。通常ダウンロードをご利用ください。';
        list.append(empty);
        return;
      }
      for (const target of targets) {
        const card = document.createElement('div'); card.className = 'backup-destination';
        const label = document.createElement('label'); label.textContent = '保存先の名前';
        const input = document.createElement('input'); input.type = 'text'; input.maxLength = 40;
        input.value = target.label; input.setAttribute('aria-label', '保存先の名前：' + target.label);
        input.disabled = writing;
        input.addEventListener('change', async () => {
          target.label = input.value.trim() || target.label;
          await saveTargets(); refresh();
        });
        label.append(input);
        const file = document.createElement('p'); file.className = 'gcal-note';
        file.textContent = target.handle.name + (target.remembered ? '' : '（次回は再設定が必要です）');
        const detail = document.createElement('p'); detail.className = 'gcal-note';
        detail.textContent = targetStatus(target, content) + (target.savedAt ? ' 最終保存：' + new Date(target.savedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '');
        const actions = document.createElement('div'); actions.className = 'gcal-actions';
        actions.append(
          makeButton('保存', () => writeAll(false, [target.id]), writing || !!isBusy?.()),
          makeButton('変更', () => chooseTarget(target.id), writing),
          makeButton('解除', () => removeTarget(target.id), writing),
          makeButton('読み込み', () => loadFromTarget(target.id), writing || !!isBusy?.())
        );
        card.append(label, file, detail, actions); list.append(card);
      }
    }
    function refresh() {
      let content = '';
      try { content = contentNow(); } catch (_) {}
      const failures = targets.filter(target => ['conflict', 'error'].includes(target.issue)).length;
      const permissions = targets.filter(target => target.issue === 'permission').length;
      const saved = targets.filter(target => target.verifiedContent === content && !target.issue).length;
      const kind = !supported ? 'unsupported' : !targets.length ? 'unconfigured' :
        writing ? 'saving' : failures ? 'error' : permissions ? 'permission' :
          saved === targets.length ? 'saved' : 'ready';
      const summary = !supported ? 'このブラウザでは直接保存できません。通常ダウンロードをご利用ください。' :
        !targets.length ? '保存先を追加してください。' :
          `バックアップ：${targets.length}件中${saved}件を保存済みです。` +
          (failures ? ' 保存先ごとのエラーを確認してください。' : permissions ? ' アクセス再許可が必要な保存先があります。' : '');
      status.textContent = message || summary;
      status.dataset.error = String(failures > 0);
      chooseButton.disabled = !readyDone || writing || !supported;
      labelField.disabled = chooseButton.disabled;
      saveButton.disabled = !readyDone || writing || !!isBusy?.() || !supported;
      autoField.checked = settings.auto;
      autoField.disabled = !supported;
      renderTargets(content);
      if (shortcutButton) {
        shortcutButton.disabled = !readyDone || writing || !!isBusy?.();
        shortcutButton.dataset.state = kind;
        shortcutButton.title = summary;
        const label = shortcutButton.querySelector('.backup-shortcut-label');
        if (label) label.textContent = writing ? '保存中…' : 'JSON保存';
      }
    }

    async function saveTargets() {
      try {
        await writeRecord(TARGET_RECORD, { targets: targets.map(target => ({
          id: target.id, label: target.label, handle: target.handle,
          baselineHash: target.baselineHash, savedAt: target.savedAt || ''
        })) });
        targets.forEach(target => { target.remembered = true; });
        return true;
      } catch (_) {
        targets.forEach(target => { target.remembered = false; });
        return false;
      }
    }
    async function permission(target, grant) {
      let result = await target.handle.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
      if (result !== 'granted' && grant)
        result = await target.handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
      return result === 'granted';
    }
    async function currentFileText(handle) {
      const file = await handle.getFile();
      return file.size ? file.text() : '';
    }
    async function writeOne(target, serialized, content, savedAt, automatic) {
      if (automatic && target.issue === 'conflict') return false;
      try {
        if (!await permission(target, !automatic)) { target.issue = 'permission'; return false; }
        const diskText = await currentFileText(target.handle);
        const diskHash = await sha256(diskText);
        if (diskText) {
          try {
            if (comparableBackup(parseBackup(diskText)) === content) {
              target.baselineHash = diskHash; target.verifiedContent = content; target.issue = null;
              return false;
            }
          } catch (_) {}
        }
        if (diskHash !== target.baselineHash &&
            (automatic || !confirm(`「${target.label}」のファイルは別の操作で更新されています。現在のダッシュボードで上書きしますか？`))) {
          target.issue = 'conflict'; return false;
        }
        const writable = await target.handle.createWritable();
        try { await writable.write(serialized); await writable.close(); }
        catch (error) { await writable.abort?.().catch(() => {}); throw error; }
        target.baselineHash = await sha256(serialized);
        target.savedAt = savedAt;
        target.verifiedContent = content;
        target.issue = null;
        return true;
      } catch (_) { target.issue = 'error'; return false; }
      finally { refresh(); }
    }
    async function writeAll(automatic = false, ids = null) {
      if (!readyDone || !targets.length) return false;
      if (writing) { pendingWrite = true; return false; }
      if (isBusy?.()) { if (automatic) changed({ delay: 500 }); return false; }
      clearTimeout(timer); timer = null;
      const selected = targets.filter(target => !ids || ids.includes(target.id));
      if (!selected.length) return false;
      const startedVersion = changeVersion;
      writing = true; message = ''; refresh();
      try {
        const operation = async () => {
          const value = snapshot();
          const serialized = JSON.stringify(value, null, 2);
          parseBackup(serialized);
          const content = comparableBackup(value);
          let wrote = false;
          for (const target of selected) if (await writeOne(target, serialized, content, value.exported, automatic)) wrote = true;
          await saveTargets();
          message = `バックアップ：${targets.length}件中${targets.filter(target => target.verifiedContent === content && !target.issue).length}件を保存済みです。`;
          return wrote;
        };
        if (navigator.locks) {
          let result = false;
          await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async lock => {
            if (lock) result = await operation();
            else setMessage('別のタブでバックアップを保存中です。少し後で再確認してください。');
          });
          return result;
        }
        return operation();
      } catch (_) { setMessage('バックアップを保存できませんでした。データと保存先を確認してください。'); return false; }
      finally {
        writing = false; refresh();
        if (pendingWrite || changeVersion !== startedVersion) {
          pendingWrite = false;
          if (settings.auto) changed({ immediate: true });
        }
      }
    }
    async function chooseTarget(replaceId = null) {
      if (!supported || writing) { if (!supported) download?.(); return false; }
      let handle;
      try {
        handle = await root.showSaveFilePicker({
          id: 'ichilole-dashboard-json', suggestedName: FILE_NAME,
          types: [{ description: 'ダッシュボードJSON', accept: { 'application/json': ['.json'] } }]
        });
      } catch (error) {
        if (error?.name !== 'AbortError') setMessage('保存先を選べませんでした。');
        return false;
      }
      if (handle.name !== FILE_NAME) { setMessage(`ファイル名は ${FILE_NAME} にしてください。`); return false; }
      try {
        for (const target of targets) if (target.id !== replaceId &&
            typeof target.handle.isSameEntry === 'function' && await target.handle.isSameEntry(handle).catch(() => false)) {
          setMessage('このファイルは既に保存先として登録されています。'); return false;
        }
        if (!await permission({ handle }, true)) { setMessage('ファイルへの書き込みが許可されませんでした。'); return false; }
        const diskText = await currentFileText(handle);
        if (diskText && comparableBackup(parseBackup(diskText)) !== contentNow() &&
            !confirm(`選んだ ${FILE_NAME} には異なるデータがあります。現在のダッシュボードで上書きしますか？`)) return false;
        const old = targets.find(target => target.id === replaceId);
        const target = {
          id: old?.id || crypto.randomUUID(), label: old?.label || labelField.value.trim() || `保存先${targets.length + 1}`,
          handle, baselineHash: await sha256(diskText), savedAt: '', verifiedContent: null, issue: null, remembered: false
        };
        if (old) targets[targets.indexOf(old)] = target;
        else { targets.push(target); labelField.value = ''; }
        await saveTargets(); refresh();
        await writeAll(false, [target.id]);
        return true;
      } catch (_) { setMessage(`保存先を準備できませんでした。有効な ${FILE_NAME} を選んでください。`); return false; }
    }
    async function removeTarget(id) {
      if (writing) return false;
      const index = targets.findIndex(target => target.id === id);
      if (index < 0) return false;
      const [removed] = targets.splice(index, 1);
      const remembered = await saveTargets();
      setMessage(`「${removed.label}」の登録を解除しました。ファイルは削除していません。` +
        (remembered ? '' : ' 次回も表示される場合は再度解除してください。'));
      return true;
    }
    async function loadFromTarget(id) {
      const target = targets.find(item => item.id === id);
      if (!target || writing || !importText) return false;
      if (!await permission(target, true)) { target.issue = 'permission'; refresh(); return false; }
      try {
        const text = await currentFileText(target.handle);
        parseBackup(text);
        if (!await importText(text)) return false;
        return adoptImportedText(text);
      } catch (_) { target.issue = 'error'; setMessage('選んだバックアップを読み込めませんでした。'); return false; }
    }
    async function adoptImportedText(text) {
      const hash = await sha256(text);
      let adopted = false;
      for (const target of targets) {
        try {
          if (await sha256(await currentFileText(target.handle)) === hash) {
            target.baselineHash = hash; target.issue = null; target.verifiedContent = null; adopted = true;
          }
        } catch (_) {}
      }
      if (adopted) { await saveTargets(); changed({ immediate: true }); }
      return adopted;
    }
    function changed(options = {}) {
      changeVersion++;
      message = '';
      if (writing) { pendingWrite = true; refresh(); return; }
      clearTimeout(timer);
      refresh();
      if (!settings.auto || !targets.some(target => target.issue !== 'conflict')) return;
      timer = setTimeout(() => writeAll(true), options.immediate ? 0 : Number(options.delay ?? 1500));
    }
    async function saveFromGesture() {
      if (!supported) { download?.(); return false; }
      if (!readyDone) await ready;
      if (!targets.length) return chooseTarget();
      return writeAll(false);
    }

    chooseButton.addEventListener('click', () => chooseTarget());
    saveButton.addEventListener('click', saveFromGesture);
    q('[data-action="download"]').addEventListener('click', () => download?.());
    autoField.addEventListener('change', event => {
      settings.auto = event.target.checked;
      saveSettings();
      if (settings.auto) changed({ immediate: true });
      else { clearTimeout(timer); refresh(); }
    });
    shortcutButton?.addEventListener('click', saveFromGesture);

    const ready = (async () => {
      if (!supported) { readyDone = true; refresh(); return; }
      try {
        const [record, legacy] = await Promise.all([readRecord(TARGET_RECORD), readRecord(LEGACY_RECORD)]);
        const items = Array.isArray(record?.targets) ? record.targets :
          legacy?.handle?.name === FILE_NAME && legacy.baselineHash ? [{
            id: crypto.randomUUID(), label: '以前の保存先', handle: legacy.handle,
            baselineHash: legacy.baselineHash, savedAt: legacy.savedAt || ''
          }] : [];
        targets = items.filter(item => item?.handle?.name === FILE_NAME && typeof item.baselineHash === 'string')
          .map(item => ({ ...item, remembered: true, verifiedContent: null, issue: null }));
        if (!Array.isArray(record?.targets) && targets.length) await saveTargets();
      } catch (_) { message = '保存先の記憶を読み込めませんでした。保存先を追加し直してください。'; }
      readyDone = true; refresh();
      if (targets.length && settings.auto) setTimeout(() => writeAll(true), 0);
    })();

    refresh();
    return { changed, saveFromGesture, chooseFromGesture: chooseTarget,
      loadFromHandle: loadFromTarget, adoptImportedText, ready,
      isWriting: () => writing, hasConflict: () => targets.some(target => target.issue === 'conflict') };
  }

  root.DashboardBackupFile = { mount };
})(window);
