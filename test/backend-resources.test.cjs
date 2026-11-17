const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { copyBackendResources } = require('../scripts/backend-resources.cjs');

function prepareMacFixture(t, dependency, { missingLibrary = false } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-runtime-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const executable = path.join(temporary, 'node/bin/node');
  const libraries = path.join(temporary, 'node/lib');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(libraries, { recursive: true });
  fs.mkdirSync(path.join(temporary, 'src-tauri'), { recursive: true });
  fs.writeFileSync(executable, 'fixture node runtime');
  fs.writeFileSync(path.join(temporary, 'src-tauri/Entitlements.plist'), 'fixture entitlements');
  if (dependency && !missingLibrary) {
    fs.writeFileSync(path.join(libraries, path.basename(dependency)), 'fixture node library');
  }
  const calls = [];
  const run = () => vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../scripts/prepare-tauri.cjs'), 'utf8'),
    {
      __dirname: path.join(temporary, 'scripts'),
      process: {
        platform: 'darwin',
        arch: 'arm64',
        execPath: executable,
        argv: [executable, 'prepare-tauri.cjs', 'aarch64-apple-darwin']
      },
      console: { log() {} },
      require(name) {
        if (name === './backend-resources.cjs') {
          return { copyBackendResources: (root, destination) => fs.mkdirSync(destination, { recursive: true }) };
        }
        if (name === 'node:child_process') {
          return {
            execFileSync(command, args) {
              calls.push({ command, args: Array.from(args) });
              if (command === 'otool') {
                return `${args[1]}:\n\t${dependency || '/usr/lib/libSystem.B.dylib'} (compatibility version 1.0.0)\n`;
              }
              return '';
            }
          };
        }
        return require(name);
      }
    }
  );
  return { run, calls, temporary };
}

test('macOS packaging accepts and signs a Node runtime without a libnode dependency', t => {
  const fixture = prepareMacFixture(t);
  fixture.run();
  assert.deepEqual(fixture.calls.map(call => call.command), ['otool', 'codesign']);
  assert.equal(fs.existsSync(path.join(fixture.temporary,
    'src-tauri/binaries/antigravity-node-aarch64-apple-darwin')), true);
});

test('macOS packaging copies a linked libnode and adds its bundle search path', t => {
  const fixture = prepareMacFixture(t, '@rpath/libnode.123.dylib');
  fixture.run();
  assert.deepEqual(fixture.calls.map(call => call.command), ['otool', 'install_name_tool', 'codesign']);
  assert.deepEqual(fixture.calls[1].args.slice(0, 2),
    ['-add_rpath', '@loader_path/../Resources/node-lib']);
  assert.equal(fs.readFileSync(path.join(fixture.temporary,
    'src-tauri/node-lib/libnode.123.dylib'), 'utf8'), 'fixture node library');
});

test('macOS packaging fails if a required libnode cannot be found', t => {
  const fixture = prepareMacFixture(t, '@rpath/libnode.123.dylib', { missingLibrary: true });
  assert.throws(fixture.run, /Could not locate Node runtime library/);
  assert.deepEqual(fixture.calls.map(call => call.command), ['otool']);
});

test('The packaged backend runs with its own modules and dictionary without legacy rule files', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'easyag-resources-'));
  const backend = path.join(temporary, 'backend');
  const dataDir = path.join(temporary, 'data');
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  copyBackendResources(path.resolve(__dirname, '..'), backend);
  assert.equal(fs.existsSync(path.join(backend, 'scripts')), false);
  assert.equal(fs.existsSync(path.join(backend, 'danger-rules.json')), false);
  assert.equal(fs.existsSync(path.join(backend, 'assets/EasyAG-Resident.exe')), false);
  assert.equal(fs.existsSync(path.join(backend, 'THIRD-PARTY-NOTICES.md')), true);
  assert.equal(fs.readFileSync(path.join(backend, 'LICENSE'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../LICENSE'), 'utf8'));
  const { createApplication } = require(path.join(backend, 'desktop/application'));
  const app = createApplication({ rootDir: backend, dataDir, native: true, testMode: true });
  t.after(() => app.close('test resource cleanup'));
  const port = await app.start();
  const url = `http://127.0.0.1:${port}`;
  const status = await (await fetch(url + '/api/status')).json();
  assert.ok(status.dictEntries > 3000);
  assert.equal(status.clientRunning, false);
  for (const route of ['/', '/ui/launcher.js', '/ui/launcher.css', '/ui/api.js', '/assets/logo-32.png']) {
    assert.equal((await fetch(url + route)).status, 200, route);
  }
  await app.close('test resource cleanup');
});
