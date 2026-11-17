const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readInstalledOAuthClient, readAsarText } = require('../adapters/desktop/oauth-client');
const { requestToken, resolveOAuthClient } = require('../core/oauth');

function installation(t, { archive = false, boundary = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-oauth-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'Antigravity.app');
  const resources = path.join(app, 'Contents/Resources');
  const relative = 'dist/remote/signInUrls.js';
  const source = 'throw Error("Configuration must never execute");\n'
    + 'const clients = [{clientId: "fixture.apps.googleusercontent.com"}];';
  const secret = 'GOCSPX-' + 't'.repeat(28);
  fs.mkdirSync(path.join(resources, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'bin/language_server'), Buffer.concat([
    Buffer.alloc(boundary ? 1024 * 1024 - 4 : 0),
    Buffer.from(secret)
  ]));
  if (archive) {
    const body = Buffer.from(source);
    const entry = { size: body.length, offset: '0' };
    const index = Buffer.from(JSON.stringify({ files: {
      dist: { files: { remote: { files: { 'signInUrls.js': entry } } } }
    } }));
    const padding = Buffer.alloc((4 - index.length % 4) % 4);
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(8 + index.length + padding.length, 4);
    prefix.writeUInt32LE(4 + index.length + padding.length, 8);
    prefix.writeUInt32LE(index.length, 12);
    fs.writeFileSync(path.join(resources, 'app.asar'), Buffer.concat([prefix, index, padding, body]));
  } else {
    const file = path.join(resources, 'app', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return { resources, secret, targets: { hub: {
    appDir: app,
    appExe: path.join(app, 'Contents/MacOS/Antigravity')
  } } };
}

test('OAuth client configuration is read from unpacked installation files without executing code', t => {
  const fixture = installation(t);
  const client = readInstalledOAuthClient({ targets: fixture.targets });
  assert.equal(client.clientId, 'fixture.apps.googleusercontent.com');
  assert.deepEqual(client.clientSecrets, [fixture.secret]);
  assert.equal(client.key, 'antigravity_personal');
  assert.equal(readInstalledOAuthClient({ targets: fixture.targets }), client);
});

test('OAuth configuration supports ASAR resources and runtime strings crossing read boundaries', t => {
  const fixture = installation(t, { archive: true, boundary: true });
  const client = readInstalledOAuthClient({ targets: fixture.targets });
  assert.equal(client.clientId, 'fixture.apps.googleusercontent.com');
  assert.equal(client.clientSecret, fixture.secret);
});

test('OAuth configuration rejects oversized or truncated archive headers', t => {
  const fixture = installation(t, { archive: true });
  const archive = path.join(fixture.resources, 'app.asar');
  const broken = Buffer.alloc(16);
  broken.writeUInt32LE(0xffffffff, 4);
  fs.writeFileSync(archive, broken);
  assert.throws(() => readAsarText(archive, 'dist/remote/signInUrls.js'), /索引无效/);
  fs.writeFileSync(archive, Buffer.alloc(4));
  assert.throws(() => readAsarText(archive, 'dist/remote/signInUrls.js'), /不完整/);
});

test('OAuth client resolution passes custom installation settings to the local adapter', () => {
  const settings = { customHubPath: 'custom-client' };
  const client = resolveOAuthClient('antigravity_personal', {
    settings,
    installedClient(input) {
      assert.equal(input.settings, settings);
      return { clientId: 'custom-client', clientSecret: 'fixture-secret' };
    }
  });
  assert.equal(client.clientId, 'custom-client');
});

test('Token exchange retries only rejected local clients and remembers the matching configuration', async () => {
  const client = { clientId: 'fixture-retry-client', clientSecret: 'old-fixture',
    clientSecrets: ['old-fixture', 'matching-fixture'] };
  const requests = [];
  const fetchImpl = async (url, options) => {
    const body = new URLSearchParams(options.body);
    const secret = body.get('client_secret');
    requests.push(secret);
    assert.equal(body.get('code'), 'fixture-code');
    return {
      ok: secret === 'matching-fixture',
      status: secret === 'matching-fixture' ? 200 : 401,
      json: async () => secret === 'matching-fixture'
        ? { access_token: 'fixture-access' }
        : { error: 'invalid_client' }
    };
  };
  const result = await requestToken(client, { code: 'fixture-code' }, fetchImpl);
  assert.equal(result.payload.access_token, 'fixture-access');
  await requestToken(client, { code: 'fixture-code' }, fetchImpl);
  assert.deepEqual(requests, ['old-fixture', 'matching-fixture', 'matching-fixture']);
});

test('Token exchange does not retry an invalid grant with other local configurations', async () => {
  let count = 0;
  const result = await requestToken({
    clientId: 'fixture-invalid-grant-client',
    clientSecrets: ['one-fixture', 'two-fixture']
  }, { code: 'expired-code' }, async () => {
    count++;
    return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
  });
  assert.equal(count, 1);
  assert.equal(result.payload.error, 'invalid_grant');
});
