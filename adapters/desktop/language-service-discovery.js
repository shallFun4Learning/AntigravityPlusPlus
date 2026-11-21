// Process/socket parsers adapted from Antigrative Dashboard (MIT).
// Copyright (c) 2026 AG Pulse contributors. See THIRD-PARTY-NOTICES.md.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const run = promisify(execFile);

function parseNetstat(text) {
  const ports = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match) continue;
    const port = Number(match[1].match(/:(\d+)$/)?.[1]), pid = Number(match[2]);
    if (port < 1 || port > 65535 || !Number.isInteger(port)) continue;
    if (!ports.has(pid)) ports.set(pid, new Set());
    ports.get(pid).add(port);
  }
  return ports;
}

function parsePs(text, uid) {
  return text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[2]) !== uid
      || !/(?:^|[\/\\])language_server(?:_(?:linux|macos|darwin)(?:_(?:x64|arm64))?)?(?:\s|$)/.test(match[3])
      || !/--standalone\b/.test(match[3])) return [];
    return [{ pid: Number(match[1]), command: match[3] }];
  });
}

function parseLsof(text) {
  let pid;
  const ports = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (/^p\d+$/.test(line)) { pid = Number(line.slice(1)); ports.set(pid, new Set()); }
    const port = line[0] === 'n' && line.match(/:(\d+)(?:\s|$)/)?.[1];
    if (pid && port) ports.get(pid).add(Number(port));
  }
  return ports;
}

function ideProcess(command) {
  return /--subclient_type(?:=|\s+)"?ide(?:"|\s|$)/.test(command)
    && !/--(?:enable_lsp|standalone)(?:\s|=|$)/.test(command);
}

function parseIdePs(text, uid, parentPid) {
  return text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[2]) !== uid || (parentPid && Number(match[3]) !== parentPid)
      || !/(?:^|[\/\\])language_server_(?:linux|macos|darwin)(?:_(?:x64|arm64|arm))?(?:\s|$)/.test(match[4])
      || !ideProcess(match[4])) return [];
    return [{ pid: Number(match[1]), parentPid: Number(match[3]), command: match[4] }];
  });
}

async function discoverProcesses({ platform = process.platform, execute = run, uid = process.getuid?.(), target = 'hub', parentPid } = {}) {
  const options = { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 };
  if (platform === 'win32') {
    // Current Windows user only. Do not select another user's logged-in backend.
    const processFilter = target === 'ide'
      ? "Name='language_server_windows_x64.exe' OR Name='language_server_windows_arm.exe'"
      : "Name='language_server.exe'";
    const modeFilter = target === 'ide'
      ? '$_.CommandLine -match "--subclient_type(?:=|\\s+)ide(?:\\s|$)" -and $_.CommandLine -notmatch "--(?:enable_lsp|standalone)(?:\\s|=|$)"'
      : '$_.CommandLine -match "(?:^|\\s)--standalone(?:\\s|=|$)"';
    const parentFilter = target === 'ide' && Number.isSafeInteger(parentPid) && parentPid > 0
      ? ` -and $_.ParentProcessId -eq ${parentPid}` : '';
    const script = `$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Get-CimInstance Win32_Process -Filter "${processFilter}" | Where-Object { ${modeFilter}${parentFilter} -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $sid } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`;
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], options);
    const parsed = stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/, '')) : [];
    const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(row => Number.isSafeInteger(row?.ProcessId) && row.ProcessId > 0
      && (target !== 'ide' || (ideProcess(row.CommandLine || '') && (!parentPid || row.ParentProcessId === parentPid))));
    if (!rows.length) return [];
    const sockets = await execute('netstat.exe', ['-ano', '-p', 'tcp'], options);
    const ports = parseNetstat(sockets.stdout);
    return rows.map(row => ({ pid: row.ProcessId, command: row.CommandLine, ports: ports.get(row.ProcessId) || new Set() }));
  }
  if (!['darwin', 'linux'].includes(platform)) throw new Error('不支持的系统');
  const { stdout } = await execute('ps', ['-ww', '-axo', target === 'ide' ? 'pid=,uid=,ppid=,args=' : 'pid=,uid=,args='], options);
  const rows = target === 'ide' ? parseIdePs(stdout, uid, parentPid) : parsePs(stdout, uid);
  if (!rows.length) return [];
  if (platform === 'darwin') {
    const sockets = await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', rows.map(row => row.pid).join(','), '-iTCP', '-sTCP:LISTEN', '-Fpn'], options)
      .catch(error => { if (error.code === 1) return { stdout: error.stdout || '' }; throw error; });
    const ports = parseLsof(sockets.stdout);
    return rows.map(row => ({ ...row, ports: ports.get(row.pid) || new Set() }));
  }
  return Promise.all(rows.map(async row => {
    const inodes = new Set(), ports = new Set();
    try {
      for (const fd of await fs.readdir(`/proc/${row.pid}/fd`)) {
        try {
          const link = await fs.readlink(`/proc/${row.pid}/fd/${fd}`);
          const match = link.match(/^socket:\[(\d+)\]$/);
          if (match) inodes.add(match[1]);
        } catch { /* A socket can close during discovery. */ }
      }
      for (const name of ['tcp', 'tcp6']) {
        const table = await fs.readFile(`/proc/${row.pid}/net/${name}`, 'utf8').catch(() => '');
        for (const line of table.split(/\r?\n/)) {
          const fields = line.trim().split(/\s+/);
          if (fields[3] === '0A' && inodes.has(fields[9])) {
            const port = parseInt(fields[1]?.split(':')[1], 16);
            if (port > 0 && port <= 65535) ports.add(port);
          }
        }
      }
    } catch { /* Exited or inaccessible process: no verified port. */ }
    return { ...row, ports };
  }));
}

function serverFromDiscovery(log, rows) {
  if (rows.length !== 1) throw new Error(rows.length ? '多个 AG 后台，暂不采集' : '等待 AG 本地服务');
  const row = rows[0];
  const port = [...log.matchAll(/listening on random port at (\d+) for HTTP(?:\s|$)/g)]
    .reverse().map(match => Number(match[1])).find(value => row.ports.has(value));
  const csrf = row.command?.match(/--csrf_token(?:=|\s+)"?([^\s"]+)/)?.[1];
  if (!port || !csrf) throw new Error('当前 AG 本地接口暂不可用');
  return { pid: row.pid, port, csrf };
}

async function readDaemonDescriptor(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.size > 4096 || (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077)))) return null;
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4097), 0, 4097, 0);
    return bytesRead <= 4096 ? JSON.parse(buffer.toString('utf8', 0, bytesRead)) : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function serverFromDaemon(row, home = os.homedir()) {
  const option = row.command?.match(/(?:^|\s)--app_data_dir(?:=|\s+)(?:"([^"]+)"|([^\s"]+))/);
  const appDataDir = option?.[1] ?? option?.[2] ?? 'antigravity';
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(appDataDir)) return null;
  const directory = path.join(home, '.gemini', appDataDir, 'daemon');
  let server = null;
  for (const port of [...row.ports].slice(0, 16)) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const descriptor = await readDaemonDescriptor(path.join(directory, `hub_${port}.json`));
    if (!descriptor || descriptor.pid !== row.pid || descriptor.httpPort !== port
      || typeof descriptor.csrfToken !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(descriptor.csrfToken)) continue;
    if (server) return null;
    server = { pid: row.pid, port, csrf: descriptor.csrfToken };
  }
  return server;
}

function logPaths(profile) {
  return [...new Set([
    ...(process.platform === 'darwin' ? [path.join(os.homedir(), 'Library/Logs/Antigravity/language_server.log')] : []),
    path.join(profile, 'logs/language_server.log')
  ])];
}

module.exports = { discoverProcesses, serverFromDiscovery, serverFromDaemon, logPaths, parsePs, parseIdePs, ideProcess, parseNetstat, parseLsof };
