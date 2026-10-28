import test from 'node:test';
import assert from 'node:assert/strict';
import { FourIdentity,FOUR_REGISTRY,AGENT_PRESET } from '../host/routes/four.mjs';
import { Router } from '../host/routes/router.mjs';
import { firstVerified } from '../host/read-cache.mjs';
import { ethers,raw,ZERO } from '../host/routes/chain.mjs';
const TOKEN='0x214b4342fb525323aa25a7ddf0076f1529824444',CORE='0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3',VAULT='0x1234567890123456789012345678901234567890',QUOTE='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const encode=n=>ethers.zeroPadValue(ethers.toBeHex(n),32);
function fourFixture(){
  const state={core:CORE,phase:1,paused:false,active:true,preset:AGENT_PRESET,registryReads:0,tokenPhaseError:false};
  const chain={run:async fn=>fn({call:async({to,data})=>{
    if(to===FOUR_REGISTRY&&data==='0x7ba9413c'){state.registryReads++;return ethers.zeroPadValue(state.core,32);}
    if(data.startsWith('0xe4860339')){
      const w=Array(20).fill(0n);w[1]=BigInt(VAULT);w[2]=state.preset;w[6]=raw('1000000000');w[9]=BigInt(QUOTE);w[10]=BigInt(VAULT);w[17]=1n;w[18]=state.paused?1n:0n;return '0x'+w.map(n=>encode(n).slice(2)).join('');
    }
    if(data==='0x51d1b100'){if(state.tokenPhaseError)throw new Error('token phase unavailable');return encode(state.phase);}
    if(data==='0xb1c9fe6e')return encode(state.phase);
    if(data.startsWith('0x3c3ef33c'))return encode(state.active?1n:0n);
    throw new Error('unexpected call');
  }})};
  return {state,identity:new FourIdentity(chain)};
}
test('Four classification reads registry/config/phase without invoking the wallet helper',async()=>{
  const {state,identity}=fourFixture();const route=await identity.detect(TOKEN);
  assert.equal(route.platform,'four');assert.equal(route.stage,'inner');assert.equal(route.quote.toLowerCase(),QUOTE);assert.equal(route.info.curve.maxSupplyRaw,String(raw('1000000000')));
  state.phase=3;assert.equal((await identity.detect(TOKEN)).stage,'outer');assert.equal(state.registryReads,1);
});
test('Four pauses and inactive presets never become ordinary DEX fallback; force refresh notices a core upgrade',async()=>{
  const {state,identity}=fourFixture();state.paused=true;await assert.rejects(identity.detect(TOKEN),/暂停/);
  state.paused=false;state.active=false;await assert.rejects(identity.detect(TOKEN),/预设/);
  state.active=true;state.phase=2;await assert.rejects(identity.detect(TOKEN),/迁移/);
  state.phase=1;state.core=VAULT;const changed=await identity.detect(TOKEN,{force:true});assert.equal(changed.info.contracts.core.toLowerCase(),VAULT);assert.equal(state.registryReads,2);
});
test('Four tokenPhase fallback uses the configured vault and unrelated presets are not called Agent-exclusive',async()=>{
  const {state,identity}=fourFixture();state.tokenPhaseError=true;assert.equal((await identity.detect(TOKEN)).stage,'inner');
  state.preset=1n;assert.equal(await identity.detect(TOKEN),null);
});
test('verified platform result does not wait for unrelated never-finishing probes',async()=>{
  const pending=new Promise(()=>{}),proof={platform:'gang',kind:'v2',stage:'inner',pad:CORE,quote:QUOTE};
  assert.equal(await firstVerified([pending,Promise.resolve(proof),pending]),proof);
  await assert.rejects(firstVerified([Promise.resolve(null),Promise.reject(new Error('RPC unavailable'))]),/RPC unavailable/);
});
test('cached platform hints recheck the actual contract without rescanning all platforms or reading a wallet',async()=>{
  let full=0,checks=0,other=0;
  const router=new Router({four:()=>{throw new Error('no CLI for identification');}}, {},{});
  router.gang.detect=async()=>{full++;return {platform:'gang',kind:'v2',stage:'inner',pad:CORE,quote:QUOTE};};
  router.gang.check=async()=>{checks++;return {platform:'gang',kind:'v2',stage:'outer',pad:CORE,quote:QUOTE};};
  router.flap.detect=router.fourIdentity.detect=async()=>{other++;return null;};
  await router.detect(TOKEN,'wallet-1');await router.detect(TOKEN,'wallet-2');assert.equal(full,1);
  router.reads.clear();assert.equal((await router.detect(TOKEN)).stage,'outer');assert.equal(full,1);assert.equal(checks,1);assert.equal(other,2);
});
test('failed identity probes cannot silently classify an unknown token as ordinary DEX',async()=>{
  const router=new Router({}, {},{});router.gang.detect=router.flap.detect=async()=>null;router.fourIdentity.detect=async()=>{throw new Error('registry unavailable');};
  await assert.rejects(router.detect(TOKEN),/registry unavailable/);
});
