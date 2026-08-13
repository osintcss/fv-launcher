/* Downloads the third-party PPAPI plugins needed to package this app. */
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS = path.join(ROOT, 'plugins');

// Pinned upstream release assets. Update an URL and its extracted-file
// checksum together; never replace these with a "latest" URL.
const SOURCES = {
  win32: {
    url: 'https://github.com/darktohka/clean-flash-builds/releases/download/v1.54/ChineseFlash-Patched-Win-34.0.0.376.7z',
    archiveSha256: '19a8d1036110af024dc877ca96a9184835c3e944fb14ca8d509662f00bf1bd31',
    files: [
      { name: 'pepflashplayer.dll', candidates: ['flash32/pepflashplayer32_34_0_0_376.dll'] },
      { name: 'pepflashplayer64.dll', candidates: ['flash64/pepflashplayer64_34_0_0_376.dll'] }
    ]
  },
  linux: {
    files: [
      { name: 'libpepflashplayer.so', url: 'https://github.com/darktohka/clean-flash-builds/releases/download/v1.7/flash_player_patched_ppapi_linux.i386.tar.gz', candidates: ['libpepflashplayer.so'] },
      { name: 'libpepflashplayer64.so', url: 'https://github.com/darktohka/clean-flash-builds/releases/download/v1.7/flash_player_patched_ppapi_linux.x86_64.tar.gz', candidates: ['libpepflashplayer.so'] }
    ]
  },
  darwin: {
    url: 'https://github.com/darktohka/clean-flash-builds/releases/download/v1.53/ChineseFlash-PPAPI-PepperFlashPlayer.zip',
    archiveSha256: '2ce195d5ffded257320bfd31887f78079af85499987d1b9bc8e603202427f58b',
    files: [{ name: 'flash.plugin', candidates: ['flash.plugin'], directory: true }]
  }
};

const EXPECTED_SHA256 = {
  'flash.plugin': '555d8be93c491db65a97ae1de86f921ddb850eeb3213d8cd9bac20245bdc5c3a',
  'libpepflashplayer.so': 'b09c817ad1d7f0193b79903a07424394c344a7345b849f87b3a938955926ab6f',
  'libpepflashplayer64.so': 'e66c93332824bce66cb862a0b7d5b175f9d5d78b296c1524dfa393ee516b0a7d',
  'pepflashplayer.dll': 'a56a9eb638d1708333b8d9acabf73fb9ff998707f7bdfc8de739eae989b5c21c',
  'pepflashplayer64.dll': 'cb91e4589f0a854dd0f23a21d6feee623a857a1dee112b8cb5e5a7c9be0af6f2'
};

function platformFromArgs() {
  const index = process.argv.indexOf('--platform');
  const value = index === -1 ? process.platform : process.argv[index + 1];
  if (!SOURCES[value]) throw new Error(`Unsupported platform: ${value}`);
  return value;
}

function download(url, destination, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error(`Too many redirects for ${url}`));
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'fv-launcher-plugin-downloader' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(download(new URL(response.headers.location, url).toString(), destination, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Download failed (${response.statusCode}): ${url}`));
      }
      const output = fs.createWriteStream(destination);
      response.pipe(output);
      output.on('finish', () => output.close(resolve));
      output.on('error', reject);
    }).on('error', reject);
  });
}

function findPath(directory, candidates, wantDirectory, root = directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (wantDirectory && (candidates.includes(entry.name) || candidates.includes(relativePath))) return fullPath;
      const found = findPath(fullPath, candidates, wantDirectory, root);
      if (found) return found;
    } else if (candidates.includes(entry.name) || candidates.includes(relativePath)) return fullPath;
  }
  return null;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function installFile(source, temporaryDirectory) {
  const archive = path.join(temporaryDirectory, path.basename(new URL(source.url).pathname));
  const unpacked = path.join(temporaryDirectory, `unpacked-${source.name}`);
  await fsp.mkdir(unpacked);
  console.log(`Downloading ${source.name}...`);
  await download(source.url, archive);
  if (source.archiveSha256 && sha256(archive) !== source.archiveSha256) throw new Error(`Checksum mismatch for archive ${source.url}`);
  execFileSync('tar', ['-xf', archive, '-C', unpacked], { stdio: 'inherit' });
  const extracted = findPath(unpacked, source.candidates, source.directory);
  if (!extracted) {
    const contents = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' });
    throw new Error(`Could not find ${source.candidates.join(' or ')} in ${source.url}. Archive contains: ${contents.trim()}`);
  }
  const destination = path.join(PLUGINS, source.name);
  if (source.directory) await fsp.cp(extracted, destination, { recursive: true, force: true });
  else await fsp.copyFile(extracted, destination);
  const actual = sha256(source.directory ? path.join(destination, 'Contents', 'MacOS', 'PepperFlashPlayer') : destination);
  const expected = EXPECTED_SHA256[source.name];
  if (expected && actual !== expected) throw new Error(`Checksum mismatch for ${source.name}: expected ${expected}, got ${actual}`);
  console.log(`Verified ${source.name}`);
}

async function main() {
  const platform = platformFromArgs();
  const source = SOURCES[platform];
  await fsp.mkdir(PLUGINS, { recursive: true });
  const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'fv-launcher-plugins-'));
  try {
    const files = source.url ? source.files.map((file) => ({ ...file, url: source.url })) : source.files;
    for (const file of files) await installFile(file, temporaryDirectory);
  } finally {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(`Plugin installation failed: ${error.message}`); process.exitCode = 1; });
