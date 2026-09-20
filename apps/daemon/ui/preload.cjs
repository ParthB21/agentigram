'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentigram', {
  platform: process.platform,
  getStatus: () => ipcRenderer.invoke('agentigram:get-status'),
  subscribeToEvents: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('agentigram:status', listener);
    return () => ipcRenderer.removeListener('agentigram:status', listener);
  },
  // Live room frames: { t: 'state', state } and { t: 'event', seq, eventType, sessionId, text }.
  subscribeToFrames: (callback) => {
    const listener = (_event, frame) => callback(frame);
    ipcRenderer.on('agentigram:frame', listener);
    return () => ipcRenderer.removeListener('agentigram:frame', listener);
  },
  setVoiceSettings: (settings) => ipcRenderer.invoke('agentigram:set-voice', settings),
  openDashboard: () => ipcRenderer.invoke('agentigram:open-dashboard'),
});
