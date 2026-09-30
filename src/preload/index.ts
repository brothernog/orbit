import { contextBridge, ipcRenderer } from 'electron'

// So canais registrados com ipcMain.handle respondem.
contextBridge.exposeInMainWorld('invoke', (name: string, ...args: unknown[]) => ipcRenderer.invoke(name, ...args))
// Eventos de streaming do chat.
contextBridge.exposeInMainWorld('onChat', (cb: (ev: unknown) => void) => { ipcRenderer.on('chat', (_e, ev) => cb(ev)) })
