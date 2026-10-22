import {contextBridge,ipcRenderer} from 'electron';
const allowed=new Set(['state','bind','unlock','maintain','displayed']);
const invoke=(name:string,...args:unknown[])=>{if(!allowed.has(name))throw Error('Forbidden IPC');return ipcRenderer.invoke('classroom:'+name,...args);};
contextBridge.exposeInMainWorld('classroom',{state:()=>invoke('state'),bind:(input:unknown)=>invoke('bind',input),unlock:(pin:string)=>invoke('unlock',pin),maintain:(action:string,value:unknown)=>invoke('maintain',action,value),displayed:(ids:string[])=>invoke('displayed',ids),subscribe:(callback:(s:unknown)=>void)=>{const listener=(_event:unknown,state:unknown)=>callback(state);ipcRenderer.on('classroom:state',listener);void invoke('state').then(callback);return()=>ipcRenderer.removeListener('classroom:state',listener);}});
ipcRenderer.on('classroom:overlay',(_event,detail)=>{window.dispatchEvent(new CustomEvent('classroom-overlay',{detail}));});

ipcRenderer.on('classroom:settings',()=>window.dispatchEvent(new Event('classroom-settings')));
