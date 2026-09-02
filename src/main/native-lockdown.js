/* ---------------------------------------------------------------------------
   Loader for the macOS presentation-options addon.

   The addon is optional. If it hasn't been built, the app still runs — it just
   falls back to simple fullscreen alone, which leaves Cmd+Tab working. Failing
   loudly here beats failing silently at the moment someone starts a session.
   ------------------------------------------------------------------------ */

const path = require('node:path');

// Bit positions from AppKit's NSApplicationPresentationOptions.
const OPTION_NAMES = [
  [1 << 0,  'AutoHideDock'],
  [1 << 1,  'HideDock'],
  [1 << 2,  'AutoHideMenuBar'],
  [1 << 3,  'HideMenuBar'],
  [1 << 4,  'DisableAppleMenu'],
  [1 << 5,  'DisableProcessSwitching'],
  [1 << 6,  'DisableForceQuit'],
  [1 << 7,  'DisableSessionTermination'],
  [1 << 8,  'DisableHideApplication'],
  [1 << 9,  'DisableMenuBarTransparency'],
  [1 << 10, 'FullScreen'],
  [1 << 11, 'AutoHideToolbar'],
  [1 << 12, 'DisableCursorLocationAssistance']
];

let native = null;
let loadError = null;

if (process.platform === 'darwin') {
  const candidates = [
    path.join(__dirname, '..', '..', 'build', 'Release', 'lockdown.node'),
    path.join(__dirname, '..', '..', 'build', 'Debug', 'lockdown.node')
  ];

  for (const candidate of candidates) {
    try {
      native = require(candidate);
      break;
    } catch (error) {
      loadError = error;
    }
  }
}

if (native) {
  console.log('[DeepWork] native lockdown loaded');
} else if (process.platform === 'darwin') {
  console.log(`[DeepWork] native lockdown unavailable — ${loadError?.message ?? 'not built'}`);
  console.log('[DeepWork] run `npx node-gyp rebuild` to build it');
}

function describeOptions() {
  if (!native || typeof native.currentOptions !== 'function') return 'unknown';

  const mask = native.currentOptions();
  if (mask === 0) return 'Default (nothing hidden or disabled)';

  const names = OPTION_NAMES
    .filter(([bit]) => (mask & bit) !== 0)
    .map(([, name]) => name);

  return names.length > 0 ? names.join(' | ') : `unrecognised mask ${mask}`;
}

module.exports = {
  available: native !== null,
  engage: () => (native ? native.engage() : false),
  release: () => (native ? native.release() : false),
  isEngaged: () => (native ? native.isEngaged() : false),
  describeOptions
};
