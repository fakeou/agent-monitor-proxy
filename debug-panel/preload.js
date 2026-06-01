const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('amp', {
  // Generic invoke
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

  // Fetch data
  refresh: () => ipcRenderer.invoke('refresh'),
  fetchInstances: () => ipcRenderer.invoke('fetch-instances'),
  fetchSummary: () => ipcRenderer.invoke('fetch-summary'),

  // WebSocket events
  onWsStatus: (callback) => {
    ipcRenderer.on('ws-status', (_, data) => callback(data))
  },
  onWsEvent: (callback) => {
    ipcRenderer.on('ws-event', (_, data) => callback(data))
  },
})
