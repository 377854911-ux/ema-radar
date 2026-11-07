'use strict';
const $=id=>document.getElementById(id);
const ms={ '15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,'4h':14400000,'6h':21600000,'8h':28800000,'12h':43200000,'1d':86400000 };
let aborter=null;
const api='https://fapi.binance.com';
const fmt=t=>new Date(t).toLocaleString('zh-CN',{timeZone:'Africa/Conakry',hour12:false});
function settings(){try{return JSON.parse(localStorage.getItem('ema.settings.backtest')||'{}')}catch{return {}}}
async function json(url,signal){const r=await fetch(url,{signal});if(!r.ok)throw Error('币安 HTTP '+r.status);return r.json()}
async function klines(symbol,tf,days,signal,onPage){
 const interval=ms[tf],end=Date.now(),start=end-days*86400000, warm=start-400*interval;
 let cursor=warm,all=[],pages=0;
 while(cursor<end){
  const batch=await json(api+'/fapi/v1/klines?symbol='+encodeURIComponent(symbol)+'&interval='+tf+'&startTime='+cursor+'&endTime='+end+'&limit=1000',signal);
  if(!Array.isArray(batch)||!batch.length)break;
  for(const c of batch){if(!all.length||Number(c[0])>Number(all[all.length-1][0]))all.push(c)}
  const next=Number(batch[batch.length-1][0])+interval;
  if(next<=cursor)throw Error('历史K线分页未推进');
  cursor=next;onPage(++pages,all.length);
  if(batch.length<1000)break;
 }
 return {all,start,end};
}
function analyze(raw,start,end,tf,onMatch){
 const periods=[25,50,100],alpha=periods.map(p=>2/(p+1)),ema=[null,null,null];
 const seed=periods.map(()=>[]);let found=0,checked=0,skipped=0;
 for(let i=0;i<raw.length;i++){
  const c=raw[i],t=Number(c[0]),closeTime=Number(c[6]),o=Number(c[1]),cl=Number(c[4]);
  if(!Number.isFinite(o)||!Number.isFinite(cl))continue;
  for(let j=0;j<3;j++){
   if(ema[j]===null){seed[j].push(cl);if(seed[j].length===periods[j])ema[j]=seed[j].reduce((a,b)=>a+b,0)/periods[j]}
   else ema[j]=alpha[j]*cl+(1-alpha[j])*ema[j];
  }
  if(ema.some(x=>x===null)||i<400||t<start||closeTime>=end)continue;
  checked++;
  const next=raw[i+1];
  if(!next||Number(next[0])!==t+ms[tf]||!Number.isFinite(Number(next[1]))){skipped++;continue}
  const lo=Math.min(...ema),hi=Math.max(...ema);
  const long=cl>o&&o<lo&&cl>hi&&ema[2]<ema[0]&&ema[2]<ema[1];
  const short=cl<o&&o>hi&&cl<lo&&ema[2]>ema[0]&&ema[2]>ema[1];
  if(long||short){found++;onMatch({symbol:$('symbol').value.trim().toUpperCase(),tf,side:long?'多头':'空头',signalTime:t,entryTime:Number(next[0]),entry:Number(next[1]),signalClose:cl,ema:[...ema]})}
 }
 return {found,checked,skipped};
}
$('stop').onclick=()=>{if(aborter){aborter.abort();$('status').textContent='正在停止…'}};
$('start').onclick=async()=>{
 if(aborter)return;
 const symbol=$('symbol').value.trim().toUpperCase(),tf=$('tf').value,days=Number($('days').value);
 if(!/^[A-Z0-9]{3,30}USDT$/.test(symbol)){ $('status').textContent='请输入有效的USDT合约交易对，例如 BTCUSDT';return}
 aborter=new AbortController();$('start').disabled=true;$('summary').textContent='等待扫描完成后模拟撮合';$('results').replaceChildren();$('count').textContent='0';
 try{
  const info=await json(api+'/fapi/v1/exchangeInfo',aborter.signal);
  const contract=info.symbols.find(x=>x.symbol===symbol&&x.contractType==='PERPETUAL'&&x.quoteAsset==='USDT');
  if(!contract)throw Error('不是币安USDT永续合约');
  $('status').textContent='正在获取历史K线…';
  const {all,start,end}=await klines(symbol,tf,days,aborter.signal,(p,n)=>{$('status').textContent='已下载 '+n+' 根K线 · '+p+' 页'});
  if(all.length<401)throw Error('有效历史K线不足，不能计算EMA100');
  const rows=[];
  $('summary').textContent='正在计算模拟交易…';
  const stats=analyze(all,start,end,tf,x=>{
   rows.push(x);const el=document.createElement('div');el.className='panel';
   const heading=document.createElement('strong');heading.style.color=x.side==='多头'?'#ff656d':'#48d69a';heading.textContent=x.symbol+' · '+x.tf+' · '+x.side;
   const details=document.createElement('p');details.className='muted';details.textContent='信号K线 '+fmt(x.signalTime)+' ｜ 下一根开盘 '+fmt(x.entryTime)+' ｜ 开盘参考价 '+x.entry+' USDT';
   el.append(heading,details);$('results').prepend(el);$('count').textContent=String(rows.length);
  });
  $('status').textContent='历史信号识别完成：'+stats.checked+' 根候选K线，'+stats.found+' 个信号，'+stats.skipped+' 根缺少连续下一根K线。仅用于核对信号，未进行历史每日前100筛选或交易撮合。';
  if(!rows.length)$('results').textContent='该交易对和周期在所选时间内没有符合条件的信号。';
  const config=settings();
  try{
   const sim=window.emaSimulate(all,rows,config);
   const st=sim.stats;
   const money=n=>Number(n).toFixed(2);
   $('summary').textContent='已平仓 '+st.count+' 笔 ｜ 胜率 '+st.winRate.toFixed(2)+'% ｜ 总盈利 '+money(st.profit)+' USDT ｜ 总亏损 '+money(st.loss)+' USDT ｜ 净盈亏 '+money(st.net)+' USDT ｜ 实际平均盈亏比 '+(st.realizedRR===null?'暂无':st.realizedRR.toFixed(2))+' ｜ 收益率 '+st.returnPct.toFixed(2)+'% ｜ 最大回撤 '+money(st.maxDrawdown)+' USDT ('+st.maxDrawdownPct.toFixed(2)+'%) ｜ 同根止盈止损排除 '+sim.excluded.ambiguous+' 笔 ｜ 重叠信号排除 '+sim.excluded.overlap+' 笔 ｜ 未平仓/数据不足 '+sim.excluded.unfinished+' 笔。资金费率未计入；非完整回测。';
   const tradeMap=new Map(sim.trades.map(t=>[t.entryTime,t]));
   for(const el of $('results').children){
    const detail=el.querySelector('p');if(!detail)continue;
    const match=rows.find(x=>detail.textContent.includes(fmt(x.entryTime)));
    if(!match)continue;
    const t=tradeMap.get(match.entryTime);
    if(t)detail.textContent+=' ｜ '+(t.exitType==='target'?'止盈':t.exitType==='stop'?'止损':'到期平仓')+' ｜ 净盈亏 '+money(t.pnl)+' USDT';
    else detail.textContent+=' ｜ 未计入模拟交易';
   }
  }catch(e){$('summary').textContent='盈亏模拟未执行：'+e.message+'。请在回测设置中关闭资金费率，并选择下一根开盘价入场。';}
 }catch(e){$('status').textContent=e.name==='AbortError'?'扫描已停止':'扫描失败：'+e.message}
 finally{aborter=null;$('start').disabled=false}
};
const s=settings();if([7,30,60].includes(Number(s.days)))$('days').value=String(s.days);
if(Array.isArray(s.timeframes)&&s.timeframes.includes('30m'))$('tf').value='30m';
