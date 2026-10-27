'use strict';
const assert=require('assert/strict'),fs=require('fs');
(async()=>{
 const home='/app';let observer,visibility,requests=0,payload={agentReceipts:[{date:'2026-11-03',version:1,digest:'approval-example',planDigest:'plan-example'}]},ok=true;
 class Node {constructor(tag){this.tag=tag;this.children=[];this.style={};this.text='';}append(...nodes){for(const n of nodes){n.parentElement=this;this.children.push(n);}}prepend(n){n.parentElement=this;this.children.unshift(n);}remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null;}setAttribute(){}set textContent(s){this.text=s;this.children=[];}get textContent(){return this.text+this.children.map(n=>n.textContent).join('');}}
 const body=new Node('body'),app=new Node('main');app.id='app';let host=new Node('section');body.append(app);app.append(host);
 const search=(n,id)=>n.id===id?n:n.children.map(x=>search(x,id)).find(Boolean);
 const document={body,hidden:false,getElementById:id=>search(body,id),querySelector:()=>host,createElement:t=>new Node(t),addEventListener:(name,fn)=>{if(name==='visibilitychange')visibility=fn;}};
 const saved={document:global.document,MutationObserver:global.MutationObserver,fetch:global.fetch};
 try{
 global.document=document;global.MutationObserver=class{constructor(fn){observer=fn;}observe(){}};
 global.fetch=async(url,options)=>{requests++;assert.equal(url,'/bridge/bootstrap');assert.equal(options.cache,'no-store');assert.equal(options.headers.Authorization,'PWA');return {ok,json:async()=>payload};};
 const source=fs.readFileSync(home+'/public/agent-receipt.js','utf8');const api=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));assert.equal(requests,0);
 await api.mountAgentReceipt();let panel=document.getElementById('agent-receipt');assert(panel);assert.equal(panel.parentElement,host);assert(panel.textContent.includes('approval-example'));assert(panel.textContent.includes('plan-example'));assert.equal(requests,1);
 app.children=[];host=new Node('section');app.append(host);observer();panel=document.getElementById('agent-receipt');assert.equal(panel.parentElement,host);assert.equal(requests,1);
 ok=false;await api.refreshAgentReceipt();assert.equal(document.getElementById('agent-receipt'),undefined);
 ok=true;payload={agentReceipts:[]};await api.refreshAgentReceipt();assert.equal(document.getElementById('agent-receipt'),undefined);
 payload={agentReceipts:[{date:'<img>',version:1,digest:'a',planDigest:'b'}]};await api.refreshAgentReceipt();assert(document.getElementById('agent-receipt').textContent.includes('<img>'));assert.equal(document.getElementById('agent-receipt').children[0].children[0].tag,'summary');
 const before=requests;document.hidden=true;visibility();assert.equal(requests,before);document.hidden=false;
 let resolve;global.fetch=()=>new Promise(r=>{resolve=r;});const pending=api.refreshAgentReceipt();api.clearAgentReceipt();resolve({ok:true,json:async()=>payload});await pending;assert.equal(document.getElementById('agent-receipt'),undefined);observer();assert.equal(document.getElementById('agent-receipt'),undefined);
 assert(fs.readFileSync(home+'/public/entry.js','utf8').includes("await authorize(); await import('./core/app.js');await (await import('./agent-receipt.js')).mountAgentReceipt()"));assert(fs.readFileSync(home+'/public/owner.js','utf8').includes('await mountAgentReceipt();}else{clearAgentReceipt();}'));
 console.log('PASS: receipt authenticated wiring, text-only render, rerender restore, no-store transport, auth/empty clear, hidden-page and stale-response guards');
 }finally{Object.assign(global,saved);}
})().catch(()=>{console.error('Receipt UI synthetic test failed');process.exitCode=1;});
