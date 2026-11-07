'use strict';
// Deterministic single-symbol candle-by-candle simulator. No intra-candle order is assumed.
window.emaSimulate=function(raw,signals,opts){
 const cfg={notional:Number(opts.notional??1000),leverage:Number(opts.leverage??1),initialCapital:Number(opts.initialCapital??10000),hardStop:Number(opts.hardStop??2)/100,rr:Number(opts.rr??1),holdCandles:Number(opts.holdCandles??12),entryFee:Number(opts.entryFee??0.02)/100,tpFee:Number(opts.tpFee??0.02)/100,slFee:Number(opts.slFee??0.05)/100,slippage:Number(opts.slippage??0.05)/100,stopMode:opts.stopMode??'hard_open',excludeAmbiguous:opts.excludeAmbiguous!==false};
 if(Object.entries(cfg).some(([k,v])=>typeof v==='number'&&(!Number.isFinite(v)||v<0))||cfg.notional<=0||cfg.leverage<1||cfg.holdCandles<1||cfg.rr<=0)throw Error('回测参数无效');
 if(opts.funding!==false)throw Error('资金费率尚未实现，请关闭资金费率');
 const offsetMode=opts.entryMode==='offset',offset=Number(opts.entryOffset??0.5)/100;
 if(offsetMode&&(!Number.isFinite(offset)||offset<=0||offset>=1))throw Error('限价偏移参数无效');
 const byOpen=new Map(raw.map((c,i)=>[Number(c[0]),i]));
 const trades=[],excluded={ambiguous:0,overlap:0,invalid:0,unfinished:0};
 let busyUntil=-1;
 for(const s of [...signals].sort((a,b)=>a.entryTime-b.entryTime)){
  const idx=byOpen.get(s.entryTime);if(idx===undefined){excluded.invalid++;continue}
  if(idx<=busyUntil){excluded.overlap++;continue}
  const open=Number(raw[idx][1]),long=s.side==='多头';
  const entry=offsetMode?open*(long?1-offset:1+offset):open;
  if(offsetMode){const high=Number(raw[idx][2]),low=Number(raw[idx][3]),closeTime=Number(raw[idx][6]);
   if(closeTime>=Date.now()){excluded.unfinished++;continue}
   if(![high,low].every(Number.isFinite)){excluded.invalid++;continue}
   if(long?low>entry:high<entry){continue}
  }
  if(!Number.isFinite(entry)||entry<=0){excluded.invalid++;continue}
  const signalIndex=idx-1;
  const interval={'15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,'4h':14400000,'6h':21600000,'8h':28800000,'12h':43200000,'1d':86400000}[s.tf];
  if(!interval){excluded.invalid++;continue}
  if(signalIndex<0||Number(raw[signalIndex][0])!==s.signalTime){excluded.invalid++;continue}
  const candle=raw[signalIndex],hard=long?entry*(1-cfg.hardStop):entry*(1+cfg.hardStop);
  const structural=cfg.stopMode==='hard_extreme'?(long?Number(candle[3]):Number(candle[2])):Number(candle[1]);
  const stop=long?Math.max(hard,structural):Math.min(hard,structural);
  const risk=Math.abs(entry-stop);
  if(!(risk>0)||!Number.isFinite(risk)|| (long&&stop>=entry)||(!long&&stop<=entry)){excluded.invalid++;continue}
  const target=long?entry+risk*cfg.rr:entry-risk*cfg.rr;
  if(target<=0){excluded.invalid++;continue}
  const qty=cfg.notional/entry;
  let outcome=null;
  const last=Math.min(raw.length-1,idx+Math.floor(cfg.holdCandles)-1);
  for(let j=idx;j<=last;j++){
   const c=raw[j],o=Number(c[1]),h=Number(c[2]),l=Number(c[3]),cl=Number(c[4]),closeTime=Number(c[6]);
   if(closeTime>=Date.now()){break}
   if(j>idx&&Number(raw[j][0])-Number(raw[j-1][0])!==interval)break
   if(![o,h,l,cl].every(Number.isFinite)){break}
   if(offsetMode&&j===idx){
    // Intrabar order of entry and exit is unknowable from OHLC: do not invent an exit on entry candle.
    if((long?l<=stop:h>=stop)||(long?h>=target:l<=target)){outcome={type:'ambiguous',j};break}
    if(j===last){outcome={type:'timeout',price:cl,j};break}
    continue;
   }
   const hitStop=long?l<=stop:h>=stop,hitTarget=long?h>=target:l<=target;
   if(hitStop&&hitTarget){outcome={type:'ambiguous',j};break}
   if(hitStop){const price=long?Math.min(o,stop)*(1-cfg.slippage):Math.max(o,stop)*(1+cfg.slippage);outcome={type:'stop',price,j};break}
   if(hitTarget){const price=long?Math.max(o,target):Math.min(o,target);outcome={type:'target',price,j};break}
   if(j===last){outcome={type:'timeout',price:cl,j};break}
  }
  if(!outcome){excluded.unfinished++;busyUntil=Math.max(busyUntil,last);continue}
  // The ambiguous candle was reached by a real open position; reserve through that candle.
  if(outcome.type==='ambiguous'){excluded.ambiguous++;busyUntil=outcome.j;continue}
  const gross=(long?1:-1)*(outcome.price-entry)*qty;
  const fee=entry*qty*cfg.entryFee+outcome.price*qty*(outcome.type==='stop'?cfg.slFee:cfg.tpFee);
  const pnl=gross-fee;
  trades.push({...s,exitTime:Number(raw[outcome.j][6]),exit:outcome.price,stop,target,exitType:outcome.type,gross,fee,pnl,qty});
  busyUntil=outcome.j;
 }
 const wins=trades.filter(t=>t.pnl>0),losses=trades.filter(t=>t.pnl<0);
 const profit=wins.reduce((a,t)=>a+t.pnl,0),loss=-losses.reduce((a,t)=>a+t.pnl,0);
 const chronological=[...trades].sort((a,b)=>a.exitTime-b.exitTime),equity=cfg.initialCapital+chronological.reduce((a,t)=>a+t.pnl,0);
 let peak=cfg.initialCapital,balance=peak,maxDrawdown=0,maxDrawdownPct=0;
 for(const t of chronological){balance+=t.pnl;peak=Math.max(peak,balance);const dd=peak-balance;if(dd>maxDrawdown)maxDrawdown=dd;const pct=peak>0?dd/peak*100:0;if(pct>maxDrawdownPct)maxDrawdownPct=pct}
 return {trades,excluded,stats:{count:trades.length,wins:wins.length,losses:losses.length,winRate:trades.length?wins.length/trades.length*100:0,profit,loss,net:profit-loss,equity,returnPct:(profit-loss)/cfg.initialCapital*100,profitFactor:loss>0?profit/loss:null,realizedRR:losses.length&&wins.length?(profit/wins.length)/(loss/losses.length):null,maxDrawdown,maxDrawdownPct}};
};