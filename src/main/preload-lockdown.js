const { contextBridge, ipcRenderer } = require('electron');

/**
 * The lockdown window's own bridge, deliberately smaller than the setup
 * window's. No file picker: during a session there should be no route to
 * browsing the disk, not even an unused one.
 *
 * File contents don't come through here either — they're fetched from
 * lockdown://file/<id>, so a 2GB lecture recording streams rather than being
 * copied through IPC.
 */
contextBridge.exposeInMainWorld('lockdown', {
  getSession: () => ipcRenderer.invoke('lockdown:session'),

  exit: () => ipcRenderer.invoke('lockdown:exit'),

  // Fired when the user presses Cmd+Q. The event object is dropped rather than
  // handed across the bridge.
  onExitRequested: (callback) => {
    ipcRenderer.on('lockdown:confirm-exit', () => callback());
  }
});
