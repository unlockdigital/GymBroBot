'use strict';
const fs=require('node:fs'),path=require('node:path');process.umask(0o077);
const data=path.join(__dirname,'data'),{check}=require('./storage.cjs');check(data,true);
for(const n of ['config.json','owner.sqlite','control.sqlite'])check(path.join(data,n));
const c=JSON.parse(fs.readFileSync(path.join(data,'config.json')));if(c.transport!=='caddy-unix')throw Error('VPS required');
const owner=require('./owner.cjs').open({file:path.join(data,'owner.sqlite'),origin:c.origin,approval:'PRIVATE_STANDALONE'});
const control=new(require('better-sqlite3'))(path.join(data,'control.sqlite'));control.pragma('synchronous=FULL');
let fd,tmp,published=false,token;
const target=path.join(data,'agent-cli.json');
try{
 if(fs.existsSync(target))throw Error('Credential already exists');
 if(!owner.status().claimed)throw Error('Claimed owner required');
 const ca=fs.readFileSync('/pairing/root.crt','utf8');new (require('node:crypto').X509Certificate)(ca);
 const api=require('./agent.cjs').create({control,owner,id:c.storage?.profile==='private-copy'?c.storage.owner:{identitySource:'standalone',externalUserId:'local-owner'}});
 token=api.issue();
 tmp=path.join(data,'.agent-cli-'+require('node:crypto').randomBytes(16).toString('hex'));
 fd=fs.openSync(tmp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
 fs.writeFileSync(fd,JSON.stringify({origin:'https://127.0.0.1:9443',serverName:'agent.gymbro.internal',ca,token}));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
 // link is atomic and refuses overwrite, unlike rename on POSIX.
 fs.linkSync(tmp,target);published=true;fs.unlinkSync(tmp);tmp=undefined;
 const dir=fs.openSync(data,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
 console.log('Owner-scoped 24-hour credential: /app/data/agent-cli.json (0600)');
}catch(error){if(published)fs.unlinkSync(target);if(token)control.prepare('DELETE FROM agent_tokens WHERE hash=?').run(require('node:crypto').createHash('sha256').update(JSON.stringify(token)).digest('hex'));throw error;
}finally{if(fd!==undefined)fs.closeSync(fd);if(tmp)fs.unlinkSync(tmp);control.close();owner.close();}
