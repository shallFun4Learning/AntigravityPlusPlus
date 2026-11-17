const fs = require('node:fs');
const path = require('node:path');
const { discoverAllTargets } = require('./discovery');

const MAX_HEADER_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 512 * 1024 * 1024;
const SOURCE_FILES = [
  'dist/remote/signInUrls.js',
  'extensions/antigravity/dist/extension.js'
];
const cache = new Map();

function readAt(fd, size, offset) {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const count = fs.readSync(fd, buffer, read, size - read, offset + read);
    if (!count) throw new Error('安装资源不完整');
    read += count;
  }
  return buffer;
}

function readAsarText(archive, relative) {
  const fd = fs.openSync(archive, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const prefix = readAt(fd, 16, 0);
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (headerSize < 8 || headerSize > MAX_HEADER_BYTES || jsonSize > headerSize - 8
      || 8 + headerSize > size) throw new Error('安装资源索引无效');
    let entry = JSON.parse(readAt(fd, jsonSize, 16).toString('utf8'));
    for (const segment of relative.split('/')) entry = entry?.files?.[segment];
    if (!entry || entry.link || entry.files || entry.unpacked
      || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > MAX_SOURCE_BYTES) {
      throw new Error('未找到登录配置资源');
    }
    const offset = Number(entry.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || 8 + headerSize + offset + entry.size > size) {
      throw new Error('登录配置资源位置无效');
    }
    return readAt(fd, entry.size, 8 + headerSize + offset).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function resourceDirectories(target) {
  const directories = new Set();
  for (const candidate of [target?.appDir, target?.appExe]) {
    if (!candidate) continue;
    const bundle = candidate.match(/^(.+?\.app)(?:[/\\]|$)/i)?.[1];
    if (bundle) directories.add(path.join(bundle, 'Contents/Resources'));
  }
  if (target?.appExe) directories.add(path.join(path.dirname(target.appExe), 'resources'));
  if (target?.appDir) directories.add(path.join(target.appDir, 'resources'));
  return [...directories];
}

function clientIdFromSource(source) {
  // Read the native app's declarative configuration without executing its code.
  return source.match(/\bclientId\s*:\s*['"]([\w-]+\.apps\.googleusercontent\.com)['"]/)?.[1]
    || source.match(/\bclient_id\s*[:=]\s*['"]([\w-]+\.apps\.googleusercontent\.com)['"]/)?.[1]
    || '';
}

function readRuntimeSecrets(file) {
  const size = fs.statSync(file).size;
  if (size < 1 || size > MAX_RUNTIME_BYTES) throw new Error('登录运行时大小无效');
  const fd = fs.openSync(file, 'r');
  const secrets = new Set();
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let previous = '';
    for (let offset = 0; offset < size;) {
      const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!read) break;
      const text = previous + buffer.subarray(0, read).toString('latin1');
      for (const match of text.matchAll(/GOCSPX-[A-Za-z0-9_-]{28}/g)) secrets.add(match[0]);
      if (secrets.size > 8) throw new Error('本机登录客户端配置不明确');
      previous = text.slice(-64);
      offset += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return [...secrets];
}

function runtimeCandidates(resources) {
  const directories = [
    path.join(resources, 'bin'),
    path.join(resources, 'app/extensions/antigravity/bin'),
    path.join(resources, 'app.asar.unpacked/extensions/antigravity/bin')
  ];
  const candidates = [];
  for (const directory of directories) {
    try {
      for (const name of fs.readdirSync(directory)) {
        if (/^language_server(?:_[\w-]+)?(?:\.exe)?$/.test(name)) {
          candidates.push(path.join(directory, name));
        }
      }
    } catch { /* Another supported installation layout may be present. */ }
  }
  return candidates;
}

function readInstalledOAuthClient({ settings = {}, targets = discoverAllTargets(settings) } = {}) {
  for (const target of Object.values(targets)) {
    for (const resources of resourceDirectories(target)) {
      for (const relative of SOURCE_FILES) {
        const archive = path.join(resources, 'app.asar');
        const unpacked = path.join(resources, 'app', relative);
        const sourceFile = fs.existsSync(unpacked) ? unpacked : archive;
        try {
          const sourceStat = fs.statSync(sourceFile);
          for (const runtime of runtimeCandidates(resources)) {
            try {
              const runtimeStat = fs.statSync(runtime);
              const key = JSON.stringify([sourceFile, relative, sourceStat.mtimeMs, sourceStat.size,
                runtime, runtimeStat.mtimeMs, runtimeStat.size]);
              if (cache.has(key)) return cache.get(key);
              if (sourceFile === unpacked && sourceStat.size > MAX_SOURCE_BYTES) continue;
              const source = sourceFile === unpacked
                ? fs.readFileSync(sourceFile, 'utf8')
                : readAsarText(archive, relative);
              const clientId = clientIdFromSource(source);
              if (!clientId) continue;
              const clientSecrets = readRuntimeSecrets(runtime);
              if (!clientSecrets.length) continue;
              const client = {
                key: 'antigravity_personal',
                label: '本机 Antigravity 账号',
                clientId,
                clientSecret: clientSecrets[0],
                clientSecrets,
                isGcpTos: false
              };
              cache.clear();
              cache.set(key, client);
              return client;
            } catch { /* Keep trying the known local runtime locations. */ }
          }
        } catch { /* Keep trying the known local configuration locations. */ }
      }
    }
  }
  throw new Error('未找到本机 Antigravity 的 OAuth 客户端配置，请确认安装路径，或设置 ANTIGRAVITY_OAUTH_CLIENT_ID 和 ANTIGRAVITY_OAUTH_CLIENT_SECRET');
}

module.exports = { readInstalledOAuthClient, readAsarText, clientIdFromSource, resourceDirectories };
