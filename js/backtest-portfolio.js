'use strict';
// Portfolio admission is chronological, independent of API download order.
// Provisional realized-only equity; funding and unrealized equity are excluded.
window.emaPortfolio=function(candidates,opts){
 const initial=Number(opts.initialCapital??10000),notional=Number(opts.notional??1000),lev=Number(opts.leverage??1),max=Number(opts.maxPositions??5);
 if(![initial,notional,lev,max].every(Number.isFinite)||initial<=0||notional<=0||lev<1||max<1||!Number.isInteger(max))throw Error('组合资金参数无效');
 const margin=notional/lev,active=[],accepted=[],excluded={capacity:0,sameSymbol:0,margin:0,invalid:0};
 let realized=initial,peak=initial,maxDD=0,maxDDPct=0;
 const update=()=>{peak=Math.max(peak,realized);const d=peak-realized;maxDD=Math.max(maxDD,d);maxDDPct=Math.max(maxDDPct,peak>0?100*d/peak:0)};
 const ordered=[...candidates].sort((a,b)=>a.entryTime-b.entryTime||a.symbol.localeCompare(b.symbol)||a.tf.localeCompare(b.tf));
 for(const t of ordered){
  if(!Number.isFinite(t.entryTime)||!Number.isFinite(t.exitTime)||t.exitTime<t.entryTime||!Number.isFinite(t.pnl)){excluded.invalid++;continue}
  // Exits strictly earlier than this candle's open are available for new entries.
  const closed=active.filter(p=>p.exitTime<t.entryTime).sort((a,b)=>a.exitTime-b.exitTime||a.symbol.localeCompare(b.symbol));
  for(const p of closed){const i=active.indexOf(p);active.splice(i,1);realized+=p.pnl;update()}
  if(active.some(p=>p.symbol===t.symbol)){excluded.sameSymbol++;continue}
  if(active.length>=max){excluded.capacity++;continue}
  if(realized-active.length*margin<margin){excluded.margin++;continue}
  active.push(t);accepted.push(t);
 }
 for(const t of [...active].sort((a,b)=>a.exitTime-b.exitTime)){realized+=t.pnl;update()}
 const wins=accepted.filter(t=>t.pnl>0),losses=accepted.filter(t=>t.pnl<0);
 const profit=wins.reduce((a,t)=>a+t.pnl,0),loss=-losses.reduce((a,t)=>a+t.pnl,0);
 return {trades:accepted,excluded,stats:{count:accepted.length,wins:wins.length,losses:losses.length,winRate:accepted.length?100*wins.length/accepted.length:0,profit,loss,net:profit-loss,equity:initial+profit-loss,returnPct:100*(profit-loss)/initial,realizedRR:wins.length&&losses.length?(profit/wins.length)/(loss/losses.length):null,maxDrawdown:maxDD,maxDrawdownPct:maxDDPct}};
};