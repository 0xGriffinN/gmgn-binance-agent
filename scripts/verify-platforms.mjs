// Read-only live verification. The guard below rejects every fund-changing command.
import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config,Wallet,ROOT } from '../host/wallet.mjs';
import { Journal } from '../host/journal.mjs';
import { RoutedService } from '../host/routed-service.mjs';
const cfg=await config(),wallet=new Wallet(cfg),cli=wallet.cli.bind(wallet);
wallet.cli=async(args,...rest)=>{
  if(args[0]==='contract-call'&&args[1]==='execute'||args[0]==='market-order'&&args[1]==='swap'||args[0]==='wallet'&&args[1]==='send'||args[0]==='auth')throw new Error('只读验证禁止执行此命令');
  return cli(args,...rest);
};
const dir=join(ROOT,'.local','verification');await mkdir(dir,{recursive:true});
const journal=new Journal(join(dir,'journal'));await journal.init();
const service=new RoutedService(wallet,journal,cfg);
const cases=[{platform:'gang',token:'0xaf21e620ff8df6042902e01e52cfbb22933abbbb',amount:'0.005'},
  {platform:'four',token:'0x214b4342fb525323aa25a7ddf0076f1529824444',amount:'0.00001'},
  {platform:'flap',token:'0x6441633c0d5edb29e9afa50cdc9a61304b9d7777',amount:'0.00001'}];
const report={version:'0.5.11',checkedAt:new Date().toISOString(),mode:'read-only',submittedTransactions:0,cases:[]};
try{
  const owner=await service.owner();
  for(const item of cases){
    try{
      const p=await service.prepare({chainId:'56',token:item.token,side:'buy',amount:item.amount,slippage:'auto',mev:true,gasLevel:'MEDIUM'});
      report.cases.push({...item,route:p.route,step:p.step.label,quote:p.quote,prepareMs:p.prepareMs,simulation:p.contractPreview?.simulationResult?.simulationCode||null,auditAvailable:p.audit.available});
    }catch(e){report.cases.push({...item,error:e.message,code:e.code});}
  }
  report.journalRecords=(await journal.list()).length;
  await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{for(const router of [service.router,service.viewRouter])for(const p of router.chain.providers)p.destroy();}
