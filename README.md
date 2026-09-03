# DeepWork

A macOS focus app that locks you in with a chosen set of PDFs and lecture
recordings, and makes leaving deliberately hard.

Pick your files, press Start, and the screen belongs to DeepWork: no dock, no
menu bar, no Cmd+Tab, no Force Quit. Getting out means holding a button for
thirty seconds — or, if you set the optional lockdown timer, waiting it out.

---

## Getting out

Read this before your first session.

| Situation | How you leave |
|---|---|
| No timer set | `⌘Q`, then hold **Exit** for 30 seconds |
| Timer running | You don't. Nothing works until it finishes. |
| Something has gone wrong | Hold the physical power button ~10 seconds |

A session disables macOS Force Quit (`⌘⌥Esc`) along with everything else, so
the power button is the only hard backstop once a timer is armed. Setting an
eight hour timer means eight hours. Try a one minute timer first.

---

## What it does

- Opens **PDFs** and **MP4s** only. Nothing else can be added to a session.
- **PDF viewer** — continuous scroll, fit-to-width zoom, jump to any page.
  Pages render lazily, so a thousand-page textbook opens immediately.
- **Video player** — play/pause, 10s and 60s skips, 0.5×–2× speed, volume.
  Controls fade away while playing, like any video player.
- **Home screen** listing the session's files, with a small clock and the
  optional lockdown timer tucked into the corners.
- **Resume** — leaving a file and coming back returns you to the same page or
  the same timestamp.

Dark throughout, and deliberately sparse. There is nothing to configure and
nothing to browse.

---

## Requirements

- macOS (Apple Silicon or Intel)
- [Node.js](https://nodejs.org) 20 or newer
- Xcode Command Line Tools — `xcode-select --install`

Windows is not supported. See [Roadmap](#roadmap).

---

## Building

```bash
git clone https://github.com/YOUR-USERNAME/deepwork.git
cd deepwork

npm install
npx node-gyp rebuild     # compiles the macOS lock
npm run dist             # produces dist/DeepWork.dmg
```

Then drag `DeepWork.app` into `/Applications`.

Because the build isn't signed with an Apple Developer ID, macOS quarantines
it if you download it rather than building it yourself. To clear that:

```bash
xattr -dr com.apple.quarantine /Applications/DeepWork.app
```

If macOS says the app is "damaged", it isn't — that's the missing signature:

```bash
codesign --force --deep --sign - /Applications/DeepWork.app
```

---

## Keyboard

**Anywhere**

| Key | Does |
|---|---|
| `⌘Q` | Ask to exit |
| `Esc` | Close a dialog |

**Reading a PDF**

| Key | Does |
|---|---|
| `⌘=` / `⌘-` | Zoom in / out |
| `⌘0` | Back to fit-width |
| Arrows, `Space` | Scroll |

**Watching a video**

| Key | Does |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Back / forward 10 seconds |
| `⇧←` / `⇧→` | Back / forward 60 seconds |
| `↑` / `↓` | Volume |

---

## How the lock works

The lock is a small Objective-C++ addon (`src/native/lockdown_mac.mm`) that
sets `NSApplicationPresentationOptions` directly:

```
HideDock | HideMenuBar | DisableAppleMenu | DisableProcessSwitching |
DisableForceQuit | DisableSessionTermination | DisableHideApplication
```

Electron's own `setKiosk(true)` sets exactly the same options — and then enters
native fullscreen. AppKit manages presentation itself for a fullscreen Space,
so it takes those options straight back and Cmd+Tab starts working again a
moment after the session begins. DeepWork uses `setSimpleFullScreen(true)`
instead, which fills the screen without creating a Space, and sets the options
afterwards so nothing overrides them. A watchdog re-applies them once a second
in case anything does.

Alongside that:

- **Windows** can't be closed, hidden, or minimised, and any extra display gets
  a blank panel so the dock can't be reached there.
- **Files** are served over a custom `lockdown://` protocol against a
  per-session allowlist. The window only ever sees opaque ids, never paths, so
  it can't be talked into opening anything that wasn't chosen up front.
- **The exit** is enforced in the main process. The window runs the countdown,
  but the refusal lives somewhere the window can't reach, and there is no
  "disarm" exposed to it at all.

### What isn't blocked

Being straight about this:

- **Spotlight** (`⌘Space`) can still launch another app.
- **Mission Control** gestures aren't covered by presentation options.
- **Screen lock** (`⌃⌘Q`) still works.
- **Rebooting** ends the session. There's no persistence yet, so a restart is
  a way out.

DeepWork is friction, not a cage. That's enough to beat an impulse to check
something; it won't beat a decision to stop.

---

## Layout

```
src/
├── main/                    Electron main process
│   ├── main.js              windows, lock, session state, timer
│   ├── file-protocol.js     lockdown:// — app assets and session files
│   ├── native-lockdown.js   loads the addon, falls back if it's missing
│   ├── preload.js           bridge for the setup window
│   └── preload-lockdown.js  smaller bridge for the locked window
├── native/
│   └── lockdown_mac.mm      NSApplicationPresentationOptions
└── renderer/
    ├── index.html           setup: pick files, press Start
    └── lockdown.html        home screen, PDF viewer, video player
```

---

## Development

```bash
npm run dev     # everything except the lock, with DevTools
npm start       # the real thing
```

`npm run dev` sets `DEEPWORK_UNLOCKED=1`, which skips the presentation options
and the shortcut blocking and turns DevTools back on. Use it for anything that
means restarting the app repeatedly — under `npm start` every reload costs a
thirty second hold, and there's no console to read errors from.

After changing `lockdown_mac.mm`, rebuild with `npx node-gyp rebuild`.

---

## Roadmap

- **Persistence** — write the session end time to disk and re-enter lockdown on
  login, so a reboot stops being an exit.
- **Signing and notarisation** — needed before the app installs cleanly for
  anyone else, and a prerequisite for auto-updates.
- **Windows** — the viewers port directly; the lock does not. It would need a
  separate addon built on low-level keyboard hooks, and Ctrl+Alt+Del can't be
  intercepted from user mode at all.

---

## License

MIT — see [LICENSE](LICENSE).

Built with [Electron](https://www.electronjs.org) and
[pdf.js](https://mozilla.github.io/pdf.js/), both Apache 2.0.
