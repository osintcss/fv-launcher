#!/usr/bin/env node
'use strict';

/**
 * Repairs the electron@11.5.0 install on macOS.
 *
 * Two macOS-specific problems are handled here:
 *
 * 1. Broken extraction. electron's own postinstall downloads its zip with
 *    `@electron/get` (reliable) and then unzips it with `extract-zip@1.7.0`.
 *    In that version the readStream `error` handler is a bare `console.log`
 *    that never invokes the entry callback, so a mid-extraction read error
 *    stalls the extract forever: install.js's promise never settles, it never
 *    writes `path.txt`, the event loop goes idle and the process exits 0
 *    without printing anything. The result is a half-extracted `dist/` with no
 *    `path.txt`, which makes `require('electron')` throw
 *    "Electron failed to install correctly" on the next `npm start`.
 *    We re-extract with macOS's `ditto`, which also preserves the symlinks,
 *    permissions and resource forks inside `Electron.app`.
 *
 * 2. Wrong architecture. Pepper Flash has no arm64 build (the bundled
 *    `plugins/flash.plugin` is x64-only), and a single process cannot mix
 *    architectures, so the Electron binary itself must be x64 and run under
 *    Rosetta 2 on Apple Silicon -- which is what `npm run start:mac`
 *    (`arch -x86_64 electron .`) does. npm installs the build matching the
 *    HOST arch by default, so an Apple Silicon Mac gets arm64 Electron and
 *    `start:mac` then fails with "Bad CPU type in executable". macOS always
 *    wants x64 here (Intel Macs get x64 natively anyway), so this script
 *    pins x64 on darwin rather than relying on the caller to remember
 *    `npm install --arch=x64`.
 *
 * No-op on every non-darwin platform, and on darwin when a correct x64
 * install is already in place.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ELECTRON_DIR = path.join(__dirname, '..', 'node_modules', 'electron');
const DIST_DIR = path.join(ELECTRON_DIR, 'dist');
const PATH_TXT = path.join(ELECTRON_DIR, 'path.txt');
const PLATFORM_PATH = 'Electron.app/Contents/MacOS/Electron';

// macOS is the only platform confirmed affected; everywhere else electron's
// own installer is left completely alone.
const REQUIRED_ARCH = 'x64';

function log(message) {
  console.log(`[repair-electron-install] ${message}`);
}

/**
 * Reads the architectures out of a Mach-O file's header.
 *
 * Done by hand rather than by shelling out to `lipo` or `file` so the check
 * does not depend on the Xcode command line tools being installed.
 */
function machoArchs(binaryPath) {
  const CPU_TYPE_X86_64 = 0x01000007;
  const CPU_TYPE_ARM64 = 0x0100000c;
  const name = (cpuType) => {
    if (cpuType === CPU_TYPE_X86_64) return 'x64';
    if (cpuType === CPU_TYPE_ARM64) return 'arm64';
    return `unknown(0x${(cpuType >>> 0).toString(16)})`;
  };

  let fd;
  try {
    fd = fs.openSync(binaryPath, 'r');
    const head = Buffer.alloc(8);
    if (fs.readSync(fd, head, 0, 8, 0) < 8) return [];

    const magic = head.readUInt32BE(0);

    // Universal ("fat") binary: a big-endian count followed by 20-byte
    // fat_arch records, each starting with its cputype.
    if (magic === 0xcafebabe || magic === 0xbebafeca) {
      const count = head.readUInt32BE(4);
      if (count > 32) return []; // implausible; treat as unreadable
      const table = Buffer.alloc(count * 20);
      fs.readSync(fd, table, 0, table.length, 8);
      const archs = [];
      for (let i = 0; i < count; i++) {
        archs.push(name(table.readUInt32BE(i * 20)));
      }
      return archs;
    }

    // Thin Mach-O: cputype is the 4 bytes after the magic, in the same
    // endianness as the magic itself.
    if (magic === 0xfeedface || magic === 0xfeedfacf) {
      return [name(head.readUInt32BE(4))]; // big-endian magic
    }
    if (magic === 0xcefaedfe || magic === 0xcffaedfe) {
      return [name(head.readUInt32LE(4))]; // little-endian magic
    }

    return [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* nothing useful to do */ }
    }
  }
}

/**
 * Mirrors electron install.js's isInstalled(), plus an architecture check --
 * an arm64 install is "correct" as far as electron's installer is concerned
 * but is exactly the state that breaks `npm run start:mac`.
 */
function inspectInstall(version) {
  const executable = path.join(DIST_DIR, PLATFORM_PATH);

  try {
    if (fs.readFileSync(path.join(DIST_DIR, 'version'), 'utf-8').replace(/^v/, '') !== version) {
      return { ok: false, reason: 'dist/version is missing or does not match package.json' };
    }
    if (fs.readFileSync(PATH_TXT, 'utf-8') !== PLATFORM_PATH) {
      return { ok: false, reason: 'path.txt is missing or does not point at the app bundle' };
    }
  } catch {
    return { ok: false, reason: 'dist/version or path.txt is unreadable (extraction did not finish)' };
  }

  if (!fs.existsSync(executable)) {
    return { ok: false, reason: 'Electron.app executable is missing' };
  }

  const archs = machoArchs(executable);
  if (!archs.includes(REQUIRED_ARCH)) {
    return {
      ok: false,
      reason: `installed Electron is ${archs.join('+') || 'an unreadable arch'}, but Flash requires ${REQUIRED_ARCH}`
    };
  }

  return { ok: true, archs };
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

async function main() {
  if (process.platform !== 'darwin') return;

  // Honour the same escape hatches as electron's own installer.
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    log('ELECTRON_SKIP_BINARY_DOWNLOAD is set; skipping.');
    return;
  }
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    log('ELECTRON_OVERRIDE_DIST_PATH is set; leaving the external build alone.');
    return;
  }

  let version;
  try {
    version = require(path.join(ELECTRON_DIR, 'package.json')).version;
  } catch {
    log('node_modules/electron is not present; nothing to repair.');
    return;
  }

  const state = inspectInstall(version);
  if (state.ok) {
    log(`electron ${version} (${state.archs.join('+')}) is installed correctly; nothing to do.`);
    return;
  }

  log(`repairing electron ${version}: ${state.reason}`);

  const { downloadArtifact } = require('@electron/get');

  // Fetches from the @electron/get cache when it is already there, so the
  // common repair case does not re-download ~80MB.
  const zipPath = await downloadArtifact({
    version,
    artifactName: 'electron',
    force: process.env.force_no_cache === 'true',
    cacheRoot: process.env.electron_config_cache,
    platform: 'darwin',
    arch: REQUIRED_ARCH
  });

  log(`extracting ${path.basename(zipPath)} with ditto`);

  // Remove any half-extracted (or wrong-arch) tree first so ditto cannot
  // merge new files into stale ones.
  rmrf(DIST_DIR);
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // `ditto -x -k` is the macOS-native zip extractor. Unlike extract-zip it
  // handles the symlinks and permissions inside Electron.app correctly, and
  // it fails loudly instead of stalling.
  execFileSync('/usr/bin/ditto', ['-x', '-k', zipPath, DIST_DIR], { stdio: 'inherit' });

  // electron's installer writes this last; index.js throws without it.
  fs.writeFileSync(PATH_TXT, PLATFORM_PATH);

  const repaired = inspectInstall(version);
  if (!repaired.ok) {
    throw new Error(`repair did not produce a usable install: ${repaired.reason}`);
  }

  log(`electron ${version} (${repaired.archs.join('+')}) repaired successfully.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[repair-electron-install] failed: ${err && err.message ? err.message : err}`);
    console.error('Run `rm -rf node_modules/electron && npm install` to retry.');
    process.exit(1);
  });
}

module.exports = { machoArchs, inspectInstall };
