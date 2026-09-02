const {
  app, BrowserWindow, Menu, globalShortcut, ipcMain, dialog, shell, screen
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const nativeLockdown = require('./native-lockdown');
const fileProtocol = require('./file-protocol');

// Must happen before the app is ready.
fileProtocol.registerScheme();

// The only file types DeepWork will open. Everything else is rejected here,
// in the main process, so a window can never talk it into opening something else.
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.mp4']);

// Escape hatch for development. With the lock engaged macOS disables Force
// Quit, so `npm run dev` runs everything except the lock itself.
const UNLOCKED = process.env.DEEPWORK_UNLOCKED === '1';

// How often to check that macOS is still applying our options.
const WATCHDOG_MS = 1000;

// Everything reachable from JavaScript that would reveal the desktop or another
// app. macOS reserves some of these; whichever it refuses get logged at session
// start rather than failing silently.
const BLOCKED_SHORTCUTS = [
  'Command+H', 'Command+Alt+H',        // hide app, hide others
  'Command+M', 'Command+Alt+M',        // minimise
  'Command+W', 'Command+Shift+W',      // close window
  'Command+`', 'Command+Shift+`',      // cycle windows
  'Command+Alt+I', 'Command+Alt+J',    // devtools
  'Command+Alt+C',
  'Command+Alt+Escape',                // force quit
  'Control+Up', 'Control+Down',        // mission control, app windows
  'Control+Left', 'Control+Right',     // switch spaces
  'F3', 'F11'                          // mission control, show desktop
];

let setupWindow = null;
let lockdownWindow = null;
let coverWindows = []; // blank panels over any non-primary display
let watchdog = null;

// Authoritative session state. Windows render it; they never own it.
let session = null; // { files, startedAt }

// Flipped only by a completed hold on the exit button. Everything that could
// close the app checks this first, so there is exactly one way out.
let allowQuit = false;

// Dropping out of a session because of a stray exception is worse than limping
// on, and a crash that prints nothing is impossible to chase down.
process.on('uncaughtException', (error) => {
  console.error('[DeepWork] uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[DeepWork] unhandled rejection:', reason);
});

/* ---------------------------------------------------------------------------
   Windows
   ------------------------------------------------------------------------ */

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 460,
    height: 500,
    minWidth: 420,
    minHeight: 420,
    show: false,
    // Matches --ink in styles.css. Without this the window paints the default
    // white for a frame before the stylesheet lands, which reads as a flash.
    backgroundColor: '#100F0D',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  setupWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  setupWindow.once('ready-to-show', () => setupWindow.show());
  setupWindow.on('closed', () => { setupWindow = null; });

  guardNavigation(setupWindow);
}

function createLockdownWindow() {
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;

  lockdownWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    closable: false,
    minimizable: false,
    // Native fullscreen is deliberately off. A fullscreen Space is managed by
    // AppKit, which takes the presentation options back and lets Cmd+Tab
    // through. Simple fullscreen fills the screen without creating a Space.
    fullscreenable: false,
    show: false,
    backgroundColor: '#100F0D',
    webPreferences: {
      preload: path.join(__dirname, 'preload-lockdown.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Off during a real session so there's no console to call exit from;
      // on under `npm run dev` so the viewer can actually be debugged.
      devTools: UNLOCKED
    }
  });

  // Served over lockdown:// rather than loadFile. Chromium won't start a Web
  // Worker on a file:// page, and pdf.js needs one.
  lockdownWindow.loadURL('lockdown://app/lockdown.html');

  lockdownWindow.once('ready-to-show', () => {
    lockdownWindow.show();
    lockdownWindow.focus();

    if (UNLOCKED) {
      console.log('[DeepWork] DEEPWORK_UNLOCKED=1 — lock and shortcut blocking skipped');
      lockdownWindow.setSimpleFullScreen(true); // still looks right while testing
      return;
    }

    engageLockdown();
  });

  // Recovery, not prevention. With the options engaged this shouldn't fire.
  lockdownWindow.on('blur', () => {
    if (UNLOCKED || allowQuit) return;

    setTimeout(() => {
      if (allowQuit || !lockdownWindow || lockdownWindow.isDestroyed()) return;

      if (nativeLockdown.available && !nativeLockdown.isEngaged()) {
        nativeLockdown.engage();
      }
      app.focus({ steal: true });
      lockdownWindow.focus();
    }, 60);
  });

  // Nothing closes this window except a confirmed exit.
  lockdownWindow.on('close', (event) => {
    if (!allowQuit) event.preventDefault();
  });

  lockdownWindow.on('closed', () => { lockdownWindow = null; });

  guardNavigation(lockdownWindow);
}

// The lock claims one display. Any others would still show the dock and
// whatever was already open there, so they get a blank panel.
function createCoverWindows() {
  const primaryId = screen.getPrimaryDisplay().id;

  for (const display of screen.getAllDisplays()) {
    if (display.id === primaryId) continue;

    const { x, y, width, height } = display.bounds;
    const cover = new BrowserWindow({
      x,
      y,
      width,
      height,
      frame: false,
      closable: false,
      minimizable: false,
      focusable: false, // never steals focus from the real window
      show: false,
      backgroundColor: '#100F0D',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false
      }
    });

    cover.loadFile(path.join(__dirname, '..', 'renderer', 'cover.html'));
    cover.once('ready-to-show', () => {
      cover.showInactive();
      cover.setAlwaysOnTop(true, 'screen-saver');
      cover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    });

    cover.on('close', (event) => {
      if (!allowQuit) event.preventDefault();
    });

    coverWindows.push(cover);
  }

  if (coverWindows.length > 0) {
    console.log(`[DeepWork] covering ${coverWindows.length} extra display(s)`);
  }
}

// No window in this app should ever open a second window, and the only
// navigation allowed is the lockdown window's own asset origin.
function guardNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!lockdownWindow) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('lockdown://app/')) return;
    event.preventDefault();
  });
}

/* ---------------------------------------------------------------------------
   Lockdown
   ------------------------------------------------------------------------ */

// Strips the menu down to Quit alone. Hide, Minimise and Close lose their
// keyboard shortcuts along with their menu items. Quit stays because
// 'before-quit' is what turns Cmd+Q into the exit question.
function applyLockdownMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'DeepWork', submenu: [{ role: 'quit' }] }
  ]));
}

function blockShortcuts() {
  const refused = [];

  for (const combo of BLOCKED_SHORTCUTS) {
    let claimed = false;
    try {
      claimed = globalShortcut.register(combo, () => {}); // registered and ignored
    } catch {
      claimed = false;
    }
    if (!claimed) refused.push(combo);
  }

  if (refused.length > 0) {
    console.log(`[DeepWork] macOS would not release: ${refused.join(', ')}`);
  }
}

function engageLockdown() {
  // Pre-Lion style fullscreen: fills the screen and drops the titlebar without
  // creating a Space, so AppKit never takes presentation management over.
  // Electron sets AutoHideDock|AutoHideMenuBar as part of this, which the
  // addon then replaces with the full Hide + Disable set.
  lockdownWindow.setSimpleFullScreen(true);
  lockdownWindow.setAlwaysOnTop(true, 'screen-saver');
  lockdownWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (!nativeLockdown.available) {
    console.log('[DeepWork] no native addon — simple fullscreen only; the dock will auto-hide but Cmd+Tab works');
    return;
  }

  const engaged = nativeLockdown.engage();
  console.log(`[DeepWork] engage() returned ${engaged}`);
  console.log(`[DeepWork] macOS is applying: ${nativeLockdown.describeOptions()}`);

  startWatchdog();
}

// Anything that quietly hands presentation back to macOS gets undone within a
// second. Cheap, and it means one missed edge case isn't a way out.
function startWatchdog() {
  stopWatchdog();
  if (!nativeLockdown.available) return;

  watchdog = setInterval(() => {
    if (allowQuit || !lockdownWindow || lockdownWindow.isDestroyed()) return;
    if (nativeLockdown.isEngaged()) return;

    console.log('[DeepWork] options were taken back — re-engaging');
    nativeLockdown.engage();
  }, WATCHDOG_MS);
}

function stopWatchdog() {
  if (watchdog !== null) clearInterval(watchdog);
  watchdog = null;
}

function releaseLockdown() {
  stopWatchdog();
  globalShortcut.unregisterAll();
  fileProtocol.clearAllowlist();

  if (nativeLockdown.available) nativeLockdown.release();

  if (lockdownWindow && !lockdownWindow.isDestroyed() && lockdownWindow.isSimpleFullScreen()) {
    lockdownWindow.setSimpleFullScreen(false);
  }
}

function destroyLockdownWindows() {
  for (const cover of coverWindows) {
    if (!cover.isDestroyed()) cover.destroy();
  }
  coverWindows = [];

  if (lockdownWindow && !lockdownWindow.isDestroyed()) lockdownWindow.destroy();
  lockdownWindow = null;
}

/* ---------------------------------------------------------------------------
   Files
   ------------------------------------------------------------------------ */

/**
 * Turn a path into a file record, or null if it isn't something we'll open.
 */
function describeFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;

  const extension = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) return null;

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return null; // gone, unreadable, or a broken symlink
  }
  if (!stats.isFile()) return null;

  return {
    path: filePath,
    name: path.basename(filePath),
    kind: extension === '.pdf' ? 'PDF' : 'Video',
    bytes: stats.size
  };
}

function describeAll(paths) {
  const seen = new Set();
  const accepted = [];
  let rejected = 0;

  for (const candidate of paths) {
    const file = describeFile(candidate);
    if (!file) { rejected += 1; continue; }
    if (seen.has(file.path)) continue; // silently drop exact duplicates
    seen.add(file.path);
    accepted.push(file);
  }

  return { accepted, rejected };
}

/* ---------------------------------------------------------------------------
   App lifecycle
   ------------------------------------------------------------------------ */

app.whenReady().then(() => {
  fileProtocol.registerHandler();
  createSetupWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createSetupWindow();
  });
});

// Cmd+Q lands here. During a session it is turned into a question for the
// lockdown window rather than an exit.
app.on('before-quit', (event) => {
  if (allowQuit) return;
  if (!lockdownWindow || lockdownWindow.isDestroyed()) return;

  event.preventDefault();
  lockdownWindow.focus();
  lockdownWindow.webContents.send('lockdown:confirm-exit');
});

// Second layer. Anything that reaches quit without going through the hold
// stops here too.
app.on('will-quit', (event) => {
  if (!allowQuit && lockdownWindow && !lockdownWindow.isDestroyed()) {
    event.preventDefault();
    return;
  }

  stopWatchdog();
  globalShortcut.unregisterAll();
  if (nativeLockdown.available) nativeLockdown.release();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------------------------------------------------------------------
   IPC — setup window
   ------------------------------------------------------------------------ */

ipcMain.handle('files:choose', async () => {
  const result = await dialog.showOpenDialog(setupWindow, {
    title: 'Choose files for this session',
    buttonLabel: 'Add',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'PDFs and videos', extensions: ['pdf', 'mp4'] }
    ]
  });

  if (result.canceled) return { accepted: [], rejected: 0 };
  return describeAll(result.filePaths);
});

ipcMain.handle('files:validate', async (_event, paths) => {
  if (!Array.isArray(paths)) return { accepted: [], rejected: 0 };
  return describeAll(paths);
});

// Begin a session. Everything is re-checked here; the window's word isn't taken for it.
ipcMain.handle('session:start', async (_event, request) => {
  if (lockdownWindow) return { ok: false, error: 'A session is already running.' };

  const paths = Array.isArray(request?.files) ? request.files : [];

  const { accepted } = describeAll(paths);
  if (accepted.length === 0) {
    return { ok: false, error: 'None of those files could be opened. Add at least one PDF or MP4.' };
  }

  // Ids are what the lockdown window sees. Paths stay in the main process.
  const files = accepted.map((file, index) => ({ ...file, id: `f${index}` }));

  session = {
    files,
    startedAt: Date.now()
  };

  fileProtocol.setAllowlist(files);

  applyLockdownMenu();
  if (!UNLOCKED) blockShortcuts();
  createLockdownWindow();
  createCoverWindows();

  // Deferred on purpose. This handler's reply is delivered to the setup window,
  // so tearing it down before returning leaves Electron sending a reply to a
  // window that no longer exists — which throws, and takes the app with it.
  setImmediate(() => {
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.destroy();
    setupWindow = null;
  });

  console.log(`[DeepWork] locked — ${accepted.length} file(s)`);
  return { ok: true };
});

/* ---------------------------------------------------------------------------
   IPC — lockdown window
   ------------------------------------------------------------------------ */

// Deliberately without paths. The window works in ids; only the protocol
// handler can turn one back into somewhere on disk.
ipcMain.handle('lockdown:session', () => {
  if (!session) return null;

  return {
    files: session.files.map(({ id, name, kind, bytes }) => ({ id, name, kind, bytes }))
  };
});

// The single exit, reached only after a completed 30 second hold. The window
// runs the timer; this just trusts it, because the window is our own code and
// has no console to be driven from.
ipcMain.handle('lockdown:exit', () => {
  allowQuit = true;
  releaseLockdown();

  console.log('[DeepWork] exited by completed hold');

  // Same reasoning as above: let this handler reply before the window goes.
  setImmediate(() => {
    destroyLockdownWindows();
    app.quit();
  });
});
