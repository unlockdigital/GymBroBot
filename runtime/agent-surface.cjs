'use strict';
const fs=require('node:fs'),http=require('node:http');
exports.start=agent=>{
 const server=http.createServer({maxHeaderSize:8192},async(req,res)=>{
  const send=(s,b)=>{res.writeHead(s,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(b));};
  try{
   if(req.headers.host!=='agent.gymbro.internal'||req.headers['x-forwarded-proto']!=='https'||['origin','cookie','sec-fetch-site','forwarded','x-forwarded-host','x-forwarded-for'].some(k=>req.headers[k]!==undefined))return send(403,{error:'CLI boundary denied'});
   if(!/^\/agent\/[a-z]+(?:\/[-a-zA-Z0-9_]{16,100})?$/.test(req.url))return send(404,{error:'Absent'});
   let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>32768)return send(413,{error:'Body limit'});chunks.push(c);}
   const raw=Buffer.concat(chunks).toString();
   return send(200,agent.handle(req.method,req.url.slice(7),new Headers(req.headers),raw?JSON.parse(raw):{}));
  }catch(e){send(e.status||400,{error:e.status?e.message:'Request rejected'});}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=3000;
 require('./storage.cjs').check('/run/gymbro-agent',true);const p='/run/gymbro-agent/agent.sock';if(fs.existsSync(p)){const st=fs.lstatSync(p);if(!st.isSocket()||st.uid!==process.getuid())throw Error('Owned socket required');fs.unlinkSync(p);}
 server.listen(p,()=>fs.chmodSync(p,0o600));return server;
};
