#!/usr/bin/env node
'use strict';

// bare-build's traversal requires a flat npm-style tree. pnpm's linked tree
// runs in development but is unsuitable as the standalone packer's input.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const host = process.argv[2] || process.env.HOST || `${os.platform()}-${os.arch()}`;
const supported = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);
const outputName = process.argv[2] ? host : 'make';
const output = path.join(root, 'out', outputName);
const executable = host.startsWith('win32') ? 'agentigram-pear.exe' : 'agentigram-pear';
const sourceEntries = [
  'app.js',
  'bin.mjs',
  'package.json',
  'package-lock.json',
  'lib',
  'ui',
  'workers',
];

if (!supported.has(host)) {
  console.error(`Unsupported platform/architecture: ${host}`);
  console.error(`Supported targets: ${[...supported].join(', ')}`);
  process.exit(1);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.on('exit', (code, signal) => resolve(signal ? 128 + signal : code));
    child.on('error', reject);
  });
}

async function run(command, args, options) {
  const code = await waitForExit(spawn(command, args, { stdio: 'inherit', ...options }));
  if (code !== 0) throw new Error(`${path.basename(command)} failed with exit code ${code}`);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function findSigntoolDir() {
  const base = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  if (!(await exists(base))) throw new Error(`Windows SDK bin directory not found: ${base}`);

  const versions = (await fs.readdir(base, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+(\.\d+)*$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(base, version, arch, 'signtool.exe');
    if (await exists(candidate)) return path.dirname(candidate);
  }
  throw new Error('signtool.exe not found in Windows SDK');
}

async function make() {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentigram-pear-build-'));
  const signFlags = [];
  const extraEnv = {};

  try {
    for (const entry of sourceEntries) {
      await fs.cp(path.join(root, entry), path.join(stage, entry), { recursive: true });
    }

    const npmArgs = ['ci', '--ignore-scripts', '--no-audit', '--no-fund'];
    if (os.platform() === 'win32') {
      const npmCli = path.join(
        path.dirname(process.execPath),
        'node_modules',
        'npm',
        'bin',
        'npm-cli.js',
      );
      await run(process.execPath, [npmCli, ...npmArgs], { cwd: stage });
    } else {
      await run('npm', npmArgs, { cwd: stage });
    }

    if (process.env.WINDOWS_CERT_SHA1) {
      extraEnv.PATH = `${await findSigntoolDir()};${process.env.PATH}`;
      signFlags.push('--sign', '--thumbprint', process.env.WINDOWS_CERT_SHA1);
    }
    if (process.env.MAC_CODESIGN_IDENTITY) {
      signFlags.push(
        '--sign',
        '--hardened-runtime',
        '--identity',
        process.env.MAC_CODESIGN_IDENTITY,
      );
    }

    const builder = path.join(stage, 'node_modules', 'bare-build', 'bin.js');
    await run(
      process.execPath,
      [
        builder,
        '--name',
        'agentigram-pear',
        '--standalone',
        ...signFlags,
        '--host',
        host,
        '--out',
        output,
        'bin.mjs',
      ],
      {
        cwd: stage,
        env: { ...process.env, ...extraEnv },
      },
    );

    if (process.env.KEYCHAIN_PROFILE) {
      const archive = path.join(stage, 'agentigram-pear.zip');
      await run('ditto', ['-c', '-k', '--sequesterRsrc', path.join(output, executable), archive], {
        cwd: root,
      });
      await run(
        'xcrun',
        [
          'notarytool',
          'submit',
          archive,
          '--keychain-profile',
          process.env.KEYCHAIN_PROFILE,
          '--wait',
        ],
        { cwd: root },
      );
    }
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

make().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
