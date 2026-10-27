'use strict';
module.exports.create=(now=Date.now)=>{let tokens=200,last=now();return {allow(){const t=now();tokens=Math.min(200,tokens+Math.max(0,t-last)*0.1);last=t;if(tokens<1)return false;tokens--;return true;}};};
