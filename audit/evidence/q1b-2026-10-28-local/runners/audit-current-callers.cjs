'use strict';
// Static API census, no execution/identity overrides. No commits/push/branches/worktree/PR/staging/index/merge/tag/release/deploy.
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const repo=path.resolve(process.argv[2]),base=path.resolve(process.argv[3]);
const ts=require(path.join(repo,'setup/node_modules/typescript'));
const files=[];
function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,e.name);if(e.isDirectory())walk(q);else if(/\.(ts|cjs|js)$/.test(q))files.push(q);}}
walk(path.join(repo,'setup/src'));walk(path.join(repo,'setup/tests'));
for(const name of ['r31-boundary-probes.cjs','r3-explicit-identity.cjs','s03-explicit-identity.cjs'])files.push(path.join(base,name));
const calls=[];
for(const file of files){const code=fs.readFileSync(file,'utf8'),src=ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true);
 function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(src)==='requestCancel'){
  assert.equal(n.arguments.length,3,file+': omitted process adapter');
  calls.push({file:file.startsWith(repo)?path.relative(repo,file):path.basename(file),line:src.getLineAndCharacterOfPosition(n.getStart(src)).line+1,adapter:n.arguments[2].getText(src)});
 }ts.forEachChild(n,visit);}visit(src);
}
assert.ok(calls.length>20);
console.log(JSON.stringify({id:'explicit-current-callers',acceptance:true,count:calls.length,calls,actual_uid:process.getuid(),global_identity_override:false,historical_old_api:'genuine legacy-to-c13 runner calls old module only before engine switch; originals retained'},null,2));
