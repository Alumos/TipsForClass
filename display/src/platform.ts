import {Engine} from './core/engine';
import type {DisplayBridge,Saved,Speech,ViewState} from './core/types';
declare global {interface Window {classroom?:DisplayBridge; overlayVisible?:boolean}}
class BrowserSpeech implements Speech {
 private reject:((e:Error)=>void)|undefined;
 status(){return !('speechSynthesis' in window)?'preview_unavailable':speechSynthesis.getVoices().some(v=>v.lang.toLowerCase().startsWith('zh'))?'preview_browser_zh':'preview_no_chinese_voice';}
 play(text:string){return new Promise<void>((resolve,reject)=>{if(!('speechSynthesis' in window))return reject(Error('浏览器不支持语音'));const voice=speechSynthesis.getVoices().find(v=>v.lang.toLowerCase().startsWith('zh'));if(!voice)return reject(Error('未检测到中文语音'));const u=new SpeechSynthesisUtterance(text);u.voice=voice;u.lang='zh-CN';this.reject=reject;u.onend=()=>{this.reject=undefined;resolve();};u.onerror=()=>{this.reject=undefined;reject(Error('语音播放失败'));};speechSynthesis.speak(u);});}
 stop(){speechSynthesis?.cancel();this.reject?.(Error('interrupted'));this.reject=undefined;}
}
export async function bridge():Promise<DisplayBridge>{if(window.classroom)return window.classroom;const store={async load(){try{return JSON.parse(localStorage.getItem('classroom-display-v1')||'null') as Saved|null;}catch{return null;}},async save(s:Saved){localStorage.setItem('classroom-display-v1',JSON.stringify(s));}};return Engine.create(store,new BrowserSpeech(),'浏览器预览 · 中文 Web Speech 回退，无法验证 Windows 焦点与语音');}
export const initialState:ViewState={bound:false,room:'等待绑定教室',label:'教室屏幕 A',online:false,live:false,syncing:false,lastSync:'',error:'',ttsStatus:'unknown',capability:'正在初始化',messages:[],now:Date.now(),quiet:false,paused:false,muted:true,alerts:[],speaking:null,lastAppliedSeq:'0',syncEpoch:'',apiBase:'http://127.0.0.1:8080/api/v1',pinSet:false,displayPosition:'top_right',pinnedMessageIds:[]};
