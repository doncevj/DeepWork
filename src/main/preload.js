const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * The setup window's only bridge to the rest of the machine.
 * Three functions, no filesystem access, no Node in the window.
 */
contextBridge.exposeInMainWorld('deepwork', {
  chooseFiles: () => ipcRenderer.invoke('files:choose'),

  // Dropped File objects carry no usable path on their own in modern Electron,
  // so resolve them here where webUtils is available.
  resolveDroppedFiles: (fileList) => {
    const paths = Array.from(fileList)
      .map((file) => {
        try {
          return webUtils.getPathForFile(file);
        } catch {
          return file.path || null; // older Electron
        }
      })
      .filter(Boolean);

    return ipcRenderer.invoke('files:validate', paths);
  },

  startSession: (payload) => ipcRenderer.invoke('session:start', payload)
});
