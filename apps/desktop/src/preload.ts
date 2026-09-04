import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('barbarianDesktop', {
  restartServer: () => ipcRenderer.invoke('barbarian:restart-server') as Promise<void>,
  applyPreferences: () => ipcRenderer.invoke('barbarian:apply-preferences') as Promise<void>,
});
