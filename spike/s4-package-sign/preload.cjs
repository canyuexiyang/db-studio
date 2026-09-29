// sandbox: true 时 preload 必须是 CommonJS（ESM preload 会失败）
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('s4', {
  ok: true,
  versions: process.versions,
});
