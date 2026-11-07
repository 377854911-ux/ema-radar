'use strict';
/* Independent five-slot Martingale; input trades are pre-simulated at a common base notional. */
window.emaMartingale=function(candidates,opts){
 const base=Number(opts.notional??1000),rate=Number(opts.martingaleRate??10)/100,initial=Number(opts.initialCapital??10000);
 if(!(base>0)||!(initial>0)||!Number.isFinite(rate)||rate<0)throw Error('马丁格尔参数无效');
 const slots='ABCDE'.split('').map(id=>({id,amount:base,losses:0,increments:0,paused:false,freeAt:-Infinity,readyOrder:-Infinity,profit:0,tradeCount:0}));
 const accepted=[],excluded={capacity:0,sameSymbol:0,paused:0,invalid:0},events=[];
 const ordered=[...candidates].sort((a,b)=>a.entryTime-b.entryTime||a.symbol.localeCompare(b.symbol)||a.tf.localeCompare(b.tf));
 let sequence=0;
 function settle(until){
  events.sort((a,b)=>a.trade.exitTime-b.trade.exitTime||a.slot.id.localeCompare(b.slot.id));
  while(events.length&&events[0].trade.exitTime<until){
   const {slot,trade}=events.shift();slot.freeAt=-Infinity;slot.readyOrder=++sequence;
   slot.profit+=trade.pnl;slot.tradeCount++;
   if(trade.pnl>0){slot.amount=base;slot.losses=0;slot.increments=0}
   else if(trade.pnl<0){slot.losses++;if(slot.increments>=10){slot.paused=true}else{slot.amount*=1+rate;slot.increments++;if(slot.increments>=10)slot.paused=true}}
  }
 }
 for(const t of ordered){
  if(!Number.isFinite(t.entryTime)||!Number.isFinite(t.exitTime)||t.exitTime<t.entryTime||!Number.isFinite(t.pnl)){excluded.invalid++;continue}
  settle(t.entryTime);
  if(events.some(x=>x.trade.symbol===t.symbol)){excluded.sameSymbol++;continue}
  const available=slots.filter(s=>!s.paused&&!events.some(e=>e.slot===s)).sort((a,b)=>a.readyOrder-b.readyOrder||a.id.localeCompare(b.id));
  if(!available.length){excluded.capacity++;continue}
  const slot=available[0],scale=slot.amount/base;
  const trade={...t,slot:slot.id,notional:slot.amount,gross:t.gross*scale,fee:t.fee*scale,pnl:t.pnl*scale,qty:t.qty*scale};
  accepted.push(trade);events.push({slot,trade});
 }
 settle(Infinity);
 const wins=accepted.filter(t=>t.pnl>0),losses=accepted.filter(t=>t.pnl<0),profit=wins.reduce((a,t)=>a+t.pnl,0),loss=-losses.reduce((a,t)=>a+t.pnl,0);
 let balance=initial,peak=initial,maxDrawdown=0,maxDrawdownPct=0;
 for(const t of [...accepted].sort((a,b)=>a.exitTime-b.exitTime||a.slot.localeCompare(b.slot))){balance+=t.pnl;peak=Math.max(peak,balance);const d=peak-balance;maxDrawdown=Math.max(maxDrawdown,d);maxDrawdownPct=Math.max(maxDrawdownPct,peak>0?d/peak*100:0)}
 return {trades:accepted,excluded,slots,stats:{count:accepted.length,wins:wins.length,losses:losses.length,winRate:accepted.length?wins.length/accepted.length*100:0,profit,loss,net:profit-loss,equity:initial+profit-loss,returnPct:(profit-loss)/initial*100,realizedRR:wins.length&&losses.length?(profit/wins.length)/(loss/losses.length):null,maxDrawdown,maxDrawdownPct}};
};