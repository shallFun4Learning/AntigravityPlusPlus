/**
 * 基础层冒烟：不启动浏览器，只验证 API 面与配置读写。
 * 运行: node test/foundation.test.cjs
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { setTimeout: delay } = require('timers/promises');

const root = path.resolve(__dirname, '..');
const runtime = process.env.EASYAG_TEST_NODE || process.execPath;
const entry = path.join(root, 'server.js');

async function start() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'easyag-foundation-'));
  const ready = path.join(data, 'ready.json');
  const child = spawn(runtime, [entry], {
    env: {
      ...process.env,
      EASYAG_TAURI: '1',
      EASYAG_TEST_MODE: '1',
      EASYAG_DATA_DIR: data,
      EASYAG_READY_FILE: ready,
      ANTIGRAVITY_OAUTH_CLIENT_ID: 'foundation-client',
      ANTIGRAVITY_OAUTH_CLIENT_SECRET: 'foundation-secret'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', c => stderr += c);
  for (let i = 0; i < 80; i++) {
    if (fs.existsSync(ready)) {
      const { port } = JSON.parse(fs.readFileSync(ready));
      return { child, url: 'http://127.0.0.1:' + port, data };
    }
    assert.equal(child.exitCode, null, stderr);
    await delay(100);
  }
  child.kill();
  throw new Error('ready timeout: ' + stderr);
}

(async () => {
  const app = await start();
  try {
    const ping = await (await fetch(app.url + '/api/ping')).text();
    assert.equal(ping, 'pong');

    const status = await (await fetch(app.url + '/api/status')).json();
    assert.equal(status.port, 7890);
    assert.equal(status.enableI18n, true);
    assert.equal(status.enableContextMonitor, true);
    assert.equal(status.enableQuotaMonitor, true);
    assert.equal(status.enableProxy, true);
    assert.equal(status.accountRiskAcknowledged, false);
    assert.ok(status.dictEntries > 100, '词典应已加载');
    const riskConfirmation = await fetch(app.url + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountRiskAcknowledged: true })
    });
    assert.equal(riskConfirmation.status, 200);
    assert.equal((await riskConfirmation.json()).settings.accountRiskAcknowledged, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(app.data, 'settings.json'), 'utf8')).accountRiskAcknowledged, true);
    const emptyAccounts = await (await fetch(app.url + '/api/accounts')).json();
    assert.deepEqual(emptyAccounts.accounts, []);
    const oauthStart = await fetch(app.url + '/api/accounts/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(oauthStart.status, 200);
    const oauthPayload = await oauthStart.json();
    const oauthRedirect = new URL(oauthPayload.url).searchParams.get('redirect_uri');
    assert.match(oauthRedirect, /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+\/oauth-callback$/);
    assert.equal((await (await fetch(app.url + '/api/accounts/oauth/status')).json()).state, 'waiting');
    const oauthCancel = await fetch(app.url + '/api/accounts/oauth/cancel', { method: 'POST', body: '{}' });
    assert.equal(oauthCancel.status, 200);
    assert.equal((await oauthCancel.json()).state, 'idle');
    const addedAccount = await fetch(app.url + '/api/accounts/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'foundation@example.com',
        label: '测试账号',
        accessToken: 'foundation-access'
      })
    });
    assert.equal(addedAccount.status, 200);
    const addedPayload = await addedAccount.json();
    assert.equal(addedPayload.ok, true);
    assert.equal(addedPayload.account.email, 'foundation@example.com');
    assert.equal('accessToken' in addedPayload.account, false, 'API 不得返回明文访问令牌');
    assert.equal((await (await fetch(app.url + '/api/accounts')).json()).accounts.length, 1);

    for (const removedRoute of ['/api/pilot/project', '/api/pilot/global', '/api/danger-rules', '/api/kb', '/api/injected', '/api/agent-event', '/capsule.html']) {
      const res = await fetch(app.url + removedRoute);
      assert.equal(res.status, 404, `${removedRoute} 应已移除`);
    }

    assert.ok((await fetch(app.url + '/ui/launcher.js')).ok, '独立界面脚本必须可加载');
    assert.ok((await fetch(app.url + '/ui/launcher.css')).ok, '独立样式必须可加载');
    const traversal = await fetch(app.url + '/ui/..%2fserver.js');
    assert.equal(traversal.status, 403, '静态目录不得暴露后端文件');
    const crossOrigin = await fetch(app.url + '/api/config', {
      method: 'POST', headers: { Origin: 'https://unrelated.example' }, body: JSON.stringify({ port: 1234 })
    });
    assert.equal(crossOrigin.status, 403, '外部网页不得修改本地设置');
    const invalidConfig = await fetch(app.url + '/api/config', { method: 'POST', body: JSON.stringify({ port: 0 }) });
    assert.equal(invalidConfig.status, 400);
    assert.equal((await (await fetch(app.url + '/api/status')).json()).port, 7890);

    const cfg = await fetch(app.url + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: 7897, enableI18n: false, enableContextMonitor: false, enableProxy: false, targetApp: 'ide' })
    });
    assert.ok(cfg.ok);
    const status2 = await (await fetch(app.url + '/api/status')).json();
    assert.equal(status2.port, 7897);
    assert.equal(status2.enableI18n, false);
    assert.equal(status2.enableContextMonitor, false);
    assert.equal(status2.enableQuotaMonitor, true);
    assert.equal(status2.enableProxy, false);
    assert.equal(status2.targetApp, 'ide');
    assert.equal(status2.activeTarget, 'ide');
    assert.equal(status2.accountRiskAcknowledged, true);

    console.log('PASS: foundation API smoke (ping/status/config/security)');
  } finally {
    try {
      await fetch(app.url + '/api/quit', { method: 'POST' });
    } catch (e) {}
    await delay(300);
    if (app.child.exitCode === null) app.child.kill();
    fs.rmSync(app.data, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
