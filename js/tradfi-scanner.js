const btn=document.querySelector('#scan'),stop=document.querySelector('#stop'),status=document.querySelector('#status'),results=document.querySelector('#results');let cancelled=false,running=false;
const soundToggle=document.querySelector('#soundToggle'),testSound=document.querySelector('#testSound');let audioContext=null,lastBellAt=0;
try{const saved=JSON.parse(localStorage.getItem('ema.settings.tradfi-scanner')||'{}');soundToggle.checked=saved.sound!==false}catch{soundToggle.checked=true}
function unlockAudio(){
if(!soundToggle.checked)return false;
try{
const Ctx=window.AudioContext||window.webkitAudioContext;if(!Ctx)return false;
audioContext=audioContext||new Ctx();
if(audioContext.state==='suspended')audioContext.resume().catch(()=>{});
return true;
}catch{return false}
}
function playAlert(force=false){
if(!soundToggle.checked||!audioContext||audioContext.state!=='running')return false;
const time=Date.now();if(!force&&time-lastBellAt<1200)return true;lastBellAt=time;
try{const now=audioContext.currentTime+0.015;
for(let i=0;i<3;i++){const osc=audioContext.createOscillator(),gain=audioContext.createGain(),t=now+i*0.20;osc.type='sine';osc.frequency.setValueAtTime([784,988,1175][i],t);gain.gain.setValueAtTime(0.0001,t);gain.gain.exponentialRampToValueAtTime(0.22,t+0.015);gain.gain.exponentialRampToValueAtTime(0.0001,t+0.17);osc.connect(gain);gain.connect(audioContext.destination);osc.start(t);osc.stop(t+0.18)}return true
}catch{return false}
}
soundToggle.addEventListener('change',()=>{try{const saved=JSON.parse(localStorage.getItem('ema.settings.tradfi-scanner')||'{}');saved.sound=soundToggle.checked;localStorage.setItem('ema.settings.tradfi-scanner',JSON.stringify(saved))}catch{}if(soundToggle.checked)unlockAudio()});
testSound.addEventListener('click',async()=>{
if(!soundToggle.checked){status.textContent='请先开启声音提醒';return}
if(!unlockAudio()){status.textContent='当前浏览器不支持音频提醒';return}
try{if(audioContext.state!=='running')await audioContext.resume();status.textContent=playAlert(true)?'已播放测试铃声；如果听不到，请检查 iPhone 音量、静音模式和声音输出':'无法播放铃声，请在页面内再次点击试听铃声'}catch{status.textContent='音频启动失败，请再次点击试听铃声'}
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&audioContext&&soundToggle.checked&&audioContext.state==='suspended')status.textContent='声音提醒需要点击「试听铃声」重新激活'});
const tfMs={ '15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,'4h':14400000,'6h':21600000,'8h':28800000,'12h':43200000,'1d':86400000 };
const config=()=>{let s={};try{s=JSON.parse(localStorage.getItem('ema.settings.tradfi-scanner')||'{}')}catch{}return {timeframes:Array.isArray(s.timeframes)?s.timeframes.filter(x=>tfMs[x]):['15m','30m','1h','2h','4h','6h','8h','12h','1d'],directions:Array.isArray(s.directions)?s.directions:['long','short'],topN:Math.min(100,Math.max(1,Number(s.topN)||100)),maxMove:Number.isFinite(Number(s.maxMove))?Number(s.maxMove):30,ema:[Number(s.emaFast)||25,Number(s.emaMid)||50,Number(s.emaSlow)||100],excludeObservation:s.excludeObservation!==false,excludeDelist:s.excludeDelist!==false}};
const assetNames={stocks:'股票合约',metals:'黄金及贵金属',gas:'天然气',oil:'原油',etfs:'指数基金合约'};
const assetChoices=document.querySelector('#assetChoices');
let selectedAssets=new Set();
function categoryOf(s){
  const symbol=String(s.symbol||'').toUpperCase(), base=String(s.baseAsset||symbol.replace(/USDT$/,'')).toUpperCase();
  const name=String(s.name||s.underlyingName||s.description||'').toUpperCase();
  if(/^(XAU|XAG|XPT|XPD|GOLD|SILVER|PLATINUM|PALLADIUM)/.test(base)||/GOLD|SILVER|PLATINUM|PALLADIUM/.test(name))return 'metals';
  if(/^(NATGAS|NGAS|NG|NATURALGAS)/.test(base)||/NATURAL.GAS/.test(name))return 'gas';
  if(/^(WTI|BRENT|CL|BZ|USOIL|UKOIL|CRUDE|OIL)/.test(base)||/CRUDE.OIL|BRENT.OIL|WTI.OIL/.test(name))return 'oil';
  if(/^(SPY|QQQ|EWY|EWJ|IWM|DIA|EEM|TLT|XLF|XLK|VTI|VOO|IVV|SOXX|SMH|KWEB|ARKK|FXI|INDA|EFA|EWT|USO|UNG)$/.test(base)||/\bETF\b|EXCHANGE.TRADED.FUND/.test(name))return 'etfs';
  return 'stocks';
}
function readTradfi(){try{return JSON.parse(localStorage.getItem('ema.settings.tradfi-scanner')||'{}')}catch{return {}}}
selectedAssets=new Set(Array.isArray(readTradfi().assets)?readTradfi().assets.filter(x=>assetNames[x]):Object.keys(assetNames));
for(const [id,name] of Object.entries(assetNames)){const label=document.createElement('label');label.style.cssText='display:flex;align-items:center;gap:6px;padding:8px;margin:0;background:#1d3450;border-radius:8px;font-size:13px';const input=document.createElement('input');input.type='checkbox';input.checked=selectedAssets.has(id);input.style.cssText='width:17px;height:17px;min-height:17px';input.addEventListener('change',()=>{if(input.checked)selectedAssets.add(id);else selectedAssets.delete(id);saveScanSettings({assets:[...selectedAssets]})});label.append(input,document.createTextNode(name));assetChoices.append(label)}
const choices=document.querySelector('#timeframeChoices'),autoScan=document.querySelector('#autoScan'),scanInterval=document.querySelector('#scanInterval');let autoTimer=null;
function readSettings(){try{return JSON.parse(localStorage.getItem('ema.settings.tradfi-scanner')||'{}')}catch{return {}}}
function saveScanSettings(patch){try{localStorage.setItem('ema.settings.tradfi-scanner',JSON.stringify({...readSettings(),...patch}))}catch(e){status.textContent='保存扫描设置失败：'+e.message}}
const savedScan=readSettings();const initialTF=Array.isArray(savedScan.timeframes)?savedScan.timeframes:Object.keys(tfMs);
for(const tf of Object.keys(tfMs)){const label=document.createElement('label');label.style.cssText='display:flex;justify-content:center;align-items:center;gap:3px;margin:0;padding:8px 2px;background:#1d3450;border-radius:8px;font-size:12px;white-space:nowrap;min-width:0';const input=document.createElement('input');input.type='checkbox';input.value=tf;input.checked=initialTF.includes(tf);input.style.cssText='width:15px;height:15px;min-height:15px;flex-shrink:0';input.addEventListener('change',()=>{const chosen=[...choices.querySelectorAll('input:checked')].map(x=>x.value);saveScanSettings({timeframes:chosen})});label.append(input,document.createTextNode(tf));choices.append(label)}
const minutes=[5,10,15,30,60];scanInterval.value=String(minutes.includes(Number(savedScan.interval))?Number(savedScan.interval):30);
autoScan.checked=savedScan.autoScan===true;
function scheduleAuto(){if(autoTimer)clearInterval(autoTimer);autoTimer=null;if(autoScan.checked){autoTimer=setInterval(()=>{if(!running&&!document.hidden)btn.click()},Number(scanInterval.value)*60000)}}
autoScan.addEventListener('change',()=>{saveScanSettings({autoScan:autoScan.checked});scheduleAuto();if(autoScan.checked&&!running)btn.click()});
scanInterval.addEventListener('change',()=>{saveScanSettings({interval:Number(scanInterval.value)});scheduleAuto()});
scheduleAuto();
const get=async url=>{const r=await fetch(url);if(!r.ok)throw Error('Binance HTTP '+r.status);return r.json()};
function emaAt(values,period){const k=2/(period+1);let v=values[0];for(let i=1;i<values.length;i++)v=k*values[i]+(1-k)*v;return v}
function signal(raw,periods,tf,now){if(!Array.isArray(raw)||raw.length<Math.max(...periods)*3+2)return null;const last=raw.at(-1);const forming=Number(last[6])>=now;const idx=forming?raw.length-1:raw.length-1;const candidateIndices=forming?[idx,idx-1]:[idx];const output=[];for(const i of candidateIndices){const c=raw[i];const isForming=Number(c[6])>=now;if(!isForming){const next=raw[i+1];if(!next||Number(next[0])>now||Number(next[6])<now)continue;}const history=raw.slice(0,i+1);if(history.length<Math.max(...periods)*3)continue;const close=history.map(k=>Number(k[4]));const lines=periods.map(p=>emaAt(close,p));const o=Number(c[1]),cl=Number(c[4]),min=Math.min(...lines),max=Math.max(...lines);const long=cl>o&&o<min&&cl>max&&lines[2]<lines[0]&&lines[2]<lines[1];const short=cl<o&&o>max&&cl<min&&lines[2]>lines[0]&&lines[2]>lines[1];if(!long&&!short)continue;output.push({side:long?'long':'short',forming:isForming,time:Number(c[0]),open:o,close:cl,ema:lines,spread:(max-min)/Math.max(Math.abs(cl),1e-12)*100})}return output}



const progressTrack=document.querySelector('#progressTrack'),progressFill=document.querySelector('#progressFill');
function progress(done,total){const pct=total?Math.round(done/total*100):0;progressFill.style.width=pct+'%';progressTrack.setAttribute('aria-valuenow',String(pct))}
function renderSignal(v,entry){const el=document.createElement('p');el.style.cssText='padding:10px 0;border-bottom:1px solid #304866;margin:0';const arrow=document.createElement('strong');arrow.textContent=v.side==='long'?'▲ 做多':'▼ 做空';arrow.style.color=v.side==='long'?'#ff5757':'#36d982';const t=new Date(v.time).toLocaleString('zh-CN',{hour12:false});el.append(v.symbol+' · '+[...entry.periods].join('、')+' · ',arrow,' · '+(v.forming?'⚠ 未收盘预警':'✓ 已收盘确认')+' · K线 '+t+' (设备当地时间) · 开盘 '+v.open+' · '+(v.forming?'当前价 ':'收盘价 ')+v.close+' · EMA '+v.ema.map(x=>x.toPrecision(7)).join('/')+' · 聚拢差 '+v.spread.toFixed(3)+'%');return el}
stop.onclick=()=>{cancelled=true;status.textContent='正在停止扫描…'};
btn.onclick=async()=>{if(running)return;running=true;cancelled=false;unlockAudio();btn.disabled=true;results.replaceChildren();progress(0,0);const s=config();let scanned=0,matches=0,errors=0,total=0;const entries=new Map();
try{
if(!s.timeframes.length)throw Error('请至少选择一个扫描周期');
if(!selectedAssets.size)throw Error('请至少选择一个传统金融品种');
if(!s.directions.length)throw Error('请至少选择一个扫描方向');
if(s.ema.some(x=>!Number.isInteger(x)||x<1)||new Set(s.ema).size!==3)throw Error('EMA参数须为三个不同的正整数');
status.textContent='读取币安TradFi合约列表…';
const [info,tickers]=await Promise.all([get('https://fapi.binance.com/fapi/v1/exchangeInfo'),get('https://fapi.binance.com/fapi/v1/ticker/24hr')]);
if(cancelled)return;
const allowed=new Map(info.symbols.filter(x=>x.contractType==='TRADIFI_PERPETUAL'&&x.quoteAsset==='USDT'&&x.status==='TRADING'&&selectedAssets.has(categoryOf(x))).map(x=>[x.symbol,x]));
const ranked=tickers.filter(x=>allowed.has(x.symbol)&&Number.isFinite(Number(x.priceChangePercent))&&Math.abs(Number(x.priceChangePercent))<=s.maxMove).sort((a,b)=>Number(b.quoteVolume)-Number(a.quoteVolume));
if(!ranked.length){results.textContent='没有找到可扫描的已上市传统金融合约；请检查品种选择、币安接口及所在地区的可用性';status.textContent='未发现符合条件的TradFi合约';return}
const tasks=ranked.flatMap(t=>s.timeframes.map(tf=>({symbol:t.symbol,tf})));total=tasks.length;let cursor=0;
const worker=async()=>{while(cursor<tasks.length&&!cancelled){const task=tasks[cursor++];try{const now=Date.now();const limit=Math.min(1000,Math.max(400,Math.max(...s.ema)*4+5));const raw=await get('https://fapi.binance.com/fapi/v1/klines?symbol='+encodeURIComponent(task.symbol)+'&interval='+task.tf+'&limit='+limit);const signals=signal(raw,s.ema,task.tf,now)||[];
for(const sig of signals){if(cancelled||!s.directions.includes(sig.side))continue;matches++;
const key=task.symbol+'|'+sig.side+'|'+(sig.forming?'forming':'confirmed');
let entry=entries.get(key);if(!entry){entry={periods:new Set(),element:null};entries.set(key,entry)}
entry.periods.add(task.tf);const v={...task,...sig};const el=renderSignal(v,entry);
if(entry.element)entry.element.replaceWith(el);else results.prepend(el);
entry.element=el;
if(!entry.alerted){entry.alerted=true;playAlert()}
}
}catch(e){errors++}finally{scanned++;progress(scanned,total);status.textContent='已检查 '+scanned+'/'+total+' · 信号 '+matches+' · 请求失败 '+errors}
}};await Promise.all(Array.from({length:4},worker));
if(!entries.size)results.textContent='本次没有当前未收盘预警或上一根已收盘确认信号';
status.textContent=(cancelled?'扫描已停止':'扫描完成')+' · '+scanned+'/'+total+' · 信号 '+matches+' · 请求失败 '+errors+'。未收盘预警仅供人工观察；已收盘信号也需由自动交易模块独立验证。聚拢阈值、影线过滤与观察标签在原扫描代码中尚未完整验证；信号仅供观察。';
}catch(e){status.textContent='扫描失败：'+e.message}finally{running=false;btn.disabled=false}
};
