// Read-only target-supply calculation and preview; execution methods are blocked.
import { mkdir,writeFile } from 'node:fs/promises';
import { config,Wallet,ROOT } from '../host/wallet.mjs';
import { Journal } from '../host/journal.mjs';
import { RoutedService } from '../host/routed-service.mjs';
const cfg=await config(),wallet=new Wallet(cfg),cli=wallet.cli.bind(wallet),four=wallet.four.bind(wallet);
if(process.argv[2]&&!['gang','four','flap'].includes(process.argv[2]))throw new Error('仅可选择 gang、four 或 flap');
wallet.cli=(a,...rest)=>{
  if(!(a[0]==='wallet'&&['status','address','settings','balance','tx-lock','tx-history'].includes(a[1])||a[0]==='market-order'&&a[1]==='quote'||a[0]==='contract-call'&&a[1]==='preview'))throw new Error('只读筹码验证禁止执行命令');
  return cli(a,...rest);
};
wallet.four=(command,...args)=>{if(!['info','quote-buy','quote-sell'].includes(command))throw new Error('只读筹码验证禁止执行命令');return four(command,...args);};
const dir=ROOT+'/.local/supply-verification';await mkdir(dir,{recursive:true});const journal=new Journal(dir+'/journal');await journal.init();
const service=new RoutedService(wallet,journal,cfg),report={version:'0.4.0',checkedAt:new Date().toISOString(),submittedTransactions:0,cases:[]};
try{
  for(const [platform,token,pctSupply] of [
    ['gang','0xaf21e620ff8df6042902e01e52cfbb22933abbbb','1'],
    ['four','0x214b4342fb525323aa25a7ddf0076f1529824444','1'],
    ['flap','0x6441633c0d5edb29e9afa50cdc9a61304b9d7777','2']
  ]){
    if(process.argv[2]&&platform!==process.argv[2])continue;
    try{
      const p=await service.prepareSupply({chainId:'56',token,side:'buy',amount:'0.003',pctSupply,slippage:'auto',mev:true,gasLevel:'MEDIUM'});
      report.cases.push({platform,token,pctSupply,budget:p.input.amount,target:p.buyTarget,step:p.step.label,simulation:p.contractPreview?.simulationResult?.simulationCode,prepareMs:p.prepareMs});
    }catch(e){report.cases.push({platform,token,pctSupply,error:e.message,code:e.code});}
  }
  report.journalRecords=(await journal.list()).length;await writeFile(dir+`/report${process.argv[2]?'-'+process.argv[2]:''}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{service.router.chain.providers.forEach(p=>p.destroy());}
