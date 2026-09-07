'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { machoArchs } = require('./repair-electron-install');

function withBinary(contents, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-launcher-macho-'));
  const binaryPath = path.join(directory, 'Electron');
  fs.writeFileSync(binaryPath, contents);
  try {
    callback(binaryPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('machoArchs identifies a thin x64 Mach-O binary', () => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(0xcffaedfe, 0);
  header.writeUInt32LE(0x01000007, 4);

  withBinary(header, (binaryPath) => {
    assert.deepEqual(machoArchs(binaryPath), ['x64']);
  });
});

test('machoArchs identifies each architecture in a fat Mach-O binary', () => {
  const header = Buffer.alloc(8 + (2 * 20));
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(0x01000007, 8);
  header.writeUInt32BE(0x0100000c, 28);

  withBinary(header, (binaryPath) => {
    assert.deepEqual(machoArchs(binaryPath), ['x64', 'arm64']);
  });
});

test('machoArchs rejects an unreadable binary', () => {
  withBinary(Buffer.from('not a Mach-O binary'), (binaryPath) => {
    assert.deepEqual(machoArchs(binaryPath), []);
  });
});
