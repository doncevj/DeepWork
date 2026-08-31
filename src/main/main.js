const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// The only file types DeepWork will open. Everything else is rejected here,
// in the main process, so the window can never talk it into opening something else.
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.mp4']);

// Session bounds, in minutes. The fields top out at 12 hours 59 minutes.
const MIN_MINUTES = 1;
const MAX_MINUTES = 12 * 60 + 59;

let mainWindow = null;

// Authoritative session state. The window renders it; it never owns it.
let session = null; // { files, minutes, startedAt, endsAt }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 560,
    minWidth: 420,
    minHeight: 500,
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

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Nothing in this app should ever open a second window or navigate away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
}

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

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------------------------------------------------------------------
   IPC
   ------------------------------------------------------------------------ */

// Open the macOS file picker.
ipcMain.handle('files:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
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

// Validate paths that arrived by drag and drop.
ipcMain.handle('files:validate', async (_event, paths) => {
  if (!Array.isArray(paths)) return { accepted: [], rejected: 0 };
  return describeAll(paths);
});

// Begin a session. Everything is re-checked here; the window's word isn't taken for it.
ipcMain.handle('session:start', async (_event, request) => {
  const minutes = Number(request?.minutes);
  const paths = Array.isArray(request?.files) ? request.files : [];

  if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    return { ok: false, error: 'Set a length between 1 minute and 12 hours 59 minutes.' };
  }

  const { accepted } = describeAll(paths);
  if (accepted.length === 0) {
    return { ok: false, error: 'None of those files could be opened. Add at least one PDF or MP4.' };
  }

  const startedAt = Date.now();
  session = {
    files: accepted,
    minutes,
    startedAt,
    endsAt: startedAt + minutes * 60_000
  };

  // Next step hooks in here: kiosk mode, always-on-top, close interception,
  // shortcut blocking, and the file viewer.
  console.log(`[DeepWork] would start — ${accepted.length} file(s), ${minutes} min`);

  return { ok: true, endsAt: session.endsAt, files: accepted, minutes };
});
