const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

const KEYCHAIN_SERVICE = 'gemini';
const KEYCHAIN_ACCOUNT = 'antigravity';
const STANDALONE_TOKEN_FILE = 'jetski-standalone-oauth-token';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function importedExpiry(value) {
  if (typeof value === 'string' && value.trim() && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value.trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function emailFromIdToken(value) {
  const token = text(value);
  const parts = token.split('.');
  if (parts.length < 2) return '';
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return text(payload.email ?? payload.emailAddress);
  } catch {
    return '';
  }
}

function credentialFromTokenPayload(payload, source) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const token = payload.token && typeof payload.token === 'object' ? payload.token : payload;
  const accessToken = text(token.access_token ?? token.accessToken ?? payload.access_token ?? payload.accessToken);
  const refreshToken = text(token.refresh_token ?? token.refreshToken ?? payload.refresh_token ?? payload.refreshToken);
  if (!accessToken && !refreshToken) return null;
  const idToken = text(payload.id_token ?? payload.idToken ?? token.id_token ?? token.idToken);
  const declaredGcpTos = payload.is_gcp_tos ?? payload.isGcpTos;
  return {
    email: text(payload.id_token_email ?? payload.email ?? token.id_token_email ?? token.email)
      || emailFromIdToken(idToken),
    accessToken,
    refreshToken,
    idToken,
    expiryTimestamp: importedExpiry(
      token.expiry
      ?? token.expiry_date
      ?? token.expiryDate
      ?? token.expiresAt
      ?? token.expires_at
      ?? payload.expiry
      ?? payload.expiry_date
      ?? payload.expiryDate
      ?? payload.expiresAt
      ?? payload.expires_at
    ),
    projectId: text(payload.project_id ?? payload.projectId ?? token.project_id ?? token.projectId),
    isGcpTos: declaredGcpTos === undefined ? true : declaredGcpTos === true,
    source
  };
}

function parseCredentialPayload(value, source) {
  let payload = text(value);
  if (!payload) return null;
  if (payload.startsWith('go-keyring-base64:')) {
    try {
      payload = Buffer.from(payload.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  try {
    return credentialFromTokenPayload(JSON.parse(payload), source);
  } catch {
    return null;
  }
}

function expirySeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Math.floor(Date.now() / 1000) + 3600;
  return Math.floor(numeric > 10_000_000_000 ? numeric / 1000 : numeric);
}

function expiryIso(value) {
  return new Date(expirySeconds(value) * 1000).toISOString();
}

function accountPayload(account, secrets) {
  const accessToken = text(secrets.accessToken);
  const refreshToken = text(secrets.refreshToken);
  if (!accessToken && !refreshToken) throw new Error('当前账号没有可写入的 token');
  const expiry = expirySeconds(account.tokenExpiresAt);
  return {
    token: {
      access_token: accessToken,
      token_type: 'Bearer',
      refresh_token: refreshToken,
      expiry: expiryIso(expiry),
      expires_in: Math.max(0, expiry - Math.floor(Date.now() / 1000))
    },
    auth_method: 'consumer',
    id_token_email: text(account.email) || undefined,
    id_token: text(secrets.idToken) || undefined
  };
}

function encodeVarint(value) {
  let current = BigInt.asUintN(64, BigInt(value));
  const output = [];
  while (current >= 0x80n) {
    output.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }
  output.push(Number(current));
  return Buffer.from(output);
}

function readVarint(data, offset) {
  let value = 0n;
  let shift = 0n;
  let position = offset;
  while (position < data.length) {
    const byte = data[position++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset: position };
    shift += 7n;
    if (shift > 63n) throw new Error('protobuf varint 过长');
  }
  throw new Error('protobuf 数据不完整');
}

function skipField(data, offset, wireType) {
  if (wireType === 0) return readVarint(data, offset).offset;
  if (wireType === 1) {
    if (offset + 8 > data.length) throw new Error('protobuf fixed64 数据不完整');
    return offset + 8;
  }
  if (wireType === 2) {
    const length = readVarint(data, offset);
    const end = length.offset + Number(length.value);
    if (end > data.length) throw new Error('protobuf length-delimited 数据不完整');
    return end;
  }
  if (wireType === 5) {
    if (offset + 4 > data.length) throw new Error('protobuf fixed32 数据不完整');
    return offset + 4;
  }
  throw new Error(`不支持的 protobuf wire type: ${wireType}`);
}

function encodeLengthField(fieldNumber, value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([
    encodeVarint((BigInt(fieldNumber) << 3n) | 2n),
    encodeVarint(body.length),
    body
  ]);
}

function encodeStringField(fieldNumber, value) {
  return encodeLengthField(fieldNumber, Buffer.from(String(value), 'utf8'));
}

function encodeVarintField(fieldNumber, value) {
  return Buffer.concat([
    encodeVarint((BigInt(fieldNumber) << 3n) | 0n),
    encodeVarint(value)
  ]);
}

function fieldBytes(fieldNumber, value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return encodeLengthField(fieldNumber, body);
}

function createOAuthInfo(account, secrets) {
  const payload = accountPayload(account, secrets);
  const fields = [
    encodeStringField(1, payload.token.access_token),
    encodeStringField(2, payload.token.token_type),
    encodeStringField(3, payload.token.refresh_token),
    encodeLengthField(4, Buffer.concat([
      encodeVarintField(1, expirySeconds(account.tokenExpiresAt)),
      encodeVarintField(2, 0)
    ]))
  ];
  if (payload.id_token) fields.push(encodeStringField(5, payload.id_token));
  if (account.isGcpTos === true) fields.push(encodeVarintField(6, 1));
  return Buffer.concat(fields);
}

function createUnifiedTopicEntry(sentinelKey, payload) {
  const row = encodeStringField(1, Buffer.from(payload).toString('base64'));
  const entry = Buffer.concat([
    encodeStringField(1, sentinelKey),
    encodeLengthField(2, row)
  ]);
  return encodeLengthField(1, entry);
}

function createUnifiedRawTopicEntry(sentinelKey, payload) {
  const row = encodeLengthField(1, payload);
  const entry = Buffer.concat([
    encodeStringField(1, sentinelKey),
    encodeLengthField(2, row)
  ]);
  return encodeLengthField(1, entry);
}

function readLengthField(data, offset) {
  const length = readVarint(data, offset);
  const end = length.offset + Number(length.value);
  if (end > data.length) throw new Error('protobuf length-delimited 字段越界');
  return { value: data.subarray(length.offset, end), offset: end };
}

function firstStringField(data, fieldNumber) {
  let offset = 0;
  while (offset < data.length) {
    const tag = readVarint(data, offset);
    const wireType = Number(tag.value & 7n);
    const number = Number(tag.value >> 3n);
    if (number === fieldNumber && wireType === 2) {
      const field = readLengthField(data, tag.offset);
      return field.value.toString('utf8');
    }
    offset = skipField(data, tag.offset, wireType);
  }
  return null;
}

function firstLengthField(data, fieldNumber) {
  let offset = 0;
  while (offset < data.length) {
    const tag = readVarint(data, offset);
    const wireType = Number(tag.value & 7n);
    const number = Number(tag.value >> 3n);
    if (number === fieldNumber && wireType === 2) return readLengthField(data, tag.offset).value;
    offset = skipField(data, tag.offset, wireType);
  }
  return null;
}

function firstVarintField(data, fieldNumber) {
  let offset = 0;
  while (offset < data.length) {
    const tag = readVarint(data, offset);
    const wireType = Number(tag.value & 7n);
    const number = Number(tag.value >> 3n);
    if (number === fieldNumber && wireType === 0) return readVarint(data, tag.offset).value;
    offset = skipField(data, tag.offset, wireType);
  }
  return null;
}

function removeUnifiedTopicEntry(topic, targetKey) {
  const result = [];
  let offset = 0;
  while (offset < topic.length) {
    const start = offset;
    const tag = readVarint(topic, offset);
    const wireType = Number(tag.value & 7n);
    const number = Number(tag.value >> 3n);
    const next = skipField(topic, tag.offset, wireType);
    let remove = false;
    if (number === 1 && wireType === 2) {
      const entry = readLengthField(topic, tag.offset).value;
      remove = firstStringField(entry, 1) === targetKey;
    }
    if (!remove) result.push(topic.subarray(start, next));
    offset = next;
  }
  return Buffer.concat(result);
}

function createUnifiedStateEntry(sentinelKey, payload) {
  const topic = createUnifiedTopicEntry(sentinelKey, payload);
  return Buffer.from(topic).toString('base64');
}

function createUserStatusPayload(email) {
  return Buffer.concat([
    encodeStringField(3, email),
    encodeStringField(7, email)
  ]);
}

function createStringValuePayload(value) {
  return encodeStringField(3, value);
}

function createAuthStatePayload(account, secrets) {
  const project = text(account.projectId) || 'aicode-consumers';
  return Buffer.from(JSON.stringify({
    state: 'signedIn',
    context: {
      project,
      showProjectError: false,
      errorMessage: '',
      ineligibleMessage: ''
    },
    token: {
      accessToken: text(secrets.accessToken),
      refreshToken: text(secrets.refreshToken),
      expiry: expirySeconds(account.tokenExpiresAt) * 1000
    }
  }));
}

function createCloudcodeUserState(account) {
  return JSON.stringify({
    state: 'signedIn',
    context: {
      project: text(account.projectId),
      showProjectError: false,
      errorMessage: ''
    },
    user: {
      email: text(account.email),
      name: text(account.email)
    }
  });
}

function decodeUnifiedStateTopic(encoded) {
  if (!encoded) return Buffer.alloc(0);
  const decoded = Buffer.from(encoded, 'base64');
  if (!decoded.length) return Buffer.alloc(0);
  return decoded;
}

function decodeUnifiedTopicPayload(encoded, targetKey) {
  const topic = decodeUnifiedStateTopic(encoded);
  let offset = 0;
  while (offset < topic.length) {
    const tag = readVarint(topic, offset);
    const wireType = Number(tag.value & 7n);
    const number = Number(tag.value >> 3n);
    if (number === 1 && wireType === 2) {
      const entry = readLengthField(topic, tag.offset).value;
      if (firstStringField(entry, 1) === targetKey) {
        const row = firstLengthField(entry, 2);
        const encodedPayload = row && firstStringField(row, 1);
        if (!encodedPayload) return null;
        return Buffer.from(encodedPayload, 'base64');
      }
    }
    offset = skipField(topic, tag.offset, wireType);
  }
  return null;
}

function decodeUnifiedRawTopicPayload(encoded, targetKey) {
  const topic = decodeUnifiedStateTopic(encoded);
  let offset = 0;
  while (offset < topic.length) {
    const tag = readVarint(topic, offset);
    const wireType = Number(tag.value & 7n);
    const number = Number(tag.value >> 3n);
    if (number === 1 && wireType === 2) {
      const entry = readLengthField(topic, tag.offset).value;
      if (firstStringField(entry, 1) === targetKey) {
        const row = firstLengthField(entry, 2);
        return row ? firstLengthField(row, 1) : null;
      }
    }
    offset = skipField(topic, tag.offset, wireType);
  }
  return null;
}

function parseOAuthInfo(payload, source) {
  if (!Buffer.isBuffer(payload)) return null;
  const accessToken = text(firstStringField(payload, 1));
  const refreshToken = text(firstStringField(payload, 3));
  if (!accessToken && !refreshToken) return null;
  const expiryPayload = firstLengthField(payload, 4);
  const expirySecondsValue = expiryPayload ? firstVarintField(expiryPayload, 1) : null;
  return {
    email: '',
    accessToken,
    refreshToken,
    idToken: text(firstStringField(payload, 5)),
    expiryTimestamp: expirySecondsValue === null ? 0 : Number(expirySecondsValue) * 1000,
    projectId: '',
    isGcpTos: (firstVarintField(payload, 6) ?? 1n) !== 0n,
    source
  };
}

function parseAuthStatePayload(payload, source) {
  if (!Buffer.isBuffer(payload)) return null;
  let state;
  try { state = JSON.parse(payload.toString('utf8')); }
  catch { return null; }
  const credential = credentialFromTokenPayload(state, source);
  if (!credential) return null;
  credential.projectId = text(state.context?.project);
  return credential;
}

function parseStateDatabasePayload(encoded, source, userStatusEncoded = encoded, cloudcodeState = '') {
  const oauthPayload = decodeUnifiedTopicPayload(encoded, 'oauthTokenInfoSentinelKey');
  const authStatePayload = decodeUnifiedRawTopicPayload(encoded, 'authStateWithContextSentinelKey');
  const credential = parseOAuthInfo(oauthPayload, source) || parseAuthStatePayload(authStatePayload, source);
  if (!credential) return null;
  const statusPayload = decodeUnifiedTopicPayload(userStatusEncoded, 'userStatusSentinelKey');
  credential.email = text(firstStringField(statusPayload || Buffer.alloc(0), 3))
    || text(firstStringField(statusPayload || Buffer.alloc(0), 7));
  if (!credential.email) {
    try { credential.email = text(JSON.parse(cloudcodeState).user?.email); }
    catch {}
  }
  return credential;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqliteAvailable() {
  return new Promise(resolve => {
    execFile('sqlite3', ['-version'], { timeout: 2000 }, error => resolve(!error));
  });
}

function runSqliteScript(dbPath, script, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', ['-batch', dbPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('SQLite 写入超时'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `SQLite 退出码 ${code}`));
      else resolve(stdout);
    });
    child.stdin.end(script);
  });
}

async function readSqliteValue(dbPath, key) {
  const { stdout } = await run('sqlite3', [
    '-batch',
    '-noheader',
    '-cmd',
    '.timeout 2000',
    dbPath,
    `SELECT value FROM ItemTable WHERE key = ${sqlString(key)} LIMIT 1;`
  ], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function readFileCredentialsFromDir(geminiDir, fsImpl = fs) {
  const candidates = [
    path.join(geminiDir, 'antigravity-cli', 'antigravity-oauth-token'),
    path.join(geminiDir, STANDALONE_TOKEN_FILE),
    path.join(geminiDir, 'oauth_creds.json')
  ];
  for (const file of candidates) {
    if (!fsImpl.existsSync(file)) continue;
    try {
      const credential = parseCredentialPayload(fsImpl.readFileSync(file, 'utf8'), `文件凭据: ${file}`);
      if (credential) return credential;
    } catch { /* Continue to the next compatible credential source. */ }
  }
  throw new Error('未找到可读取的本地文件凭据');
}

async function readSystemCredential(runImpl = run, platform = process.platform) {
  let command;
  let args;
  if (platform === 'darwin') {
    command = 'security';
    args = ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'];
  } else if (platform === 'linux') {
    command = 'secret-tool';
    args = ['lookup', 'service', KEYCHAIN_SERVICE, 'username', KEYCHAIN_ACCOUNT];
  } else {
    throw new Error('当前平台暂不支持读取系统凭据');
  }
  const result = await runImpl(command, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
  const credential = parseCredentialPayload(result.stdout, platform === 'darwin' ? 'macOS 钥匙串' : 'Linux Secret Service');
  if (!credential) throw new Error('系统凭据格式无法识别');
  return credential;
}

async function readStateDatabase(dbPath, fsImpl = fs) {
  if (!dbPath || !fsImpl.existsSync(dbPath)) throw new Error('Antigravity 用户数据库不存在');
  if (!(await sqliteAvailable())) throw new Error('未找到 sqlite3，无法读取 Antigravity 用户数据库');

  const current = await readSqliteValue(dbPath, 'antigravityUnifiedStateSync.oauthToken');
  if (current) {
    let userStatus = '';
    let cloudcodeState = '';
    try {
      userStatus = await readSqliteValue(dbPath, 'antigravityUnifiedStateSync.userStatus');
    } catch { /* The OAuth row can still be useful when the identity row is absent. */ }
    try {
      cloudcodeState = await readSqliteValue(dbPath, 'cloudcode.userState');
    } catch { /* Older databases may not expose the cloudcode state row. */ }
    const credential = parseStateDatabasePayload(
      current,
      `Antigravity 数据库: ${dbPath}`,
      userStatus || current,
      cloudcodeState
    );
    if (credential) return credential;
  }

  const legacy = await readSqliteValue(dbPath, 'jetskiStateSync.agentManagerInitState');
  if (legacy) {
    const oauthPayload = firstLengthField(Buffer.from(legacy, 'base64'), 6);
    const credential = parseOAuthInfo(oauthPayload, `Antigravity 数据库: ${dbPath}`);
    if (credential) {
      try {
        const userStatus = await readSqliteValue(dbPath, 'antigravityUnifiedStateSync.userStatus');
        const statusPayload = decodeUnifiedTopicPayload(userStatus, 'userStatusSentinelKey');
        credential.email = text(firstStringField(statusPayload || Buffer.alloc(0), 3))
          || text(firstStringField(statusPayload || Buffer.alloc(0), 7));
      } catch { /* Legacy databases may not have a separate identity row. */ }
      return credential;
    }
  }
  throw new Error('Antigravity 用户数据库中没有可读取的登录状态');
}

async function readCurrentCredentials({ target = 'hub', targetInfo = {}, runImpl = run, fsImpl = fs } = {}) {
  const errors = [];
  const geminiDir = path.join(os.homedir(), '.gemini');
  const dbPath = candidateStateDatabase(targetInfo);
  const sources = [];
  if (target !== 'ide') sources.push(() => readSystemCredential(runImpl));
  if (dbPath) sources.push(() => readStateDatabase(dbPath, fsImpl));
  sources.push(() => readFileCredentialsFromDir(geminiDir, fsImpl));

  for (const read of sources) {
    try {
      const credential = await read();
      if (credential) return credential;
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(errors.length ? errors.join('；') : '未找到 Antigravity 本地登录状态');
}

async function injectStateDatabase(dbPath, account, secrets) {
  if (!fs.existsSync(dbPath)) return { written: false, path: dbPath, reason: '数据库文件不存在' };
  if (!(await sqliteAvailable())) throw new Error('未找到 sqlite3，无法更新 Antigravity 的 state.vscdb');

  const backupPath = `${dbPath}.antigravity-plus-plus.backup`;
  fs.copyFileSync(dbPath, backupPath);

  let existing = '';
  try {
    existing = await readSqliteValue(dbPath, 'antigravityUnifiedStateSync.oauthToken');
  } catch (error) {
    throw new Error(`读取 state.vscdb 失败: ${error.message}`);
  }

  let topic = Buffer.alloc(0);
  if (existing) {
    try {
      topic = decodeUnifiedStateTopic(existing);
      // Validate the outer topic before modifying the database. A malformed
      // value is left untouched so a future client update cannot be hidden.
      removeUnifiedTopicEntry(topic, 'oauthTokenInfoSentinelKey');
    } catch (error) {
      throw new Error(`state.vscdb 中的 OAuth 数据格式无法识别: ${error.message}`);
    }
  }
  topic = removeUnifiedTopicEntry(topic, 'authStateWithContextSentinelKey');
  topic = Buffer.concat([
    createUnifiedRawTopicEntry('authStateWithContextSentinelKey', createAuthStatePayload(account, secrets)),
    removeUnifiedTopicEntry(topic, 'oauthTokenInfoSentinelKey'),
    createUnifiedTopicEntry('oauthTokenInfoSentinelKey', createOAuthInfo(account, secrets))
  ]);
  const oauthValue = topic.toString('base64');
  const userStatus = createUnifiedStateEntry(
    'userStatusSentinelKey',
    createUserStatusPayload(account.email)
  );
  const projectId = text(account.projectId);
  const statements = [
    '.timeout 2000',
    'PRAGMA busy_timeout = 2000;',
    'BEGIN IMMEDIATE;',
    'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT);',
    `INSERT OR REPLACE INTO ItemTable (key, value) VALUES (${sqlString('antigravityUnifiedStateSync.oauthToken')}, ${sqlString(oauthValue)});`,
    `INSERT OR REPLACE INTO ItemTable (key, value) VALUES (${sqlString('antigravityUnifiedStateSync.userStatus')}, ${sqlString(userStatus)});`,
    `INSERT OR REPLACE INTO ItemTable (key, value) VALUES (${sqlString('cloudcode.userState')}, ${sqlString(createCloudcodeUserState(account))});`,
    `INSERT OR REPLACE INTO ItemTable (key, value) VALUES (${sqlString('antigravityOnboarding')}, 'true');`,
    `DELETE FROM ItemTable WHERE key = ${sqlString('jetskiStateSync.agentManagerInitState')};`
  ];
  if (projectId) {
    statements.push(
      `INSERT OR REPLACE INTO ItemTable (key, value) VALUES (${sqlString('antigravityUnifiedStateSync.enterprisePreferences')}, ${sqlString(createUnifiedStateEntry('enterpriseGcpProjectId', createStringValuePayload(projectId)))});`
    );
  } else {
    statements.push(`DELETE FROM ItemTable WHERE key = ${sqlString('antigravityUnifiedStateSync.enterprisePreferences')};`);
  }
  statements.push('COMMIT;');
  await runSqliteScript(dbPath, statements.join('\n') + '\n');
  return { written: true, path: dbPath, backupPath };
}

function writeJsonAtomically(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function writeFileCredentialsToDir(geminiDir, account, secrets) {
  const payload = accountPayload(account, secrets);
  const standalonePath = path.join(geminiDir, STANDALONE_TOKEN_FILE);
  const oauthCredsPath = path.join(geminiDir, 'oauth_creds.json');
  writeJsonAtomically(standalonePath, payload);
  writeJsonAtomically(oauthCredsPath, {
    access_token: payload.token.access_token,
    token_type: payload.token.token_type,
    refresh_token: payload.token.refresh_token,
    expiry: payload.token.expiry
  });
  return { written: true, paths: [standalonePath, oauthCredsPath] };
}

function writeSecretTool(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('secret-tool', [
      'store',
      '--label=Antigravity',
      'service',
      KEYCHAIN_SERVICE,
      'username',
      KEYCHAIN_ACCOUNT
    ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Linux Secret Service 写入超时'));
    }, 10000);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `secret-tool 退出码 ${code}`));
    });
    child.stdin.end(payload);
  });
}

async function writeSystemCredential(payload) {
  if (process.platform === 'darwin') {
    const encoded = `go-keyring-base64:${Buffer.from(payload, 'utf8').toString('base64')}`;
    await run('security', [
      'delete-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT
    ], { timeout: 5000 }).catch(() => {});
    await run('security', [
      'add-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
      '-w',
      encoded,
      '-A'
    ], { timeout: 8000 });
    return { written: true, backend: 'macOS Keychain' };
  }
  if (process.platform === 'linux') {
    await writeSecretTool(payload);
    return { written: true, backend: 'Linux Secret Service' };
  }
  if (process.platform === 'win32') {
    await run('cmdkey', [
      `/generic:${KEYCHAIN_SERVICE}:${KEYCHAIN_ACCOUNT}`,
      '/user:antigravity',
      `/pass:${payload}`
    ], { timeout: 8000, windowsHide: true });
    return { written: true, backend: 'Windows Credential Manager' };
  }
  throw new Error(`当前平台不支持系统凭据存储: ${process.platform}`);
}

function candidateStateDatabase(targetInfo) {
  const candidates = [];
  if (targetInfo?.profile) {
    candidates.push(path.join(targetInfo.profile, 'User', 'globalStorage', 'state.vscdb'));
  }
  if (targetInfo?.appDir) {
    candidates.push(path.join(
      targetInfo.appDir,
      'data',
      'user-data',
      'User',
      'globalStorage',
      'state.vscdb'
    ));
  }
  const existing = candidates.find(file => fs.existsSync(file));
  return existing || candidates[0] || null;
}

async function writeCredentials({ target, targetInfo, account, secrets, writeKeychain = true }) {
  const payload = JSON.stringify(accountPayload(account, secrets));
  const geminiDir = path.join(os.homedir(), '.gemini');
  let fileResult = null;
  let keychainResult = null;
  let databaseResult = null;
  let fileError = null;
  let keychainError = null;
  let databaseError = null;

  try {
    fileResult = writeFileCredentialsToDir(geminiDir, account, secrets);
  } catch (error) {
    fileError = error;
  }

  const dbPath = candidateStateDatabase(targetInfo);
  if (dbPath && fs.existsSync(dbPath)) {
    try {
      databaseResult = await injectStateDatabase(dbPath, account, secrets);
    } catch (error) {
      databaseError = error;
    }
  }

  if (writeKeychain) {
    try {
      keychainResult = await writeSystemCredential(payload);
    } catch (error) {
      keychainError = error;
    }
  }

  const hasDatabase = Boolean(databaseResult?.written);
  const hasKeychain = Boolean(keychainResult?.written);
  const targetReady = target === 'ide' ? hasDatabase || hasKeychain : hasKeychain || hasDatabase;
  if (!targetReady) {
    const details = [
      fileError && `文件凭据: ${fileError.message}`,
      databaseError && `state.vscdb: ${databaseError.message}`,
      keychainError && `系统凭据: ${keychainError.message}`
    ].filter(Boolean).join('；');
    throw new Error(`没有成功写入 Antigravity 可读取的凭据来源${details ? `（${details}）` : ''}`);
  }
  return {
    ok: true,
    target,
    file: fileResult,
    database: databaseResult,
    keychain: keychainResult,
    warnings: [fileError, databaseError, keychainError]
      .filter(Boolean)
      .map(error => error.message)
  };
}

module.exports = {
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
  STANDALONE_TOKEN_FILE,
  accountPayload,
  encodeVarint,
  createOAuthInfo,
  createUnifiedTopicEntry,
  createUnifiedRawTopicEntry,
  createUnifiedStateEntry,
  decodeUnifiedRawTopicPayload,
  removeUnifiedTopicEntry,
  createUserStatusPayload,
  createStringValuePayload,
  createAuthStatePayload,
  createCloudcodeUserState,
  candidateStateDatabase,
  injectStateDatabase,
  writeFileCredentialsToDir,
  writeSystemCredential,
  writeCredentials,
  sqliteAvailable,
  importedExpiry,
  credentialFromTokenPayload,
  parseCredentialPayload,
  parseOAuthInfo,
  parseAuthStatePayload,
  parseStateDatabasePayload,
  readFileCredentialsFromDir,
  readSystemCredential,
  readStateDatabase,
  readCurrentCredentials
};
