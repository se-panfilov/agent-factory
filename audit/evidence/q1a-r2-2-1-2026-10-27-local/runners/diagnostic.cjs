'use strict';
// One targeted diagnostic attempt only. No keepalive or runtime repair. No commits/push/branches/worktree/index/PR/release/deploy.
const fs=require('node:fs'),hooks=require('node:async_hooks'),start=process.hrtime.bigint();let n=0;const active=new Map();
function log(event,data={}){if(n++<20000)fs.writeSync(2,JSON.stringify({diagnostic:event,pid:process.pid,ns:String(process.hrtime.bigint()-start),...data})+'\n');}
hooks.createHook({init(id,type,trigger){if(type.includes('FSREQ')||type==='PROCESSWRAP'){active.set(id,type);log('begin',{id,type,trigger});}},destroy(id){if(active.has(id)){log('end',{id,type:active.get(id)});active.delete(id);}}}).enable();
process.on('beforeExit',code=>log('beforeExit',{code,active:[...active]}));process.on('exit',code=>log('exit',{code,active:[...active]}));process.on('uncaughtExceptionMonitor',e=>log('uncaught',{name:e.name,message:e.message}));log('started',{cwd:process.cwd()});
