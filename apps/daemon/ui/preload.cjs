'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentigram', {
  getStatus: () => ipcRenderer.invoke('agentigram:get-status'),
  subscribeToEvents: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('agentigram:status', listener);
    return () => ipcRenderer.removeListener('agentigram:status', listener);
  },
  submitHumanAction: (action) => ipcRenderer.invoke('agentigram:human-action', action),
  setVoiceSettings: (settings) => ipcRenderer.invoke('agentigram:set-voice', settings),
  openDashboard: () => ipcRenderer.invoke('agentigram:open-dashboard'),
});
