# Flash Player

A cross-platform Electron-based Flash player using Clean Flash Player.

## Quick Start

```bash
npm install
npm run download:plugins
npm start
```

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

Windows:

```batch
set GAME_URL=https://your-server.com/game && npm start
```

macOS / Linux:

```bash
GAME_URL=https://your-server.com/game npm start
```

## Requirements

- Node.js 20+

## License

MIT
