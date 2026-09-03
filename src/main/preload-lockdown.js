const { contextBridge, ipcRenderer } = require('electron');

/**
 * The lockdown window's own bridge, deliberately smaller than the setup
 * window's. No file picker: during a session there should be no route to
 * browsing the disk, not even an unused one.
 *
 * File contents don't come through here either — they're fetched from
 * lockdown://file/<id>, so a 2GB lecture recording streams rather than being
 * copied through IPC.
 *
 * Note there's no disarm. Arming the timer is a one-way door by design, so
 * there is nothing here that could undo it.
 */
contextBridge.exposeInMainWorld('lockdown', {
  getSession: () => ipcRenderer.invoke('lockdown:session'),

  getTimer: () => ipcRenderer.invoke('lockdown:timer'),
  armTimer: (minutes) => ipcRenderer.invoke('lockdown:arm', minutes),

  exit: () => ipcRenderer.invoke('lockdown:exit'),

  // Fired when the user presses Cmd+Q. The event object is dropped; the
  // payload says whether the timer is currently refusing.
  onExitRequested: (callback) => {
    ipcRenderer.on('lockdown:confirm-exit', (_event, payload) => callback(payload));
  }
});
