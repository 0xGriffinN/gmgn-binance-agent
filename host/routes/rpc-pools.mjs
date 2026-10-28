const PUBLIC_READ=['https://bsc-dataseed.bnbchain.org','https://bsc-rpc.publicnode.com'];
const PUBLIC_TRADE=['https://bsc-dataseed1.bnbchain.org','https://bsc-dataseed2.bnbchain.org','https://bsc-dataseed1.defibit.io'];
function urls(value){
  return (Array.isArray(value)?value:typeof value==='string'?value.split(','):[]).map(s=>String(s).trim()).filter(Boolean).map(s=>{
    const u=new URL(s);if(!['https:','http:'].includes(u.protocol))throw new Error('RPC 地址必须使用 HTTP 或 HTTPS');return s;
  });
}
export function rpcPools(cfg={},env=process.env){
  const read=urls(cfg.rpcUrls),explicit=urls(env.TRADE_RPC_URL||cfg.tradeRpcUrls);
  const own=read.filter(s=>!/(publicnode|dataseed|bnbchain|nodereal|48\.club)/i.test(new URL(s).hostname));
  return {read:[...new Set(read.length?read:PUBLIC_READ)],trade:[...new Set([...(explicit.length?explicit:own),...PUBLIC_TRADE])]};
}
