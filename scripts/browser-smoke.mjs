#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(tmpdir(),'classroom-browser-'));
const out=path.join(root,'artifacts','qa');await mkdir(out,{recursive:true});
const base='http://127.0.0.1:18081',ui='http://127.0.0.1:4173';
const binary=path.join(temp,'notice-api');const children=[];let browser;
const env={...process.env,APP_MODE:'demo',HTTP_ADDR:'127.0.0.1:18081',DATABASE_PATH:path.join(temp,'notice.db'),ALLOWED_ORIGINS:ui,GOCACHE:path.join(root,'.tools/go-build'),GOMODCACHE:path.join(root,'.tools/go-mod')};
let logs='';const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function run(cmd,args,cwd){const child=spawn(cmd,args,{cwd,env,stdio:['ignore','pipe','pipe']});children.push(child);child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);return child;}
async function api(route,token,body,method='POST'){const response=await fetch(base+'/api/v1'+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();assert(response.ok,JSON.stringify(value));return value.data;}
async function ready(url){for(let i=0;i<100;i++){try{const response=await fetch(url);if(response.ok)return;}catch{}await pause(100);}throw Error('Not ready '+url+'\n'+logs);}
async function waitDisplayed(token,id){let delivery;for(let i=0;i<60;i++){delivery=await api(`/messages/${id}/delivery`,token,undefined,'GET');if(delivery.displayedDeviceCount===1)return delivery;await pause(100);}return delivery;}
try{
 for(const url of [base+'/healthz',ui]){try{await fetch(url,{signal:AbortSignal.timeout(300)});throw Error('Port in use: '+url);}catch(error){if(error.message.startsWith('Port in use'))throw error;}}
 const result=spawnSync('go',['build','-o',binary,'./cmd/server'],{cwd:path.join(root,'server'),env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 run(binary,[],path.join(root,'server'));
 run(process.execPath,[path.join(root,'display/node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port','4173','--strictPort'],path.join(root,'display'));
 await Promise.all([ready(base+'/healthz'),ready(ui)]);
 const login=await api('/auth/demo-login',null,{});const token=login.token;
 const code=await api('/admin/rooms/1/bind-codes',token,{});
 browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(ui);await page.getByRole('heading',{name:'绑定教室屏幕'}).waitFor();
 await page.getByLabel('API 服务地址').fill(base+'/api/v1');
 await page.getByLabel('设备名称').fill('自动验证教室屏');
 await page.getByLabel('6 位绑定码').fill(code.bindCode);
 await page.getByLabel('设置维护 PIN').fill('123456');
 await page.getByRole('button',{name:'连接教室 →'}).click();
 await page.locator('.preview-device-status').getByText('后台待机',{exact:false}).waitFor({timeout:15000});
 assert.equal(await page.locator('.board,.notice-card,.cards').count(),0,'绑定后不应常驻公告墙');
 assert(await page.getByRole('button',{name:'设置与维护'}).isVisible());
 await page.screenshot({path:path.join(out,'display-idle-no-board.png'),fullPage:true});
 console.log('✓ 已绑定大屏保持后台待机，页面无常驻公告墙');

 const classes=(await api('/classes?roomId=1',token,undefined,'GET')).items;
 const students=(await api(`/students?classId=${classes[0].id}`,token,undefined,'GET')).items;
 const center=await api('/messages',token,{clientToken:randomUUID(),type:'call',displayPosition:'center',roomIds:['1'],studentIds:[students[0].id],destination:'三楼教师办公室',body:'请带上课本和练习册',broadcastTimes:0,expireAt:new Date(Date.now()+1800000).toISOString()});
 const centerCard=page.locator('.preview-overlay.center');await centerCard.waitFor({timeout:10000});
 const centerBox=await centerCard.boundingBox();assert(centerBox&&centerBox.width>=740&&centerBox.height>=460,'居中提醒应足够醒目');
 const centerFont=parseFloat(await centerCard.locator('.preview-info').evaluate(element=>getComputedStyle(element).fontSize));assert(centerFont>=29,'居中正文至少 29px');
 assert.equal(await page.locator('.notice-card').count(),0);
 assert.equal((await waitDisplayed(token,center.id)).displayedDeviceCount,1);
 await page.screenshot({path:path.join(out,'display-center-transient.png'),fullPage:true});
 await centerCard.waitFor({state:'hidden',timeout:17000});
 console.log('✓ 居中提醒为约 760×480 大窗、正文约 30px，约 15 秒自动消失并写展示回执');

 const right=await api('/messages',token,{clientToken:randomUUID(),type:'call',displayPosition:'top_right',roomIds:['1'],studentIds:[students[1].id,students[2].id],destination:'二楼会议室',body:'请两名同学下课后到场',broadcastTimes:0,expireAt:new Date(Date.now()+1800000).toISOString()});
 const rightCard=page.locator('.preview-overlay.top-right');await rightCard.waitFor({timeout:10000});
 const rightBox=await rightCard.boundingBox();assert(rightBox&&rightBox.width<centerBox.width&&rightBox.width<=470,'右上角提醒应明显小于居中窗');
 const rightFont=parseFloat(await rightCard.locator('.preview-info').evaluate(element=>getComputedStyle(element).fontSize));assert(rightFont>=21,'右上角正文至少 21px');
 assert.equal(await rightCard.locator('.preview-people>div').count(),2);
 assert.equal((await waitDisplayed(token,right.id)).displayedDeviceCount,1);
 await page.screenshot({path:path.join(out,'display-top-right-transient.png'),fullPage:true});
 await rightCard.waitFor({state:'hidden',timeout:17000});
 console.log('✓ 右上角为小浮窗、正文约 22px，人员逐行显示，约 15 秒自动消失');

 await page.reload();await page.locator('.preview-device-status').getByText('后台待机',{exact:false}).waitFor({timeout:15000});await pause(1200);
 assert.equal(await page.locator('.preview-overlay').count(),0,'历史公告不应在重连后重复弹出');
 console.log('✓ 刷新恢复后台待机，不补弹历史提醒');
 await api(`/messages/${center.id}/revoke`,token,{});
 await api(`/messages/${right.id}/revoke`,token,{});
 await page.getByRole('button',{name:'设置与维护'}).click();
 await page.getByPlaceholder('维护 PIN').fill('123456');
 await page.getByRole('button',{name:'进入维护',exact:true}).click();
 await page.getByRole('button',{name:'开启语音',exact:true}).waitFor();
 assert(await page.getByRole('button',{name:'开启语音',exact:true}).isVisible());
 await page.screenshot({path:path.join(out,'display-settings.png'),fullPage:true});
 assert.deepEqual(errors,[]);console.log('✓ PIN 维护页与默认语音开关正确；无页面脚本异常');
 console.log('Screenshots: '+out+'\nNative Windows focus/mouse passthrough still needs Windows hardware validation.');
}catch(error){console.error(error);console.error(logs.slice(-3000));process.exitCode=1;}finally{
 await browser?.close();
 for(const child of children){if(child.exitCode===null)child.kill('SIGTERM');}
 await Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(3000).then(()=>{if(child.exitCode===null)child.kill('SIGKILL');})])));
 await rm(temp,{recursive:true,force:true});
}
