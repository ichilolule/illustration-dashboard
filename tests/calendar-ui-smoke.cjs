// Optional browser smoke test. Requires Playwright with Chromium installed.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(require.resolve('playwright', {
  paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()]
}));
const root = path.resolve(__dirname, '..');
async function waitForStoredJson(page, getterName, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      const text = await page.evaluate(name => window[name](), getterName);
      lastValue = JSON.parse(text);
      if (predicate(lastValue)) return lastValue;
    } catch (_) {}
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for ${getterName}: ${JSON.stringify(lastValue)}`);
}
(async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const file = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
      const data = await fs.readFile(file);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8');
      res.end(data);
    } catch (_) { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CALENDAR_CHROME_PATH || undefined
    });
  }
  catch (error) { server.close(); throw error; }
  try {
    const context = await browser.newContext({ viewport: { width: 1120, height: 900 } });
    const page = await context.newPage(), errors = [], remote = new Map();
    let version = 0, transientFailures = 1;
    let calendarResource = { id: 'dedicated@group.calendar.google.com', summary: '制作予定（ダッシュボード）',
      description: '', timeZone: 'Asia/Tokyo', labelProperties: { eventLabels: [] } };
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const fileHandle = async name => (await navigator.storage.getDirectory())
        .getFileHandle(name, { create: true });
      const backupHandle = () => fileHandle('dashboard_sync.json');
      const aiCasesHandle = () => fileHandle('dashboard_cases.json');
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: options => {
          if (options?.id && (options.id.length > 32 || !/^[A-Za-z0-9_-]+$/.test(options.id)))
            throw new TypeError('Invalid file picker id');
          return fileHandle(options?.suggestedName || 'dashboard_sync.json');
        }
      });
      window.__getBackupText = async () => (await (await backupHandle()).getFile()).text();
      window.__setBackupText = async value => {
        const writable = await (await backupHandle()).createWritable();
        await writable.write(String(value));
        await writable.close();
      };
      window.__getAiCasesText = async () => (await (await aiCasesHandle()).getFile()).text();
      window.__setAiCasesText = async value => {
        const writable = await (await aiCasesHandle()).createWritable();
        await writable.write(String(value));
        await writable.close();
      };
    });
    await context.route('https://cdn.jsdelivr.net/**', route => route.abort());
    await context.route('https://accounts.google.com/gsi/client', route => route.fulfill({
      contentType: 'application/javascript', body: `window.google={accounts:{oauth2:{
        hasGrantedAllScopes:()=>true,
        initTokenClient:(options)=>{window.__lastTokenConfig=options;return{requestAccessToken:()=>{
          window.__tokenRequestCount=(window.__tokenRequestCount||0)+1;
          if(window.__tokenMode==='cancel')return options.error_callback({type:'popup_closed'});
          options.callback({access_token:'mock-token',expires_in:3600});
        }}}
      }}};`
    }));
    await context.route('https://www.googleapis.com/**', async route => {
      const req = route.request(), url = new URL(req.url()), method = req.method();
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE',
        'Access-Control-Allow-Headers': 'authorization,content-type,if-match'
      } });
      let result = {}, status = 200;
      if (url.pathname.includes('/userinfo')) result = { sub: 'mock-account', email: 'mock@example.test' };
      else if (url.pathname.endsWith('/calendarList')) result = { items: [] };
      else if (url.pathname === '/calendar/v3/calendars') {
        calendarResource = { ...calendarResource, ...(req.postDataJSON() || {}) };
        result = calendarResource;
      }
      else if (url.pathname.startsWith('/calendar/v3/calendars/') && !url.pathname.includes('/events')) {
        if (method === 'PUT') calendarResource = { ...calendarResource, ...(req.postDataJSON() || {}) };
        result = calendarResource;
      }
      else if (method === 'GET') result = { items: [...remote.values()] };
      else {
        const body = req.postDataJSON();
        if (method === 'POST' && body.extendedProperties?.private?.dashboardKey !== 'status' && transientFailures > 0) {
          transientFailures--;
          status = 503;
          result = { error: { errors: [{ reason: 'backendError' }], message: 'Backend Error' } };
          return route.fulfill({ status, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: JSON.stringify(result) });
        }
        const id = method === 'POST' ? body.id : decodeURIComponent(url.pathname.split('/').at(-1));
        if (method === 'DELETE') { remote.delete(id); status = 204; }
        else {
          result = { ...(remote.get(id) || {}), ...body, id, etag: 'e' + ++version, updated: new Date().toISOString() };
          remote.set(id, result);
        }
      }
      await route.fulfill({ status, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: status === 204 ? '' : JSON.stringify(result) });
    });
    const url = 'http://localhost:' + server.address().port;
    await page.goto(url);
    const dateBoundary = await page.evaluate(() => {
      const savedCfg = localStorage.getItem('cfg');
      const cfg = getCfg();
      cfg.businessDayStartHour = 4;
      localStorage.setItem('cfg', JSON.stringify(cfg));
      const justAfterMidnight = new Date(2026, 8, 5, 0, 30);
      const holder = document.createElement('div');
      holder.innerHTML = buildMonthGrid(2026, 8, justAfterMidnight);
      const highlightedDay = holder.querySelector('.cal-cell.today .cal-date')?.firstChild?.textContent.trim();
      const businessDay = ymd(getBusinessDate(justAfterMidnight));
      const calendarDay = calendarTodayYmd(justAfterMidnight);
      if (savedCfg === null) localStorage.removeItem('cfg');
      else localStorage.setItem('cfg', savedCfg);
      return { businessDay, calendarDay, highlightedDay };
    });
    assert.deepEqual(dateBoundary, {
      businessDay: '2026-09-04',
      calendarDay: '2026-09-05',
      highlightedDay: '5'
    });
    const shortcut = page.locator('#google-transfer-shortcut');
    assert.equal(await shortcut.locator('.gcal-shortcut-label').innerText(), 'Google転記');
    assert.equal(await shortcut.getAttribute('data-connected'), 'false');
    assert.equal(await shortcut.locator('.gcal-sync-dot').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(222, 173, 84)');
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const section = page.locator('#google-calendar-settings');
    const backupSection = page.locator('#icloud-backup-settings');
    const aiSection = page.locator('#google-drive-ai-settings');
    await backupSection.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#icloud-backup-settings [data-role="status"]').textContent.length > 0);
    assert.match(await backupSection.innerText(), /最初に保存先を設定/);
    await backupSection.getByRole('button', { name: '保存先を設定' }).click();
    await page.waitForFunction(() => document.querySelector('#icloud-backup-settings [data-role="status"]').textContent.includes('上書き保存'));
    assert.equal(JSON.parse(await page.evaluate(() => window.__getBackupText())).cases.length, 0);
    const downloadPromise = page.waitForEvent('download');
    await backupSection.getByRole('button', { name: '通常ダウンロード' }).click();
    assert.equal((await downloadPromise).suggestedFilename(), 'dashboard_sync.json');
    await aiSection.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#google-drive-ai-settings [data-role="status"]').textContent.length > 0);
    assert.match(await aiSection.innerText(), /最初に保存先を設定/);
    await page.evaluate(() => localStorage.setItem('profile', JSON.stringify({
      name: '非公開の本名', addr: '非公開の住所', bankInfo: '非公開の口座', paypayId: 'private-paypay'
    })));
    await aiSection.getByRole('button', { name: '保存先を設定' }).click();
    await page.waitForFunction(() => document.querySelector('#google-drive-ai-settings [data-role="status"]').textContent.includes('上書き保存'));
    const initialAiCases = JSON.parse(await page.evaluate(() => window.__getAiCasesText()));
    assert.equal(initialAiCases.kind, 'illustration-dashboard-cases');
    assert.equal(initialAiCases.schemaVersion, 2);
    assert.deepEqual(initialAiCases.cases, []);
    assert.ok(!('profile' in initialAiCases) && !('settings' in initialAiCases) && !('googleCalendar' in initialAiCases));
    const aiDownloadPromise = page.waitForEvent('download');
    await aiSection.getByRole('button', { name: '通常ダウンロード' }).click();
    assert.equal((await aiDownloadPromise).suggestedFilename(), 'dashboard_cases.json');
    await section.waitFor({ state: 'visible' });
    assert.match(await section.innerText(), /初回接続の設定が必要/);
    await section.locator('[data-field="client"]').fill('123-mock.apps.googleusercontent.com');
    await section.getByRole('button', { name: '接続設定を保存' }).click();
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.includes('接続ボタン'));
    await page.evaluate(() => {
      const date = todayYmd();
      cases = [normalizeCase({ name: '動作確認用の案件', deadline: addDays(date, 5), workStatus: 'progress', step: '1', paymentTerms: 'postpaid', paymentStatus: 'unpaid', price: 12000 })];
      cases[0].contact = 'client@example.test';
      cases[0].detail = '青い衣装・笑顔\nhttps://example.test/reference';
      cases[0].memo = 'AIにも必要な内部メモ';
      saveAll();
    });
    page.once('dialog', dialog => dialog.accept());
    const stateMatrix = await page.evaluate(() => {
      const main = cases[0];
      const deadline = addDays(todayYmd(), 5);
      cases.push(
        normalizeCase({ id: 'delivered-unpaid', name: '納品済み後払い', deadline, step: '5', workStatus: 'wait', paymentTerms: 'postpaid', paymentStatus: 'unpaid' }),
        normalizeCase({ id: 'paid-in-progress', name: '入金済み制作中', deadline, step: '3', workStatus: 'progress', paymentTerms: 'prepaid', paymentStatus: 'paid', paidDate: todayYmd() })
      );
      archive.push(normalizeCase({ id: 'manual-archive', name: '未完了アーカイブ', step: '2', workStatus: 'wait', paymentStatus: 'unpaid' }));
      saveAll();
      const delivered = cases.find(item => item.id === 'delivered-unpaid');
      const schedule = buildScheduleMap();
      const waits = Object.values(schedule).flatMap(day => day.wait || []).map(item => item.caseName);
      const projection = buildAiCasesData();
      const result = {
        deliveredStayedActive: !!delivered,
        deliveredWorkStatus: delivered?.workStatus,
        deliveredOverallStatus: projection.cases.find(item => item.id === 'delivered-unpaid')?.overallStatus,
        paidInProgressStayedActive: cases.some(item => item.id === 'paid-in-progress'),
        manualArchivePreserved: archive.some(item => item.id === 'manual-archive' && item.step === '2'),
        deliveredExcludedFromWait: !waits.includes('納品済み後払い')
      };
      delivered.paymentStatus = 'paid';
      delivered.paidDate = todayYmd();
      saveAll();
      result.deliveredPaidArchived = archive.some(item => item.id === 'delivered-unpaid') && !cases.some(item => item.id === 'delivered-unpaid');
      cases.push(normalizeCase({ id: 'modal-transition', name: '編集画面から納品', step: '3', workStatus: 'progress', paymentStatus: 'paid', paidDate: todayYmd() }));
      openModal(cases.length - 1);
      document.getElementById('m-step').value = '5';
      updateWorkStatusUI();
      saveCase();
      result.modalPaidDeliveryArchived = archive.some(item => item.id === 'modal-transition') && !cases.some(item => item.id === 'modal-transition');
      cases = [main];archive = [];saveAll();
      return result;
    });
    assert.deepEqual(stateMatrix, {
      deliveredStayedActive: true,
      deliveredWorkStatus: null,
      deliveredOverallStatus: 'delivered_awaiting_payment',
      paidInProgressStayedActive: true,
      manualArchivePreserved: true,
      deliveredExcludedFromWait: true,
      deliveredPaidArchived: true,
      modalPaidDeliveryArchived: true
    });
    await shortcut.click();
    await page.waitForFunction(() => document.querySelector('.gcal-shortcut-label').textContent === '転記中…');
    assert.equal(await shortcut.isEnabled(), false);
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.startsWith('転記完了') &&
      document.querySelector('.gcal-shortcut-label').textContent === 'Google転記');
    assert.equal(await shortcut.locator('.gcal-shortcut-label').innerText(), 'Google転記');
    assert.equal(await shortcut.getAttribute('data-connected'), 'true');
    assert.equal(await shortcut.locator('.gcal-sync-dot').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(111, 189, 152)');
    assert.ok(remote.size > 1);
    const workEvent = [...remote.values()].find(event => event.summary?.startsWith('☀️') || event.summary?.startsWith('🌃'));
    assert.ok(workEvent && workEvent.eventLabelId);
    assert.match(workEvent.description, /依頼詳細：\n青い衣装・笑顔/);
    assert.ok(!workEvent.description.includes('編集元') && !workEvent.description.includes('枠：'));
    assert.ok(![...remote.values()].some(event => event.summary?.includes('返信待ち')));
    assert.ok(calendarResource.labelProperties.eventLabels.some(label => label.name === '動作確認用の案件'));
    const count = remote.size;
    await shortcut.click();
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.includes('追加0・変更0・削除0'));
    assert.equal(remote.size, count);
    const boundaryRevision = await page.evaluate(() => googleCalendarSync.exportConfig().revision);
    await page.evaluate(() => {
      activeBusinessDay = addDays(todayYmd(), -1);
      refreshBusinessDay();
    });
    await page.waitForFunction(previous => googleCalendarSync.exportConfig().revision !== previous,
      boundaryRevision, { timeout: 15000 });
    const backup = await page.evaluate(() => googleCalendarSync.exportConfig());
    assert.ok(backup.calendarId && backup.revision && backup.clientId);
    assert.ok(backup.clientLabels?.['動作確認用の案件']?.id);
    assert.ok(!JSON.stringify(backup).includes('mock-token'));
    assert.ok(!('deviceId' in backup) && !('pendingRevision' in backup));
    await waitForStoredJson(page, '__getBackupText', data => !!data.googleCalendar?.revision);
    const directBackup = JSON.parse(await page.evaluate(() => window.__getBackupText()));
    assert.equal(directBackup.cases[0].name, '動作確認用の案件');
    assert.equal(directBackup.googleCalendar.revision, backup.revision);
    const aiCases = await waitForStoredJson(page, '__getAiCasesText', data => data.cases[0]?.name === '動作確認用の案件');
    assert.ok(aiCases.cases[0].id.startsWith('case_'));
    assert.equal(aiCases.cases[0].contact, 'client@example.test');
    assert.equal(aiCases.cases[0].memo, 'AIにも必要な内部メモ');
    assert.equal(aiCases.cases[0].overallStatus, 'in_progress');
    assert.equal(aiCases.cases[0].paymentTerms, 'postpaid');
    assert.equal(aiCases.cases[0].paymentStatus, 'unpaid');
    assert.ok(!('status' in aiCases.cases[0]) && !('paid' in aiCases.cases[0]) && !('payment' in aiCases.cases[0]));
    assert.ok(!JSON.stringify(aiCases).includes('非公開の本名'));
    assert.ok(!JSON.stringify(aiCases).includes('非公開の住所'));
    assert.ok(!JSON.stringify(aiCases).includes('非公開の口座'));
    page.once('dialog', dialog => dialog.accept());
    assert.equal(await page.evaluate(value => applyBackupText(JSON.stringify(value)), aiCases), true);
    const afterAiImport = await page.evaluate(() => googleCalendarSync.exportConfig());
    assert.equal(afterAiImport.revision, backup.revision);
    assert.equal(afterAiImport.calendarId, backup.calendarId);
    assert.equal(await page.evaluate(() => getProfile().name), '非公開の本名');
    if (process.env.CALENDAR_QA_DIR) {
      await page.evaluate(() => {
        cases.push(normalizeCase({ id: 'visual-delivered', name: '馬車道はげみ　かき氷', step: '5', workStatus: 'wait', paymentTerms: 'postpaid', paymentStatus: 'unpaid', paydue: addDays(todayYmd(), 2), deadline: addDays(todayYmd(), -5) }));
        saveAll();
      });
      await page.getByRole('button', { name: '案件一覧', exact: true }).click();
      assert.match(await page.locator('#case-list').innerText(), /馬車道はげみ　かき氷/);
      assert.match(await page.locator('#case-list').innerText(), /納品済み・入金待ち/);
      await page.screenshot({ path: path.join(process.env.CALENDAR_QA_DIR, 'case-list-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(process.env.CALENDAR_QA_DIR, 'case-list-mobile.png') });
      await page.setViewportSize({ width: 1120, height: 900 });
      await page.evaluate(() => { cases = cases.filter(item => item.id !== 'visual-delivered'); saveAll(); });
      await page.getByRole('button', { name: '設定', exact: true }).click();
    }
    const stableCaseId = aiCases.cases[0].id;
    // Editing the real dashboard fires the automatic projection hook.
    await page.evaluate(() => { cases[0].name = '変更後の案件'; saveAll(); });
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.startsWith('転記完了') &&
      !document.querySelector('#google-calendar-settings .gcal-status').textContent.includes('変更0'), { timeout: 15000 });
    assert.ok([...remote.values()].some(event => event.summary.includes('変更後の案件')));
    const workBeforeStatusRoundTrip = [...remote.values()]
      .filter(event => /^[☀🌃]/u.test(event.summary || ''))
      .map(event => [event.id, event.summary]).sort();
    await page.evaluate(() => {
      window.__originalCalendarChanged = googleCalendarSync.changed;
      window.__calendarChangeDelays = [];
      googleCalendarSync.changed = options => {
        window.__calendarChangeDelays.push(options?.delayMs || 0);
        return window.__originalCalendarChanged({ ...options, delayMs: Math.min(options?.delayMs || 0, 100) });
      };
    });
    await page.getByRole('button', { name: '案件一覧', exact: true }).click();
    const changedCaseCard = page.locator('#case-list .case-card').filter({ hasText: '変更後の案件' });
    await changedCaseCard.getByRole('button', { name: '確認待ち', exact: true }).click();
    await changedCaseCard.getByRole('button', { name: '進行中', exact: true }).click();
    await page.waitForTimeout(2500);
    assert.deepEqual(await page.evaluate(() => window.__calendarChangeDelays), [60000, 60000]);
    assert.deepEqual([...remote.values()]
      .filter(event => /^[☀🌃]/u.test(event.summary || ''))
      .map(event => [event.id, event.summary]).sort(), workBeforeStatusRoundTrip);
    assert.ok(![...remote.values()].some(event => event.summary?.includes('返信待ち')));
    await page.evaluate(() => { googleCalendarSync.changed = window.__originalCalendarChanged; });
    const tokenRequestsBeforeExpiry = await page.evaluate(() => window.__tokenRequestCount || 0);
    await page.evaluate(() => {
      const realNow = Date.now;
      Date.now = () => realNow() + 2 * 60 * 60 * 1000;
      activeBusinessDay = addDays(todayYmd(), -1);
      refreshBusinessDay();
      Date.now = realNow;
    });
    await page.waitForFunction(() => document.querySelector('.gcal-shortcut-label').textContent === '未転記');
    assert.equal(await page.evaluate(() => window.__tokenRequestCount || 0), tokenRequestsBeforeExpiry);
    await page.getByRole('button', { name: 'カレンダー', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__tokenRequestCount || 0), tokenRequestsBeforeExpiry);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__tokenRequestCount || 0), tokenRequestsBeforeExpiry);
    await page.locator('#google-transfer-shortcut').click();
    await page.waitForFunction(expected => (window.__tokenRequestCount || 0) === expected,
      tokenRequestsBeforeExpiry + 1);
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.startsWith('転記完了'),
      { timeout: 15000 });
    const tokenRequestsBeforeCancel = await page.evaluate(() => window.__tokenRequestCount || 0);
    await page.evaluate(() => {
      const realNow = Date.now;
      Date.now = () => realNow() + 2 * 60 * 60 * 1000;
      window.__tokenMode = 'cancel';
      cases[0].memo = '再接続取消テスト';
      saveAll();
      Date.now = realNow;
    });
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await page.waitForFunction(expected => (window.__tokenRequestCount || 0) === expected,
      tokenRequestsBeforeCancel + 1);
    await page.getByRole('button', { name: '案件一覧', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__tokenRequestCount || 0), tokenRequestsBeforeCancel + 1);
    await page.evaluate(() => { window.__tokenMode = 'success'; });
    await page.locator('#google-transfer-shortcut').click();
    await page.waitForFunction(expected => (window.__tokenRequestCount || 0) === expected,
      tokenRequestsBeforeCancel + 2);
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.startsWith('転記完了'),
      { timeout: 15000 });
    if (process.env.CASE_STATE_SMOKE_ONLY === '1') {
      assert.deepEqual(errors, []);
      console.log('PASS: case state transitions, AI projection, desktop and mobile rendering, calendar integration');
      return;
    }
    // A business-day boundary stays pending after restart without reconnecting on desktop/mobile browsing.
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.includes('接続ボタン'));
    await page.evaluate(() => {
      cases[0].name = '再起動後の案件';
      localStorage.setItem('cases', JSON.stringify(cases));
      activeBusinessDay = addDays(todayYmd(), -1);
      refreshBusinessDay();
    });
    const reloadedAiCases = await waitForStoredJson(page, '__getAiCasesText', data => data.cases[0]?.name === '再起動後の案件');
    assert.equal(reloadedAiCases.cases[0].id, stableCaseId);
    await page.waitForFunction(() => document.querySelector('.gcal-shortcut-label').textContent === '未転記');
    assert.equal(await page.evaluate(() => window.__tokenRequestCount || 0), 0);
    await page.getByRole('button', { name: '案件一覧', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__tokenRequestCount || 0), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'カレンダー', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__tokenRequestCount || 0), 0);
    assert.equal(await page.locator('#google-transfer-shortcut .gcal-shortcut-label').innerText(), '未転記');
    await page.locator('#google-transfer-shortcut').click();
    await page.waitForFunction(() => (window.__tokenRequestCount || 0) === 1);
    assert.equal(await page.evaluate(() => window.__lastTokenConfig.login_hint), 'mock-account');
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.startsWith('転記完了'), { timeout: 15000 });
    assert.ok([...remote.values()].some(event => event.summary.includes('再起動後の案件')));
    assert.equal(await page.locator('#google-transfer-shortcut .gcal-shortcut-label').innerText(), 'Google転記');
    await page.setViewportSize({ width: 1120, height: 900 });
    // A cancelled automatic reconnect is not repeated on every screen action; the pending shortcut remains the recovery path.
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.includes('接続ボタン'));
    await page.evaluate(() => {
      window.__tokenMode = 'cancel';
      cases[0].memo = '再接続取消テスト';
      saveAll();
    });
    await page.getByRole('button', { name: 'カレンダー', exact: true }).click();
    await page.waitForFunction(() => (window.__tokenRequestCount || 0) === 1);
    await page.waitForFunction(() => document.querySelector('.gcal-shortcut-label').textContent === '未転記');
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__tokenRequestCount || 0), 1);
    await page.evaluate(() => { window.__tokenMode = 'success'; });
    await page.locator('#google-transfer-shortcut').click();
    await page.waitForFunction(() => (window.__tokenRequestCount || 0) === 2);
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.startsWith('転記完了') &&
      document.querySelector('.gcal-shortcut-label').textContent === 'Google転記', { timeout: 15000 });
    // An explicitly confirmed stale lock can be taken over even when Google's revision advanced.
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const marker = [...remote.values()].find(event => event.extendedProperties?.private?.dashboardKey === 'status');
    marker.extendedProperties.private.revision = 'b'.repeat(32);
    marker.extendedProperties.private.busy = 'installed-web-app-device';
    marker.extendedProperties.private.busySince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    marker.etag = 'e' + ++version;
    remote.set(marker.id, marker);
    await section.getByRole('button', { name: '今すぐ転記' }).click();
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.includes('引き継いで再開'));
    const takeover = section.getByRole('button', { name: '中断した転記をこの端末で引き継ぐ' });
    await takeover.waitFor({ state: 'visible' });
    page.once('dialog', dialog => dialog.accept());
    await takeover.click();
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.startsWith('転記完了'));
    assert.equal(remote.get(marker.id).extendedProperties.private.busy, '');
    await section.scrollIntoViewIfNeeded();
    if (process.env.CALENDAR_QA_DIR) {
      await page.screenshot({ path: path.join(process.env.CALENDAR_QA_DIR, 'calendar-settings-desktop.png') });
      await page.getByRole('button', { name: 'カレンダー', exact: true }).click();
      await page.screenshot({ path: path.join(process.env.CALENDAR_QA_DIR, 'calendar-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(process.env.CALENDAR_QA_DIR, 'calendar-mobile.png') });
      await page.getByRole('button', { name: '設定', exact: true }).click();
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.CALENDAR_QA_DIR, 'calendar-settings-mobile.png') });
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.ok(await page.evaluate(() => document.querySelector('.top-bar > span').getBoundingClientRect().height < 30));
    // A conflict in the AI-facing Google Drive file does not stop the independent iCloud backup.
    await page.evaluate(async () => {
      const cloud = JSON.parse(await window.__getAiCasesText());
      cloud.cases[0].memo = 'Google Drive側の外部更新';
      cloud.updatedAt = new Date(Date.now() + 60000).toISOString();
      await window.__setAiCasesText(JSON.stringify(cloud, null, 2));
      cases[0].memo = 'iCloudへ保存する変更';
      saveAll();
    });
    await page.waitForFunction(() => document.querySelector('#google-drive-ai-settings [data-role="status"]').textContent.includes('自動保存を停止'));
    await waitForStoredJson(page, '__getBackupText', data => data.cases[0]?.memo === 'iCloudへ保存する変更');
    assert.equal(JSON.parse(await page.evaluate(() => window.__getAiCasesText())).cases[0].memo, 'Google Drive側の外部更新');
    // An external edit of the selected iCloud file pauses writes until the user imports that version.
    await page.evaluate(async () => {
      const cloud = JSON.parse(await window.__getBackupText());
      cloud.cases[0].name = 'iCloud側の案件';
      cloud.exported = new Date(Date.now() + 60000).toISOString();
      await window.__setBackupText(JSON.stringify(cloud, null, 2));
      cases[0].memo = 'ローカル側の未保存変更';
      saveAll();
    });
    await page.waitForFunction(() => document.querySelector('#icloud-backup-settings [data-role="status"]').textContent.includes('自動保存を停止'));
    assert.equal(JSON.parse(await page.evaluate(() => window.__getBackupText())).cases[0].name, 'iCloud側の案件');
    page.once('dialog', dialog => dialog.accept());
    await backupSection.getByRole('button', { name: '保存先を読み込む' }).click();
    await page.waitForFunction(() => cases[0]?.name === 'iCloud側の案件');
    await page.waitForFunction(() => document.querySelector('#icloud-backup-settings [data-role="status"]').textContent.includes('上書き保存'));
    assert.equal(JSON.parse(await page.evaluate(() => window.__getBackupText())).cases[0].name, 'iCloud側の案件');
    // A stale open tab cannot reconnect and send its obsolete in-memory cases.
    const other = await context.newPage();
    await other.goto(url);
    await other.waitForFunction(() => document.querySelector('#icloud-backup-settings [data-role="status"]').textContent.includes('自動保存を利用できます'));
    await other.evaluate(() => localStorage.setItem('cases', '[]'));
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.includes('別のタブ'));
    await section.getByRole('button', { name: 'Googleに接続して転記' }).click();
    assert.match(await section.locator('.gcal-status').innerText(), /再読み込み/);
    assert.deepEqual(errors, []);
    console.log('PASS: state migration, delivered-payment transitions, midnight highlight, retry, client labels, event details, repeat sync, dual JSON saves, AI privacy filter, conflict recovery, mobile layout, stale-tab guard');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
