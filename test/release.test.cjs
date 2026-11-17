const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { releaseMetadata, packageNames, prepareReleaseAssets, publishRelease } = require('../scripts/release.cjs');

const sha = 'a'.repeat(40);
const env = { GITHUB_REPOSITORY: 'example/launcher', GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/main', GITHUB_RUN_NUMBER: '9' };

function fixture(t, version = '0.1.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src-tauri'));
  fs.mkdirSync(path.join(root, 'release-assets'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
  fs.writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, 'src-tauri/Cargo.toml'), `[package]\nname = "launcher"\nversion = "${version}"\n\n[dependencies]\n`);
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), `# 更新\n\n## v${version}（未发布）\n\n### 功能\n\n- 多账号与额度圆环。\n\n## v4.0.5\n\n旧项目历史。\n`);
  return root;
}

test('main builds receive unique preview tags while platform package versions stay unchanged', t => {
  const root = fixture(t);
  const metadata = releaseMetadata(root, env);
  assert.deepEqual(metadata, { version: '0.1.0', tag: 'v0.1.0-preview.9', prerelease: true });
  assert.equal(releaseMetadata(root, { ...env, GITHUB_RUN_NUMBER: '10' }).tag, 'v0.1.0-preview.10');
  assert.deepEqual(packageNames(metadata.version), [
    'AntigravityPlusPlus-0.1.0-macos-arm64-beta.zip',
    'AntigravityPlusPlus-0.1.0-macos-x64-beta.zip',
    'AntigravityPlusPlus-0.1.0-windows-x64.zip'
  ]);
});

test('version tags must match all application manifests before publishing a stable release', t => {
  const root = fixture(t);
  assert.deepEqual(releaseMetadata(root, { ...env, GITHUB_REF: 'refs/tags/v0.1.0' }),
    { version: '0.1.0', tag: 'v0.1.0', prerelease: false });
  assert.throws(() => releaseMetadata(root, { ...env, GITHUB_REF: 'refs/tags/v4.0.5-lite' }), /Release tag must match/);
  fs.writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.2.0' }));
  assert.throws(() => releaseMetadata(root, env), /tauri.conf.json version must match/);
});

test('prerelease version tags keep prerelease status and a valid preview suffix', t => {
  const root = fixture(t, '0.2.0-beta.1');
  assert.equal(releaseMetadata(root, env).tag, 'v0.2.0-beta.1.preview.9');
  assert.equal(releaseMetadata(root, { ...env, GITHUB_REF: 'refs/tags/v0.2.0-beta.1' }).prerelease, true);
});

test('release preparation rejects missing, empty or unexpected platform packages', async t => {
  const root = fixture(t);
  const directory = path.join(root, 'release-assets');
  const metadata = releaseMetadata(root, env);
  await assert.rejects(prepareReleaseAssets(root, directory, metadata, env), /exactly the three/);
  for (const name of packageNames(metadata.version)) fs.writeFileSync(path.join(directory, name), '');
  await assert.rejects(prepareReleaseAssets(root, directory, metadata, env), /Empty release package/);
  fs.writeFileSync(path.join(directory, 'unexpected.zip'), 'unexpected package');
  await assert.rejects(prepareReleaseAssets(root, directory, metadata, env), /exactly the three/);
  assert.equal(fs.existsSync(path.join(directory, 'SHA256SUMS.txt')), false);
});

test('release preparation generates verifiable checksums and only the matching changelog section', async t => {
  const root = fixture(t);
  const directory = path.join(root, 'release-assets');
  const metadata = releaseMetadata(root, env);
  const packages = packageNames(metadata.version);
  for (const name of packages) fs.writeFileSync(path.join(directory, name), `archive: ${name}`);
  const assets = await prepareReleaseAssets(root, directory, metadata, env);
  assert.equal(assets.files.length, 4);
  const checksums = fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
  assert.equal(checksums.length, 3);
  for (const [index, name] of packages.entries()) {
    const actual = createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex');
    assert.equal(checksums[index], `${actual}  ${name}`);
  }
  const notes = fs.readFileSync(assets.notesFile, 'utf8');
  assert.match(notes, /多账号与额度圆环/);
  assert.match(notes, /预览版/);
  assert.match(notes, new RegExp(sha));
  assert.doesNotMatch(notes, /旧项目历史/);
});

test('publishing uploads every asset to a draft before making a release public', () => {
  const calls = [];
  const metadata = { version: '0.1.0', tag: 'v0.1.0-preview.9', prerelease: true };
  const assets = { files: ['windows.zip', 'arm64.zip', 'x64.zip', 'SHA256SUMS.txt'], notesFile: 'notes.md' };
  const url = publishRelease(metadata, assets, env, args => {
    calls.push(args);
    if (calls.length === 1) throw Object.assign(new Error('missing'), { stderr: 'release not found' });
    if (args[1] === 'view') return 'https://example.com/release\n';
    return '';
  });
  assert.equal(url, 'https://example.com/release');
  assert.deepEqual(calls.map(args => args[1]), ['view', 'create', 'upload', 'edit', 'view']);
  assert.ok(calls[1].includes('--draft'));
  assert.equal(calls[1][calls[1].indexOf('--target') + 1], sha);
  for (const file of assets.files) assert.ok(calls[2].includes(file));
  assert.ok(calls[3].includes('--draft=false'));
  assert.ok(calls[3].includes('--latest=false'));
});

test('reruns complete an existing draft and preserve an already published release', () => {
  const metadata = { version: '0.1.0', tag: 'v0.1.0', prerelease: false };
  const assets = { files: ['complete.zip', 'SHA256SUMS.txt'], notesFile: 'notes.md' };
  for (const isDraft of [true, false]) {
    const calls = [];
    publishRelease(metadata, assets, env, args => {
      calls.push(args);
      if (calls.length === 1) return JSON.stringify({ isDraft, targetCommitish: sha, url: 'https://example.com/release' });
      return 'https://example.com/release';
    });
    assert.deepEqual(calls.map(args => args[1]), isDraft ? ['view', 'upload', 'edit', 'view'] : ['view']);
  }
});

test('publication refuses a release from another commit and stops on asset upload failure', () => {
  const metadata = { version: '0.1.0', tag: 'v0.1.0', prerelease: false };
  const assets = { files: ['complete.zip'], notesFile: 'notes.md' };
  assert.throws(() => publishRelease(metadata, assets, env, () =>
    JSON.stringify({ isDraft: true, targetCommitish: 'b'.repeat(40) })), /different commit/);
  const calls = [];
  assert.throws(() => publishRelease(metadata, assets, env, args => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ isDraft: true, targetCommitish: sha });
    throw new Error('Upload failed');
  }), /Upload failed/);
  assert.deepEqual(calls.map(args => args[1]), ['view', 'upload']);
});

test('GitHub permission failures are not treated as a missing release', () => {
  const calls = [];
  assert.throws(() => publishRelease({ tag: 'v0.1.0' }, {}, env, args => {
    calls.push(args);
    throw Object.assign(new Error('Forbidden'), { stderr: 'HTTP 403: Resource not accessible by integration' });
  }), /Forbidden/);
  assert.equal(calls.length, 1);
});
