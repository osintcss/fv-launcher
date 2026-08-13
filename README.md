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

## Configure Game URL

By default, the app connects to `https://example.com/flash-game`.

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
