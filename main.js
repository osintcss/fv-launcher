const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DEFAULT_GAME_URL = 'https://fv.ktrestoration.xyz/login';
const DISCORD_BROWSER_SETTING = 'discordBrowserPath';
const LAUNCHER_SETTINGS_FILE = 'launcher-settings.json';

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

function getLauncherSettingsPath() {
  return path.join(app.getPath('userData'), LAUNCHER_SETTINGS_FILE);
}

function readLauncherSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(getLauncherSettingsPath(), 'utf8'));
    return settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings
      : {};
  } catch {
    return {};
  }
}

function writeLauncherSettings(settings) {
  const settingsDirectory = app.getPath('userData');
  fs.mkdirSync(settingsDirectory, { recursive: true });
  fs.writeFileSync(
    getLauncherSettingsPath(),
    `${JSON.stringify(settings, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
}

function getConfiguredDiscordBrowserPath() {
  const browserPath = readLauncherSettings()[DISCORD_BROWSER_SETTING];
  return typeof browserPath === 'string' && browserPath.trim() !== ''
    ? browserPath
    : null;
}

function setConfiguredDiscordBrowserPath(browserPath) {
  const settings = readLauncherSettings();
  if (browserPath) {
    settings[DISCORD_BROWSER_SETTING] = browserPath;
  } else {
    delete settings[DISCORD_BROWSER_SETTING];
  }
  writeLauncherSettings(settings);
}

function isBrowserExecutable(browserPath) {
  if (typeof browserPath !== 'string' || !path.isAbsolute(browserPath)) {
    return false;
  }

  try {
    const file = fs.statSync(browserPath);
    if (process.platform === 'darwin' && browserPath.toLowerCase().endsWith('.app')) {
      return file.isDirectory();
    }

    if (!file.isFile()) {
      return false;
    }

    if (process.platform === 'win32') {
      return path.extname(browserPath).toLowerCase() === '.exe';
    }

    return (file.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function getCommonWindowsBrowserPaths() {
  if (process.platform !== 'win32') {
    return [];
  }

  const roots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
  ].filter((root) => typeof root === 'string' && root !== '');

  const candidates = [
    {
      name: 'Mozilla Firefox',
      relativePaths: [
        'Mozilla Firefox\\firefox.exe',
        'Programs\\Mozilla Firefox\\firefox.exe',
      ],
    },
    {
      name: 'Opera GX',
      relativePaths: [
        'Programs\\Opera GX\\launcher.exe',
        'Opera GX\\launcher.exe',
      ],
    },
    {
      name: 'Google Chrome',
      relativePaths: [
        'Google\\Chrome\\Application\\chrome.exe',
        'Programs\\Google\\Chrome\\Application\\chrome.exe',
      ],
    },
    {
      name: 'Microsoft Edge',
      relativePaths: ['Microsoft\\Edge\\Application\\msedge.exe'],
    },
    {
      name: 'Brave',
      relativePaths: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    },
    {
      name: 'Vivaldi',
      relativePaths: ['Vivaldi\\Application\\vivaldi.exe'],
    },
    {
      name: 'Opera',
      relativePaths: [
        'Opera\\launcher.exe',
        'Programs\\Opera\\launcher.exe',
      ],
    },
  ];
  const found = [];
  const seen = new Set();

  for (const candidate of candidates) {
    for (const root of roots) {
      for (const relativePath of candidate.relativePaths) {
        const browserPath = path.join(root, relativePath);
        const normalizedPath = browserPath.toLowerCase();
        if (seen.has(normalizedPath) || !isBrowserExecutable(browserPath)) {
          continue;
        }

        seen.add(normalizedPath);
        found.push({ name: candidate.name, path: browserPath });
      }
    }
  }

  return found;
}

async function browseForDiscordBrowser() {
  const filters = process.platform === 'win32'
    ? [{ name: 'Browser executable', extensions: ['exe'] }]
    : undefined;
  let result;
  try {
    result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose browser for Discord sign-in',
      properties: ['openFile'],
      filters,
    });
  } catch {
    dialog.showErrorBox(
      'Browser Selection Failed',
      'The launcher could not open the browser selection dialog.'
    );
    return null;
  }

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const browserPath = result.filePaths[0];
  if (!isBrowserExecutable(browserPath)) {
    dialog.showErrorBox(
      'Invalid Browser Executable',
      process.platform === 'win32'
        ? 'Choose a Windows browser .exe file.'
        : 'Choose an executable browser application.'
    );
    return null;
  }

  return browserPath;
}

function saveDiscordBrowser(browserPath) {
  try {
    setConfiguredDiscordBrowserPath(browserPath);
  } catch {
    dialog.showErrorBox(
      'Browser Preference Not Saved',
      'The launcher could not save the selected browser preference.'
    );
    return false;
  }

  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Discord Browser Saved',
    message: 'Discord sign-in will use the selected browser.',
    detail: browserPath,
  });
  return true;
}

async function chooseDiscordBrowser() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const commonBrowsers = getCommonWindowsBrowserPaths();
  let browserPath = null;

  if (commonBrowsers.length > 0) {
    let result;
    try {
      result = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Choose browser for Discord sign-in',
        message: 'Select a detected browser or browse for another executable.',
        detail: commonBrowsers
          .map((browser, index) => `${index + 1}. ${browser.name}\n${browser.path}`)
          .join('\n\n'),
        buttons: [
          ...commonBrowsers.map((browser) => `Use ${browser.name}`),
          'Browse...',
          'Cancel',
        ],
        defaultId: 0,
        cancelId: commonBrowsers.length + 1,
        noLink: true,
      });
    } catch {
      dialog.showErrorBox(
        'Browser Selection Failed',
        'The launcher could not open the browser selection dialog.'
      );
      return;
    }

    if (result.response < commonBrowsers.length) {
      browserPath = commonBrowsers[result.response].path;
    } else if (result.response === commonBrowsers.length) {
      browserPath = await browseForDiscordBrowser();
    } else {
      return;
    }
  } else {
    browserPath = await browseForDiscordBrowser();
  }

  if (browserPath) {
    saveDiscordBrowser(browserPath);
  }
}

function useDefaultDiscordBrowser() {
  try {
    setConfiguredDiscordBrowserPath(null);
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Default Browser Restored',
      message: 'Discord sign-in will use the Windows default browser.',
    });
  } catch {
    dialog.showErrorBox(
      'Browser Preference Not Saved',
      'The launcher could not clear the selected browser preference.'
    );
  }
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;

    try {
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('spawn', () => {
      if (!settled) {
        settled = true;
        child.unref();
        resolve();
      }
    });
  });
}

function openDiscordBrowser(url) {
  const browserPath = getConfiguredDiscordBrowserPath();
  if (browserPath && isBrowserExecutable(browserPath)) {
    if (process.platform === 'darwin' && browserPath.toLowerCase().endsWith('.app')) {
      return spawnDetached('open', ['-a', browserPath, url]);
    }

    return spawnDetached(browserPath, [url]);
  }

  if (browserPath) {
    // A browser can be uninstalled or moved after it was selected. Fall back
    // to the OS association and remove the stale preference.
    try {
      setConfiguredDiscordBrowserPath(null);
    } catch {
      // The default-browser fallback is still safe if the preference cannot
      // be removed.
    }
  }

  return shell.openExternal(url);
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

    const configuredBrowserPath = getConfiguredDiscordBrowserPath();
    Promise.resolve(openDiscordBrowser(authUrl.toString())).catch(() => {
      finish({
        error: configuredBrowserPath
          ? 'The launcher could not open the selected browser.'
          : 'The launcher could not open your default browser.',
      });
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
        {
          label: 'Choose Browser for Discord Sign-In...',
          click: () => {
            chooseDiscordBrowser();
          }
        },
        {
          label: 'Use Default Browser for Discord Sign-In',
          click: () => {
            useDefaultDiscordBrowser();
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

  // Electron 11 predates setWindowOpenHandler(); 'new-window' is the
  // equivalent hook on this runtime. The pinned Electron version cannot be
  // raised because Chromium dropped PPAPI/Flash support in Electron 12.
  mainWindow.webContents.on('new-window', (event, url) => {
    event.preventDefault();
    if (isAllowedGameUrl(url)) shell.openExternal(url);
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
