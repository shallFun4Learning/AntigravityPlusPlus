const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AccountStore,
  refreshAccessToken,
  tokenNeedsRefresh
} = require('../core/accounts');

test('AccountStore encrypts token secrets and keeps account metadata usable', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-plus-plus-accounts-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const store = new AccountStore(dataDir);
  const account = store.add({
    email: ' User@Example.com ',
    label: '个人账号',
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiryTimestamp: 2_000_000_000,
    projectId: 'project-a'
  });
  assert.equal(account.email, 'user@example.com');
  assert.equal(account.hasAccessToken, true);
  assert.equal(account.hasRefreshToken, true);
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.getSecrets(account.id), {
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    idToken: ''
  });

  const secretsFile = fs.readFileSync(path.join(dataDir, 'account-secrets.json'), 'utf8');
  assert.equal(secretsFile.includes('access-secret'), false);
  assert.equal(secretsFile.includes('refresh-secret'), false);

  const updated = store.add({
    email: 'user@example.com',
    label: '工作账号',
    accessToken: 'new-access'
  });
  assert.equal(updated.id, account.id, '同邮箱导入应更新原账号');
  assert.equal(store.list().length, 1);
  assert.equal(store.getSecrets(account.id).refreshToken, 'refresh-secret');

  store.setCurrent(account.id, 'hub');
  assert.equal(store.current('hub').id, account.id);
  assert.equal(store.currentIds().hub, account.id);
  store.clearCurrent('hub');
  assert.equal(store.current('hub'), null);

  store.remove(account.id);
  assert.equal(store.list().length, 0);
  assert.equal(store.currentIds().hub, null);
});

test('token refresh updates access token without replacing refresh token', async t => {
  const previousId = process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
  const previousSecret = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
  process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = 'test-client';
  process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'test-secret';
  t.after(() => {
    if (previousId === undefined) delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
    else process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    else process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = previousSecret;
  });

  const response = await refreshAccessToken(
    { tokenExpiresAt: 1 },
    { refreshToken: 'old-refresh', accessToken: 'old-access', idToken: 'old-id' },
    async (url, options) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(options.method, 'POST');
      const body = String(options.body);
      assert.match(body, /client_id=test-client/);
      assert.match(body, /refresh_token=old-refresh/);
      return {
        ok: true,
        status: 200,
        async json() {
          return { access_token: 'new-access', expires_in: 1800, id_token: 'new-id' };
        }
      };
    }
  );
  assert.equal(response.accessToken, 'new-access');
  assert.equal(response.refreshToken, 'old-refresh');
  assert.equal(response.idToken, 'new-id');
  assert.ok(response.expiryTimestamp > Date.now());
});

test('token refresh policy treats a real access token without expiry as usable', () => {
  assert.equal(tokenNeedsRefresh({ tokenExpiresAt: 0 }, { accessToken: 'access' }), false);
  assert.equal(tokenNeedsRefresh({ tokenExpiresAt: 0 }, { accessToken: '' }), true);
  assert.equal(tokenNeedsRefresh({ tokenExpiresAt: Date.now() - 1 }, { accessToken: 'access' }), true);
});
