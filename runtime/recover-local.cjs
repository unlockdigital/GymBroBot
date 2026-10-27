 'use strict';
// Exclusive stopped-app operation. Successful legacy recovery returns a capability
// solely to the authorized caller; never send stdout to shared logs.
process.umask(0o077);
try {
 const fs=require('fs'),path=require('path');
 const data=path.join(__dirname,'data'),{check}=require('./storage.cjs');
 check(data,true);for(const n of ['config.json','owner.sqlite'])check(path.join(data,n));
 const c=JSON.parse(fs.readFileSync(path.join(data,'config.json'),'utf8'));
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error();
 const keys=Object.keys(input).sort().join(',');
 const reset=keys==='currentPassword,replacementSecret';
 if(!reset&&keys!=='password,secret')throw Error();
 if(!Object.values(input).every(v=>typeof v==='string'))throw Error();
 const owner=require('./owner.cjs').open({file:path.join(data,'owner.sqlite'),origin:c.origin,approval:'PRIVATE_STANDALONE'});
 try {
  const result=reset?owner.resetRecoveryLocal(input.currentPassword,input.replacementSecret):owner.recoverLocal(input.secret,input.password);
  if(!result.ok)throw Error();
  process.stdout.write(JSON.stringify(result)+'\n');
 } finally {owner.close();}
} catch {
 // Parser, storage, operation, close and output errors may contain caller secrets.
 process.exitCode=1;
 try {process.stderr.write('Recovery failed\n');} catch {}
}
