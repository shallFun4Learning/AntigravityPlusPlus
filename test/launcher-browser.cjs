// Real browser regression for launcher initialization, actions and fallback paths.
// All API responses are synthetic; no installed Antigravity is launched or changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { CdpConnection } = require('../adapters/desktop/cdp');
const { waitForBrowserPage } = require('./browser-ready.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const executable = process.argv[2];
  assert.ok(executable && fs.existsSync(executable), 'Supply an installed Chromium executable');
  const root = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'easyag-launcher-browser-'));
  const calls = [];
  const status = {
    activeTarget: 'hub', phase: 'idle', port: 7890, enableProxy: true,
    enableI18n: true, enableContextMonitor: true, enableQuotaMonitor: true, dictEntries: 4150, clientRunning: false,
    accountRiskAcknowledged: false,
    accounts: { accounts: [], currentByTarget: { hub: null, ide: null } },
    targets: {
      hub: { exists: true, appExe: 'C:\\Synthetic\\Antigravity.exe' },
      ide: { exists: false, appExe: '' }
    }
  };
  let failLaunch = false;
  let conflict = false;
  let cleanupFails = false;
  let oauthState = 'idle';
  let oauthPolls = 0;
  let failRiskSave = false;
  let finishSwitch;
  let failSwitch = true;
  const streams = new Set();
  function publishStatus(patch) {
    Object.assign(status, patch);
    for (const stream of streams) stream.write(`data: ${JSON.stringify(patch)}\n\n`);
  }
  function progress(accountId, stage, state, extra = {}) {
    status.accountSwitch = { accountId, target: 'hub', stage, state, revision: (status.accountSwitch?.revision || 0) + 1, ...extra };
    for (const stream of streams) stream.write(`data: ${JSON.stringify({ accountSwitch: status.accountSwitch })}\n\n`);
  }
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (!route.startsWith('/api/')) {
      const files = { '/': 'index.html', '/ui/launcher.js': 'ui/launcher.js', '/ui/workspace.js': 'ui/workspace.js', '/ui/api.js': 'ui/api.js', '/ui/launcher.css': 'ui/launcher.css', '/assets/logo-64.png': 'assets/logo-64.png' };
      if (!files[route]) { res.writeHead(404); res.end(); return; }
      const mime = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
      res.setHeader('Content-Type', mime[path.extname(route)] || 'text/html; charset=utf-8');
      res.end(fs.readFileSync(path.join(root, files[route])));
      return;
    }
    if (route === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    calls.push({ route, input, method: req.method });
    let result = { ok: true };
    if (route === '/api/status') result = status;
    if (route === '/api/accounts') result = status.accounts;
    if (route === '/api/accounts/oauth/start') {
      oauthState = 'waiting';
      oauthPolls = 0;
      result = {
        ok: true,
        state: oauthState,
        url: 'http://127.0.0.1:45678/oauth-callback?state=synthetic-state',
        expiresAt: Date.now() + 300000
      };
    }
    if (route === '/api/accounts/oauth/open') {
      oauthState = 'opened';
      result = { ok: true, state: oauthState, message: '登录页面已打开' };
    }
    if (route === '/api/accounts/oauth/status') {
      if (oauthState === 'opened' && ++oauthPolls >= 1) {
        oauthState = 'completed';
        const account = {
          id: 'synthetic-oauth-account',
          email: 'oauth-browser@example.com',
          label: '个人账号',
          hasAccessToken: true,
          hasRefreshToken: true,
          tokenExpiresAt: Date.now() + 3600000
        };
        status.accounts = {
          accounts: [
            account,
            {
              id: 'synthetic-switch-account',
              email: 'switch-browser@example.com',
              label: '工作账号',
              hasAccessToken: true,
              hasRefreshToken: true,
              tokenExpiresAt: Date.now() + 3600000
            }
          ],
          currentByTarget: { hub: 'synthetic-switch-account', ide: null }
        };
        result = { ok: true, state: oauthState, account, message: '已保存账号 oauth-browser@example.com' };
      } else {
        result = { ok: true, state: oauthState, url: oauthState === 'waiting' ? 'http://127.0.0.1:45678/oauth-callback?state=synthetic-state' : '', message: '等待登录' };
      }
    }
    if (route === '/api/accounts/oauth/cancel') {
      oauthState = 'idle';
      result = { ok: true, state: oauthState };
    }
    if (route === '/api/accounts/add') {
      const account = {
        id: 'synthetic-account',
        email: input.email,
        label: input.label,
        hasAccessToken: Boolean(input.accessToken),
        hasRefreshToken: Boolean(input.refreshToken),
        tokenExpiresAt: 0
      };
      status.accounts = { accounts: [account], currentByTarget: { hub: null, ide: null } };
      result = { ok: true, account, accounts: status.accounts };
    }
    if (route === '/api/accounts/switch') {
      const account = status.accounts.accounts.find(item => item.id === input.accountId) || status.accounts.accounts[0];
      progress(account.id, 'writing', 'working');
      await new Promise(resolve => { finishSwitch = resolve; });
      if (failSwitch) {
        progress(account.id, 'writing', 'failed', { error: '模拟写入失败' });
        res.statusCode = 400;
        result = { ok: false, error: '模拟写入失败' };
      } else {
        status.accounts.currentByTarget[input.target] = account.id;
        progress(account.id, 'complete', 'done', { launched: true });
        result = { ok: true, launched: true, account, accounts: status.accounts };
      }
    }
    if (route === '/api/logs') result = [{ at: new Date().toISOString(), category: 'SYSTEM', message: '启动器已就绪' }];
    if (route === '/api/config') {
      for (const key of ['port', 'enableProxy', 'enableI18n', 'enableContextMonitor', 'enableQuotaMonitor']) if (key in input) status[key] = input[key];
    }
    if (route === '/api/config' && input.targetApp) status.activeTarget = input.targetApp;
    if (route === '/api/config' && input.accountRiskAcknowledged === true) {
      if (failRiskSave) {
        res.statusCode = 400;
        result = { ok: false, error: '模拟设置保存失败' };
      } else {
        status.accountRiskAcknowledged = true;
        result = { ok: true, settings: { accountRiskAcknowledged: true } };
      }
    }
    if (route === '/api/set-target-path' || route === '/api/browse-exe') {
      const exe = route === '/api/browse-exe' ? 'D:\\Synthetic\\Browsed.exe' : input.path;
      if (exe === 'invalid.exe') { res.statusCode = 400; result = { ok: false, error: '指定的文件路径不存在' }; }
      else {
        status.targets[input.target] = { exists: Boolean(exe), appExe: exe, isCustom: Boolean(exe) };
        result = { ok: true, path: exe, status };
      }
    }
    if (route === '/api/launch' && failLaunch) { res.statusCode = 409; result = { ok: false, error: 'Synthetic launch failure', code: 'TARGET_NOT_FOUND' }; }
    if (route === '/api/launch' && conflict) { res.statusCode = 409; result = { ok: false, code: 'PROCESS_CONFLICT', error: '已有 AG 进程' }; }
    if (route === '/api/clean-and-launch' && cleanupFails) { res.statusCode = 409; result = { ok: false, code: 'CLEANUP_FAILED', error: '进程未退出' }; }
    if (route === '/api/launch' && !failLaunch && !conflict || route === '/api/clean-and-launch' && !cleanupFails) {
      publishStatus({ phase: 'running', activeTarget: input.target, clientRunning: true, cdpSockets: 1 });
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--no-proxy-server', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let socket;
  let reopenedServer;
  try {
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); } catch {}
      if (!port) await sleep(100);
    }
    assert.ok(port, 'Browser starts');
    const page = await waitForBrowserPage(port, browser);
    socket = await new CdpConnection(page.webSocketDebuggerUrl).open();
    const evaluate = async expression => {
      const result = await socket.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).catch(error => { throw new Error(`Evaluate ${expression}: ${error.message}`); });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const waitFor = async expression => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(50); }
      assert.fail(`Timed out: ${expression}`);
    };
    const activate = selector => evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!button?.getClientRects().length) throw new Error('Control is not visible');
      button.focus(); button.click();
    })()`);
    const click = id => activate('#' + id);
    const navigate = view => activate(`nav [data-view="${view}"]`);
    const screenshot = async name => {
      if (!process.argv[4]) return;
      await evaluate('document.fonts.ready.then(() => true)');
      const { data } = await socket.command('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(process.argv[4], { recursive: true });
      fs.writeFileSync(path.join(process.argv[4], name + '.png'), Buffer.from(data, 'base64'));
    };
    const resize = (width, height) => socket.command('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 1 });
    await resize(1080, 730);
    await socket.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    const visible = "document.getElementById('pathModal').style.display === 'flex'";
    const riskVisible = "document.getElementById('accountRiskModal').style.display === 'flex'";
    await socket.command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await waitFor("document.body?.dataset.uiState === 'idle'");
    assert.equal(await evaluate("document.getElementById('launchBtn').disabled"), false);
    assert.equal(await evaluate(riskVisible), false, '普通启动不弹出账号风险提示');
    await evaluate("window.confirm = () => { throw new Error('不应调用原生确认框'); }");
    await navigate('accounts');
    await waitFor(riskVisible);
    assert.equal(await evaluate("document.getElementById('accountRiskCheckbox').checked"), false);
    assert.equal(await evaluate("document.getElementById('accountRiskAccept').disabled"), true);
    assert.match(await evaluate("document.getElementById('accountRiskDescription').textContent"), /封禁/);
    assert.match(await evaluate("document.getElementById('accountRiskDescription').textContent"), /法律法规/);
    assert.match(await evaluate("document.getElementById('accountRiskDescription').textContent"), /Google 服务条款/);
    await click('accountRiskAccept');
    assert.equal(calls.some(call => call.route === '/api/accounts/import-current'), false);
    assert.equal(calls.some(call => call.input.accountRiskAcknowledged === true), false);
    await click('accountRiskCheckbox');
    await click('accountRiskCancel');
    await waitFor(`!(${riskVisible})`);
    assert.equal(await evaluate("document.querySelector('[data-page=home]').hidden"), false);
    assert.equal(calls.some(call => call.input.accountRiskAcknowledged === true), false, '取消不记录已确认');
    await navigate('accounts');
    await waitFor(riskVisible);
    assert.equal(await evaluate("document.getElementById('accountRiskCheckbox').checked"), false, '再次进入时仍需主动勾选');
    assert.equal(calls.some(call => call.route === '/api/accounts/oauth/start'), false, '确认之前不创建登录流程');
    await click('accountRiskCheckbox');
    assert.equal(await evaluate("document.getElementById('accountRiskAccept').disabled"), false);
    failRiskSave = true;
    await click('accountRiskAccept');
    await waitFor("!document.getElementById('accountRiskError').hidden");
    assert.equal(await evaluate(riskVisible), true, '确认状态保存失败时保持弹窗');
    assert.equal(calls.some(call => call.route === '/api/accounts/oauth/start'), false);
    assert.equal(status.accountRiskAcknowledged, false);
    failRiskSave = false;
    await click('accountRiskAccept');
    await waitFor(`!(${riskVisible})`);
    assert.equal(status.accountRiskAcknowledged, true);
    await waitFor("!document.querySelector('[data-page=accounts]').hidden");
    assert.equal(await evaluate("document.getElementById('accountImportBtn').getClientRects().length"), 1);
    await click('accountAddBtn');
    await waitFor("document.getElementById('accountForm').style.display === 'block'");
    await waitFor("document.getElementById('accountLoginUrlInput').value.includes('/oauth-callback')");
    assert.equal(await evaluate("document.getElementById('accountCopyLink').disabled"), false);
    assert.match(await evaluate("document.querySelector('.account-callback-hint').textContent"), /复制登录成功后的链接/);
    assert.equal(await evaluate("document.getElementById('accountCallbackFill').disabled"), true);
    await click('accountOpenLink');
    await waitFor("document.getElementById('accountList').textContent.includes('oauth-browser@example.com')");
    assert.ok(calls.some(call => call.route === '/api/accounts/oauth/start'));
    assert.ok(calls.some(call => call.route === '/api/accounts/oauth/open'));
    await waitFor("document.getElementById('accountForm').style.display === 'none'");
    await evaluate("window.confirm = () => { throw new Error('不应调用原生确认框'); }");
    const selected = "document.querySelector('.account-item[aria-pressed=true]').dataset.account";
    const current = "document.querySelector('.account-item:has(.current-label)').dataset.account";
    await activate('[data-account=synthetic-switch-account]');
    assert.equal(await evaluate("document.getElementById('switchAccountBtn').disabled"), true);
    await activate('[data-account=synthetic-oauth-account]');
    assert.equal(await evaluate(selected), 'synthetic-oauth-account');
    assert.equal(await evaluate(current), 'synthetic-switch-account');
    assert.equal(calls.filter(call => call.route === '/api/accounts/switch').length, 0);
    await click('dismissNotice');
    await screenshot('accounts');
    await evaluate("document.getElementById('accountSearch').value = 'unknown'; document.getElementById('accountSearch').dispatchEvent(new Event('input'))");
    assert.match(await evaluate("document.getElementById('accountList').textContent"), /没有匹配/);
    assert.equal(await evaluate("document.getElementById('accountDetail').hidden"), true);
    await evaluate("document.getElementById('accountSearch').value = ''; document.getElementById('accountSearch').dispatchEvent(new Event('input'))");
    await navigate('home');
    await screenshot('workspace');
    await navigate('network');
    await click('customPortBtn');
    assert.equal(await evaluate("document.activeElement.id"), 'proxyPortInput');
    const enterPort = value => evaluate(`(() => {
      const input = document.getElementById('proxyPortInput');
      input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('change'));
    })()`);
    await enterPort('70000');
    await waitFor("document.getElementById('proxyPortInput').getAttribute('aria-invalid') === 'true'");
    assert.equal(calls.some(call => call.input.port === 70000), false);
    await enterPort('9123');
    await waitFor("document.getElementById('portCurrentState').textContent.includes('9123')");
    await navigate('home');
    assert.equal(await evaluate("document.getElementById('homeSettings').contains(document.getElementById('proxyPortInput'))"), true);
    assert.equal(await evaluate("document.getElementById('proxyPortInput').value"), '9123');
    await activate('[data-port="7890"]');
    await navigate('accounts');
    await activate('[data-account=synthetic-oauth-account]');
    await resize(520, 640);
    assert.equal(await evaluate("document.getElementById('workspace').scrollWidth <= document.getElementById('workspace').clientWidth"), true);
    const headerY = await evaluate("document.getElementById('launchBtn').getBoundingClientRect().top");
    await evaluate("document.getElementById('workspace').scrollTop = 500");
    assert.equal(await evaluate("document.getElementById('launchBtn').getBoundingClientRect().top"), headerY);
    await resize(1080, 730);
    await click('switchAccountBtn');
    await waitFor("document.getElementById('accountConfirmModal').style.display === 'flex'");
    await click('accountConfirmCancel');
    assert.equal(calls.some(call => call.route === '/api/accounts/switch'), false);
    await click('switchAccountBtn');
    await waitFor("document.getElementById('accountConfirmModal').style.display === 'flex'");
    assert.match(await evaluate("document.getElementById('accountConfirmMessage').textContent"), /桌面版/);
    await click('accountConfirmOk');
    await waitFor("document.getElementById('switchProgress').textContent.includes('正在更新登录状态')");
    assert.equal(await evaluate("document.getElementById('switchAccountBtn').disabled"), true);
    assert.equal(await evaluate(current), 'synthetic-switch-account');
    finishSwitch();
    await waitFor("document.getElementById('switchProgress').textContent.includes('模拟写入失败') && !document.getElementById('switchAccountBtn').disabled");
    assert.equal(await evaluate(current), 'synthetic-switch-account');
    failSwitch = false;
    await click('switchAccountBtn');
    await waitFor("document.getElementById('accountConfirmModal').style.display === 'flex'");
    await click('accountConfirmOk');
    await waitFor("document.getElementById('switchProgress').textContent.includes('正在更新登录状态')");
    finishSwitch();
    await waitFor(`${current} === 'synthetic-oauth-account'`);
    assert.ok(calls.some(call => call.route === '/api/accounts/switch' && call.input.accountId === 'synthetic-oauth-account'));
    assert.equal(await evaluate(riskVisible), false, '后续切换无需重复确认风险');
    const confirmationCount = calls.filter(call => call.input.accountRiskAcknowledged === true).length;
    reopenedServer = http.createServer(server.listeners('request')[0]);
    reopenedServer.listen(0, '127.0.0.1');
    await once(reopenedServer, 'listening');
    await socket.command('Page.navigate', { url: `http://127.0.0.1:${reopenedServer.address().port}/` });
    await waitFor("document.body?.dataset.uiState === 'idle'");
    await navigate('accounts');
    await waitFor("!document.querySelector('[data-page=accounts]').hidden");
    await click('accountAddBtn');
    await waitFor("document.getElementById('accountForm').style.display === 'block'");
    assert.equal(await evaluate(riskVisible), false, '重新打开且本地端口改变后仍不重复提示');
    assert.equal(calls.filter(call => call.input.accountRiskAcknowledged === true).length, confirmationCount);
    await click('accountFormCancel');
    await navigate('enhance');
    assert.match(await evaluate("document.getElementById('enhancementMonitorRow').textContent"), /界面深度汉化与监控/);
    assert.equal(await evaluate("document.getElementById('enhancementMonitorToggle').checked"), true);
    assert.equal(await evaluate("document.getElementById('enhancementMonitorToggle').indeterminate"), false);
    const checked = id => evaluate(`document.getElementById(${JSON.stringify(id)}).checked`);
    const shown = id => evaluate(`!!document.getElementById(${JSON.stringify(id)}).getClientRects().length`);
    await click('contextMonitorToggle');
    assert.equal(await evaluate("document.getElementById('enhancementMonitorToggle').indeterminate"), true);
    assert.equal(await checked('quotaMonitorToggle'), true);
    assert.equal(await shown('contextPreview'), false);
    assert.equal(await shown('quotaPreview'), true);
    await click('quotaMonitorToggle');
    assert.equal(await shown('emptyPreview'), true);
    await click('contextMonitorToggle');
    assert.equal(await shown('quotaPreview'), false);
    assert.equal(await shown('contextPreview'), true);
    await click('enhancementMonitorToggle');
    assert.equal(await checked('i18nToggle'), true);
    assert.equal(await checked('contextMonitorToggle'), true);
    assert.equal(await checked('quotaMonitorToggle'), true);
    await click('enhancementMonitorToggle');
    assert.equal(await checked('i18nToggle'), false);
    assert.equal(await checked('contextMonitorToggle'), false);
    assert.equal(await checked('quotaMonitorToggle'), false);
    await click('enhancementMonitorToggle');
    await click('contextMonitorToggle');
    await waitFor("!document.getElementById('contextMonitorToggle').checked");
    assert.ok(calls.some(({ input }) => input.enableQuotaMonitor === false && Object.keys(input).length === 1));
    const theme = await evaluate('document.documentElement.dataset.theme');
    await click('themeToggleBtn');
    await waitFor(`document.documentElement.dataset.theme !== ${JSON.stringify(theme)}`);
    await navigate('home');
    await screenshot('desktop-rings-light');
    const writeCount = () => calls.filter(call => call.method === 'POST').length;
    const idleWrites = writeCount();
    await click('targetIdeBtn');
    assert.equal(await shown('targetNotice'), true);
    assert.match(await evaluate("document.getElementById('targetNoticeTitle').textContent"), /未检测到 Antigravity IDE/);
    assert.equal(await evaluate(visible), false);
    assert.equal(await evaluate("document.getElementById('targetIdeBtn').getAttribute('aria-pressed')"), 'true');
    await navigate('network');
    assert.equal(await shown('editTargetPath'), true);
    assert.equal(writeCount(), idleWrites, 'Browsing a missing client does not save settings, start or restart it');
    await click('editTargetPath');
    await waitFor(visible);
    await evaluate(`document.getElementById('customPathInput').value = ${JSON.stringify('D:\\Typing.exe')}`);
    await sleep(3300); // Cross the normal status poll: editing must survive it.
    assert.equal(await evaluate("document.getElementById('customPathInput').value"), 'D:\\Typing.exe');
    await click('modalCancelBtn');
    await waitFor(`!(${visible})`);
    await click('launchBtn'); // Missing target must remain actionable after dismissal.
    await waitFor(visible);
    await evaluate("document.getElementById('customPathInput').value = 'invalid.exe'");
    await click('savePathBtn');
    await waitFor("document.getElementById('pathEditTip').style.display === 'flex'");
    await evaluate(`document.getElementById('customPathInput').value = ${JSON.stringify('D:\\Synthetic\\IDE.exe')}`);
    await click('savePathBtn');
    await waitFor(`!(${visible})`);
    assert.ok(calls.some(call => call.route === '/api/set-target-path' && call.input.target === 'ide' && call.input.path === 'D:\\Synthetic\\IDE.exe'));
    await click('targetHubBtn');
    await click('launchBtn');
    await waitFor("document.body?.dataset.uiState === 'running'");
    assert.ok(calls.some(call => call.route === '/api/launch'));
    assert.equal(await evaluate("document.getElementById('targetIdeBtn').disabled"), false);
    const runningWrites = writeCount();
    await click('targetIdeBtn');
    await waitFor("document.getElementById('targetNoticeTitle').textContent.includes('正在查看 IDE 版')");
    publishStatus({ activeTarget: 'hub', targets: { ...status.targets, ide: { ...status.targets.ide, exists: false } } });
    await navigate('home');
    await waitFor("document.getElementById('targetNoticeTitle').textContent.includes('未检测到 Antigravity IDE')");
    await sleep(3200); // The backend keeps reporting the running desktop during polling.
    assert.equal(await evaluate("document.getElementById('targetIdeBtn').getAttribute('aria-pressed')"), 'true');
    assert.equal(await evaluate("document.getElementById('targetHubBtn').getAttribute('aria-pressed')"), 'false');
    assert.match(await evaluate("document.getElementById('targetNoticeText').textContent"), /桌面版/);
    assert.equal(await evaluate(visible), false);
    assert.equal(await evaluate("document.getElementById('clientStatusBadge').textContent"), '未检测到');
    assert.equal(await evaluate("document.getElementById('launchBtn').disabled"), true);
    assert.equal(await evaluate("document.getElementById('quotaMonitorToggle').disabled"), true);
    await screenshot('ide-preview-light');
    await click('launchBtn');
    await navigate('accounts');
    assert.equal(await evaluate("document.getElementById('switchAccountBtn').disabled"), true);
    await click('switchAccountBtn');
    assert.equal(await shown('accountConfirmModal'), false);
    assert.equal(writeCount(), runningWrites, 'Previewing the other client must leave the running session untouched');
    await click('targetHubBtn');
    assert.match(await evaluate("document.getElementById('launchText').textContent"), /重启 Antigravity/);
    assert.equal(await shown('targetNotice'), false);
    publishStatus({ phase: 'idle', clientRunning: false, cdpSockets: 0 });
    await waitFor("document.body?.dataset.uiState === 'idle'");
    conflict = true;
    await click('launchBtn');
    await waitFor("document.getElementById('processModal').style.display === 'flex'");
    assert.equal(await evaluate("document.getElementById('pathModal').style.display"), 'none');
    await click('processCancelBtn');
    await click('launchBtn');
    await waitFor("document.getElementById('processModal').style.display === 'flex'");
    cleanupFails = true;
    await click('processCleanBtn');
    await waitFor("document.getElementById('processError').textContent.includes('进程未退出')");
    assert.equal(await evaluate("document.getElementById('processCleanBtn').disabled"), false);
    cleanupFails = false;
    await click('processCleanBtn');
    await waitFor("document.body?.dataset.uiState === 'running'");
    await click('launchBtn');
    await waitFor("document.getElementById('processModal').style.display === 'flex'");
    await click('processCancelBtn');
    publishStatus({ phase: 'idle', clientRunning: false, cdpSockets: 0 });
    await waitFor("document.body?.dataset.uiState === 'idle'");
    conflict = false;
    failLaunch = true;
    await click('launchBtn');
    await waitFor(visible);
    assert.match(await evaluate("document.getElementById('pathTipText').textContent"), /Synthetic launch failure/);
    await click('browseExeBtn');
    await waitFor(`!(${visible})`);
    assert.ok(calls.some(call => call.route === '/api/browse-exe' && call.input.target === 'hub'));
    await click('targetIdeBtn');
    await click('launchBtn');
    await waitFor(visible);
    await click('resetPathBtn');
    await waitFor("document.getElementById('customPathInput').value === ''");
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await waitFor(`!(${visible})`);
    await click('launchBtn'); await waitFor(visible);
    await click('modalCloseBtn'); await waitFor(`!(${visible})`);
    await click('launchBtn'); await waitFor(visible);
    await click('pathModal'); await waitFor(`!(${visible})`);
    await click('updateBtn');
    await waitFor("document.getElementById('updateActionText').textContent === '↻ 检查更新'");
    assert.ok(calls.some(call => call.route === '/api/update'));
    console.log('PASS: independent ring controls, IDE preview across polling and session events, explicit path selection, account actions, launch and recovery');
  } finally {
    if (socket) { try { await socket.command('Browser.close'); } catch {} socket.close(); }
    if (browser.exitCode === null) browser.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (reopenedServer) {
      reopenedServer.closeAllConnections();
      await new Promise(resolve => reopenedServer.close(resolve));
    }
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (path.resolve(profile).startsWith(tempRoot) && path.basename(profile).startsWith('easyag-launcher-browser-')) {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chromium may still own its temporary files. */ }
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
