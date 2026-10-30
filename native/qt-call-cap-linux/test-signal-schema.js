const assert=require('node:assert/strict');
const {schema,record}=require('./signal-schema');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const fixture={sessId:'secret-session',rtpIP:'127.0.0.1:9000',fromId:123,
  servers:[{rtpaddr:'127.0.0.1:9000'}],extra:{'123456789':'private'},settings:{enabled:true}};
const result=schema(fixture),text=JSON.stringify(result);
for(const secret of ['secret-session','127.0.0.1','123456789','private']) assert.ok(!text.includes(secret));
assert.deepEqual(result.fields.fromId,{type:'number',uint32:true});
assert.equal(result.fields.servers.items[0].fields.rtpaddr.type,'string');
assert.equal(result.fields.extra.otherKeys,1);
assert.equal(schema(JSON.parse('{"__proto__":{"bad":true}}')).otherKeys,1);
assert.equal(schema(JSON.stringify(fixture)).schema.fields.sessId.type,'string');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zcall-schema-test-'));
const file=path.join(dir,'schema.jsonl');
try {
  record(file,{type:'request',command:'makeCall',data:{partner:[{id:'private-partner',name:'private-name'}],type:3}});
  record(file,{type:'request',command:'endCall',data:null});
  record(file,{type:'request',command:'private-command',data:fixture});
  record(file,{type:'control',data:{act:'request',data:fixture}});
  const saved=fs.readFileSync(file,'utf8');
  const entries=saved.trim().split('\n').map(JSON.parse);
  assert.equal(entries.length,3);
  assert.equal(entries[0].command,'makeCall');
  assert.equal(entries[0].schema.fields.partner.items[0].fields.id.type,'string');
  assert.equal(entries[1].command,'endCall');
  assert.equal(entries[2].action,'request');
  for(const secret of ['private-partner','private-name','private-command','secret-session','127.0.0.1']) assert.ok(!saved.includes(secret));
  assert.equal(fs.statSync(file).mode & 0o777,0o600);
} finally {fs.rmSync(dir,{recursive:true,force:true});}
console.log('PASS passive signaling schema: structural types only, sensitive scalar/dynamic keys excluded');
