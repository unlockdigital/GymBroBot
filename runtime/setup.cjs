'use strict';
const fs=require('fs'),path=require('path');process.umask(0o077);
const data=path.join(__dirname,'data'),origin=process.env.PUBLIC_ORIGIN;
if(!/^https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(origin||''))throw Error('Set PUBLIC_ORIGIN to canonical HTTPS domain');
require('./storage.cjs').check(data,true);
if(fs.readdirSync(data).some(x=>x!=='.owner-lock'))throw Error('Setup requires empty data');
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({origin,transport:'caddy-unix'}),{flag:'wx',mode:0o600});
const owner=require('./owner.cjs').open({file:path.join(data,'owner.sqlite'),origin,approval:'PRIVATE_STANDALONE'});
try{console.log('Private ten-minute enrollment capability: '+owner.provision().claimSecret);}finally{owner.close();}
