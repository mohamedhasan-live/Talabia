'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The only surface the page gets. No Node, no filesystem, no IPC channel names.
// Every call that touches a record names the branch it belongs to.
contextBridge.exposeInMainWorld('desktop', {
  branches: true,
  state: () => ipcRenderer.invoke('ws:state'),
  load: (id) => ipcRenderer.invoke('data:load', id),
  save: (data, id, baseRev) => ipcRenderer.invoke('data:save', data, id, baseRev),
  cloudState: () => ipcRenderer.invoke('cloud:state'),
  cloudSettings: () => ipcRenderer.invoke('cloud:settings'),
  cloudTest: (o) => ipcRenderer.invoke('cloud:test', o),
  cloudConfigure: (o) => ipcRenderer.invoke('cloud:configure', o),
  signIn: (email, password) => ipcRenderer.invoke('auth:signin', email, password),
  signOut: () => ipcRenderer.invoke('auth:signout'),
  admin: (op, o) => ipcRenderer.invoke('admin:call', op, o),
  logActivity: (items) => ipcRenderer.invoke('activity:log', items),
  cloudSync: () => ipcRenderer.invoke('cloud:sync'),
  cloudResolve: (id, which) => ipcRenderer.invoke('cloud:resolve', id, which),
  onCloud: (cb) => { ipcRenderer.on('cloud:update', (_e, u) => cb(u)); },
  addBranch: (o) => ipcRenderer.invoke('branch:add', o),
  renameBranch: (id, name) => ipcRenderer.invoke('branch:rename', id, name),
  setCurrent: (id) => ipcRenderer.invoke('branch:current', id),
  catalogLoad: (brand) => ipcRenderer.invoke('catalog:load', brand),
  catalogSave: (brand, data, baseRev) => ipcRenderer.invoke('catalog:save', brand, data, baseRev),
  removeBranch: (id) => ipcRenderer.invoke('branch:remove', id),
  branchStats: () => ipcRenderer.invoke('branch:stats'),
  legacyAdopt: (id) => ipcRenderer.invoke('legacy:adopt', id),
  legacyDismiss: (id) => ipcRenderer.invoke('legacy:dismiss', id),
  exportFile: (data, hint) => ipcRenderer.invoke('data:export', data, hint),
  importFile: () => ipcRenderer.invoke('data:import'),
  reveal: (id) => ipcRenderer.invoke('data:reveal', id),
  reloadPage: () => ipcRenderer.invoke('page:reload')
});
