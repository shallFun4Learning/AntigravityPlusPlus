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
    enableI18n: true, enableContextMonitor: true, clientRunning: false,
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
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (!route.startsWith('/api/')) {
      const files = { '/': 'index.html', '/ui/launcher.js': 'ui/launcher.js', '/ui/api.js': 'ui/api.js', '/ui/launcher.css': 'ui/launcher.css' };
      if (!files[route]) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', route.endsWith('.js') ? 'text/javascript' : route.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
      res.end(fs.readFileSync(path.join(root, files[route])));
      return;
    }
    if (route === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    calls.push({ route, input });
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
          label: '网页登录账号',
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
              label: '切换测试账号',
              hasAccessToken: true,
              hasRefreshToken: true,
              tokenExpiresAt: Date.now() + 3600000
            }
          ],
          currentByTarget: { hub: null, ide: null }
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
      status.accounts.currentByTarget.hub = account?.id || null;
      result = { ok: true, launched: true, account, accounts: status.accounts };
    }
    if (route === '/api/logs') result = [];
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
    const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    const visible = "document.getElementById('pathModal').style.display === 'flex'";
    const riskVisible = "document.getElementById('accountRiskModal').style.display === 'flex'";
    await socket.command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await waitFor("document.body.dataset.uiState === 'idle'");
    assert.equal(await evaluate("document.getElementById('launchBtn').disabled"), false);
    assert.equal(await evaluate(riskVisible), false, '普通启动不弹出账号风险提示');
    await evaluate("window.confirm = () => { throw new Error('不应调用原生确认框'); }");
    await click('accountImportBtn');
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
    assert.equal(calls.some(call => call.input.accountRiskAcknowledged === true), false, '取消不记录已确认');
    await click('accountAddBtn');
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
    await evaluate("Array.from(document.querySelectorAll('#accountList button')).find(button => button.textContent.trim() === '切换').click()");
    await waitFor("document.getElementById('accountConfirmModal').style.display === 'flex'");
    assert.match(await evaluate("document.getElementById('accountConfirmMessage').textContent"), /桌面版/);
    await click('accountConfirmOk');
    for (let i = 0; i < 100 && !calls.some(call => call.route === '/api/accounts/switch'); i++) await sleep(50);
    assert.ok(calls.some(call => call.route === '/api/accounts/switch' && call.input.accountId === 'synthetic-oauth-account'));
    assert.equal(await evaluate(riskVisible), false, '后续切换无需重复确认风险');
    const confirmationCount = calls.filter(call => call.input.accountRiskAcknowledged === true).length;
    reopenedServer = http.createServer(server.listeners('request')[0]);
    reopenedServer.listen(0, '127.0.0.1');
    await once(reopenedServer, 'listening');
    await socket.command('Page.navigate', { url: `http://127.0.0.1:${reopenedServer.address().port}/` });
    await waitFor("document.body.dataset.uiState === 'idle'");
    await click('accountAddBtn');
    await waitFor("document.getElementById('accountForm').style.display === 'block'");
    assert.equal(await evaluate(riskVisible), false, '重新打开且本地端口改变后仍不重复提示');
    assert.equal(calls.filter(call => call.input.accountRiskAcknowledged === true).length, confirmationCount);
    await click('accountFormCancel');
    assert.match(await evaluate("document.getElementById('enhancementMonitorRow').textContent"), /界面深度汉化与监控/);
    assert.equal(await evaluate("document.getElementById('enhancementMonitorToggle').checked"), true);
    assert.equal(await evaluate("document.getElementById('enhancementMonitorToggle').indeterminate"), false);
    await click('contextMonitorToggle');
    assert.equal(await evaluate("document.getElementById('enhancementMonitorToggle').indeterminate"), true);
    await click('enhancementMonitorToggle');
    assert.equal(await evaluate("document.getElementById('i18nToggle').checked"), true);
    assert.equal(await evaluate("document.getElementById('contextMonitorToggle').checked"), true);
    await click('enhancementMonitorToggle');
    assert.equal(await evaluate("document.getElementById('i18nToggle').checked"), false);
    assert.equal(await evaluate("document.getElementById('contextMonitorToggle').checked"), false);
    const theme = await evaluate('document.documentElement.dataset.theme');
    await click('themeToggleBtn');
    await waitFor(`document.documentElement.dataset.theme !== ${JSON.stringify(theme)}`);
    await click('targetIdeBtn');
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
    await waitFor("document.body.dataset.uiState === 'running'");
    assert.ok(calls.some(call => call.route === '/api/launch'));
    assert.equal(await evaluate("document.getElementById('targetIdeBtn').disabled"), true);
    await waitFor("document.body.dataset.uiState === 'idle'");
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
    await waitFor("document.body.dataset.uiState === 'running'");
    await click('launchBtn');
    await waitFor("document.getElementById('processModal').style.display === 'flex'");
    await click('processCancelBtn');
    await waitFor("document.body.dataset.uiState === 'idle'");
    conflict = false;
    failLaunch = true;
    await click('launchBtn');
    await waitFor(visible);
    assert.match(await evaluate("document.getElementById('pathTipText').textContent"), /Synthetic launch failure/);
    await click('browseExeBtn');
    await waitFor(`!(${visible})`);
    assert.ok(calls.some(call => call.route === '/api/browse-exe' && call.input.target === 'hub'));
    status.targets.ide.exists = false;
    await click('targetIdeBtn');
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
    console.log('PASS: first-use account risk checkbox, cancellation, save retry and persistence across ports; account switching, theme, launch, failure recovery, polling and update');
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
