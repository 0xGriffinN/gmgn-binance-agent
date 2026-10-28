import { BNB,requireThat } from './domain.mjs';
import { ZERO,ethers,same,raw } from './routes/chain.mjs';
const TRANSFER=ethers.id('Transfer(address,address,uint256)');
// Some official aggregator routes use a relayer. The authenticated wallet order
// plus bounded outgoing and verified incoming logs bind it to its owner. Partial
// input additionally requires exact output agreement with the completed order.
export function verifyRelayedMarket(row,step,tx,receipt,fromDecimals,toDecimals){
  const r=step.result;
  requireThat(step.kind==='market'&&r?.status==='FINISHED'&&String(r.chain)==='56'&&step.orderId&&String(r.orderId)===String(step.orderId)&&
    same(r.txHash,step.txHash)&&same(tx?.hash,step.txHash)&&same(r.fromToken,step.fromToken)&&same(r.toToken,step.toToken)&&
    receipt.status===1&&Number.isSafeInteger(receipt.blockNumber)&&receipt.blockNumber>=step.blockBefore&&
    ![BNB,ZERO].some(a=>same(a,step.fromToken)||same(a,step.toToken)),'TX_OWNER','交易发送钱包不匹配，尚无完整的中继兑换凭据');
  const expected=raw(step.amount,fromDecimals);
  requireThat(raw(r.fromTokenQty,fromDecimals)===expected,'ORDER_AMOUNT','币安订单支付数量与本步骤不一致');
  let paid=0n,received=0n;
  for(const l of receipt.logs||[]){
    if(l.topics?.[0]!==TRANSFER||l.topics.length!==3)continue;
    const from='0x'+l.topics[1].slice(-40),to='0x'+l.topics[2].slice(-40);
    if(same(l.address,step.fromToken)&&same(from,row.wallet))paid+=BigInt(l.data);
    if(same(l.address,step.toToken)&&same(to,row.wallet))received+=BigInt(l.data);
  }
  const partial=paid>0n&&paid<expected&&Number.isInteger(toDecimals)&&typeof r.toTokenActualQty==='string'&&
    received===raw(r.toTokenActualQty,toDecimals);
  requireThat((paid===expected||partial)&&received>0n,'TX_OWNER','中继交易的实际扣款或到账不匹配，需继续核对');
  return {relayed:true,receivedRaw:String(received),...(partial?{spentRaw:String(paid),inputRemainderRaw:String(expected-paid)}:{})};
}
