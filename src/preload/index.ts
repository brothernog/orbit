import { contextBridge, ipcRenderer } from 'electron'

// So canais registrados com ipcMain.handle respondem.
contextBridge.exposeInMainWorld('invoke', (name: string, ...args: unknown[]) => ipcRenderer.invoke(name, ...args))
// Eventos de streaming do chat; devolve a funcao que remove o listener.
contextBridge.exposeInMainWorld('onChat', (cb: (ev: unknown) => void) => {
  const f = (_e: unknown, ev: unknown) => cb(ev)
  ipcRenderer.on('chat', f)
  return () => { ipcRenderer.removeListener('chat', f) }
})
