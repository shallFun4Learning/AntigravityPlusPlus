const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  accountPayload,
  createOAuthInfo,
  createUnifiedStateEntry,
  createUnifiedTopicEntry,
  createUnifiedRawTopicEntry,
  createAuthStatePayload,
  createUserStatusPayload,
  decodeUnifiedRawTopicPayload,
  removeUnifiedTopicEntry,
  injectStateDatabase,
  writeFileCredentialsToDir,
  candidateStateDatabase,
  readFileCredentialsFromDir,
  readSystemCredential,
  readStateDatabase,
  parseOAuthInfo
} = require('../features/antigravity-credentials');

function account() {
  return {
    id: 'account-1',
    email: 'test@example.com',
    tokenExpiresAt: 2_000_000_000_000,
    projectId: '',
    isGcpTos: false
  };
}

function secrets() {
  return {
    accessToken: 'access-value',
    refreshToken: 'refresh-value',
    idToken: 'id-value'
  };
}

test('credential payload and topic entries preserve existing rows', () => {
  const oauth = createOAuthInfo(account(), secrets());
  assert.ok(oauth.length > 20);
  assert.match(JSON.stringify(accountPayload(account(), secrets())), /refresh-value/);

  const old = Buffer.concat([
    createUnifiedTopicEntry('existingKey', Buffer.from('existing-payload')),
    createUnifiedTopicEntry('oauthTokenInfoSentinelKey', Buffer.from('old-oauth'))
  ]);
  const next = Buffer.concat([
    removeUnifiedTopicEntry(old, 'oauthTokenInfoSentinelKey'),
    createUnifiedTopicEntry('oauthTokenInfoSentinelKey', oauth)
  ]);
  assert.ok(next.includes(Buffer.from('existingKey')));
  assert.equal(next.includes(Buffer.from('old-oauth')), false);
  assert.ok(next.length > old.length - 20);
  assert.match(createUnifiedStateEntry('userStatusSentinelKey', Buffer.from('status')), /^[A-Za-z0-9+/]+=*$/);
});

test('file credentials are written with restrictive permissions', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-plus-plus-gemini-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const result = writeFileCredentialsToDir(temp, account(), secrets());
  assert.equal(result.written, true);
  const standalone = JSON.parse(fs.readFileSync(path.join(temp, 'jetski-standalone-oauth-token'), 'utf8'));
  assert.equal(standalone.token.refresh_token, 'refresh-value');
  assert.equal(standalone.id_token_email, 'test@example.com');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(temp, 'jetski-standalone-oauth-token')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(temp, 'oauth_creds.json')).mode & 0o777, 0o600);
  }
});

test('state.vscdb injection backs up the database and writes the current account', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-plus-plus-vscdb-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const db = path.join(temp, 'state.vscdb');
  execFileSync('sqlite3', [db], {
    input: [
      'CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);',
      `INSERT INTO ItemTable(key, value) VALUES ('unrelated', 'keep-me');`,
      `INSERT INTO ItemTable(key, value) VALUES ('antigravityUnifiedStateSync.oauthToken', '${createUnifiedStateEntry('existingKey', Buffer.from('existing'))}');`
    ].join('\n')
  });

  const result = await injectStateDatabase(db, account(), secrets());
  assert.equal(result.written, true);
  assert.equal(fs.existsSync(result.backupPath), true);
  assert.equal(execFileSync('sqlite3', ['-batch', '-noheader', db, "SELECT value FROM ItemTable WHERE key='unrelated';"], { encoding: 'utf8' }).trim(), 'keep-me');
  const oauthValue = execFileSync('sqlite3', ['-batch', '-noheader', db, "SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.oauthToken';"], { encoding: 'utf8' }).trim();
  assert.ok(oauthValue.length > 20);
  const authState = JSON.parse(decodeUnifiedRawTopicPayload(oauthValue, 'authStateWithContextSentinelKey').toString('utf8'));
  assert.equal(authState.state, 'signedIn');
  assert.equal(authState.token.refreshToken, 'refresh-value');
  assert.equal(authState.context.project, 'aicode-consumers');
  const cloudcodeState = JSON.parse(execFileSync('sqlite3', ['-batch', '-noheader', db, "SELECT value FROM ItemTable WHERE key='cloudcode.userState';"], { encoding: 'utf8' }).trim());
  assert.equal(cloudcodeState.user.email, 'test@example.com');
  assert.equal(execFileSync('sqlite3', ['-batch', '-noheader', db, "SELECT value FROM ItemTable WHERE key='antigravityOnboarding';"], { encoding: 'utf8' }).trim(), 'true');
});

test('state database candidate follows the selected target profile', () => {
  const profile = path.join(os.tmpdir(), 'Antigravity-profile');
  assert.equal(
    candidateStateDatabase({ profile, appDir: '/Applications/Antigravity.app' }),
    path.join(profile, 'User', 'globalStorage', 'state.vscdb')
  );
});

test('file credentials prefer standalone state and read oauth_creds expiry_date', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-plus-plus-import-files-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const standalone = {
    token: {
      access_token: 'standalone-access',
      refresh_token: 'standalone-refresh',
      expiry: '2030-01-02T03:04:05.000Z'
    },
    id_token_email: 'standalone@example.com'
  };
  fs.writeFileSync(path.join(temp, 'jetski-standalone-oauth-token'), JSON.stringify(standalone));
  const preferred = await readFileCredentialsFromDir(temp);
  assert.equal(preferred.email, 'standalone@example.com');
  assert.equal(preferred.refreshToken, 'standalone-refresh');
  assert.equal(preferred.expiryTimestamp, Date.parse('2030-01-02T03:04:05.000Z'));

  fs.rmSync(path.join(temp, 'jetski-standalone-oauth-token'));
  fs.writeFileSync(path.join(temp, 'oauth_creds.json'), JSON.stringify({
    access_token: 'oauth-access',
    refresh_token: 'oauth-refresh',
    expiry_date: 2_000_000_000_000
  }));
  const fallback = await readFileCredentialsFromDir(temp);
  assert.equal(fallback.refreshToken, 'oauth-refresh');
  assert.equal(fallback.expiryTimestamp, 2_000_000_000_000);
});

test('system credential reader decodes macOS keychain payload', async () => {
  const payload = JSON.stringify({
    token: {
      access_token: 'keychain-access',
      refresh_token: 'keychain-refresh',
      expiry: '2031-01-01T00:00:00.000Z'
    },
    id_token_email: 'keychain@example.com'
  });
  const encoded = `go-keyring-base64:${Buffer.from(payload).toString('base64')}`;
  const credential = await readSystemCredential(async (command, args) => {
    assert.equal(command, 'security');
    assert.deepEqual(args, ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w']);
    return { stdout: encoded };
  }, 'darwin');
  assert.equal(credential.email, 'keychain@example.com');
  assert.equal(credential.refreshToken, 'keychain-refresh');
  assert.equal(credential.source, 'macOS 钥匙串');
});

test('Windows system credential reading fails without invoking Unix credential tools', async () => {
  await assert.rejects(readSystemCredential(
    async () => assert.fail('Windows must not execute security or secret-tool'),
    'win32'
  ), /当前平台暂不支持读取系统凭据/);
});

test('new state database format reads OAuth and separate user status rows', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-plus-plus-import-db-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const db = path.join(temp, 'state.vscdb');
  const imported = account();
  imported.isGcpTos = false;
  const oauth = createOAuthInfo(imported, secrets());
  execFileSync('sqlite3', [db], {
    input: [
      'CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);',
      `INSERT INTO ItemTable(key, value) VALUES ('antigravityUnifiedStateSync.oauthToken', '${createUnifiedStateEntry('oauthTokenInfoSentinelKey', oauth)}');`,
      `INSERT INTO ItemTable(key, value) VALUES ('antigravityUnifiedStateSync.userStatus', '${createUnifiedStateEntry('userStatusSentinelKey', createUserStatusPayload('db@example.com'))}');`
    ].join('\n')
  });
  const credential = await readStateDatabase(db);
  assert.equal(credential.refreshToken, 'refresh-value');
  assert.equal(credential.email, 'db@example.com');
  assert.equal(credential.isGcpTos, true, '缺少显式标记时应兼容 Antigravity 默认值');
});

test('state database reads the auth state sentinel when the OAuth sentinel is absent', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-plus-plus-auth-state-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const db = path.join(temp, 'state.vscdb');
  const imported = { ...account(), projectId: 'project-from-auth-state' };
  const oauthValue = Buffer.concat([
    createUnifiedRawTopicEntry('authStateWithContextSentinelKey', createAuthStatePayload(imported, secrets()))
  ]).toString('base64');
  const userStatus = createUnifiedStateEntry('userStatusSentinelKey', createUserStatusPayload('auth-state@example.com'));
  execFileSync('sqlite3', [db], {
    input: [
      'CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);',
      `INSERT INTO ItemTable(key, value) VALUES ('antigravityUnifiedStateSync.oauthToken', '${oauthValue}');`,
      `INSERT INTO ItemTable(key, value) VALUES ('antigravityUnifiedStateSync.userStatus', '${userStatus}');`
    ].join('\n')
  });
  const credential = await readStateDatabase(db);
  assert.equal(credential.refreshToken, 'refresh-value');
  assert.equal(credential.email, 'auth-state@example.com');
  assert.equal(credential.projectId, 'project-from-auth-state');
});

test('missing state database credentials fail without exposing token data', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-plus-plus-import-empty-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  await assert.rejects(
    () => readFileCredentialsFromDir(temp),
    /未找到可读取的本地文件凭据/
  );
  assert.equal(fs.readdirSync(temp).length, 0);
});

test('OAuth protobuf without a GCP flag defaults to compatible true', () => {
  const payload = createOAuthInfo({ ...account(), isGcpTos: false }, secrets());
  assert.equal(parseOAuthInfo(payload, 'fixture').isGcpTos, true);
});
