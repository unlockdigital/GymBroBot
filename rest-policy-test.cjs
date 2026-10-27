'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const app=fs.readFileSync('/app/public/core/app.js','utf8');
const source=app.match(/function prescribedRestSeconds\(ex\) \{[\s\S]*?\n\}/)[0];
const rest=vm.runInNewContext(source+';prescribedRestSeconds',{DEFAULT_REST_SECONDS:120});
for(const n of [30,60,90,180,300])assert.equal(rest({restSeconds:n}),n);
for(const n of [0,29,301,Infinity,NaN,'90',null,90.5])assert.equal(rest({restSeconds:n}),120);
assert.equal(rest({}),120);assert.equal(rest(null),120);assert.equal((app.match(/startRest\(prescribedRestSeconds\(ex\)\)/g)||[]).length,2);
console.log('PASS 16 rest-policy checks');
