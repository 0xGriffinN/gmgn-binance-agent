// Public chain reads and official read-only info only. No wallet execution.
import { mkdir,writeFile } from 'node:fs/promises';
import { config,Wallet,ROOT } from '../host/wallet.mjs';
import { Router } from '../host/routes/router.mjs';
const cfg=await config(),wallet=new Wallet(cfg),router=new Router(wallet,cfg),cases=[];
try{
  for(const [expected,token] of [['gang','0xaf21e620ff8df6042902e01e52cfbb22933abbbb'],['four','0x214b4342fb525323aa25a7ddf0076f1529824444'],['flap','0x6441633c0d5edb29e9afa50cdc9a61304b9d7777']]){
    const start=performance.now(),route=await router.detect(token,undefined,{force:true});
    const coldMs=Math.round(performance.now()-start),warm=performance.now();await router.detect(token);
    cases.push({expected,platform:route.platform,kind:route.kind,stage:route.stage,coldMs,cachedMs:Math.round(performance.now()-warm)});
  }
  const dir=ROOT+'/.local/identification-verification';await mkdir(dir,{recursive:true});
  const report={checkedAt:new Date().toISOString(),submittedTransactions:0,cases};
  await writeFile(dir+`/${process.argv[2]==='before'?'before':'after'}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{router.chain.providers.forEach(p=>p.destroy());}
