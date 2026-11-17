// Run on the target runner: bundle Node and ws so end users need neither npm nor Rust.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { copyBackendResources } = require('./backend-resources.cjs');
const root = path.resolve(__dirname, '..');
const triple = process.argv[2];
const targets = {
  'x86_64-pc-windows-msvc': ['win32', 'x64'],
  'aarch64-apple-darwin': ['darwin', 'arm64'],
  'x86_64-apple-darwin': ['darwin', 'x64']
};
assert.deepEqual([process.platform, process.arch], targets[triple], 'Build Node on the matching target runner');
const backend = path.join(root, 'src-tauri', 'backend');
assert.equal(path.resolve(backend), path.resolve(root, 'src-tauri', 'backend'));
assert.ok(backend.startsWith(root + path.sep), 'Clean only the generated backend directory');
fs.rmSync(backend, { recursive: true, force: true });
copyBackendResources(root, backend);
const tauriDir = path.join(root, 'src-tauri');
const binaries = path.join(tauriDir, 'binaries');
const nodeLibDir = path.join(tauriDir, 'node-lib');
fs.mkdirSync(binaries, { recursive: true });
fs.rmSync(nodeLibDir, { recursive: true, force: true });
fs.mkdirSync(nodeLibDir, { recursive: true });
const runtime = path.join(binaries, 'antigravity-node-' + triple + (process.platform === 'win32' ? '.exe' : ''));
fs.copyFileSync(process.execPath, runtime);
if (process.platform !== 'win32') fs.chmodSync(runtime, 0o755);
if (process.platform === 'darwin') {
  try {
    const linkedLibraries = execFileSync('otool', ['-L', runtime], { encoding: 'utf8' })
      .split('\n')
      .slice(1)
      .map(line => line.trim().split(/\s+/)[0])
      .filter(Boolean)
      .filter(library => /^libnode(?:\.[^/]+)?\.dylib$/.test(path.basename(library)));
    const nodePrefix = path.resolve(path.dirname(process.execPath), '..');
    const copiedLibraries = [];
    for (const library of linkedLibraries) {
      const name = path.basename(library);
      const candidates = [
        path.isAbsolute(library) ? library : null,
        path.join(nodePrefix, 'lib', name),
        path.join(path.dirname(process.execPath), name),
        path.join(path.dirname(process.execPath), '..', 'lib', name)
      ].filter(Boolean);
      const source = candidates.find(candidate => fs.existsSync(candidate));
      assert.ok(source, `Could not locate Node runtime library ${name}`);
      fs.copyFileSync(source, path.join(nodeLibDir, name));
      copiedLibraries.push(name);
    }
    if (copiedLibraries.length > 0) {
      execFileSync('install_name_tool', [
        '-add_rpath',
        '@loader_path/../Resources/node-lib',
        runtime
      ]);
      console.log('Bundled Node runtime libraries:', copiedLibraries.join(', '));
    } else {
      console.log('Node runtime does not require a separate libnode library');
    }
    const entPath = path.join(tauriDir, 'Entitlements.plist');
    if (fs.existsSync(entPath)) {
      execFileSync('codesign', ['--force', '--options', 'runtime', '--sign', '-', '--entitlements', entPath, runtime]);
      console.log('Signed antigravity-node with JIT entitlements');
    }
  } catch (e) {
    throw new Error(`Could not prepare the macOS Node runtime: ${e.message}`, { cause: e });
  }
}
console.log('Prepared backend and Node runtime:', triple);
