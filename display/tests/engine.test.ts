import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AlertLimiter,AlertQueue} from '../src/core/alerts';
import {Engine,validBase} from '../src/core/engine';
import {compareSeq,legacyDestination,messagePages,quietAt,sortMessages,textPages,speechKey} from '../src/core/rules';
import {canAcknowledgeVisible} from '../src/core/visibility';
import {overlayBounds} from '../src/core/window';
import {displayPositionFor} from '../src/core/rules';
import type {Message,Saved,Snapshot} from '../src/core/types';
const now=Date.parse('2026-10-22T01:30:00Z');
function message(id='m1',generation=0):Message{return {id,revision:generation+1,type:'call',title:'请到办公室',body:'请带好作业',targets:[{studentId:'s1',name:'测试同学',className:'三年二班',studentNoSuffix:'001'}],teacherName:'测试老师',priority:10,startAt:new Date(now-60000).toISOString(),expireAt:new Date(now+3600000).toISOString(),createdAt:new Date(now-60000).toISOString(),status:'active',speechText:'请测试同学到办公室。',broadcast:{generation,times:2,notBefore:new Date(now-60000).toISOString(),deadlineAt:new Date(now+180000).toISOString()}};}
function snapshot(messages:Message[]=[],epoch='epoch-a',watermark='9007199254740993'):Snapshot{return {syncEpoch:epoch,protocolVersion:1,watermark,serverTime:new Date(now).toISOString(),room:{id:'1',name:'测试教室'},settings:{timezone:'Asia/Shanghai',quietHours:[],configRevision:1},messages};}
let engines:Engine[]=[];
beforeEach(()=>{vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval']});vi.setSystemTime(now);vi.stubGlobal('WebSocket',class {readyState=1;onmessage:any;onclose:any;onerror:any;close(){this.onclose?.();}});});
afterEach(()=>{const old=engines;engines=[];for(const e of old)e.stop();vi.useRealTimers();vi.unstubAllGlobals();});
async function harness(initial?:Partial<Saved>){let data:Saved|null={apiBase:'http://127.0.0.1:8080/api/v1',installationId:'installation',label:'屏幕',lastAppliedSeq:'0',ledger:{},receipts:[],receiptKeys:[],...initial};let snap=snapshot();const requests:{path:string;body:any}[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string,init:any)=>{const body=init.body?JSON.parse(init.body):null;requests.push({path:url,body});let result:any={};if(url.endsWith('/device/snapshot'))result=snap;else if(url.endsWith('/device/ws-ticket'))result={ticket:'one-time'};else if(url.endsWith('/device/receipts'))result={accepted:body.items.length};else if(url.endsWith('/devices/bind'))result={deviceToken:'secret-token',device:{id:'d1'},room:{id:'1',name:'测试教室'}};return {ok:true,status:200,json:async()=>({code:0,data:result})};}));const speech={status:()=> 'mock-ready',play:vi.fn(async(_text:string)=>{}),stop:vi.fn()};const engine=await Engine.create({load:async()=>structuredClone(data),save:async(s)=>{data=structuredClone(s);}},speech,'test');engines.push(engine);return {engine,internals:engine as any,speech,requests,get data(){return data!;},setSnapshot:(value:Snapshot)=>{snap=value;}};}
describe('sync and receipts',()=>{
 it('compares arbitrary decimal seq without number precision loss',()=>{expect(compareSeq('9007199254740993','9007199254740992')).toBe(1);expect(compareSeq('10','9')).toBe(1);expect(compareSeq('0010','10')).toBe(0);});
 it('replays buffered revocation above watermark and ignores stale upsert',async()=>{const h=await harness();h.setSnapshot(snapshot([message()]));const socket={close(){}};h.internals.socket=socket;h.internals.buffer=[{seq:'9007199254740994',event:'message.revoked',syncEpoch:'epoch-a',protocolVersion:1,data:{id:'m1',revision:2}}];await h.internals.snapshot(socket);expect((await h.engine.state()).messages).toHaveLength(0);expect(h.engine.saved.lastAppliedSeq).toBe('9007199254740994');await h.internals.apply({seq:'9007199254740993',event:'message.upsert',syncEpoch:'epoch-a',protocolVersion:1,data:message()});expect((await h.engine.state()).messages).toHaveLength(0);});
 it('never emits displayed from synchronization; only an explicit visible acknowledgement',async()=>{const h=await harness();h.setSnapshot(snapshot([message()]));await h.internals.snapshot();expect(h.engine.saved.receiptKeys.some(k=>k.endsWith(':displayed'))).toBe(false);await h.engine.displayed(['m1']);expect(h.engine.saved.receiptKeys).toContain('d:m1:1:displayed');await h.engine.displayed(['m1']);expect(h.engine.saved.receiptKeys.filter(k=>k.endsWith(':displayed'))).toHaveLength(1);});
 it('suppresses initial history alerts, but a new replay generation alerts once',async()=>{const h=await harness();h.setSnapshot(snapshot([message()]));await h.internals.snapshot();h.engine.saved.deviceToken='token';h.internals.socket={readyState:1,close(){}};await h.internals.tick();expect((await h.engine.state()).alerts).toHaveLength(0);await h.internals.apply({seq:'9007199254740994',event:'message.replay',syncEpoch:'epoch-a',protocolVersion:1,data:message('m1',1)});await h.internals.tick();await h.internals.tick();expect((await h.engine.state()).alerts.map(a=>a.id)).toEqual(['m1']);});
 it('limits receipt batches to the server maximum of 50',async()=>{const h=await harness();h.setSnapshot(snapshot([]));await h.internals.snapshot();for(let i=0;i<61;i++)h.internals.enqueue({kind:'delivery',messageId:'m'+i,revision:1,state:'received'});await h.internals.flush();expect(h.requests.find(r=>r.path.endsWith('/device/receipts'))?.body.items).toHaveLength(50);expect(h.engine.saved.receipts).toHaveLength(11);});
 it('clears old epoch work and suppresses restored historical speech',async()=>{const h=await harness({snapshot:snapshot([message()]),receipts:[{kind:'delivery',messageId:'old',revision:1,state:'received'}]});h.setSnapshot(snapshot([message()],'epoch-restored','1'));await h.internals.snapshot();expect(h.engine.saved.receipts.some(r=>r.messageId==='old')).toBe(false);expect(Object.values(h.engine.saved.ledger).every(l=>l.reason==='restore_uncertain')).toBe(true);});
 it('keeps teacher-pinned messages first and otherwise shows newest first',()=>{const a={...message('a'),createdAt:'2026-10-22T01:00:00Z'};const b={...message('b'),createdAt:'2026-10-22T01:20:00Z'};const c={...message('c'),createdAt:'2026-10-22T01:10:00Z'};expect(sortMessages([a,b,c],['a','c']).map(m=>m.id)).toEqual(['a','c','b']);expect(sortMessages([a,b,c]).map(m=>m.id)).toEqual(['b','c','a']);});
 it('applies room display settings from the live event',async()=>{const h=await harness({snapshot:snapshot([message()])});await h.internals.apply({seq:'9007199254740994',event:'room.display',syncEpoch:'epoch-a',protocolVersion:1,data:{displaySettings:{displayPosition:'center',pinnedMessageIds:['12','8'],revision:3}}});expect(h.engine.saved.snapshot?.displaySettings).toEqual({displayPosition:'center',pinnedMessageIds:['12','8'],revision:3});expect((await h.engine.state()).displayPosition).toBe('center');});
 it('extracts legacy call destinations without reusing them as a title',()=>{const m={...message(),title:'呼叫 张三 · 到办公室'};expect(legacyDestination(m)).toBe('到办公室');expect(legacyDestination({...m,destination:'报告厅',title:'呼叫 张三 · 旧地点'})).toBe('报告厅');});
});
describe('speech and safe preview',()=>{
 it('defaults to device muted and records skipped rather than played',async()=>{const h=await harness();h.setSnapshot(snapshot([message()]));await h.internals.snapshot();await h.internals.runSpeech();expect(h.speech.play).not.toHaveBeenCalled();expect(Object.values(h.engine.saved.ledger)).toHaveLength(2);expect(Object.values(h.engine.saved.ledger).every(l=>l.state==='skipped'&&l.reason==='device_muted')).toBe(true);});
 it('treats interrupted playing on restart as crash_uncertain',async()=>{const key=speechKey('epoch-a','m1',0,1);const h=await harness({snapshot:snapshot([message()]),ledger:{[key]:{state:'playing',messageId:'m1',generation:0,round:1}}});expect(h.engine.saved.ledger[key]).toMatchObject({state:'skipped',reason:'crash_uncertain'});expect(h.speech.play).not.toHaveBeenCalled();});
 it('does not start speech while offline',async()=>{const h=await harness({muted:false});h.setSnapshot(snapshot([message()]));await h.internals.snapshot();h.internals.online=false;await h.internals.runSpeech();expect(h.speech.play).not.toHaveBeenCalled();});
 it('stops an active sound immediately on revoke',async()=>{const h=await harness({muted:false});h.setSnapshot(snapshot([message()]));await h.internals.snapshot();h.speech.play.mockImplementation(()=>new Promise<void>(()=>{}));void h.internals.runSpeech();await Promise.resolve();await h.internals.apply({seq:'9007199254740994',event:'message.revoked',syncEpoch:'epoch-a',protocolVersion:1,data:{id:'m1',revision:2}});expect(h.speech.stop).toHaveBeenCalled();});
 it('checks quiet hours in school timezone and splits long content without truncation',()=>{expect(quietAt({timezone:'Asia/Shanghai',quietHours:[{days:[4],start:'09:00',end:'10:00'}],configRevision:1},now)).toBe(true);const long='完整姓名📚'.repeat(80);expect(textPages(long,50).join('')).toBe(long);});
 it('rejects unsafe or credential-bearing API URLs',()=>{expect(()=>validBase('http://school.example/api/v1')).toThrow();expect(()=>validBase('https://token:password@example.com/api/v1')).toThrow();expect(validBase('http://127.0.0.1:8080/api/v1')).toBe('http://127.0.0.1:8080/api/v1');});
});
describe('desktop visible receipt policy',()=>{
 const base={visible:true,minimized:false,overlay:false,overlayShown:false,overlayMessage:''};
 it('rejects hidden and minimized windows',()=>{expect(canAcknowledgeVisible({...base,visible:false},['m1'])).toBe(false);expect(canAcknowledgeVisible({...base,minimized:true},['m1'])).toBe(false);});
 it('requires showInactive completion and matching overlay card',()=>{expect(canAcknowledgeVisible({...base,overlay:true,overlayMessage:'m1'},['m1'])).toBe(false);expect(canAcknowledgeVisible({...base,overlay:true,overlayShown:true,overlayMessage:'m1'},['m2'])).toBe(false);expect(canAcknowledgeVisible({...base,overlay:true,overlayShown:true,overlayMessage:'m1'},['m1'])).toBe(true);});
});

describe('overlay interruption budget',()=>{
 it('limits one burst to three reminders and imposes a minute cooldown',()=>{const l=new AlertLimiter();expect(l.accept(1000)).toBe(true);expect(l.hideDeadline(1000)).toBe(16000);expect(l.accept(17000)).toBe(true);expect(l.accept(33000)).toBe(true);expect(l.hideDeadline(33000)).toBe(46000);expect(l.accept(44000)).toBe(false);expect(l.accept(90000)).toBe(false);expect(l.accept(107000)).toBe(true);});
 it('does not turn a long gap after one reminder into a cooldown',()=>{const l=new AlertLimiter();expect(l.accept(1000)).toBe(true);expect(l.accept(50000)).toBe(true);});
});

describe('overlay alert queue',()=>{
 it('allows only one asynchronous alert hand-off at a time',()=>{
  const queue=new AlertQueue();
  queue.enqueue('m1');queue.enqueue('m2');
  expect(queue.take()).toBe('m1');
  expect(queue.take()).toBeUndefined();
  queue.finish();
  expect(queue.take()).toBe('m2');
 });

 it('caps pending alerts, deduplicates ids and preserves a deferred alert',()=>{
  const queue=new AlertQueue();
  queue.enqueue('m1');queue.enqueue('m1');queue.enqueue('m2');queue.enqueue('m3');
  expect(queue.pending).toBe(2);
  expect(queue.take()).toBe('m1');
  queue.requeue('m1');
  expect(queue.pending).toBe(2);
  queue.finish();
  expect(queue.take()).toBe('m1');
 });
});

describe('overlay placement',()=>{
 const workArea={x:100,y:50,width:1092,height:614};
 it('places the compact card at the top right or true center of the work area',()=>{
  expect(overlayBounds(workArea,'top_right')).toEqual({x:712,y:70,width:460,height:300});
  expect(overlayBounds(workArea,'center')).toEqual({x:266,y:117,width:760,height:480});
 });

it('uses each message display position and falls back for older messages',()=>{
  expect(displayPositionFor({displayPosition:'center'},'top_right')).toBe('center');
  expect(displayPositionFor({displayPosition:'top_right'},'center')).toBe('top_right');
  expect(displayPositionFor({},'center')).toBe('center');
  expect(displayPositionFor(undefined,'top_right')).toBe('top_right');
});

 it('fits small displays without leaving the available work area',()=>{
  for(const position of ['top_right','center'] as const){const bounds=overlayBounds({x:-200,y:0,width:300,height:200},position);expect(bounds.x).toBeGreaterThanOrEqual(-180);expect(bounds.y).toBeGreaterThanOrEqual(20);expect(bounds.x+bounds.width).toBeLessThanOrEqual(80);expect(bounds.y+bounds.height).toBeLessThanOrEqual(180);}
 });
});

describe('board pagination',()=>{
 it('keeps one complete stacked message per page so long cards cannot overlap the footer',()=>{
  const first=message('m1'),second=message('m2');
  expect(messagePages([first,second])).toEqual([[first],[second]]);
  expect(messagePages([])).toEqual([]);
 });
});
