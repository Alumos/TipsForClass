<script setup lang="ts">
import {computed,nextTick,onMounted,onUnmounted,ref,shallowRef,watch} from 'vue';
import {bridge,initialState,isOverlayWindow,isTauriDesktop} from './platform';
import {DEFAULT_API_BASE} from './core/engine';
import type {DisplayBridge,Message} from './core/types';
import {displayPositionFor,legacyDestination,textPages} from './core/rules';

const native=isTauriDesktop()||!!window.classroom;
const overlay=isOverlayWindow();
const state=ref({...initialState});
const api=shallowRef<DisplayBridge>();
const error=ref('');
const busy=ref(false);
const settings=ref(false);
const unlocked=ref(false);
const pin=ref('');
const form=ref({apiBase:DEFAULT_API_BASE,bindCode:'',label:'班级屏幕 A',pin:''});
const elapsed=ref(0),previewId=ref(''),overlayId=ref(''),overlayShown=ref(false),lastSerial=ref(0),showPreview=ref(false);

const visible=computed(()=>{
  const id=overlay?overlayId.value:previewId.value;
  return id?state.value.messages.filter(message=>message.id===id):[];
});
const preview=computed(()=>state.value.messages.find(message=>message.id===previewId.value));
const previewPosition=computed(()=>displayPositionFor(preview.value,state.value.displayPosition));
const previewPositionLabel=computed(()=>previewPosition.value==='center'?'屏幕居中区域':'屏幕右上角浮窗');
const overlayPosition=computed(()=>displayPositionFor(visible.value[0],state.value.displayPosition));
const overlayClass=computed(()=>overlayPosition.value==='center'?'center':'top-right');
const nameLimit=computed(()=>overlay?overlayPosition.value==='center'?3:2:previewPosition.value==='center'?3:2);

function typeLabel(message:Message){return message.type==='call'?(message.targets.length>1?'多人呼叫':'个人呼叫'):message.type==='batch'?'作业布置':'普通通知';}
function shownNames(message:Message,limit=nameLimit.value){return (message.targets||[]).slice(0,limit);}
function remainingNames(message:Message,limit=nameLimit.value){return Math.max(0,(message.targets||[]).length-shownNames(message,limit).length);}
function destination(message:Message){return legacyDestination(message);}
function infoText(message:Message){
  const place=destination(message).replace(/^到/,'');
  if(message.type==='call')return [place?'请到 '+place:'',message.body].filter(Boolean).join('\n');
  if(message.type==='batch')return [place?'作业地点：'+place:'',message.body].filter(Boolean).join('\n');
  return message.body||'';
}
function positionFor(message:Message){return displayPositionFor(message,state.value.displayPosition);}
function overlayInfoLimit(message:Message){return positionFor(message)==='center'?200:100;}
function overlayInfoPage(message:Message){const pages=textPages(infoText(message),overlayInfoLimit(message));return pages[Math.floor(elapsed.value/6)%pages.length];}
function overlayPageCount(message:Message){return textPages(infoText(message),overlayInfoLimit(message)).length;}
function overlayNoticeTitle(message:Message){const limit=positionFor(message)==='center'?56:40;const pages=textPages(message.title||'班级通知',limit);return pages[Math.floor(elapsed.value/6)%pages.length];}
function overlayTitlePageCount(message:Message){return textPages(message.title||'班级通知',positionFor(message)==='center'?56:40).length;}

let unsubscribe:(()=>void)|undefined,timer:ReturnType<typeof setInterval>,hideTimer:ReturnType<typeof setTimeout>,idleTimer:ReturnType<typeof setTimeout>;
// 引擎每秒推送状态，API 地址只在首次同步时回填一次；否则用户输入会被立刻覆盖回旧值。
let apiSeeded=false;
async function attempt(action:()=>Promise<unknown>){busy.value=true;error.value='';try{await action();}catch(e){error.value=(e as Error).message;}finally{busy.value=false;}}
async function bindNow(){await attempt(async()=>{await api.value?.bind({...form.value});form.value.pin='';form.value.bindCode='';});}
async function unlock(){await attempt(async()=>{if(!await api.value?.unlock(pin.value))throw Error('PIN 不正确');unlocked.value=true;pin.value='';activity();});}
function activity(){clearTimeout(idleTimer);idleTimer=setTimeout(()=>{unlocked.value=false;void api.value?.maintain('lock');},300000);}
async function action(name:string,value?:unknown){await attempt(async()=>{await api.value?.maintain(name,value);activity();});}
async function unbind(){if(confirm('确认清除本机授权与公告缓存？需要管理员提供新的绑定码。'))await action('unbind');}
async function reportVisible(){
  await nextTick();
  if(document.visibilityState!=='visible')return;
  if(overlay&&!overlayShown.value)return;
  if(!overlay&&(native||!showPreview.value))return;
  await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
  if(document.visibilityState==='visible'&&(!overlay||overlayShown.value)&&(overlay||showPreview.value))try{await api.value?.displayed(visible.value.map(message=>message.id));}catch(e){error.value=(e as Error).message;}
}
function handleVisibility(){void reportVisible();}
function openSettings(){settings.value=true;}
function hideBrowserPreview(){showPreview.value=false;}
function overlayEvent(event:Event){const detail=(event as CustomEvent).detail;overlayId.value=detail.id||'';overlayShown.value=!!detail.visible;elapsed.value=0;if(overlayShown.value)void reportVisible();}
watch(()=>visible.value.map(message=>`${message.id}:${message.revision}`).join(','),()=>void reportVisible());
onMounted(async()=>{
  api.value=await bridge();
  unsubscribe=api.value.subscribe(next=>{
    state.value=next;
    if(!apiSeeded){apiSeeded=true;form.value.apiBase=next.apiBase;}
    if(!native){
      const fresh=next.alerts.filter(alert=>alert.serial>lastSerial.value).sort((a,b)=>b.serial-a.serial);
      if(fresh.length){
        lastSerial.value=Math.max(...fresh.map(alert=>alert.serial));
        previewId.value=fresh[0].id;
        showPreview.value=true;
        elapsed.value=0;
        clearTimeout(hideTimer);
        hideTimer=setTimeout(hideBrowserPreview,15000);
      }
    }
  });
  document.addEventListener('visibilitychange',handleVisibility);
  window.addEventListener('classroom-overlay',overlayEvent);
  window.addEventListener('classroom-settings',openSettings);
  timer=setInterval(()=>{elapsed.value++;},1000);
  void reportVisible();
});
onUnmounted(()=>{unsubscribe?.();clearInterval(timer);clearTimeout(hideTimer);clearTimeout(idleTimer);document.removeEventListener('visibilitychange',handleVisibility);window.removeEventListener('classroom-overlay',overlayEvent);window.removeEventListener('classroom-settings',openSettings);});
</script>

<template>
 <section v-if="overlay" class="native-overlay" :class="[overlayClass,{hidden:!overlayShown}]" aria-live="polite">
  <template v-if="visible[0]">
   <div class="overlay-top"><span class="pulse"></span><b>{{typeLabel(visible[0])}}</b><span>{{state.className}}</span></div>
   <h2 v-if="visible[0].type==='notice'" class="overlay-title">{{overlayNoticeTitle(visible[0])}}</h2>
   <div v-if="visible[0].type!=='notice'" class="overlay-person-list">
    <div v-for="target in shownNames(visible[0])" :key="target.studentId" class="overlay-person">{{target.name}}</div>
    <small v-if="remainingNames(visible[0])">另有 {{remainingNames(visible[0])}} 人</small>
   </div>
   <p class="overlay-info">{{overlayInfoPage(visible[0])}}</p>
   <footer><span>{{visible[0].teacherName}}发布 · 默认静音 · 自动收起</span><span v-if="overlayPageCount(visible[0])>1 || overlayTitlePageCount(visible[0])>1">内容 {{Math.floor(elapsed/6)+1}}</span></footer>
  </template>
 </section>

 <main v-else-if="!state.bound" class="bind-screen">
  <div class="bind-story"><div class="brand-mark">告</div><span class="eyebrow">CLASSROOM NOTICE</span><h1>每一条消息，<br>都被好好看见。</h1><p>日常保持安静，需要时轻轻提醒。<br>连接教师与班级，课件与课堂照常进行。</p><div class="quiet-promise">○ 后台托盘　○ 默认静音　○ 不抢课件焦点</div></div>
  <form class="bind-form" @submit.prevent="bindNow"><span class="eyebrow">CONNECT YOUR CLASSROOM</span><h2>绑定班级屏幕</h2><p>请管理员在小程序「管理」中生成一次性绑定码。</p><label>API 服务地址<input v-model="form.apiBase" type="url" required placeholder="https://notice.alumos.cn/api/v1"></label><label>设备名称<input v-model="form.label" maxlength="40" required></label><label>6 位绑定码<input v-model="form.bindCode" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" class="code-input" required placeholder="000000"></label><label>设置维护 PIN<input v-model="form.pin" type="password" inputmode="numeric" pattern="[0-9]{6,12}" minlength="6" maxlength="12" required placeholder="6–12 位数字，请妥善保存"></label><p v-if="error" class="error" role="alert">{{error}}</p><button class="primary" :disabled="busy">{{busy?'正在连接…':'连接班级 →'}}</button><small>{{native?'设备凭据由桌面安全存储保护。':'浏览器预览将设备凭据存入本机 localStorage；请仅用于本机试点。'}}</small><small>{{state.capability}}</small></form>
 </main>

 <main v-else class="preview-stage">
  <div class="preview-device-status" :class="{offline:!state.online}">
   <span class="pulse"></span>
   <span>{{state.className}} · {{state.paused?'提醒已暂停':state.online?'后台待机':'网络异常'}}</span>
  </div>
  <button class="preview-settings" type="button" @click="settings=true">设置与维护</button>
  <p v-if="state.error" class="error preview-error" role="status">{{state.error}}</p>

  <aside v-if="preview && showPreview" class="preview-overlay" :class="previewPosition==='center'?'center':'top-right'" aria-live="polite">
   <div class="overlay-top"><span class="pulse"></span><b>{{typeLabel(preview)}}</b><button type="button" aria-label="关闭提醒预览" @click="hideBrowserPreview">×</button></div>
   <h3 v-if="preview.type==='notice'" class="preview-title">{{overlayNoticeTitle(preview)}}</h3>
   <div v-if="preview.type!=='notice'" class="preview-people">
    <div v-for="target in shownNames(preview)" :key="target.studentId">{{target.name}}</div>
    <small v-if="remainingNames(preview)">另有 {{remainingNames(preview)}} 人</small>
   </div>
   <p class="preview-info">{{overlayInfoPage(preview)}}</p>
   <div class="preview-foot"><small>{{previewPositionLabel}} · 默认静音</small><small v-if="overlayPageCount(preview)>1 || overlayTitlePageCount(preview)>1">内容 {{Math.floor(elapsed/6)+1}}</small></div>
  </aside>

  <div v-if="settings" class="modal-backdrop" @pointerdown="activity">
   <section class="settings-panel">
    <button class="close" type="button" aria-label="关闭设置" @click="settings=false;unlocked=false;api?.maintain('lock')">×</button>
    <span class="eyebrow">DEVICE MAINTENANCE</span><h2>设置与维护</h2>
    <form v-if="!unlocked" @submit.prevent="unlock"><p>请输入绑定时设置的维护 PIN。</p><input v-model="pin" type="password" inputmode="numeric" placeholder="维护 PIN" required><button class="primary" :disabled="busy">进入维护</button></form>
    <template v-else>
      <p class="capability">{{state.capability}}</p>
      <div class="setting-row"><span>提醒位置<small>每条消息在发布或编辑时单独选择</small></span><b>逐条设置</b></div>
      <div class="setting-row"><span>语音提醒<small>默认关闭，开启后可能打断课件音频</small></span><button type="button" @click="action('mute',!state.muted)">{{state.muted?'开启语音':'关闭语音'}}</button></div>
      <div class="setting-row"><span>暂停提醒</span><button type="button" @click="action('pause',!state.paused)">{{state.paused?'恢复':'暂停'}}</button></div>
      <div class="setting-row"><span>语音状态<small>{{state.ttsStatus}}</small></span><button type="button" @click="action('test')">测试声音</button></div>
      <div class="setting-row"><span>重新同步公告</span><button type="button" @click="action('resync')">立即同步</button></div>
      <p class="muted">服务：{{state.apiBase}}<br>同步水位：{{state.lastAppliedSeq}}</p>
      <button class="danger" type="button" @click="unbind">解绑此设备</button><small>5 分钟无操作自动退出维护。试点版尚未提供签名自动更新。</small>
    </template>
    <p v-if="error" role="alert" class="error">{{error}}</p>
   </section>
  </div>
 </main>
</template>
