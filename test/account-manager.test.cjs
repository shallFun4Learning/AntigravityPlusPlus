const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountStore } = require('../core/accounts');
const { createAccountManager } = require('../core/account-manager');

function fixture(t, {
  launchResult = { ok: true },
  targetExists = false,
  targetRunning = false,
  credentialReader,
  identityReader
} = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-plus-plus-manager-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AccountStore(dataDir);
  const calls = [];
  let externalRunning = targetRunning;
  let currentSettings = { targetApp: 'hub' };
  const session = {
    phase: 'idle',
    async stopOnly() {
      calls.push('stop');
      this.phase = 'idle';
      return { ok: true };
    },
    async launch() {
      calls.push('launch');
      if (launchResult.ok) this.phase = 'running';
      return launchResult;
    }
  };
  const managerOptions = {
    store,
    settings: { get: () => ({ ...currentSettings }) },
    desktop: {
      resolveTarget: target => ({ id: target, name: target, exists: targetExists }),
      running: async () => externalRunning,
      stop: async () => {
        calls.push('desktop-stop');
        externalRunning = false;
        return { ok: true };
      }
    },
    session,
    events: { log: (...args) => calls.push(args), publish: event => calls.push(event) },
    configure: async input => {
      currentSettings = { ...currentSettings, ...input };
      calls.push({ configure: input });
      return currentSettings;
    },
    credentialWriter: async input => {
      calls.push({ write: input.account.email, target: input.target });
      if (input.account.email === 'broken@example.com') throw new Error('模拟凭据写入失败');
      return { ok: true };
    }
  };
  if (credentialReader) managerOptions.credentialReader = credentialReader;
  if (identityReader) managerOptions.identityReader = identityReader;
  const manager = createAccountManager(managerOptions);
  return { store, manager, session, calls };
}

test('account manager switches account without launching an unavailable target', async t => {
  const { manager, calls } = fixture(t);
  const first = manager.add({ email: 'one@example.com', accessToken: 'one' });
  const second = manager.add({ email: 'two@example.com', accessToken: 'two' });
  const result = await manager.switch(second.id, 'hub');
  assert.equal(result.ok, true);
  assert.equal(result.launched, false);
  assert.equal(result.requiresLaunch, true);
  assert.equal(manager.current('hub').account.email, 'two@example.com');
  assert.deepEqual(calls.filter(item => typeof item === 'string'), []);
  assert.equal(first.email, 'one@example.com');
});

test('switching an IDE account cannot stop a running desktop session', async t => {
  const { manager, session, calls } = fixture(t, { targetExists: true });
  const account = manager.add({ email: 'work@example.com', accessToken: 'fixture' });
  session.phase = 'running';
  session.activeTarget = { id: 'hub' };
  await assert.rejects(manager.switch(account.id, 'ide'), /另一个客户端正在运行/);
  assert.equal(session.phase, 'running');
  assert.ok(!calls.some(call => call === 'stop' || call === 'launch' || call.write));
});

test('account manager stops a running session before switching and launches when target exists', async t => {
  const { manager, session, calls } = fixture(t, { targetExists: true });
  const account = manager.add({ email: 'one@example.com', accessToken: 'one' });
  session.phase = 'running';
  assert.equal((await manager.switch(account.id, 'hub')).ok, true);
  assert.deepEqual(calls.filter(item => item === 'stop'), ['stop']);
  assert.deepEqual(calls.filter(item => item === 'launch'), ['launch']);
});

test('account manager restarts an already running Antigravity even before session attachment', async t => {
  const { manager, calls } = fixture(t, { targetExists: true, targetRunning: true });
  const account = manager.add({ email: 'one@example.com', accessToken: 'one' });
  const result = await manager.switch(account.id, 'hub');
  assert.equal(result.launched, true);
  assert.deepEqual(calls.filter(item => item === 'desktop-stop'), ['desktop-stop']);
  assert.deepEqual(calls.filter(item => item === 'launch'), ['launch']);
  assert.deepEqual(calls.filter(item => item.accountSwitch).map(item => item.accountSwitch.stage),
    ['checking', 'stopping', 'writing', 'launching', 'complete']);
});

test('account manager still relaunches when a running target has stale path metadata', async t => {
  const { manager, calls } = fixture(t, { targetExists: false, targetRunning: true });
  const account = manager.add({ email: 'one@example.com', accessToken: 'one' });
  const result = await manager.switch(account.id, 'hub');
  assert.equal(result.launched, true);
  assert.deepEqual(calls.filter(item => item === 'desktop-stop'), ['desktop-stop']);
  assert.deepEqual(calls.filter(item => item === 'launch'), ['launch']);
});

test('failed credential write restores the previous current account', async t => {
  const { manager } = fixture(t);
  const good = manager.add({ email: 'good@example.com', accessToken: 'good' });
  const broken = manager.add({ email: 'broken@example.com', accessToken: 'broken' });
  await manager.switch(good.id, 'hub');
  await assert.rejects(() => manager.switch(broken.id, 'hub'), /模拟凭据写入失败/);
  assert.equal(manager.current('hub').account.id, good.id);
  assert.equal(manager.switchStatus.state, 'failed');
  assert.equal(manager.switchStatus.stage, 'writing');
});

test('a pending restart preserves the current badge and prevents concurrent switches', async t => {
  const { manager, session } = fixture(t, { targetExists: true });
  const original = manager.add({ email: 'current@example.com', accessToken: 'current' });
  const next = manager.add({ email: 'next@example.com', accessToken: 'next' });
  await manager.switch(original.id, 'hub');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  session.launch = async () => { entered.resolve(); return release.promise; };
  const switching = manager.switch(next.id, 'hub');
  await entered.promise;
  assert.equal(manager.switchStatus.stage, 'launching');
  assert.equal(manager.current('hub').account.id, original.id);
  await assert.rejects(() => manager.switch(next.id, 'ide'), /正在切换/);
  release.resolve({ ok: true });
  await switching;
  assert.equal(manager.current('hub').account.id, next.id);
  assert.equal(manager.current('ide').account, null);
  assert.equal(manager.switchStatus.state, 'done');
});

test('imports current credentials into the encrypted account store without returning secrets', async t => {
  const { manager, store } = fixture(t, {
    credentialReader: async ({ target }) => ({
      email: 'imported@example.com',
      accessToken: 'imported-access',
      refreshToken: 'imported-refresh',
      expiryTimestamp: 2_000_000_000_000,
      idToken: 'imported-id',
      projectId: 'project',
      isGcpTos: true,
      source: `文件凭据: ${target}`
    })
  });
  const result = await manager.importCurrent('hub');
  assert.equal(result.ok, true);
  assert.equal(result.target, 'hub');
  assert.equal(result.source, '本地文件凭据');
  assert.equal(result.account.email, 'imported@example.com');
  assert.equal('accessToken' in result, false);
  assert.equal('refreshToken' in result, false);
  assert.equal(store.getSecrets(result.account.id).refreshToken, 'imported-refresh');
  assert.equal(manager.current('hub').account, null);
});

test('imports identity from the read-only AG status endpoint when credential lacks email', async t => {
  const calls = [];
  const { manager } = fixture(t, {
    credentialReader: async () => ({
      accessToken: 'access',
      refreshToken: 'refresh',
      source: 'Antigravity 数据库: fixture'
    }),
    identityReader: async input => {
      calls.push(input.target);
      return { email: 'status@example.com' };
    }
  });
  const result = await manager.importCurrent('ide');
  assert.deepEqual(calls, ['ide']);
  assert.equal(result.account.email, 'status@example.com');
  assert.equal(result.source, 'Antigravity 本地数据库');
});

test('failed import leaves the selected account unchanged', async t => {
  const { manager } = fixture(t, {
    credentialReader: async () => ({ accessToken: 'access', refreshToken: 'refresh' }),
    identityReader: async () => { throw new Error('无法读取当前邮箱'); }
  });
  const existing = manager.add({ email: 'existing@example.com', accessToken: 'existing' });
  await manager.switch(existing.id, 'hub');
  await assert.rejects(() => manager.importCurrent('hub'), /无法读取当前邮箱/);
  assert.equal(manager.current('hub').account.id, existing.id);
});
