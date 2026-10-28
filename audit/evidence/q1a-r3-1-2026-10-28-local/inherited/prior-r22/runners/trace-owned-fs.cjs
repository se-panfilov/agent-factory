'use strict';
const fs=require('node:fs/promises'),process=require('node:process');
const start=process.hrtime.bigint(); const out=s=>process.stderr.write(JSON.stringify({phase:s,pid:process.pid,cwd:process.cwd(),elapsed_ns:String(process.hrtime.bigint()-start)})+'\n');
for(const key of ['mkdtemp','mkdir','readFile','writeFile','open','stat','lstat','rename','unlink']){
 const original=fs[key].bind(fs);let id=0;
 fs[key]=async function(...args){const n=key+':'+(++id)+':'+String(args[0]);out('begin:'+n);try{const r=await original(...args);out('done:'+n);return r;}catch(e){out('error:'+n+':'+e.code);throw e;}};
}
out('trace-loaded');
