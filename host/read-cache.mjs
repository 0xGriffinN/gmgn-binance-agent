// Only read results may enter this cache. Executions and receipts are never cached.
export class ReadCache {
  constructor(){this.values=new Map();this.jobs=new Map();}
  async get(key,ttl,read,{force=false}={}){
    const hit=this.values.get(key);
    if(!force&&hit&&Date.now()-hit.at<ttl)return hit.value;
    if(this.jobs.has(key))return this.jobs.get(key);
    const job=Promise.resolve().then(read).then(value=>{if(this.values.size>=512)this.values.delete(this.values.keys().next().value);this.values.set(key,{at:Date.now(),value});return value;}).finally(()=>this.jobs.delete(key));
    this.jobs.set(key,job);return job;
  }
  clear(){this.values.clear();}
}

// Return the first verified platform; a slow unrelated probe cannot delay it.
// If nothing matches, any probe failure remains an error rather than DEX proof.
export function firstVerified(jobs){
  return new Promise((resolve,reject)=>{
    if(!jobs.length)return resolve(null);
    let left=jobs.length;const errors=[];
    for(const [index,job] of jobs.entries())Promise.resolve(job).then(value=>{
      if(value)resolve(value);
    },error=>{errors[index]=error;}).finally(()=>{
      if(--left===0){const error=errors.find(Boolean);if(error)reject(error);else resolve(null);}
    });
  });
}
