# Flash Player

A cross-platform Electron-based Flash player using Clean Flash Player.

## Quick Start

```bash
npm install
npm run download:plugins
npm start
```

**On macOS, run `npm run start:mac` instead of `npm start`**, and make sure
Rosetta 2 is installed first. See [macOS setup](#macos-setup) for why.

## macOS setup

macOS needs two extra things: Rosetta 2, and an x64 build of Electron.

### Why

Pepper Flash was never built for arm64 — the macOS plug-in
(`plugins/flash.plugin`) is x64-only, and there is no arm64 version to switch
to. A single process cannot mix architectures, so an arm64 Electron cannot
load the x64 PPAPI plug-in at all. The whole Electron process therefore has to
run as x64, under Rosetta 2 on Apple Silicon. That is what `npm run start:mac`
does:

```json
"start:mac": "arch -x86_64 electron ."
```

This applies to Intel Macs too — they simply get x64 natively and do not need
Rosetta.

### Rosetta 2 (Apple Silicon only)

`arch -x86_64` and the packaged release both fail on an Apple Silicon Mac that
has never installed Rosetta 2. Check whether it is present:

```bash
/usr/bin/pgrep -q oahd && echo "Rosetta 2 installed" || echo "Rosetta 2 missing"
```

Install it if missing:

```bash
softwareupdate --install-rosetta --agree-to-license
```

### x64 Electron

`npm install` normally installs the Electron build matching the host
architecture, which on an Apple Silicon Mac is arm64 — and `npm run start:mac`
then fails with `Bad CPU type in executable`.

`scripts/repair-electron-install.js` runs as a `postinstall` step and handles
this: on macOS it pins Electron to x64 regardless of the host chip, so
`npm install` is all you need — no `--arch=x64` flag to remember. It is a
no-op on every other platform, and a no-op on macOS when a correct x64
Electron is already in place.

The same script also repairs a broken Electron download. `electron@11.5.0`
unzips its runtime with `extract-zip@1.7.0`, whose read-stream error handler
only calls `console.log` and never completes the entry. A read error part-way
through extraction therefore stalls silently: the installer never writes
`path.txt`, the process still exits `0`, and the next `npm start` fails with

```
Error: Electron failed to install correctly, please delete node_modules/electron and try installing again
```

When the script sees that state it re-fetches the runtime through
`@electron/get` and extracts it with macOS's `ditto`, which handles the
symlinks and permissions inside `Electron.app` correctly and fails loudly
instead of stalling.

Electron is pinned to 11.5.0 on purpose and cannot be upgraded: Chromium
removed PPAPI/Flash support in Electron 12.

## Plugins

The PPAPI Flash plugins are third-party binaries and are intentionally not
tracked in Git. `npm run download:plugins` downloads pinned upstream archives
and verifies their SHA-256 checksums before installing the platform-specific
plugin under `plugins/`.

The source versions are pinned in `scripts/download-plugins.js`:

- Windows: Clean Flash 34.0.0.376
- macOS: Clean Flash 34.0.0.372
- Linux: Clean Flash 34.0.0.137

To package for a specific platform, the plugin download is performed first:

```bash
npm run build:win
npm run build:mac
npm run build:linux
```

The GitHub Actions workflow stamps each build with `1.0.<run number>` before
packaging. This keeps the app version and every release asset filename aligned
with the published release tag (for example, `v1.0.5` produces a Windows
asset named `Flash Player 1.0.5.exe`). Local builds use the version in
`package.json`.

The macOS build produces a ZIP containing `Flash Player.app`. This avoids the
legacy DMG toolchain required by the pinned Electron version.

### macOS Flash runtime patch

The macOS PPAPI plug-in is not committed to this repository. The upstream
`34.0.0.372` archive contains a `PepperFlashPlayer` executable whose five
runtime-gate patches are still in their original, unpatched state. That gate
shows the in-player **“Please update to the latest version to continue”**
screen, independently of the FarmVille page or SWF files.

`scripts/download-plugins.js` applies the five version-specific macOS PPAPI
patches published by [FlashPatch](https://github.com/darktohka/FlashPatch) as
part of `npm run build:mac`. Each patch is guarded: the downloader first
requires the exact expected original bytes at its fixed offset, writes the
documented replacement bytes, and then verifies the SHA-256 of the resulting
`PepperFlashPlayer` executable. A changed or unexpected upstream binary fails
the build instead of being silently patched.

This was diagnosed by comparing the bundled executable with FlashPatch's
`34.0.0.372` Mac PPAPI patch definition. All five offsets initially matched
the original byte patterns (for example, offset `0x56C3F9` was `74 4C` rather
than FlashPatch's `90 90`), proving that the update screen came from the
runtime binary rather than the server template or the game SWF.

## Configure Game URL

The packaged launcher defaults to `https://fv.ktrestoration.xyz/login`.
This is a public URL, so it is intentionally stored in source rather than a
GitHub Secret. You can still override it locally with `GAME_URL`.

### Discord sign-in

Discord sign-in is opened in the user's default browser because the legacy
Electron/Chromium runtime is not able to reliably render the current Discord
web application. When the sign-in link is selected, the launcher starts a
loopback listener on `127.0.0.1`, opens the server's launcher OAuth endpoint,
and receives a short-lived, one-time FarmVille handoff token after Discord
authentication. The token is consumed immediately by the embedded game
session and is never a Discord access token.

If the Windows default browser cannot open Discord correctly, use **File →
Choose Browser for Discord Sign-In...** in the launcher. The chooser first
lists common browsers it detects (including Firefox and Opera GX), and also
offers **Browse...** for another executable. The selection is stored for future
sign-ins. **Use Default Browser for Discord Sign-In** removes the override. The
launcher always passes the same HTTPS OAuth URL and keeps the localhost callback
flow.

Windows:

```batch
set GAME_URL=https://your-server.com/game && npm start
```

macOS:

```bash
GAME_URL=https://your-server.com/game npm run start:mac
```

Linux:

```bash
GAME_URL=https://your-server.com/game npm start
```

## Requirements

- Node.js 20+
- macOS: Rosetta 2 on Apple Silicon (see [macOS setup](#macos-setup))

## License

MIT
