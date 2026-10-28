// Read-only: does not restore workflows or dispatch queued intents.
import { config,Wallet } from '../host/wallet.mjs';
import { RoutedService } from '../host/routed-service.mjs';
const cfg=await config(),wallet=new Wallet(cfg),cli=wallet.cli.bind(wallet);
const allowed=new Set(['wallet:status','wallet:address','wallet:balance','wallet:settings','market-order:quote']);
wallet.cli=(args,...rest)=>{if(!allowed.has(args.slice(0,2).join(':')))throw new Error('只读持仓验证禁止此命令');return cli(args,...rest);};
const service=new RoutedService(wallet,{dir:'unused-verification',list:async()=>[]},cfg);
try{
  const token=process.argv[2]||'0xaf21e620ff8df6042902e01e52cfbb22933abbbb',view=await service.snapshot({token});
  if(view.status!=='CONNECTED'||view.holding?.source!=='chain')throw new Error(view.holdingError||view.routeError||'链上持仓未核实');
  console.log(JSON.stringify({mode:'read-only',submittedTransactions:0,status:view.status,token,holding:{balance:view.holding.balance,symbol:view.holding.symbol,source:view.holding.source,blockNumber:view.holding.blockNumber},rpcPools:{read:service.viewRouter.chain.urls.length,trade:service.router.chain.urls.length,separateInstances:service.viewRouter.chain!==service.router.chain}},null,2));
}finally{for(const router of [service.router,service.viewRouter])for(const p of router.chain.providers)p.destroy();}
