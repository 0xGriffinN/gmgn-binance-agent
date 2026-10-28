import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const TOKEN='0xaf21e620ff8df6042902e01e52cfbb22933abbbb';
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.value='';this.style={};this.dataset={};this.listeners={};this.classList={toggle(){},contains(){return false;},remove(){}};}
  append(...nodes){for(const n of nodes){this.children.push(n);if(n&&typeof n==='object')n.parentElement=this;}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(k,v){if(k==='id')this.id=v;else if(k==='value')this.value=v;}
  getElementById(id){if(this.id===id)return this;return this.children.map(c=>c.getElementById?.(id)).find(Boolean);}
  querySelectorAll(tag){return this.children.flatMap(c=>c.tag?[...(c.tag===tag?[c]:[]),...c.querySelectorAll(tag)]:[]);}
  querySelector(){return null;}
  addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);}
  scrollIntoView(){}
}
async function panel(active=null,route={platform:'gang',kind:'v2',stage:'inner'},{walletDeferred=false,quickImmediate=false,orderDeferred=false}={}){
  const calls=[],root=new Element('root'),template={};let messageListener;
  runInNewContext(await readFile(new URL('../extension/panel-template.js',import.meta.url),'utf8'),template);
  function make(n){if(typeof n==='string')return {textContent:n};const el=new Element(n.tag);for(const [k,v]of Object.entries(n.attrs))el.setAttribute(k,v);el.append(...n.children.map(make));return el;}
  root.append(...template.__GMGN_AGENT_TEMPLATE__.nodes.map(make));
  const get=id=>root.getElementById(id);
  for(const [id,value]of Object.entries({'gas':'MEDIUM','buy-slippage':'auto','sell-slippage':'auto','buy-amount':'0.005','sell-percent':'100'}))get(id).value=value;
  get('approval-cap').checked=true;get('sell-to-bnb').checked=false;get('mev').checked=true;
  const context={crypto:{randomUUID:()=> '00000000-0000-0000-0000-000000000123'},__GMGN_AGENT_MOUNT__:{root,body:new Element('body'),layout(){}},location:{protocol:'https:'},document:{hidden:false,createElement:t=>new Element(t),createTextNode:t=>({textContent:t})},setInterval(){},navigator:{},
    chrome:{storage:{local:{get:async()=>({}),set:async()=>{}}},runtime:{onMessage:{addListener(fn){messageListener=fn;}},sendMessage:async m=>{
      calls.push(m);if(m.method==='trade.quick'&&!quickImmediate||m.method==='wallet.snapshot'&&walletDeferred||m.method==='orders.refresh'&&orderDeferred)return new Promise(()=>{});
      if(m.method==='trade.quick')return {data:{id:m.params.requestId,queued:true,status:'QUEUED',message:'已排队'}};
      const data=m.method==='context'?{supported:true,token:TOKEN,url:`https://gmgn.ai/bsc/token/${TOKEN}`}:
        m.method==='token.route'?{token:TOKEN,...route}:m.method==='wallet.snapshot'?{status:'CONNECTED',address:TOKEN,native:{balance:'1'},holding:{balance:'100',symbol:'TEST',value:'1'},settings:{},route}:
        m.method==='orders.list'?{records:active?[active]:[],active}:m.method==='orders.refresh'?active:{};return {data};
    }}}};
  runInNewContext(await readFile(new URL('../extension/preset-model.js',import.meta.url),'utf8'),context);
  runInNewContext(await readFile(new URL('../extension/panel.js',import.meta.url),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  return {get,calls,emit:message=>messageListener(message)};
}
test('buy preset submits once immediately with current settings and ignores a repeated click while busy',async()=>{
  const {get,calls}=await panel(),button=get('buy-presets').children[0];assert.equal(button.disabled,false);
  button.listeners.click[0]({isTrusted:true});button.listeners.click[0]({isTrusted:true});
  const trades=calls.filter(c=>c.method==='trade.quick');assert.equal(trades.length,1);assert.equal(trades[0].params.amount,'0.01');assert.equal(trades[0].params.side,'buy');assert.equal(trades[0].params.approvalCap,true);assert.equal(trades[0].params.sellToBnb,false);
  assert.equal(get('review').hidden,true);
});
test('sell preset directly submits its percentage and synthetic page clicks cannot trade',async()=>{
  const {get,calls}=await panel(),button=get('sell-presets').children[1];
  button.listeners.click[0]({isTrusted:false});assert.equal(calls.filter(c=>c.method==='trade.quick').length,0);
  button.listeners.click[0]({isTrusted:true});const trade=calls.find(c=>c.method==='trade.quick');assert.equal(trade.params.side,'sell');assert.equal(trade.params.percent,'25');
});

test('confirmed sale awaiting manual BNB settlement leaves buy buttons enabled',async()=>{
  const row={id:'old-sale',token:TOKEN,side:'sell',amount:'100',createdAt:Date.now(),status:'WAITING_NEXT',afterSell:{token:TOKEN,amount:'1'},steps:[{status:'FINISHED',role:'trade'}]};
  const {get}=await panel(row);assert.equal(get('buy').disabled,false);assert.equal(get('buy-presets').children[0].disabled,false);
});

test('unresolved transaction allows queueing with compact buy and sell button labels',async()=>{
  const row={id:'pending-sale',token:TOKEN,side:'sell',amount:'100',createdAt:Date.now(),status:'UNKNOWN',steps:[{status:'APP_CONFIRM',role:'trade'}]};
  const {get}=await panel(row);assert.equal(get('buy').disabled,false);assert.equal(get('buy-presets').children[0].disabled,false);assert.equal(get('buy').textContent,'买入');assert.equal(get('sell').textContent,'卖出');
});

test('inner Gang and Four show only buy 1%, while Flap exposes buy 1% and 2%',async()=>{
  for(const platform of ['gang','four']){
    const {get}=await panel(null,{platform,kind:platform==='gang'?'v2':'agent',stage:'inner'});
    assert.deepEqual(get('buy-supply-presets').children.map(b=>b.textContent),['百1']);
  }
  const {get}=await panel(null,{platform:'flap',kind:'portal',stage:'inner'});
  assert.deepEqual(get('buy-supply-presets').children.map(b=>b.textContent),['百1','百2']);
});

test('chip shortcut sends a supply-percent buy intent directly, keeping the BNB preset amount separate',async()=>{
  const {get,calls}=await panel(null,{platform:'flap',kind:'portal',stage:'inner'}),button=get('buy-supply-presets').children[1];
  button.onclick({isTrusted:false});assert.equal(calls.filter(c=>c.method==='trade.quick').length,0);
  button.onclick({isTrusted:true});button.onclick({isTrusted:true});
  const trades=calls.filter(c=>c.method==='trade.quick');assert.equal(trades.length,1);assert.equal(trades[0].params.pctSupply,'2');assert.equal(trades[0].params.amount,'0.005');assert.equal(trades[0].params.side,'buy');
});

test('platform display and chip options arrive before a delayed wallet balance response',async()=>{
  const {get,calls}=await panel(null,{platform:'gang',kind:'v2',stage:'inner'},{walletDeferred:true});
  assert.match(get('context-note').textContent,/GANG/);assert.equal(get('buy-supply-presets').children[0].textContent,'百1');
  assert.equal(calls.filter(c=>c.method==='wallet.snapshot').length,1);assert.equal(get('buy').disabled,true);
});

test('compact token identity keeps full editable CA and renders the wallet token symbol',async()=>{
  const {get}=await panel();assert.equal(get('ca').tag,'input');assert.equal(get('ca').value,TOKEN);assert.equal(get('token-name').textContent,'TEST');
});

test('accepted queue intent releases the buttons without waiting for slow order reconciliation',async()=>{
  const active={id:'pending-sale',token:TOKEN,status:'UNKNOWN',steps:[{status:'APP_CONFIRM',role:'trade'}]};
  const {get,calls}=await panel(active,undefined,{quickImmediate:true,orderDeferred:true});
  get('buy-presets').children[0].listeners.click[0]({isTrusted:true});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(get('buy').disabled,false);
  get('buy-presets').children[1].listeners.click[0]({isTrusted:true});
  assert.equal(calls.filter(c=>c.method==='trade.quick').length,2);
});

test('verified position event updates instantly and delayed wallet data cannot erase it',async()=>{
  const {get,emit}=await panel();
  const position={token:TOKEN,wallet:TOKEN,balance:'127.5',symbol:'TEST',blockNumber:102,confirmedAt:Date.now()};
  emit({type:'agent-position-update',position});assert.match(get('holding-balance').textContent,/127.5/);
  await new Promise(r=>setImmediate(r));assert.match(get('holding-balance').textContent,/127.5/);
  emit({type:'agent-position-update',position:{...position,balance:'1',blockNumber:101}});assert.match(get('holding-balance').textContent,/127.5/);
  emit({type:'agent-position-update',position:{...position,wallet:'0x'+'1'.repeat(40),balance:'999',blockNumber:103}});assert.match(get('holding-balance').textContent,/127.5/);
});
