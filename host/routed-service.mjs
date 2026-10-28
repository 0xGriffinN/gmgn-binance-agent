import { Service } from './service.mjs';
import { Router } from './routes/router.mjs';
import { ZERO,WBNB,ERC,same,raw,fmt,percent,contractStep,expiryMs } from './routes/chain.mjs';
import { BNB,requireThat,tradeInput,safeOrder,address } from './domain.mjs';
import { QuickFlow } from './quick-flow.mjs';
import { ReadCache } from './read-cache.mjs';
import { SupplyBuy,supplyPct } from './supply-buy.mjs';
import { TradeQueue } from './trade-queue.mjs';
import { positionLedger } from './position-ledger.mjs';
import { rpcPools } from './routes/rpc-pools.mjs';
import { verifyRelayedMarket } from './market-receipt.mjs';
import { WalletState } from './wallet-state.mjs';
import { recoverMarketOrder } from './recover-market-order.mjs';
const FINAL=new Set(['FINISHED','PARTIAL','FAILED','NOT_SUBMITTED','MANUALLY_RECONCILED']);
const publicPreview=data=>({parsedTx:data.parsedTx,risks:data.risks,simulationResult:data.simulationResult,requireConfirmation:data.requireConfirmation,expiresAt:data.expiresAt});
export class RoutedService extends Service {
  constructor(wallet,journal,cfg={},router){
    super(wallet,journal,cfg);const pools=rpcPools(cfg);
    this.router=router||new Router(wallet,{...cfg,rpcUrls:pools.trade,rpcPurpose:'trade'});
    this.viewRouter=router||new Router(wallet,{...cfg,rpcUrls:pools.read,rpcPurpose:'read'});
    // Share platform hints and official read-only funding quotes, not RPC jobs.
    this.viewRouter.knownRoutes=this.router.knownRoutes;this.viewRouter.fundingReads=this.router.fundingReads;
    this.mutating=new Set();this.quickFlow=new QuickFlow(this);this.reads=new ReadCache();this.queue=new TradeQueue(this);
    this.walletState=new WalletState(async()=>{
      const [owner,lock,settings]=await Promise.all([super.owner(),this.wallet.cli(['wallet','tx-lock','--binanceChainId','56']),this.wallet.cli(['wallet','settings'])]);
      if(this.observedOwner&&!same(this.observedOwner,owner))this.reads.clear();
      this.observedOwner=owner;return {owner,lock,settings};
    });
  }
  startBackgroundState(){
    if(this.stateTimer)return;
    this.backgroundState=true;
    const refresh=()=>{if(!this.mutating.size)void this.walletState.get({force:true}).then(s=>this.prewarmContext(s.owner)).catch(()=>{this.reads.clear();});};
    refresh();this.stateTimer=setInterval(refresh,5000);this.stateTimer.unref?.();
  }
  stopBackgroundState(){clearInterval(this.stateTimer);this.stateTimer=null;this.backgroundState=false;this.invalidateWalletState();}
  invalidateWalletState(){this.walletState.invalidate();for(const key of ['prepare-owner','poll-owner','developer'])this.reads.values.delete(key);}
  async owner(){return this.backgroundState?(await this.walletState.get()).owner:super.owner();}
  async walletLock(){return this.backgroundState?(await this.walletState.get()).lock:this.wallet.cli(['wallet','tx-lock','--binanceChainId','56']);}
  async requireWalletUnlocked(lock,owner){
    if(lock.status==='UNLOCKED')return;
    // A cached locked result must not reject a click after the user approved.
    const [current,currentOwner]=await Promise.all([this.wallet.cli(['wallet','tx-lock','--binanceChainId','56']),super.owner()]);
    requireThat(same(currentOwner,owner),'WALLET_CHANGED','钱包已切换，未提交本次交易');
    this.invalidateWalletState();
    if(current.status==='UNLOCKED')return;
    requireThat(current.status==='LOCKED','WALLET_LOCKED','币安钱包状态暂无法确认，本次未提交；请稍后查单');
    const [history,orders]=await Promise.allSettled([
      this.wallet.cli(['wallet','tx-history','--type','pending','--binanceChainId','56','--size','20']),
      this.wallet.cli(['market-order','list','--status','PENDING','--binanceChainId','56','--pageSize','20'])
    ]);
    const h=history.status==='fulfilled'?history.value:null,o=orders.status==='fulfilled'?orders.value:null;
    const empty=Array.isArray(h?.transactions)&&h.transactions.length===0&&h.hasMore===false&&Array.isArray(o?.list)&&o.list.length===0&&Number(o.total)===0;
    const pending=(Array.isArray(h?.transactions)&&h.transactions.length>0)||(Array.isArray(o?.list)&&o.list.length>0);
    requireThat(false,'WALLET_LOCKED',empty?'币安仍返回钱包锁定，但未查到待处理交易；可能锁状态尚未同步。本次未提交，不会自动补单':pending?'币安钱包锁定，仍有待处理订单；请在 App 查看订单或风险确认。本次未提交':'币安钱包仍锁定，待处理订单查询未完成；暂无法确认原因，本次未提交');
  }
  async prewarmContext(owner){
    const input=this.warmInput;if(!input||this.warmJob||this.mutating.size)return;
    this.warmJob=true;
    try{
      const routeJob=this.viewRouter.detect(input.token,owner,{force:true}).then(async route=>{
        // Verified read-only route hint; submit still checks the current contract and stage.
        this.router.reads.values.set(`route:${input.token.toLowerCase()}`,{at:Date.now(),value:route});
        if(route.quote&&!same(route.quote,ZERO)&&!same(route.quote,WBNB))await this.viewRouter.fundingQuote(route.quote,input.amount,{slippage:input.slippage});
      });
      await Promise.allSettled([routeJob,this.reads.get(`audit:${owner}:${input.token}`,15000,()=>this.wallet.audit(input.token)),this.viewRouter.tokenMeta(input.token)]);
    }finally{this.warmJob=false;}
  }
  async developer(force=false){
    const s=this.backgroundState?(await this.walletState.get()).settings:await this.reads.get('developer',5000,()=>this.wallet.cli(['wallet','settings']),{force});
    requireThat(s.devMode?.enabled===true&&(!s.devMode.expiresAt||expiryMs(s.devMode.expiresAt)>Date.now()),'DEVELOPER_MODE','此路由需要开发者模式：币安 App → Agentic Wallet → 设置 → 开发者模式，开启后重新报价');
  }
  async walletSettings(){return this.backgroundState?(await this.walletState.get()).settings:this.reads.get('developer',5000,()=>this.wallet.cli(['wallet','settings']));}
  async nativeBalance(owner){return this.router.chain.nativeBalance?{balance:fmt(await this.router.chain.nativeBalance(owner))}:this.balance(BNB);}
  async prepareSupply(input){
    const run=()=>this.prepareSupplyStep(input);
    return this.router.chain.withReadScope?this.router.chain.withReadScope(run):run();
  }
  async prepareSupplyStep(input){
    const startedAt=Date.now(),plan=await new SupplyBuy(this).plan(input),supplyPlanMs=Date.now()-startedAt,p=await this.prepare(plan.input);
    requireThat(same(p.owner,plan.owner),'WALLET_CHANGED','筹码计算期间钱包切换，已停止');
    const meta=await this.router.tokenMeta(p.input.token);
    p.buyTarget={...plan.buyTarget,estimatedTokens:p.quote.toCoinAmount,estimatedPct:supplyPct(raw(p.quote.toCoinAmount,meta.decimals),raw(plan.buyTarget.supply,meta.decimals))};
    p.prepareTiming={...p.prepareTiming,supplyPlanMs};p.prepareMs=Date.now()-startedAt;return p;
  }
  async snapshot(input={}) {
    const key=`snapshot:${input.token||''}`;
    return this.reads.get(key,0,()=>this.loadSnapshot(input));
  }
  async routeView(input){
    requireThat(input.chainId==='56','UNSUPPORTED_CHAIN','当前版本只支持 BSC');
    const token=address(input.token),started=Date.now(),route=await this.viewRouter.detect(token,undefined,{force:input.force===true});
    return {token,platform:route.platform,kind:route.kind,stage:route.stage,quote:route.quote,identifyMs:Date.now()-started};
  }
  async loadSnapshot(input={}) {
    const router=this.viewRouter;
    if(input.token)this.warmInput={token:address(input.token),amount:typeof input.amount==='string'&&/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(input.amount)&&Number(input.amount)>0?input.amount:'0.01',slippage:input.slippage||'auto'};
    const routeJob=input.token?router.detect(address(input.token)).then(route=>({route}),error=>({error})):null;
    if(routeJob)void routeJob.then(({route})=>{
      if(!route?.quote||same(route.quote,ZERO)||same(route.quote,WBNB)||!router.fundingQuote)return;
      const budget=typeof input.amount==='string'&&/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(input.amount)&&Number(input.amount)>0?input.amount:'0.01';
      return router.fundingQuote(route.quote,budget,{slippage:input.slippage||'auto'});
    }).catch(()=>{});
    const metaJob=input.token?router.tokenMeta(input.token).catch(()=>null):null;
    const [view,meta]=await Promise.all([super.snapshot(input),metaJob]);
    if(input.token&&meta)view.token={address:input.token,symbol:meta.symbol,decimals:meta.decimals};
    if(view.status==='CONNECTED'&&input.token){
      this.reads.values.set('prepare-owner',{at:Date.now(),value:view.address});
      void this.reads.get(`audit:${view.address}:${input.token}`,15000,()=>this.wallet.audit(input.token)).catch(()=>{});
      try{const result=await routeJob;if(result.error)throw result.error;const route=result.route;view.route={platform:route.platform,kind:route.kind,stage:route.stage,quote:route.quote};
        if(route.platform==='flap'&&route.kind==='agent'&&route.stage==='inner'){const shares=await router.flap.shares(route,view.address);view.holding={address:input.token,balance:fmt(shares),symbol:'曲线份额',price:'0',value:'0'};}
        else if(meta&&router.chain.holding){
          try{
          const holding=await router.chain.holding(input.token,view.address),balance=fmt(BigInt(holding.balanceRaw),meta.decimals),old=view.holding;
          view.holding={...old,address:input.token,symbol:meta.symbol,balance,source:'chain',blockNumber:holding.blockNumber,
            value:raw(balance,meta.decimals)===0n?'0':Number(old?.price)>0?String(Number(balance)*Number(old.price)):null};
          }catch{view.holding=null;view.holdingError='链上余额暂未核实';}
        }
      }catch(e){view.routeError=e.message;}
      if(view.holding&&meta)try{view.accounting=positionLedger(await this.journal.list(0),{wallet:view.address,token:input.token,decimals:meta.decimals,balance:view.holding.balance,value:view.holding.value,nativePrice:view.native?.price});}catch{view.accounting={reason:'成交记录暂不可核对'};}
    }return view;
  }
  async prepare(rawInput,workflow=null) {
    const run=()=>this.prepareStep(rawInput,workflow);
    return this.router.chain.withReadScope?this.router.chain.withReadScope(run):run();
  }
  async prepareStep(rawInput,workflow=null) {
    const startedAt=Date.now(),prepareTiming={};let phaseAt=startedAt;
    const mark=name=>{const now=Date.now();prepareTiming[name]=now-phaseAt;phaseAt=now;};
    const input=tradeInput(rawInput),owner=await this.reads.get('prepare-owner',10000,()=>this.owner());
    const active=await this.journal.active();
    requireThat(!active||workflow&&active.id===workflow.id,'INFLIGHT','已有未确认流程，请先查单或继续该流程');
    if(workflow)requireThat(same(owner,workflow.wallet),'WALLET_CHANGED','请连接原钱包后继续');
    if(input.side==='buy')requireThat(raw(input.amount)<=raw(this.cfg.maxBuyBnb||'0.1'),'BUY_LIMIT','超过本地单笔买入上限');
    mark('identityMs');
    const routeJob=this.router.detect(input.token,owner);
    // All are read-only. Start them together; failures are joined before any preview/submit.
    const safetyJob=Promise.allSettled([input.side==='buy'?this.reads.get(`audit:${owner}:${input.token}`,15000,()=>this.wallet.audit(input.token)):Promise.resolve({available:true,trusted:true,hits:[]}),this.nativeBalance(owner),routeJob.then(r=>r.stage==='inner'?this.developer():undefined)]);
    const [initialRoute,meta]=await Promise.all([routeJob,this.router.tokenMeta(input.token)]);
    let route=initialRoute;
    let amount=input.amount;
    if(input.side==='sell'){
      let balance;
      if(route.platform==='flap'&&route.kind==='agent'&&route.stage==='inner')balance=await this.router.flap.shares(route,owner);
      else if(route.kind==='fair'&&route.stage==='inner')balance=0n; // fair adapter uses positions(), not ERC20 holdings.
      else balance=await this.router.chain.balance(input.token,owner);
      amount=fmt(percent(balance,input.percent),meta.decimals);
    }
    mark('contextMs');
    let built;
    if(workflow?.afterSell)built=await this.sweep(workflow,input);
    else{
      const routedInput={...input,_funded:workflow?.funded||{},_fundingPlans:workflow?.fundingPlans||{}};
      try{built=await this.router.build(route,routedInput,owner,amount);}
      catch(e){
        if(route.stage!=='inner'||workflow?.steps?.some(s=>s.role==='trade'))throw e;
        const next=await this.router.detect(input.token,owner,{force:true});
        if(next.stage!=='outer'||next.platform!==route.platform)throw e;
        route=next;built=await this.router.build(route,routedInput,owner,amount);
      }
    }
    const safety=await safetyJob;for(const r of safety)if(r.status==='rejected')throw r.reason;
    const [audit,native]=safety.map(r=>r.value);
    requireThat(audit.riskLevel!==5,'AUDIT_BLOCKED','币安安全审计返回最高风险等级 5，已阻止');
    const step=built.step;
    requireThat(step,'NO_STEP','未生成可执行步骤');
    if(step.role==='trade'){
      if(input.side==='sell'&&route.kind!=='fair')step.sellAmount=amount;
      if(input.side==='buy')step.costBnbEstimate=input.amount;
    }
    requireThat(built.out&&raw(String(built.out),36)>0n,'NO_QUOTE','路由未返回有效的预计到账数量');
    const gasReserve=raw(this.cfg.gasReserveBnb||'0.00005');
    const payment=step.kind==='market'&&same(step.fromToken,BNB)?raw(step.amount):step.kind==='contract'?BigInt(step.value):0n;
    requireThat(raw(native.balance)>=payment+gasReserve,'INSUFFICIENT_BNB','BNB 不足以支付当前步骤并保留 Gas');
    if(input.side==='buy')requireThat(BigInt(workflow?.spentBnb||'0')+payment<=raw(input.amount),'BUDGET_EXCEEDED','继续此步骤会超过原始 BNB 预算，已停止；已兑换资产留在钱包');
    const receive=built.receive||step.toToken||BNB;
    mark('routeBuildMs');
    const symbolJob=(same(receive,ZERO)||same(receive,BNB)?Promise.resolve('BNB'):this.router.tokenMeta(receive).then(m=>m.symbol)).then(value=>({value}),error=>({error}));
    let contractPreview=null;
    if(step.kind==='contract'){
      if(route.stage!=='inner')await this.developer();
      contractPreview=await this.wallet.cli(['contract-call','preview','--binanceChainId','56','--from',owner,'--to',step.to,'--value',step.value,'--inputData',step.inputData],65000);
      requireThat(contractPreview.requestId,'NO_PREVIEW','合约预览未返回 requestId，无法执行');
      const simulation=contractPreview.simulationResult;
      requireThat(!simulation?.simulationErrorDetail&&(!simulation?.simulationCode||/^0+$/.test(String(simulation.simulationCode))||simulation.simulationCode==='SUCCESS'),'SIMULATION_FAILED',simulation?.simulationErrorDetail||`钱包模拟未通过：${simulation?.simulationCode}`);
      step.requestId=contractPreview.requestId;
    }
    const symbolResult=await symbolJob;if(symbolResult.error)throw symbolResult.error;const receiveSymbol=symbolResult.value;
    mark('previewMs');
    const p={id:crypto.randomUUID(),rootId:workflow?.id,revision:workflow?.revision||0,owner,input,amount,createdAt:Date.now(),expiresAt:Date.now()+45000,
      route:{platform:route.platform,kind:route.kind,stage:route.stage,target:route.pad||route.market||route.info?.contracts?.core,quote:route.quote,label:built.route},step,receive,audit,note:built.note,
      quote:{fromCoinSymbol:input.side==='buy'?'BNB':meta.symbol,fromCoinAmount:input.side==='buy'?input.amount:amount,toCoinSymbol:receiveSymbol,toCoinAmount:built.out,slippage:input.slippage==='auto'?(step.kind==='market'?step.quote.slippage:0.01):Number(input.slippage)/100},
      contractPreview:contractPreview?publicPreview(contractPreview):null,prepareMs:Date.now()-startedAt,prepareTiming};
    if(contractPreview?.expiresAt){const t=expiryMs(contractPreview.expiresAt);requireThat(Number.isFinite(t)&&t>Date.now(),'PREVIEW_EXPIRED','钱包合约预览已过期');p.expiresAt=Math.min(p.expiresAt,t);}
    this.previews.set(p.id,p);return p;
  }
  async sweep(row,input){
    const {token,amount}=row.afterSell;
    if(same(token,WBNB))return {route:'卖出所得 WBNB → BNB',out:fmt(BigInt(amount)),receive:ZERO,step:contractStep('将本次卖出所得 WBNB 解包',WBNB,ERC,'withdraw',[BigInt(amount)],0n,'settle')};
    const meta=await this.router.chain.meta(token);
    try{const step=await this.router.market(token,BNB,fmt(BigInt(amount),meta.decimals),input,'本次卖出所得 → BNB','settle');return {route:'卖出结算',out:step.quote.toCoinAmount,receive:BNB,step};}
    catch(e){if(!/one side must be a supported stablecoin|Unsupported token pair for Ondo/i.test(e.message))throw e;
      const step=await this.router.market(token,'0x55d398326f99059fF775485246999027B3197955',fmt(BigInt(amount),meta.decimals),input,'卖出结算 → USDT 中转','settle-mid');
      return {route:'卖出结算 · USDT 中转',out:step.quote.toCoinAmount,receive:step.toToken,step};}
  }
  async continueOrder(input){
    const row=await this.journal.get(input.id);
    requireThat(row&&!row.blocked&&['WAITING_NEXT','PAUSED'].includes(row.status),'NOT_READY','此流程当前不能继续，需要先核对已提交步骤');
    return this.prepare(row.input,row);
  }
  async publishPosition(row,step,receipt){
    if(step.role!=='trade'||step.status!=='FINISHED'||receipt.status!==1||!Number.isSafeInteger(receipt.blockNumber)||!this.viewRouter.chain.balanceAt)return;
    if(step.route?.platform==='flap'&&step.route?.kind==='agent'&&step.route.stage==='inner')return;
    const router=this.viewRouter;
    const [balance,meta]=await Promise.all([router.chain.balanceAt(row.token,row.wallet,receipt.blockNumber),router.tokenMeta(row.token)]);
    this.journal.onPosition?.({wallet:row.wallet,token:row.token,balance:fmt(balance,meta.decimals),symbol:meta.symbol,decimals:meta.decimals,
      blockNumber:receipt.blockNumber,txHash:step.txHash,source:'receipt-block',confirmedAt:step.confirmedAt});
  }
  async submit(input){
    const p=this.previews.get(input.previewId);
    if(!p){const old=(await this.journal.list()).find(r=>r.previewIds?.includes(input.previewId));if(old)return old;}
    requireThat(p&&p.expiresAt>Date.now(),'QUOTE_EXPIRED','报价已过期，请重新报价或继续流程');
    requireThat(input.confirmed===true,'NOT_CONFIRMED','请明确确认此步骤');
    requireThat(p.audit.available||input.acknowledgeUnavailable===true,'AUDIT_ACK','请明确确认安全审计不可用');
    let row=p.rootId?await this.journal.get(p.rootId):null;
    if(row?.previewIds?.includes(p.id))return row;
    const id=row?.id||p.id;
    requireThat(!this.mutating.has(id),'INFLIGHT','当前流程正在处理');this.mutating.add(id);
    let sending=false,locked=false,claimed=false;
    try{
      if(row)requireThat(['WAITING_NEXT','PAUSED'].includes(row.status)&&row.revision===p.revision,'STEP_CHANGED','流程已变化，请重新继续');
      else{row={id,createdAt:Date.now(),wallet:p.owner,chainId:'56',token:p.input.token,side:p.input.side,input:p.input,amount:p.amount,buyTarget:p.buyTarget,queueId:p.queueId,requestedAt:p.requestedAt,revision:0,steps:[],previewIds:[],funded:{},spentBnb:'0',status:'VALIDATING'};await this.journal.lock(id,row);locked=true;}
      await this.journal.claimStep(id,p.id);claimed=true;
      if(p.rootId){row=await this.journal.get(id);requireThat(['WAITING_NEXT','PAUSED'].includes(row.status)&&row.revision===p.revision,'STEP_CHANGED','流程已变化，请重新查单');}
      if(p.rootId){
        const active=await this.journal.active();
        requireThat(!active||active.id===id,'INFLIGHT','另一笔交易正在处理，请稍后继续结算');
        if(!active){await this.journal.lock(id,row);locked=true;}
      }
      if(input.quick===true&&(!row.quick||input.renewQuick))row.quick={expiresAt:Date.now()+20*60000,acknowledgeUnavailable:input.acknowledgeUnavailable===true};
      const validationAt=Date.now();
      const spendToken=p.step.spendToken||(p.step.kind==='market'&&!same(p.step.fromToken,BNB)?p.step.fromToken:null);
      const spendJob=spendToken?Promise.all([this.router.tokenMeta(spendToken),this.router.chain.balance(spendToken,p.owner)]):Promise.resolve(null);
      const [owner,lock,route,native,blockBefore,beforeNonce,spend]=await Promise.all([this.owner(),this.walletLock(),this.router.recheck?this.router.recheck(p.route,p.input.token,p.owner):this.router.detect(p.input.token,p.owner,{force:true}),this.nativeBalance(p.owner),this.router.chain.block(),p.step.kind==='contract'&&this.router.chain.nonce?this.router.chain.nonce(p.owner):Promise.resolve(null),spendJob,p.step.kind==='contract'?this.developer(true):Promise.resolve()]);
      requireThat(same(owner,p.owner),'WALLET_CHANGED','钱包已切换');
      await this.requireWalletUnlocked(lock,p.owner);
      requireThat(route.platform===p.route.platform&&route.kind===p.route.kind&&route.stage===p.route.stage,'ROUTE_CHANGED','平台或内外盘阶段已变化，请重新预览');
      requireThat((route.pad||route.market||route.info?.contracts?.core||'').toLowerCase()===(p.route.target||'').toLowerCase()&&(route.quote||'').toLowerCase()===(p.route.quote||'').toLowerCase(),'ROUTE_CHANGED','平台合约或支付币已变化，请重新预览');
      requireThat(p.expiresAt>Date.now(),'QUOTE_EXPIRED','检查期间报价已过期，请重新预览');
      const payment=p.step.kind==='market'&&same(p.step.fromToken,BNB)?raw(p.step.amount):p.step.kind==='contract'?BigInt(p.step.value):0n;
      requireThat(raw(native.balance)>=payment+raw(this.cfg.gasReserveBnb||'0.00005'),'INSUFFICIENT_BNB','BNB 余额已变化，无法支付当前步骤');
      if(p.input.side==='buy')requireThat(BigInt(row.spentBnb)+payment<=raw(p.input.amount),'BUDGET_EXCEEDED','当前步骤将超出原始预算');
      if(spend)requireThat(spend[1]>=raw(p.step.spendAmount||p.step.amount,spend[0].decimals),'BALANCE_CHANGED','支付币余额已变化');
      const step={...p.step,previewId:p.id,status:'SUBMITTING',receive:p.receive,route:p.route,blockBefore,beforeNonce,createdAt:Date.now(),prepareMs:p.prepareMs,prepareTiming:p.prepareTiming,validationMs:Date.now()-validationAt};
      row.steps.push(step);row.previewIds.push(p.id);row.status='SUBMITTING';delete row.errorCode;row.revision++;row.updatedAt=Date.now();row.message=`提交步骤：${step.label}`;
      await this.journal.save(row);sending=true;
      this.invalidateWalletState();
      const response=step.kind==='contract'?await this.wallet.cli(['contract-call','execute','--requestId',step.requestId],310000):await this.wallet.cli(['market-order','swap','--fromTokenQty',step.amount,'--fromToken',step.fromToken,'--toToken',step.toToken,'--binanceChainId','56','--slippage',p.input.slippage,'--mev',String(p.input.mev),'--gasLevel',p.input.gasLevel],310000);
      step.orderId=response.orderId?String(response.orderId):null;step.txHash=response.txHash||null;
      step.submittedAt=Date.now();step.submitMs=step.submittedAt-step.createdAt;
      step.status=response.status==='PENDING_CONFIRMATION'?'APP_CONFIRM':step.txHash||step.orderId?'PENDING':'UNKNOWN';
      row.status=step.status;row.message=step.status==='APP_CONFIRM'?'请在币安 App 审批；不会自动重发':step.status==='UNKNOWN'?'提交结果未知，请先核对':`${step.label}已提交，等待链上确认${row.quick?'，随后自动继续':''}`;
      await this.journal.save(row);return row;
    }catch(e){
      if(!row||!claimed)throw e;
      if(e.code==='STEP_CHANGED')throw e;
      row.status=sending?'UNKNOWN':row.steps.length?'PAUSED':'NOT_SUBMITTED';row.message=e.message;row.errorCode=e.code;row.updatedAt=Date.now();
      row.revision++;
      await this.journal.save(row);if(locked&&!sending&&!row.steps.length)await this.journal.unlock(id);return row;
    }finally{this.invalidateWalletState();this.previews.delete(p.id);this.mutating.delete(id);if(claimed)await this.journal.releaseStep(id,p.id);}
  }
  async refreshOrder(input){
    let row=await this.journal.get(input.id);requireThat(row,'NOT_FOUND','找不到订单');
    if(!row.steps)return super.refreshOrder(input);
    if(FINAL.has(row.status)||['WAITING_NEXT','PAUSED'].includes(row.status))return row;
    if(this.polling.has(row.id)||this.mutating.has(row.id))return row;this.polling.add(row.id);
    const pollToken=`poll-${crypto.randomUUID()}`;let claimed=false;
    try{
      try{await this.journal.claimStep(row.id,pollToken);claimed=true;}catch(e){if(e.code==='STEP_BUSY')return row;throw e;}
      row=await this.journal.get(row.id);
      if(FINAL.has(row.status)||['WAITING_NEXT','PAUSED'].includes(row.status))return row;
      const step=row.steps.at(-1);if(!step)return row;
      if(step.status==='FINISHED')return row;
      if(step.kind==='market'&&!step.orderId){
        requireThat(same(await this.owner(),row.wallet),'WALLET_CHANGED','请连接原钱包后查单');
        const data=await this.wallet.cli(['market-order','list','--binanceChainId','56','--fromToken',step.fromToken,'--toToken',step.toToken,'--startTime',String(step.createdAt-2000),'--endTime',String(step.createdAt+30000),'--pageSize','100']);
        const decimals=same(step.fromToken,BNB)?18:(await this.router.tokenMeta(step.fromToken)).decimals;
        const records=await this.journal.list(0),usedIds=new Set(records.flatMap(r=>(r.steps||[]).filter(s=>s.orderId).map(s=>String(s.orderId))));
        const match=recoverMarketOrder(data,step,decimals,usedIds);
        if(!match)return row;
        step.orderId=String(match.orderId);step.recoveredOrderId=true;
        await this.journal.save(row);
      }
      const knownHash=step.txHash;
      const pollTiming={};
      const timed=async(name,fn)=>{const at=Date.now();try{return await fn();}finally{pollTiming[name]=(pollTiming[name]||0)+Date.now()-at;}};
      const confirmation=hash=>timed('rpcMs',()=>this.router.chain.confirmation?this.router.chain.confirmation(hash):Promise.all([this.router.chain.receipt(hash),this.router.chain.transaction(hash)]));
      // Wallet lookup and chain confirmation run together, never wait on the CLI to begin RPC.
      const checks=await Promise.allSettled([
        timed('identityMs',()=>this.reads.get('poll-owner',5000,()=>this.owner())),
        step.kind==='market'&&step.orderId?timed('walletOrderMs',()=>this.wallet.cli(['market-order','list','--orderId',step.orderId])):Promise.resolve(null),
        knownHash?confirmation(knownHash):Promise.resolve(null)
      ]);
      for(const c of checks)if(c.status==='rejected')throw c.reason;
      requireThat(same(checks[0].value,row.wallet),'WALLET_CHANGED','请连接原钱包后查单');
      if(step.kind==='market'&&step.orderId){
        const data=checks[1].value;const r=data.list?.find(x=>String(x.orderId)===step.orderId);
        if(!r)return row;
        requireThat(String(r.chain)==='56'&&same(r.fromToken,step.fromToken)&&same(r.toToken,step.toToken),'ORDER_MISMATCH','订单链或交易对不匹配');
        step.result=safeOrder(r);step.txHash=r.txHash||step.txHash;
        if(r.status==='FAILED'){step.status='FAILED';row.status=row.steps.length>1?'PARTIAL':'FAILED';row.message='当前步骤失败，后续未执行；已完成步骤的资产保留在钱包';row.updatedAt=Date.now();this.invalidateWalletState();await this.journal.save(row);await this.journal.unlock(row.id);return row;}
        if(r.status!=='FINISHED'&&!step.txHash){
          const lock=await this.walletLock();
          row.status=lock.status==='LOCKED'?'APP_CONFIRM':'PENDING';step.status=row.status;
          row.message=lock.status==='LOCKED'?'币安订单等待 App 处理，请查看风险提示或审批；后台持续查单，不会重复提交':'币安订单处理中，后台持续核对；不会重复提交';
          await this.journal.save(row);return row;
        }
      }
      if(!step.txHash&&step.kind==='contract')step.txHash=await this.findContractHash(row,step);
      if(!step.txHash){
        if(row.status==='APP_CONFIRM'&&Date.now()-step.createdAt>20*60000){row.status='UNKNOWN';row.message='App 审批结果尚未识别，请核对订单或补充交易哈希；不会重复提交';await this.journal.save(row);}
        return row;
      }
      const [receipt,transaction]=knownHash===step.txHash&&checks[2].value?checks[2].value:await confirmation(step.txHash);if(!receipt)return row;
      step.pollTiming=pollTiming;
      requireThat(transaction,'TX_MISSING','交易详情暂未查到，请继续核对');
      const relayed=!same(transaction.from,row.wallet);
      if(relayed){
        requireThat(step.kind==='market','TX_OWNER','交易发送钱包不匹配');
        const [meta,outMeta]=await Promise.all([this.router.tokenMeta(step.fromToken),this.router.tokenMeta(step.toToken)]);
        const proof=verifyRelayedMarket(row,step,transaction,receipt,meta.decimals,outMeta.decimals);step.relayed=true;
        if(proof.inputRemainderRaw){step.actualInputAmount=fmt(BigInt(proof.spentRaw),meta.decimals);step.inputRemainderRaw=proof.inputRemainderRaw;step.inputRemainderAmount=fmt(BigInt(proof.inputRemainderRaw),meta.decimals);step.inputSymbol=meta.symbol;}
      }
      if(step.kind==='contract')requireThat(same(transaction.to,step.to)&&same(transaction.data,step.inputData)&&transaction.value===BigInt(step.value),'TX_MISMATCH','链上交易与已确认步骤不一致');
      if(receipt.status!==1){step.status='FAILED';row.status=row.steps.length>1?'PARTIAL':'FAILED';row.message='当前步骤链上回滚，后续未执行';await this.journal.save(row);await this.journal.unlock(row.id);return row;}
      if(relayed){step.gasFeeRaw='0';step.gasPaidBy='relayer';}
      else if(receipt.fee!=null)step.gasFeeRaw=String(receipt.fee);
      else if(receipt.gasUsed!=null&&receipt.gasPrice!=null)step.gasFeeRaw=String(BigInt(receipt.gasUsed)*BigInt(receipt.gasPrice));
      let received=0n,asset=step.kind==='market'?step.toToken:step.role==='funding'?step.toToken:step.receive;
      if(asset&&!same(asset,ZERO)&&!same(asset,BNB))received=this.router.chain.transfers(receipt,asset,row.wallet);
      if(step.kind==='market'&&step.result?.status!=='FINISHED'&&(same(asset,ZERO)||same(asset,BNB)))return row;
      step.status='FINISHED';step.receivedRaw=String(received);step.updatedAt=Date.now();
      step.confirmedAt=Date.now();step.confirmationMs=step.confirmedAt-(step.submittedAt||step.createdAt);
      const payment=step.kind==='market'&&same(step.fromToken,BNB)?raw(step.amount):step.kind==='contract'?BigInt(step.value):0n;
      row.spentBnb=String(BigInt(row.spentBnb)+payment);row.revision++;row.updatedAt=Date.now();
      if(step.role==='funding'){
        requireThat(received>0n,'NO_RECEIPT_AMOUNT','兑换已确认但未识别到账日志，暂不生成下一步');
        if(BigInt(step.existingContribution||0)>0n){received+=BigInt(step.existingContribution);requireThat(await this.router.chain.balance(asset,row.wallet)>=received,'FUNDING_CHANGED','原有支付币余额发生变化，请先核对');}
        row.funded[asset.toLowerCase()]=String(received);row.status='WAITING_NEXT';row.message='支付币已到账，请继续预览下一步';
        if(step.kind==='market'&&!same(step.fromToken,BNB))delete row.funded[step.fromToken.toLowerCase()];
        if(step.fundingPlan){row.fundingPlans||={};row.fundingPlans[step.fundingPlan.token.toLowerCase()]=step.fundingPlan;}
      }else if(['approval','claim'].includes(step.role)){row.status='WAITING_NEXT';row.message='当前步骤已确认，请继续预览下一步';}
      else if(step.role==='settle-mid'){requireThat(received>0n,'NO_RECEIPT_AMOUNT','中转到账数量未识别');row.afterSell={token:asset,amount:String(received)};row.status='WAITING_NEXT';row.message='中转币已到账，请继续结算为 BNB';}
      else if(row.side==='sell'&&row.input.sellToBnb!==false&&step.role==='trade'&&asset&&!same(asset,ZERO)&&!same(asset,BNB)){
        requireThat(received>0n,'NO_RECEIPT_AMOUNT','卖出已确认但到账数量未识别，请核对');
        const meta=await this.router.tokenMeta(asset);row.sellResult={token:asset,amount:fmt(received,meta.decimals),symbol:meta.symbol,txHash:step.txHash};
        row.afterSell={token:asset,amount:String(received)};row.status='WAITING_NEXT';row.message=`卖出已成交，收到 ${row.sellResult.amount} ${meta.symbol}；待换回 BNB`;
      }else{
        const unusedInput=row.steps.some(s=>BigInt(s.inputRemainderRaw||0)>0n);
        row.status=step.result?.refund?.length||unusedInput?'PARTIAL':'FINISHED';row.message=unusedInput?'流程已完成，部分支付币未使用并保留在钱包':row.status==='PARTIAL'?'已成交并存在退款':row.side==='sell'&&row.input.sellToBnb===false?'已卖出，支付币保留在钱包':'流程已完成';row.result={...(step.result||{}),txHash:step.txHash,toToken:asset,toTokenActualQty:received>0n?fmt(received,(await this.router.tokenMeta(asset)).decimals):step.result?.toTokenActualQty||null};
      }
      if(row.quick&&row.status==='WAITING_NEXT')row.message=`${step.label}已确认，自动执行下一步`;
      await this.journal.save(row);void this.publishPosition(row,step,receipt).catch(()=>{});
      if(FINAL.has(row.status))await this.journal.unlock(row.id);else if(row.quick&&row.status==='WAITING_NEXT')this.quickFlow.kick(row.id);return row;
    }catch(e){row.message=e.message;if(row.steps?.at(-1)?.status==='FINISHED'){row.blocked=true;row.status='PAUSED';}if(claimed)await this.journal.save(row);return row;}finally{this.polling.delete(row.id);if(claimed)await this.journal.releaseStep(row.id,pollToken);}
  }
  async findContractHash(row,step){
    const start=Math.max(0,(step.createdAt||row.createdAt)-60000);
    const history=await this.reads.get(`history:${row.wallet}:${start}`,1500,()=>this.wallet.cli(['wallet','tx-history','--binanceChainId','56','--size','100','--startTime',String(start)])).catch(()=>null);
    const records=history?.transactions||[],byId=step.orderId&&records.find(t=>String(t.orderId||'')===step.orderId);
    const exact=byId?.txHash||byId?.txHashList?.[0]?.txHash;
    if(/^0x[0-9a-fA-F]{64}$/.test(exact||''))return exact;
    // Older multi-step orders predate beforeNonce. A prior verified mined call
    // in this same workflow can provide a nonce lower bound without resubmission.
    if(!Number.isInteger(step.beforeNonce)){
      const previous=row.steps.slice(0,-1).reverse().find(s=>s.status==='FINISHED'&&s.kind==='contract'&&s.txHash);
      if(previous){
        const bound=await this.reads.get(`anchor:${row.wallet}:${previous.txHash}`,30000,async()=>{
          const [tx,rc]=await Promise.all([this.router.chain.transaction(previous.txHash),this.router.chain.receipt(previous.txHash)]);
          return tx&&rc?.status===1&&Number.isInteger(tx.nonce)&&tx.blockNumber<=step.blockBefore&&same(tx.from,row.wallet)&&same(tx.to,previous.to)&&same(tx.data,previous.inputData)&&tx.value===BigInt(previous.value)?tx.nonce+1:null;
        }).catch(()=>null);
        if(Number.isInteger(bound)){step.beforeNonce=bound;step.nonceRecoveredFrom=previous.txHash;}
      }
    }
    // Full calldata/value/address and nonce/block bounds must match uniquely.
    if(!Number.isInteger(step.beforeNonce))return null;
    const hashes=records.flatMap(t=>[t.txHash,...(t.txHashList||[]).map(x=>x.txHash)]).filter(h=>/^0x[0-9a-fA-F]{64}$/.test(h||''));
    if(step.approval&&this.router.chain.approvalHashes){
      const a=step.approval;
      const events=await this.reads.get(`approval-events:${row.id}:${step.previewId}`,1000,()=>this.router.chain.approvalHashes(a.token,row.wallet,a.spender,step.blockBefore)).catch(()=>[]);
      hashes.unshift(...events);
    }
    const previous=new Set(row.steps.slice(0,-1).map(s=>s.txHash));
    const candidates=[...new Set(hashes)].filter(h=>!previous.has(h)).slice(0,30);
    const checks=await Promise.all(candidates.map(async hash=>{
      const tx=await this.router.chain.transaction(hash).catch(()=>null);
      return tx&&tx.blockNumber>=step.blockBefore&&tx.nonce>=step.beforeNonce&&same(tx.from,row.wallet)&&same(tx.to,step.to)&&same(tx.data,step.inputData)&&tx.value===BigInt(step.value)?hash:null;
    }));
    const found=checks.filter(Boolean);requireThat(found.length<=1,'AMBIGUOUS_TX','发现多笔相同调用，请在订单中核对完整交易哈希');
    return found[0]||null;
  }
  async attachHash(input){
    const row=await this.journal.get(input.id),step=row?.steps?.at(-1);
    requireThat(row&&step&&['APP_CONFIRM','UNKNOWN','SUBMITTING','PENDING'].includes(row.status)&&step.kind==='contract'&&!step.txHash,'NOT_ATTACHABLE','此步骤不需要补充交易哈希');
    requireThat(/^0x[0-9a-fA-F]{64}$/.test(input.txHash),'INVALID_HASH','请输入完整交易哈希');
    requireThat(same(await this.owner(),row.wallet),'WALLET_CHANGED','请连接原钱包');
    const tx=await this.router.chain.transaction(input.txHash);
    requireThat(tx&&tx.blockNumber>=step.blockBefore&&same(tx.from,row.wallet)&&same(tx.to,step.to)&&same(tx.data,step.inputData)&&tx.value===BigInt(step.value),'TX_MISMATCH','此哈希与待确认交易不匹配');
    step.txHash=input.txHash;row.status='PENDING';await this.journal.save(row);const next=await this.refreshOrder({id:row.id});if(row.quick)this.quickFlow.kick(row.id);return next;
  }
  async dispatch(method,params){
    if(method.startsWith('auth.'))this.invalidateWalletState();
    if(method==='token.route')return this.routeView(params);
    if(method==='trade.quick')return this.queue.enqueue(params);
    if(method==='orders.cancel-queued')return this.queue.cancel(params);
    if(method==='orders.list'){const active=await this.journal.active(),queued=await this.queue.records();return {active,records:[...await this.journal.list(),...queued].sort((a,b)=>b.createdAt-a.createdAt).slice(0,50),queuedCount:queued.filter(r=>['QUEUED','QUEUE_STARTING'].includes(r.status)).length};}
    if(method==='orders.quick-resume')return this.quickFlow.resume(params);
    if(method==='orders.resolve'){const row=await this.journal.get(params.id);requireThat(!row?.steps,'MANUAL_REVIEW','多步骤流程不能按普通市价单解除锁，请先核对所有步骤和链上回执');}
    if(method==='orders.continue')return this.continueOrder(params);
    if(method==='orders.attach-hash')return this.attachHash(params);
    return super.dispatch(method,params);
  }
}
