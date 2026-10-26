'use strict';
// Transparent external completion contract. Originals unchanged. No commits/push/branches/worktree/index/PR/release/deploy.
const fs=require('node:fs'),path=require('node:path');
const label=process.argv[3];
const contracts=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),contract=contracts[process.argv[3]],runner=path.resolve(process.argv[4]),args=process.argv.slice(5);
if(!contract)throw Error('unknown completion contract');
let text='',overflow=false;const write=process.stdout.write.bind(process.stdout);
process.stdout.write=function(chunk,...rest){const s=Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk);if(Buffer.byteLength(text)+Buffer.byteLength(s)<=32*1024*1024)text+=s;else overflow=true;return write(chunk,...rest);};
function complete(){try{const rows=text.split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l)),ids=rows.map(r=>r.id??r.mode);return !overflow&&JSON.stringify(ids)===JSON.stringify(contract.ids)&&new Set(ids).size===ids.length&&(!contract.marker||ids.at(-1)===contract.marker)&&(!contract.marker||rows.at(-1).cases===undefined||rows.at(-1).cases===contract.cases)&&!rows.some(r=>r.harness_ok===false)&&rows.filter(r=>r.id!==contract.marker).every(r=>Object.entries(contract.predicates??{}).every(([k,v])=>Object.hasOwn(r,k)&&JSON.stringify(r[k])===JSON.stringify(v)));}catch{return false;}}
function guard(){if(!complete()){process.stderr.write('INCOMPLETE completion contract: '+label+'\n');if(!process.exitCode)process.exitCode=70;}}
process.on('beforeExit',guard);process.on('exit',guard);
const exit=process.exit.bind(process);process.exit=function(code){if(code!==undefined)process.exitCode=code;guard();exit(process.exitCode??0);};
process.argv=[process.execPath,runner,...args];require(runner);
