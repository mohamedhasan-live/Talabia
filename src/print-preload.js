'use strict';
// The print window's only surface: the document it shows, the printers, the preview, and its actions. No Node, no filesystem.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('printer', {
  onDoc: (cb) => { ipcRenderer.on('print:doc', (_e, d) => cb(d)); },
  printers: () => ipcRenderer.invoke('printwin:printers'),
  render: (html, opts) => ipcRenderer.invoke('printwin:render', html, opts),
  addPrinter: () => ipcRenderer.invoke('printwin:addPrinter'),
  system: (html, opts) => ipcRenderer.invoke('printwin:system', html, opts),
  printNow: (html, opts) => ipcRenderer.invoke('print:now', html, opts),
  close: () => ipcRenderer.send('print:close')
});
