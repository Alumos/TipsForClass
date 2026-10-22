/** Bound a burst so a busy classroom never stays covered by notifications. */
export class AlertLimiter {
 private burstStart=0;private coolingUntil=0;private shown=0;
 accept(now:number){
  if(now<this.coolingUntil)return false;
  if(this.burstStart&&now-this.burstStart>=45000){this.burstStart=0;this.shown=0;}
  if(!this.burstStart){this.burstStart=now;this.shown=0;}
  if(this.shown>=3){this.coolingUntil=this.burstStart+105000;this.shown=0;this.burstStart=0;return false;}
  this.shown++;return true;
 }
 hideDeadline(now:number){return Math.min(now+15000,this.burstStart+45000);}
}

/** Serializes the asynchronous hand-off from queued alerts to the one overlay window. */
export class AlertQueue {
 private ids:string[]=[];
 private inFlight=false;

 enqueue(id:string,maxPending=2){
  if(!id||this.ids.includes(id)||this.ids.length>=maxPending)return;
  this.ids.push(id);
 }

 take(){
  if(this.inFlight)return undefined;
  const id=this.ids.shift();
  if(id)this.inFlight=true;
  return id;
 }

 requeue(id:string){
  this.ids=this.ids.filter(pending=>pending!==id);
  this.ids.unshift(id);
 }

 finish(){this.inFlight=false;}
 clear(){this.ids=[];}
 get pending(){return this.ids.length;}
 get busy(){return this.inFlight;}
}
