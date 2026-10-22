import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import type {Speech} from '../src/core/types.js';
export class WindowsSpeech implements Speech {
 private child:ChildProcessWithoutNullStreams|undefined;private pending:{id:string;resolve:()=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}|undefined;private capability='windows_adapter_missing';
 constructor(private executable:string){if(process.platform!=='win32'){this.capability='not_windows_no_native_tts';return;}if(existsSync(executable))this.start();}
 private start(){this.child=spawn(this.executable,[],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});createInterface({input:this.child.stdout}).on('line',line=>{try{const e=JSON.parse(line);if(e.event==='ready')this.capability=e.chineseVoices>0?'windows_zh_ready':'windows_no_chinese_voice';if(this.pending&&e.requestId===this.pending.id){if(e.event==='completed'){clearTimeout(this.pending.timer);this.pending.resolve();this.pending=undefined;}else if(e.event==='failed'){clearTimeout(this.pending.timer);this.pending.reject(Error('Windows 语音失败'));this.pending=undefined;}}}catch{/* Never log text or student payload. */}});this.child.on('error',()=>this.failed());this.child.on('exit',()=>this.failed());}
 private failed(){this.capability='windows_adapter_unavailable';if(this.pending)clearTimeout(this.pending.timer);this.pending?.reject(Error('语音适配器不可用'));this.pending=undefined;this.child=undefined;}
 status(){return this.capability;}
 async play(text:string){if(!this.child&&process.platform==='win32'&&existsSync(this.executable))this.start();if(this.capability!=='windows_zh_ready'||!this.child)throw Error('Windows 中文语音不可用');if(!text||text.length>800)throw Error('无效播报文本');return new Promise<void>((resolve,reject)=>{const id=crypto.randomUUID();const timer=setTimeout(()=>{if(this.pending?.id===id){this.stop();reject(Error('语音播放超时'));}},120000);this.pending={id,resolve,reject,timer};this.child!.stdin.write(JSON.stringify({command:'speak',requestId:id,text})+'\n');});}
 stop(){this.child?.stdin.write(JSON.stringify({command:'stop'})+'\n');if(this.pending)clearTimeout(this.pending.timer);this.pending?.reject(Error('interrupted'));this.pending=undefined;}
 close(){this.stop();this.child?.kill();}
}
