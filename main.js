const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DEFAULT_GAME_URL = 'https://fv.ktrestoration.xyz/login';

function parseGameUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('GAME_URL must be a valid URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('GAME_URL must use HTTPS');
  }

  parsed.hash = '';
  return parsed;
}

const initialGameUrl = parseGameUrl(process.env.GAME_URL || DEFAULT_GAME_URL);

const CONFIG = {
  // GAME_URL is an optional local override. The packaged launcher defaults to
  // the public FarmVille Restoration server below.
  gameUrl: initialGameUrl.toString(),
  allowedOrigin: initialGameUrl.origin,
  fullscreen: false,
  width: 1280,
  height: 800,
  resizable: true
};

function getFlashPluginPath() {
  const pluginsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'plugins')
    : path.join(__dirname, 'plugins');

  switch (process.platform) {
    case 'win32':
      const win64 = path.join(pluginsDir, 'pepflashplayer64.dll');
      const win32 = path.join(pluginsDir, 'pepflashplayer.dll');
      return (process.arch === 'x64') ? win64 : win32;

    case 'darwin':
      return path.join(pluginsDir, 'flash.plugin'); // x64 only

    case 'linux':
      const lin64 = path.join(pluginsDir, 'libpepflashplayer64.so');
      const lin32 = path.join(pluginsDir, 'libpepflashplayer.so');
      return (process.arch === 'x64') ? lin64 : lin32;

    default:
      return null;
  }
}

function getFlashVersion() {
  const versions = {
    win32: '34.0.0.376',
    darwin: '34.0.0.372',
    linux: '34.0.0.137'
  };
  return versions[process.platform] || '0.0.0.0';
}

function initializeFlash() {
  const flashPath = getFlashPluginPath();

  if (!flashPath) {
    return false;
  }

  if (!fs.existsSync(flashPath)) {
    return false;
  }

  app.commandLine.appendSwitch('ppapi-flash-path', flashPath);
  app.commandLine.appendSwitch('ppapi-flash-version', getFlashVersion());
  app.commandLine.appendSwitch('enable-plugins');
  app.commandLine.appendSwitch('allow-outdated-plugins');
  return true;
}

function isAllowedGameUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.origin === CONFIG.allowedOrigin;
  } catch {
    return false;
  }
}

function isDiscordLoginRequest(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.origin === CONFIG.allowedOrigin
      && parsed.pathname === '/auth/discord';
  } catch {
    return false;
  }
}

function base64Url(value) {
  return value.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function showUrlPrompt(currentUrl) {
  return new Promise((resolve) => {
    let resolved = false;

    const promptWindow = new BrowserWindow({
      width: 500,
      height: 180,
      parent: mainWindow,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false
      }
    });

    promptWindow.setMenu(null);

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; background: #f5f5f5; margin: 0; }
          h3 { margin: 0 0 15px 0; color: #333; }
          input { width: 100%; padding: 10px; font-size: 14px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
          .buttons { margin-top: 15px; text-align: right; }
          button { padding: 8px 20px; margin-left: 10px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
          .ok { background: #007bff; color: white; }
          .ok:hover { background: #0056b3; }
          .cancel { background: #ccc; }
          .cancel:hover { background: #999; }
        </style>
      </head>
      <body>
        <h3>Enter Server URL</h3>
        <input type="text" id="url" value="${escapeHtml(currentUrl)}">
        <div class="buttons">
          <button class="cancel" id="cancelBtn">Cancel</button>
          <button class="ok" id="okBtn">OK</button>
        </div>
        <script>
          const { ipcRenderer } = require('electron');
          const urlInput = document.getElementById('url');

          urlInput.focus();
          urlInput.select();

          document.getElementById('okBtn').onclick = function() {
            ipcRenderer.send('url-prompt-result', urlInput.value.trim());
          };

          document.getElementById('cancelBtn').onclick = function() {
            ipcRenderer.send('url-prompt-result', null);
          };

          urlInput.onkeydown = function(e) {
            if (e.key === 'Enter') {
              ipcRenderer.send('url-prompt-result', urlInput.value.trim());
            } else if (e.key === 'Escape') {
              ipcRenderer.send('url-prompt-result', null);
            }
          };
        </script>
      </body>
      </html>
    `;

    const handler = (event, url) => {
      if (!resolved) {
        resolved = true;
        ipcMain.removeListener('url-prompt-result', handler);
        if (!promptWindow.isDestroyed()) {
          promptWindow.close();
        }
        resolve(url);
      }
    };

    ipcMain.on('url-prompt-result', handler);

    promptWindow.on('closed', () => {
      if (!resolved) {
        resolved = true;
        ipcMain.removeListener('url-prompt-result', handler);
        resolve(null);
      }
    });

    promptWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    promptWindow.once('ready-to-show', () => {
      promptWindow.show();
    });
  });
}

let mainWindow;
let flashAvailable = false;
let launcherLoginInProgress = false;

function beginLauncherDiscordLogin(loginUrl) {
  if (launcherLoginInProgress) return;
  launcherLoginInProgress = true;

  const state = base64Url(crypto.randomBytes(32));
  const intent = new URL(loginUrl).searchParams.get('intent') === 'register' ? 'register' : 'login';
  let callbackServer;
  let timeout;

  const finish = (result) => {
    if (timeout) clearTimeout(timeout);
    launcherLoginInProgress = false;
    if (callbackServer && callbackServer.listening) callbackServer.close();

    if (result.error) {
      dialog.showErrorBox('Discord Sign-In Failed', result.error);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(CONFIG.gameUrl);
      return;
    }

    if (!result.token) {
      dialog.showErrorBox('Discord Sign-In Failed', 'The launcher did not receive a sign-in token.');
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(CONFIG.gameUrl);
      return;
    }

    const consumeUrl = new URL('/auth/discord/launcher/consume', `${CONFIG.allowedOrigin}/`);
    consumeUrl.searchParams.set('token', result.token);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(consumeUrl.toString());
  };

  callbackServer = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || requestUrl.pathname !== '/callback') {
      response.writeHead(404);
      response.end();
      return;
    }

    const returnedState = requestUrl.searchParams.get('state') || '';
    if (returnedState !== state) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid sign-in state. You can close this window.');
      finish({ error: 'The Discord sign-in could not be verified. Please try again.' });
      return;
    }

    const error = requestUrl.searchParams.get('error');
    const token = requestUrl.searchParams.get('token');
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8'
    });
    response.end('<!doctype html><title>FV Launcher</title><p>Sign-in complete. You can return to the launcher.</p>');
    finish({ error, token });
  });

  callbackServer.once('error', () => {
    finish({ error: 'The launcher could not start its local sign-in callback.' });
  });

  callbackServer.listen(0, '127.0.0.1', () => {
    const address = callbackServer.address();
    if (!address || typeof address === 'string') {
      finish({ error: 'The launcher could not determine its local sign-in port.' });
      return;
    }

    const authUrl = new URL('/auth/discord/launcher', `${CONFIG.allowedOrigin}/`);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('callback', `http://127.0.0.1:${address.port}/callback`);
    authUrl.searchParams.set('intent', intent);

    Promise.resolve(shell.openExternal(authUrl.toString())).catch(() => {
      finish({ error: 'The launcher could not open your default browser.' });
    });
  });

  timeout = setTimeout(() => {
    finish({ error: 'Discord sign-in timed out. Please try again.' });
  }, 5 * 60 * 1000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: CONFIG.width,
    height: CONFIG.height,
    resizable: CONFIG.resizable,
    fullscreen: CONFIG.fullscreen,
    webPreferences: {
      plugins: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'Flash Player',
    center: true,
    autoHideMenuBar: true
  });

  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Change Server URL',
          accelerator: 'CmdOrCtrl+L',
          click: async () => {
            const newUrl = await showUrlPrompt(CONFIG.gameUrl);
            if (newUrl && newUrl !== CONFIG.gameUrl) {
              let parsedUrl;
              try {
                parsedUrl = parseGameUrl(newUrl);
              } catch (error) {
                dialog.showErrorBox('Invalid Server URL', error.message);
                return;
              }
              CONFIG.gameUrl = parsedUrl.toString();
              CONFIG.allowedOrigin = parsedUrl.origin;
              console.log('Loading new URL:', CONFIG.gameUrl);
              mainWindow.loadURL(CONFIG.gameUrl);
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow.reload()
        },
        {
          label: 'Hard Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            mainWindow.webContents.session.clearCache();
            mainWindow.reload();
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => {
            const zoom = mainWindow.webContents.getZoomFactor();
            mainWindow.webContents.setZoomFactor(zoom + 0.1);
          }
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            const zoom = mainWindow.webContents.getZoomFactor();
            mainWindow.webContents.setZoomFactor(Math.max(0.1, zoom - 0.1));
          }
        },
        {
          label: 'Reset Zoom',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            mainWindow.webContents.setZoomFactor(1);
          }
        },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Flash Player',
              message: 'Flash Player',
              detail: `Electron: ${process.versions.electron}\nChrome: ${process.versions.chrome}\nFlash: ${flashAvailable ? getFlashVersion() : 'Not installed'}`
            });
          }
        }
      ]
    }
  ];

  if (process.platform === 'darwin') {
    menuTemplate.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  if (flashAvailable) {
    mainWindow.loadURL(CONFIG.gameUrl);
  } else {
    mainWindow.loadFile('index.html');
  }

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (isDiscordLoginRequest(navigationUrl)) {
      event.preventDefault();
      beginLauncherDiscordLogin(navigationUrl);
      return;
    }
    if (!isAllowedGameUrl(navigationUrl)) event.preventDefault();
  });

  mainWindow.webContents.on('will-redirect', (event, navigationUrl) => {
    if (!isAllowedGameUrl(navigationUrl)) event.preventDefault();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedGameUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

}

flashAvailable = initializeFlash();

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('web-contents-created', (event, contents) => {
  contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(false);
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
});
