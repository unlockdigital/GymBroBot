
'use strict';
const net=require('node:net');
// Canonical peer only. IPv6 privacy addresses share a /64 budget.
function clientKey(raw){
 if(typeof raw!=='string'||raw.includes('%')||raw.trim()!==raw)return null;
 let ip=raw;if(ip.startsWith('::ffff:')&&net.isIP(ip.slice(7))===4)ip=ip.slice(7);
 const family=net.isIP(ip);if(family===4)return 'v4:'+ip;
 if(family!==6)return null;
 const canonical=new URL('http://['+ip+']/').hostname.slice(1,-1);
 const [l,r]=canonical.split('::'),left=l?l.split(':'):[],right=r?r.split(':'):[];
 const groups=canonical.includes('::')?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left;
 if(groups.slice(0,5).every(x=>parseInt(x,16)===0)&&parseInt(groups[5],16)===65535){const hi=parseInt(groups[6],16),lo=parseInt(groups[7],16);return 'v4:'+[(hi>>8)&255,hi&255,(lo>>8)&255,lo&255].join('.');}
 return 'v6:'+groups.slice(0,4).map(x=>x.padStart(4,'0')).join(':');
}
module.exports={clientKey};
