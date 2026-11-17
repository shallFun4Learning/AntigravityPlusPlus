const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function releaseMetadata(root, env = process.env) {
  const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const version = readJson('package.json').version;
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/, 'Invalid package version');
  const lock = readJson('package-lock.json');
  const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const cargoPackage = cargo.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
  const cargoVersion = cargoPackage?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  for (const [name, actual] of [
    ['package-lock.json', lock.version],
    ['package-lock.json root package', lock.packages[''].version],
    ['tauri.conf.json', readJson('src-tauri/tauri.conf.json').version],
    ['Cargo.toml', cargoVersion]
  ]) {
    assert.equal(actual, version, `${name} version must match package.json`);
  }

  if (env.GITHUB_REF?.startsWith('refs/tags/')) {
    const tag = env.GITHUB_REF.slice('refs/tags/'.length);
    assert.equal(tag, `v${version}`, 'Release tag must match the application version');
    return { version, tag, prerelease: version.includes('-') };
  }
  assert.match(env.GITHUB_RUN_NUMBER || '', /^[1-9]\d*$/, 'A workflow run number is required for previews');
  return { version, tag: `v${version}${version.includes('-') ? '.' : '-'}preview.${env.GITHUB_RUN_NUMBER}`, prerelease: true };
}

function packageNames(version) {
  return [
    `AntigravityPlusPlus-${version}-macos-arm64-beta.zip`,
    `AntigravityPlusPlus-${version}-macos-x64-beta.zip`,
    `AntigravityPlusPlus-${version}-windows-x64.zip`
  ];
}

async function prepareReleaseAssets(root, directory, metadata, env = process.env) {
  const packages = packageNames(metadata.version);
  assert.deepEqual(
    fs.readdirSync(directory).filter(name => name.endsWith('.zip')).sort(),
    packages,
    'A release requires exactly the three verified platform packages'
  );
  const checksums = [];
  for (const name of packages) {
    const file = path.join(directory, name);
    assert.ok(fs.statSync(file).size > 0, `Empty release package: ${name}`);
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    checksums.push(`${hash.digest('hex')}  ${name}`);
  }
  const checksumFile = path.join(directory, 'SHA256SUMS.txt');
  fs.writeFileSync(checksumFile, checksums.join('\n') + '\n');

  const escaped = metadata.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionPattern = new RegExp(`^## v?${escaped}(?:\\s|[（(]|$)`);
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
  const start = changelog.findIndex(line => sectionPattern.test(line));
  assert.ok(start >= 0, 'The release version needs a CHANGELOG section');
  const next = changelog.findIndex((line, index) => index > start && /^## /.test(line));
  const changes = changelog.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
  const notesFile = path.join(directory, 'RELEASE_NOTES.md');
  const channel = metadata.prerelease
    ? '这是通过三平台构建与测试后自动发布的预览版，供体验和反馈。'
    : '此版本通过三平台构建与测试后自动发布。';
  fs.writeFileSync(notesFile, [
    `# Antigravity++ ${metadata.tag}`, '', channel, '',
    `源码提交：\`${env.GITHUB_SHA || 'local'}\``, '',
    '## 下载', '',
    '| 平台 | 文件 |', '| --- | --- |',
    `| Windows x64 | \`${packages[2]}\` |`,
    `| macOS Apple Silicon（Beta） | \`${packages[0]}\` |`,
    `| macOS Intel（Beta） | \`${packages[1]}\` |`, '',
    'Windows 完整解压后运行 AntigravityPlusPlus.exe；macOS 解压后打开 Antigravity++.app。',
    'macOS 应用使用临时签名，尚未经过 Apple 公证。',
    '下载后可使用 SHA256SUMS.txt 校验文件完整性。', '',
    '## 本版更新', '', changes, ''
  ].join('\n'));
  return { files: [...packages.map(name => path.join(directory, name)), checksumFile], notesFile };
}

function publishRelease(metadata, assets, env = process.env, run = args => execFileSync('gh', args, { encoding: 'utf8' })) {
  assert.match(env.GITHUB_REPOSITORY || '', /^[\w.-]+\/[\w.-]+$/, 'A GitHub repository is required');
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/, 'A full commit SHA is required');
  const common = [metadata.tag, '--repo', env.GITHUB_REPOSITORY];
  let existing;
  try {
    existing = JSON.parse(run(['release', 'view', ...common, '--json', 'isDraft,targetCommitish,url']));
  } catch (error) {
    if (!/release not found/i.test(String(error.stderr))) throw error;
  }
  if (existing) {
    assert.equal(existing.targetCommitish, env.GITHUB_SHA, 'An existing release belongs to a different commit');
    if (!existing.isDraft) return existing.url;
  } else {
    const create = ['release', 'create', ...common, '--target', env.GITHUB_SHA,
      '--title', `Antigravity++ ${metadata.tag}`, '--notes-file', assets.notesFile, '--draft'];
    if (metadata.prerelease) create.push('--prerelease', '--latest=false');
    if (env.GITHUB_REF?.startsWith('refs/tags/')) create.push('--verify-tag');
    run(create);
  }
  run(['release', 'upload', ...common, ...assets.files, '--clobber']);
  run(['release', 'edit', ...common, '--notes-file', assets.notesFile, '--draft=false',
    `--prerelease=${metadata.prerelease}`, `--latest=${!metadata.prerelease}`]);
  return run(['release', 'view', ...common, '--json', 'url', '--jq', '.url']).trim();
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const metadata = releaseMetadata(root);
  if (process.argv[2] === 'metadata') {
    assert.ok(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required');
    for (const [name, value] of Object.entries(metadata)) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
    console.log(`Release: ${metadata.tag} (${metadata.prerelease ? 'preview' : 'stable'})`);
    return;
  }
  assert.equal(process.argv[2], 'publish', 'Use metadata or publish');
  const directory = path.resolve(process.argv[3] || 'release-assets');
  const assets = await prepareReleaseAssets(root, directory, metadata);
  const url = publishRelease(metadata, assets);
  console.log(`Published ${url}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Antigravity++\n\n[${metadata.tag}](${url})\n\nThree platform packages and SHA256SUMS.txt are available.\n`);
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { releaseMetadata, packageNames, prepareReleaseAssets, publishRelease };
