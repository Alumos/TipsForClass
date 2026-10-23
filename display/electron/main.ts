import {app,BrowserWindow,dialog,ipcMain,Menu,nativeImage,safeStorage,screen,Tray,type IpcMainInvokeEvent,type MenuItem} from 'electron';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {Engine} from '../src/core/engine.js';
import {canAcknowledgeVisible} from '../src/core/visibility.js';
import {AlertLimiter,AlertQueue} from '../src/core/alerts.js';
import {overlayBounds} from '../src/core/window.js';
import {displayPositionFor} from '../src/core/rules.js';
import type {ViewState} from '../src/core/types.js';
import {SecureSqliteStore} from './storage.js';
import {WindowsSpeech} from './speech.js';
const here=dirname(fileURLToPath(import.meta.url));
let main:BrowserWindow,overlay:BrowserWindow,tray:Tray,engine:Engine,speech:WindowsSpeech,quitting=false,overlayVisible=false,overlayMessage='',lastSerial=0,hideTimer:ReturnType<typeof setTimeout>|undefined,trayPauseItem:MenuItem|undefined,lastTrayTooltip='';
const queue=new AlertQueue();let paused=false;const limiter=new AlertLimiter();
const icon=nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAZUlEQVR4nO3XMQ4AEBBEUedxFKdw/xsohEShIRTCF6aYel6yW+wa653pJG1K03WidIihyitCALK8RIApIMWwlHcA+AgEwAH4EuIAfAQC4AB8CXEAPoJ/AbtzBQA/ywW44jnF3vMMyTUf12ajVjEAAAAASUVORK5CYII=');
function secure(window:BrowserWindow){window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());window.webContents.on('will-attach-webview',event=>event.preventDefault());}
function sender(e:IpcMainInvokeEvent){if(![main?.webContents.id,overlay?.webContents.id].includes(e.sender.id)||e.senderFrame!==e.sender.mainFrame)throw Error('拒绝不受信任的 IPC');}
function load(window:BrowserWindow,hash=''){return window.loadFile(join(here,'../../dist/index.html'),{hash});}
function openMain(){if(main.isMinimized())main.restore();main.show();main.focus();}
function openSettings(){openMain();main.webContents.send('classroom:settings');}
function hideOverlay(){clearTimeout(hideTimer);hideTimer=undefined;overlayVisible=false;overlayMessage='';overlay.webContents.send('classroom:overlay',{visible:false,id:''});overlay.hide();overlay.setAlwaysOnTop(false);if(queue.pending)setTimeout(()=>void showNext(),1000);}
async function showNext(){
 if(overlayVisible||queue.busy||paused||main?.isVisible())return;
 const id=queue.take();
 if(!id)return;
 try{
  const state=await engine.state();
  if(paused)return;
  if(main.isVisible()){queue.requeue(id);return;}
  const message=state.messages.find(m=>m.id===id);
  if(!message)return;
  const now=Date.now();
  if(!limiter.accept(now)){queue.clear();return;}
  const {workArea}=screen.getPrimaryDisplay();
  overlay.setBounds(overlayBounds(workArea,displayPositionFor(message,state.displayPosition)));
  overlayMessage=id;overlay.setAlwaysOnTop(true,'floating');overlay.showInactive();overlayVisible=true;
  overlay.webContents.send('classroom:overlay',{visible:true,id});
  hideTimer=setTimeout(hideOverlay,Math.max(0,limiter.hideDeadline(now)-now));
 }catch(error){console.error('无法显示班级公告提醒',error);}
 finally{queue.finish();if(queue.pending&&!overlayVisible&&!paused&&!main.isVisible())void showNext();}
}
function updatePauseMenu(){if(!trayPauseItem)return;const label=paused?'恢复提醒':'暂停提醒';if(trayPauseItem.label!==label)trayPauseItem.label=label;}
function setPaused(next:boolean){const pausing=next&&!paused;paused=next;updatePauseMenu();if(pausing){queue.clear();if(overlayVisible)hideOverlay();}}
function toggleReminders(){const next=!paused;setPaused(next);engine.pauseReminders(next);}
function createTrayMenu(){const menu=Menu.buildFromTemplate([{label:'打开设置与维护',click:openSettings},{label:'暂停提醒',click:toggleReminders},{type:'separator'},{label:'退出',click:async()=>{const result=await dialog.showMessageBox({type:'question',buttons:['取消','退出'],defaultId:0,cancelId:0,message:'退出后将无法接收班级公告，确认退出？'});if(result.response===1){quitting=true;app.quit();}}}]);trayPauseItem=menu.items[1];tray.setContextMenu(menu);updatePauseMenu();}
function updateTray(state:ViewState){setPaused(state.paused);const tooltip=`班级公告 · ${state.className} · ${state.paused?'提醒暂停':state.online?'已连接':'网络异常'}`;if(tooltip!==lastTrayTooltip){tray.setToolTip(tooltip);lastTrayTooltip=tooltip;}}
function publish(state:ViewState){for(const w of [main,overlay])if(w&&!w.isDestroyed())w.webContents.send('classroom:state',state);updateTray(state);const current=state.messages.find(m=>m.id===overlayMessage);if(overlayVisible&&current){const {workArea}=screen.getPrimaryDisplay();overlay.setBounds(overlayBounds(workArea,displayPositionFor(current,state.displayPosition)));}const fresh=state.alerts.filter(a=>a.serial>lastSerial);for(const alert of fresh){lastSerial=Math.max(lastSerial,alert.serial);if(!paused)queue.enqueue(alert.id);}if(overlayVisible&&!current)hideOverlay();if(!overlayVisible)void showNext();}
if(!app.requestSingleInstanceLock())app.quit();else{
 app.on('second-instance',()=>{if(main)openMain();});
 app.whenReady().then(async()=>{try{const store=await SecureSqliteStore.open(app.getPath('userData'));speech=new WindowsSpeech(app.isPackaged?join(process.resourcesPath,'windows-tts','ClassroomTts.exe'):join(here,'../../windows-tts/bin/publish/ClassroomTts.exe'));engine=await Engine.create(store,speech,process.platform==='win32'?'Windows 语音适配器 · 需中文语音与实际设备验收':'当前为非 Windows 桌面预览 · 未验证 Windows 语音与焦点行为');
 const prefs={preload:join(here,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true};
 main=new BrowserWindow({width:1280,height:860,minWidth:840,minHeight:620,show:false,backgroundColor:'#fffdf9',title:'班级公告 · 查看与维护',webPreferences:prefs});overlay=new BrowserWindow({width:476,height:338,show:false,frame:false,transparent:true,backgroundColor:'#00000000',focusable:false,skipTaskbar:true,resizable:false,movable:false,hasShadow:false,webPreferences:prefs});overlay.setIgnoreMouseEvents(true,{forward:true});secure(main);secure(overlay);main.on('close',e=>{if(!quitting){e.preventDefault();main.hide();}});main.on('show',()=>{if(overlayVisible)hideOverlay();});main.on('hide',()=>void showNext());
 ipcMain.handle('classroom:state',e=>{sender(e);return engine.state();});ipcMain.handle('classroom:bind',async(e,input)=>{sender(e);if(e.sender!==main.webContents||!input||typeof input!=='object'||Object.values(input).some(v=>typeof v!=='string'||v.length>400))throw Error('绑定参数无效');if(!safeStorage.isEncryptionAvailable())throw Error('当前用户安全存储不可用，无法绑定');await engine.bind(input);main.hide();return;});ipcMain.handle('classroom:unlock',(e,pin)=>{sender(e);if(e.sender!==main.webContents||typeof pin!=='string'||pin.length>12)throw Error('PIN 无效');return engine.unlock(pin);});ipcMain.handle('classroom:maintain',(e,action,value)=>{sender(e);if(e.sender!==main.webContents||typeof action!=='string'||!['pause','mute','test','resync','unbind','diagnostics','lock'].includes(action))throw Error('维护操作无效');return engine.maintain(action,value);});ipcMain.handle('classroom:displayed',async(e,ids)=>{sender(e);if(!Array.isArray(ids)||ids.length>3||ids.some(id=>typeof id!=='string'||id.length>100))throw Error('回执参数无效');const source=e.sender===overlay.webContents?overlay:main;if(!canAcknowledgeVisible({visible:source.isVisible(),minimized:source.isMinimized(),overlay:source===overlay,overlayShown:overlayVisible,overlayMessage},ids))return;await engine.displayed(ids);});
 tray=new Tray(icon);tray.on('double-click',openMain);createTrayMenu();await Promise.all([load(main),load(overlay,'overlay')]);engine.subscribe(publish);const state=await engine.state();if(!state.bound)openMain();else updateTray(state);
 }catch(e){dialog.showErrorBox('大屏启动失败',(e as Error).message);quitting=true;app.quit();}});
 app.on('window-all-closed',()=>{/* Keep the tray receiver alive. */});app.on('before-quit',()=>{quitting=true;engine?.stop();speech?.close();});
}
