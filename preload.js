'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  getConfig: () => ipcRenderer.invoke('getConfig'),
  getState: () => ipcRenderer.invoke('getState'),
  updateConfig: (partial) => ipcRenderer.invoke('updateConfig', partial),
  checkOllama: () => ipcRenderer.invoke('checkOllama'),
  getStorageInfo: () => ipcRenderer.invoke('getStorageInfo'),
  getArchive: (opts) => ipcRenderer.invoke('getArchive', opts),

  // 动态页
  getHeatmap: (opts) => ipcRenderer.invoke('getHeatmap', opts),
  getTimeline: (opts) => ipcRenderer.invoke('getTimeline', opts),
  getBucketDetail: (bucketId) => ipcRenderer.invoke('getBucketDetail', bucketId),
  getFilterOptions: (opts) => ipcRenderer.invoke('getFilterOptions', opts),
  getSummaryStatus: () => ipcRenderer.invoke('getSummaryStatus'),

  // 日记页
  getDiary: (date) => ipcRenderer.invoke('getDiary', date),
  requestDiary: (date) => ipcRenderer.invoke('requestDiary', date),
  getDiaryStatus: () => ipcRenderer.invoke('getDiaryStatus'),
  scanDiaryBacklog: () => ipcRenderer.invoke('scanDiaryBacklog'),
  getMonthMarkers: (year, month) => ipcRenderer.invoke('getMonthMarkers', { year, month }),

  // 手动日记（随笔）
  getNote: (date) => ipcRenderer.invoke('getNote', date),
  saveNote: (payload) => ipcRenderer.invoke('saveNote', payload),
  saveNoteImage: (payload) => ipcRenderer.invoke('saveNoteImage', payload),
  getNoteTags: () => ipcRenderer.invoke('getNoteTags'),


  // 看板页
  getDashboard: (type, value) => ipcRenderer.invoke('getDashboard', { type, value }),

  // 问答页
  askQuestion: (question) => ipcRenderer.invoke('askQuestion', question),

  onScreenshot: (cb) => ipcRenderer.on('screenshot', (_e, p) => cb(p)),
  onRecord: (cb) => ipcRenderer.on('record', (_e, p) => cb(p)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, p) => cb(p)),
  onStats: (cb) => ipcRenderer.on('stats', (_e, p) => cb(p)),
  onLog: (cb) => ipcRenderer.on('log', (_e, p) => cb(p)),
  onSummary: (cb) => ipcRenderer.on('summary', (_e, p) => cb(p)),
  onSummaryStatus: (cb) => ipcRenderer.on('summaryStatus', (_e, p) => cb(p)),
  onDiary: (cb) => ipcRenderer.on('diary', (_e, p) => cb(p)),
  onDiaryStatus: (cb) => ipcRenderer.on('diaryStatus', (_e, p) => cb(p)),
});
