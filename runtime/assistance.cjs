'use strict';
// Assistance is an amount of external help, never a negative added weight.
function parse(row) {
 const notes=typeof row.notes==='string'?row.notes:'';
 const flagged=/\bassistance_/i.test(notes)||row.loadMode==='assisted'||row.assistanceLb!==undefined;
 if(!flagged)return {assisted:false};
 const matches=[...notes.matchAll(/\bassistance_lb=(\d+(?:\.\d+)?)(?=$|[;\s])/gi)];
 const amount=row.assistanceLb!==undefined?row.assistanceLb:(matches.length===1?Number(matches[0][1]):null);
 const invalid=(row.loadMode!==undefined&&row.loadMode!=='assisted')||(row.assistanceLb!==undefined&&matches.length===1&&row.assistanceLb!==Number(matches[0][1]))||typeof amount!=='number'||!Number.isFinite(amount)||amount<=0||amount>500||matches.length>1||((notes.match(/\bassistance_/gi)||[]).length>matches.length)||(/\bassistance_/i.test(notes)&&matches.length!==1);
 return invalid?{assisted:true,invalid:true}:{assisted:true,assistanceLb:amount};
}
module.exports={parse};
