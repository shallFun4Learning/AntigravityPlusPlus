const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { AccountStore } = require('../core/accounts');
const { createOAuthLogin } = require('../features/oauth-login');

function setTestOAuthEnvironment(t) {
  const previous = {
    clientId: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID,
    clientSecret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET
  };
  process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = 'test-client';
  process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'test-secret';
  t.after(() => {
    if (previous.clientId === undefined) delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
    else process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = previous.clientId;
    if (previous.clientSecret === undefined) delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    else process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = previous.clientSecret;
  });
}

function fixture(t, fetchImpl = async () => {
  throw new Error('Unexpected network request');
}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-plus-plus-oauth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AccountStore(dataDir);
  const opened = [];
  const logs = [];
  const login = createOAuthLogin({
    accountManager: {
      add: input => store.add(input),
      list: () => ({ accounts: store.list(), currentByTarget: store.currentIds() })
    },
    host: { open: url => opened.push(url) },
    events: { log: (...args) => logs.push(args) },
    fetchImpl,
    timeoutMs: 10_000,
    clientKey: 'environment'
  });
  t.after(() => login.close());
  return { login, store, opened, logs };
}

async function waitForState(login, expected) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const status = login.status();
    if (status.state === expected) return status;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(login.status().state, expected);
}

test('OAuth login generates a loopback URL and saves the account after callback', async t => {
  setTestOAuthEnvironment(t);
  const calls = [];
  const { login, store, opened, logs } = fixture(t, async (url, options = {}) => {
    calls.push({ url, options });
    if (url === 'https://oauth2.googleapis.com/token') {
      assert.equal(options.method, 'POST');
      assert.match(String(options.body), /client_id=test-client/);
      assert.match(String(options.body), /grant_type=authorization_code/);
      const verifier = new URLSearchParams(options.body).get('code_verifier');
      assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
      assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'),
        auth.searchParams.get('code_challenge'));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: 'callback-access',
            refresh_token: 'callback-refresh',
            id_token: 'header.eyJlbWFpbCI6ImNhbGxiYWNrQGV4YW1wbGUuY29tIn0.signature',
            expires_in: 3600
          };
        }
      };
    }
    if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
      assert.equal(options.headers.Authorization, 'Bearer callback-access');
      return {
        ok: true,
        status: 200,
        async json() {
          return { email: 'callback@example.com', name: '网页登录账号' };
        }
      };
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  });

  const started = await login.start();
  const auth = new URL(started.url);
  const redirect = new URL(auth.searchParams.get('redirect_uri'));
  assert.match(redirect.hostname, /^(?:localhost|127\.0\.0\.1|\[::1\])$/);
  assert.equal(redirect.pathname, '/oauth-callback');
  assert.equal(auth.searchParams.get('response_type'), 'code');
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.equal(auth.searchParams.get('prompt'), 'consent');
  assert.ok(auth.searchParams.get('state'));
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(started.account, null);
  assert.equal(started.url.includes('callback-access'), false);

  const callback = await fetch(`${redirect}?code=authorization-code&state=${encodeURIComponent(auth.searchParams.get('state'))}`);
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /登录成功/);
  const completed = await waitForState(login, 'completed');

  assert.equal(completed.account.email, 'callback@example.com');
  assert.equal(completed.account.hasRefreshToken, true);
  assert.equal(store.list()[0].email, 'callback@example.com');
  assert.equal(store.getSecrets(store.list()[0].id).refreshToken, 'callback-refresh');
  assert.deepEqual(opened, []);
  assert.ok(logs.some(item => item[1].includes('callback@example.com')));
  assert.equal(calls.length, 2);
});

test('OAuth callback rejects a mismatched state without saving an account', async t => {
  setTestOAuthEnvironment(t);
  const { login, store } = fixture(t);
  const started = await login.start();
  const auth = new URL(started.url);
  const redirect = new URL(auth.searchParams.get('redirect_uri'));
  const response = await fetch(`${redirect}?code=untrusted&state=wrong-state`);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /校验失败/);
  const status = await waitForState(login, 'error');
  assert.match(status.error, /校验失败/);
  assert.equal(store.list().length, 0);
});

test('OAuth open and cancel expose the link without retaining a running listener', async t => {
  setTestOAuthEnvironment(t);
  const { login, opened } = fixture(t);
  const started = await login.start();
  const openedStatus = await login.open();
  assert.equal(openedStatus.state, 'opened');
  assert.deepEqual(opened, [started.url]);
  const cancelled = await login.cancel();
  assert.equal(cancelled.state, 'idle');
  assert.equal(login.status().state, 'idle');
});

test('OAuth login accepts a copied callback URL for manual completion', async t => {
  setTestOAuthEnvironment(t);
  const { login, store } = fixture(t, async (url, options = {}) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      assert.equal(options.method, 'POST');
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: 'manual-access',
            refresh_token: 'manual-refresh',
            id_token: 'header.eyJlbWFpbCI6Im1hbnVhbEBleGFtcGxlLmNvbSJ9.signature',
            expires_in: 3600
          };
        }
      };
    }
    if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
      return {
        ok: true,
        status: 200,
        async json() {
          return { email: 'manual@example.com', name: '手工回填账号' };
        }
      };
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  });

  const started = await login.start();
  const auth = new URL(started.url);
  const callbackUrl = new URL(auth.searchParams.get('redirect_uri'));
  callbackUrl.searchParams.set('code', 'manual-code');
  callbackUrl.searchParams.set('state', auth.searchParams.get('state'));

  const completed = await login.completeFromCallbackUrl(callbackUrl.toString());
  assert.equal(completed.state, 'completed');
  assert.equal(completed.account.email, 'manual@example.com');
  assert.equal(store.getSecrets(completed.account.id).refreshToken, 'manual-refresh');
});

test('OAuth manual completion keeps the flow available after a bad pasted URL', async t => {
  setTestOAuthEnvironment(t);
  const { login } = fixture(t);
  await login.start();

  await assert.rejects(
    () => login.completeFromCallbackUrl('https://accounts.google.com/not-a-callback'),
    /不是有效的 OAuth 回调链接/
  );
  assert.equal(login.status().state, 'waiting');
});

test('OAuth token exchange failure does not write an account', async t => {
  setTestOAuthEnvironment(t);
  const { login, store } = fixture(t, async () => ({
    ok: false,
    status: 400,
    async json() {
      return { error: 'invalid_grant', error_description: '授权码已失效' };
    }
  }));
  const started = await login.start();
  const auth = new URL(started.url);
  const redirect = new URL(auth.searchParams.get('redirect_uri'));
  const response = await fetch(`${redirect}?code=expired&state=${encodeURIComponent(auth.searchParams.get('state'))}`);
  assert.equal(response.status, 200);
  const status = await waitForState(login, 'error');
  assert.match(status.error, /授权码已失效/);
  assert.equal(store.list().length, 0);
});
