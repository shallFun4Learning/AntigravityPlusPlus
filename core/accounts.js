const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { readJson, writeJson } = require('./storage');
const { resolveOAuthClient, requestToken } = require('./oauth');

const STORE_VERSION = 1;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;

function accountIndexPath(dataDir) {
  return path.join(dataDir, 'accounts.json');
}

function accountSecretsPath(dataDir) {
  return path.join(dataDir, 'account-secrets.json');
}

function accountKeyPath(dataDir) {
  return path.join(dataDir, 'account-secrets.key');
}

function now() {
  return Date.now();
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeExpiry(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function makeAccountId() {
  return crypto.randomUUID();
}

function loadKey(file) {
  try {
    const key = fs.readFileSync(file);
    if (key.length === 32) return key;
  } catch {}
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return key;
}

function encrypt(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64')
  };
}

function decrypt(payload, key) {
  if (!payload || payload.algorithm !== 'aes-256-gcm') return {};
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(payload.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final()
  ]).toString('utf8');
  const value = JSON.parse(plaintext);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function defaultIndex() {
  return {
    version: STORE_VERSION,
    accounts: [],
    currentByTarget: {
      hub: null,
      ide: null
    }
  };
}

function normalizeIndex(value) {
  const index = value && typeof value === 'object' ? value : {};
  const accounts = Array.isArray(index.accounts) ? index.accounts : [];
  const normalized = {
    version: STORE_VERSION,
    accounts: accounts
      .filter(account => account && typeof account === 'object' && cleanString(account.id))
      .map(account => ({
        id: cleanString(account.id),
        email: normalizeEmail(account.email),
        label: cleanString(account.label),
        createdAt: Number(account.createdAt) || now(),
        lastUsedAt: Number(account.lastUsedAt) || 0,
        tokenExpiresAt: normalizeExpiry(account.tokenExpiresAt),
        projectId: cleanString(account.projectId),
        oauthClientKey: cleanString(account.oauthClientKey),
        isGcpTos: account.isGcpTos === true,
        disabled: account.disabled === true,
        disabledReason: cleanString(account.disabledReason)
      }))
      .filter(account => account.email || account.id),
    currentByTarget: {
      hub: cleanString(index.currentByTarget?.hub) || null,
      ide: cleanString(index.currentByTarget?.ide) || null
    }
  };
  return normalized;
}

function publicAccount(account, secrets, currentByTarget) {
  const secret = secrets[account.id] || {};
  return {
    ...account,
    hasAccessToken: Boolean(cleanString(secret.accessToken)),
    hasRefreshToken: Boolean(cleanString(secret.refreshToken)),
    isCurrent: Object.values(currentByTarget).includes(account.id),
    currentTargets: Object.entries(currentByTarget)
      .filter(([, id]) => id === account.id)
      .map(([target]) => target)
  };
}

function validateInput(input) {
  const email = normalizeEmail(input?.email);
  const refreshToken = cleanString(input?.refreshToken);
  const accessToken = cleanString(input?.accessToken);
  if (!email) throw new Error('账号邮箱不能为空');
  if (!refreshToken && !accessToken) {
    throw new Error('至少需要提供 access token 或 refresh token');
  }
  return {
    email,
    label: cleanString(input?.label),
    accessToken,
    refreshToken,
    expiryTimestamp: normalizeExpiry(input?.expiryTimestamp || input?.expiresAt),
    idToken: cleanString(input?.idToken),
    projectId: cleanString(input?.projectId),
    oauthClientKey: cleanString(input?.oauthClientKey),
    isGcpTos: input?.isGcpTos === true
  };
}

class AccountStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.indexFile = accountIndexPath(dataDir);
    this.secretsFile = accountSecretsPath(dataDir);
    this.keyFile = accountKeyPath(dataDir);
    this.key = null;
    this.index = null;
    this.secrets = null;
  }

  load() {
    if (!this.index) {
      this.index = normalizeIndex(readJson(this.indexFile, defaultIndex()));
    }
    if (!this.secrets) {
      this.key = this.key || loadKey(this.keyFile);
      try {
        this.secrets = decrypt(readJson(this.secretsFile, {}), this.key);
      } catch {
        this.secrets = {};
      }
    }
    return this;
  }

  save() {
    this.load();
    writeJson(this.indexFile, this.index);
    writeJson(this.secretsFile, encrypt(this.secrets, this.key));
    try { fs.chmodSync(this.secretsFile, 0o600); } catch {}
  }

  list() {
    this.load();
    return this.index.accounts.map(account => publicAccount(
      account,
      this.secrets,
      this.index.currentByTarget
    ));
  }

  get(accountId) {
    this.load();
    const account = this.index.accounts.find(item => item.id === accountId);
    if (!account) throw new Error('账号不存在');
    return account;
  }

  getSecrets(accountId) {
    this.load();
    this.get(accountId);
    return { ...(this.secrets[accountId] || {}) };
  }

  add(input) {
    const normalized = validateInput(input);
    this.load();
    const existing = this.index.accounts.find(account => account.email === normalized.email);
    const account = existing || {
      id: makeAccountId(),
      email: normalized.email,
      createdAt: now(),
      lastUsedAt: 0,
      disabled: false,
      disabledReason: ''
    };
    Object.assign(account, {
      label: normalized.label || account.label,
      tokenExpiresAt: normalized.expiryTimestamp || account.tokenExpiresAt || 0,
      projectId: normalized.projectId || account.projectId || '',
      oauthClientKey: normalized.oauthClientKey || account.oauthClientKey || '',
      isGcpTos: normalized.isGcpTos,
      disabled: false,
      disabledReason: ''
    });
    const previous = this.secrets[account.id] || {};
    this.secrets[account.id] = {
      accessToken: normalized.accessToken || previous.accessToken || '',
      refreshToken: normalized.refreshToken || previous.refreshToken || '',
      idToken: normalized.idToken || previous.idToken || ''
    };
    if (!existing) this.index.accounts.push(account);
    this.save();
    return publicAccount(account, this.secrets, this.index.currentByTarget);
  }

  remove(accountId) {
    this.load();
    this.get(accountId);
    this.index.accounts = this.index.accounts.filter(account => account.id !== accountId);
    delete this.secrets[accountId];
    for (const target of Object.keys(this.index.currentByTarget)) {
      if (this.index.currentByTarget[target] === accountId) this.index.currentByTarget[target] = null;
    }
    this.save();
  }

  setCurrent(accountId, target) {
    this.load();
    const account = this.get(accountId);
    if (!['hub', 'ide'].includes(target)) throw new Error('不支持的账号目标');
    this.index.currentByTarget[target] = accountId;
    account.lastUsedAt = now();
    this.save();
    return publicAccount(account, this.secrets, this.index.currentByTarget);
  }

  clearCurrent(target) {
    this.load();
    if (!['hub', 'ide'].includes(target)) throw new Error('不支持的账号目标');
    this.index.currentByTarget[target] = null;
    this.save();
  }

  currentIds() {
    this.load();
    return { ...this.index.currentByTarget };
  }

  current(target) {
    this.load();
    if (!['hub', 'ide'].includes(target)) throw new Error('不支持的账号目标');
    const accountId = this.index.currentByTarget[target];
    if (!accountId) return null;
    const account = this.index.accounts.find(item => item.id === accountId);
    return account ? publicAccount(account, this.secrets, this.index.currentByTarget) : null;
  }

  updateToken(accountId, token) {
    this.load();
    const account = this.get(accountId);
    const secret = this.secrets[accountId] || {};
    this.secrets[accountId] = {
      accessToken: cleanString(token.accessToken) || secret.accessToken || '',
      refreshToken: cleanString(token.refreshToken) || secret.refreshToken || '',
      idToken: cleanString(token.idToken) || secret.idToken || ''
    };
    if (token.expiryTimestamp) account.tokenExpiresAt = normalizeExpiry(token.expiryTimestamp);
    if (token.projectId) account.projectId = cleanString(token.projectId);
    if (token.oauthClientKey) account.oauthClientKey = cleanString(token.oauthClientKey);
    if (token.isGcpTos !== undefined) account.isGcpTos = token.isGcpTos === true;
    account.disabled = false;
    account.disabledReason = '';
    this.save();
    return publicAccount(account, this.secrets, this.index.currentByTarget);
  }
}

function tokenNeedsRefresh(account, secret) {
  if (!cleanString(secret.accessToken)) return true;
  if (!Number.isFinite(account.tokenExpiresAt) || account.tokenExpiresAt <= 0) return false;
  return account.tokenExpiresAt <= Date.now() + TOKEN_REFRESH_SKEW_MS;
}

async function refreshAccessToken(account, secret, fetchImpl = globalThis.fetch, resolveClient = resolveOAuthClient) {
  if (!cleanString(secret.refreshToken)) throw new Error('当前账号没有 refresh token');
  const client = resolveClient(account?.oauthClientKey);
  const { response, payload } = await requestToken(client, {
    refresh_token: secret.refreshToken,
    grant_type: 'refresh_token'
  }, fetchImpl);
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || `Token 刷新失败 (${response.status})`);
  }
  return {
    accessToken: payload.access_token,
    refreshToken: secret.refreshToken,
    idToken: cleanString(payload.id_token) || secret.idToken,
    expiryTimestamp: Date.now() + Number(payload.expires_in || 3600) * 1000
  };
}

module.exports = {
  AccountStore,
  accountIndexPath,
  accountSecretsPath,
  accountKeyPath,
  normalizeEmail,
  normalizeExpiry,
  tokenNeedsRefresh,
  refreshAccessToken
};
