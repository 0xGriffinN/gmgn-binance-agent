(() => {
  const defaults = () => [
    {buy:['0.01','0.02','0.05','0.1'],sell:['10','25','50','100']},
    {buy:['0.001','0.003','0.005','0.01'],sell:['10','25','50','100']},
    {buy:['0.025','0.05','0.075','0.1'],sell:['10','25','50','100']}
  ];
  function values(text,side,max='0.1') {
    const list=String(text).split(/[,，\s]+/).filter(Boolean);
    if(!list.length||list.length>8)throw new Error('每组请输入 1–8 个快捷数值');
    for(const v of list){
      if(!/^(0|[1-9]\d*)(\.\d+)?$/.test(v)||!Number.isFinite(Number(v))||Number(v)<=0)throw new Error('快捷数值必须是大于 0 的普通小数');
      if((v.split('.')[1]||'').length>(side==='buy'?18:2))throw new Error('快捷数值的小数位过多');
      if(Number(v)>Number(side==='buy'?max:100))throw new Error(side==='buy'?`买入快捷数值不能超过 ${max} BNB`:'卖出比例不能超过 100%');
    }
    return [...new Set(list)];
  }
  globalThis.AgentPresets={defaults,values,load(input){
    const result=defaults();
    if(Array.isArray(input))for(let i=0;i<3;i++)try{if(input[i])result[i]={buy:values(input[i].buy.join(','),'buy','1000000'),sell:values(input[i].sell.join(','),'sell')};}catch{}
    return result;
  }};
})();
