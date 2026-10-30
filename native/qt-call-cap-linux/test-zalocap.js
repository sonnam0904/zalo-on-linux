'use strict';
// Drives ZaloCap's agent over stdin/stdout the way main-dist/main.js does, using fake screenshot
// and clipboard tools so no real screen, window or clipboard is touched.
const assert = require('assert');
const {spawn} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENT = path.join(__dirname, 'zalocap-agent.js');
const agentModule = require(AGENT);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake image data')]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zalocap-test-'));

function script(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\n' + body + '\n', {mode: 0o755});
}
function makeBin(name, {flameshot, withXclip = true}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, {recursive: true});
  fs.symlinkSync('/bin/sh', path.join(dir, 'sh'));
  fs.symlinkSync(fs.realpathSync('/bin/cat'), path.join(dir, 'cat'));
  fs.writeFileSync(path.join(dir, 'fake.png'), PNG);
  if (flameshot === 'ok') script(dir, 'flameshot', `cat "${dir}/fake.png"`);
  if (flameshot === 'cancel') script(dir, 'flameshot', 'exit 1');
  if (withXclip) script(dir, 'xclip', `
echo "$@" >> "${dir}/xclip.log"
case "$*" in
  *TARGETS*) echo image/png ;;
  *"-t image/png -o"*) cat "${dir}/fake.png" ;;
esac`);
  return dir;
}

function startAgent(bin) {
  const child = spawn(process.execPath, [AGENT], {
    env: {ELECTRON_RUN_AS_NODE: '1', PATH: bin, ZALO_ZCAP_TMP: path.join(root, 'tmp-' + path.basename(bin)), HOME: root},
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const frames = [];
  const errors = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => errors.push(chunk));
  let buffer = '';
  const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('@end_cap_resp@')) >= 0) {
      const raw = buffer.slice(buffer.indexOf('@cap_resp@') + '@cap_resp@'.length, end);
      buffer = buffer.slice(end + '@end_cap_resp@'.length);
      const outer = JSON.parse(raw);
      const inner = JSON.parse(outer.data);
      frames.push({id: outer.id, cmd: inner.cmd, data: inner.data});
      waiters.splice(0).forEach(w => w());
    }
  });
  const waitFor = async (predicate, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (!predicate(frames)) {
      if (Date.now() > deadline) throw new Error('timeout; frames: ' + frames.map(f => f.cmd).join(','));
      await new Promise(r => { waiters.push(r); setTimeout(r, 100); });
    }
  };
  const send = (cmd, data) => child.stdin.write(JSON.stringify({cmd, data}) + '\n');
  return {child, frames, errors, waitFor, send};
}

(async () => {
  // Successful capture.
  let bin = makeBin('ok', {flameshot: 'ok'});
  let a = startAgent(bin);
  await a.waitFor(f => f.some(x => x.cmd === 'cap:initSuccess'));
  a.send('zalo:capture', {language: '_vn', enableSend2Me: 1, enableAccept: 1, viMyCloud: '', enMyCloud: ''});
  await a.waitFor(f => f.some(x => x.cmd === 'cap:quitAction'));
  assert.deepStrictEqual(a.frames.map(f => f.cmd), ['cap:initSuccess', 'cap:recvReq', 'cap:running', 'cap:copyScrs', 'zalo:changeDataClipboard', 'cap:acceptScrs', 'cap:quitAction']);
  assert.ok(a.frames.findIndex(f => f.cmd === 'zalo:changeDataClipboard') < a.frames.findIndex(f => f.cmd === 'cap:acceptScrs'), 'clipboard-change comes before accept');
  assert.strictEqual(a.frames.find(f => f.cmd === 'cap:recvReq').data, 'zalo:capture', 'recvReq carries the raw command name');
  assert.deepStrictEqual(a.frames.map(f => f.id), a.frames.map((f, i) => a.frames[0].id + i), 'frame ids increase by one');
  await new Promise(r => setTimeout(r, 300));
  assert.ok(/-t image\/png -i /.test(fs.readFileSync(path.join(bin, 'xclip.log'), 'utf8')), 'picture was put on the clipboard as PNG');

  // Clipboard request returns a real PNG file; convertBitmap acknowledges.
  a.send('zalo:getDataClipboard', 1699999999999); // main.js sends the bare id as data
  await a.waitFor(f => f.some(x => x.cmd === 'cap:getClipboard'));
  const clip = JSON.parse(a.frames.find(f => f.cmd === 'cap:getClipboard').data);
  assert.strictEqual(clip.idReq, '1699999999999', 'idReq is the id as a string (renderer compares with ===)');
  assert.strictEqual(clip.urls.length, 1);
  assert.ok(fs.readFileSync(clip.urls[0]).subarray(0, 4).equals(PNG.subarray(0, 4)), 'returned url is a PNG file');
  a.send('zalo:convertBitmap', 'user-42');
  await a.waitFor(f => f.some(x => x.cmd === 'cap:convertBitmap'));
  assert.deepStrictEqual(JSON.parse(a.frames.find(f => f.cmd === 'cap:convertBitmap').data), {idReq: 'user-42', isSuccess: true});
  a.send('zalo:recvAck', 5);
  a.child.stdin.end();
  await new Promise(r => a.child.on('exit', r));

  // Without enableAccept the picture is only copied (no send into a chat).
  bin = makeBin('copyonly', {flameshot: 'ok'});
  a = startAgent(bin);
  await a.waitFor(f => f.some(x => x.cmd === 'cap:initSuccess'));
  a.send('zalo:capture', {enableAccept: 0, enableSend2Me: 1});
  await a.waitFor(f => f.some(x => x.cmd === 'cap:quitAction'));
  assert.deepStrictEqual(a.frames.map(f => f.cmd), ['cap:initSuccess', 'cap:recvReq', 'cap:running', 'cap:copyScrs', 'zalo:changeDataClipboard', 'cap:quitAction']);
  a.child.stdin.end();
  await new Promise(r => a.child.on('exit', r));

  // The tool native to the desktop is tried first; an explicit override wins.
  const names = env => agentModule.orderedTools(env).map(t => t[0]);
  assert.deepStrictEqual(names({XDG_CURRENT_DESKTOP: 'KDE'}).slice(0, 2), ['spectacle', 'flameshot']);
  assert.deepStrictEqual(names({XDG_CURRENT_DESKTOP: 'GNOME'}).slice(0, 2), ['gnome-screenshot', 'flameshot']);
  assert.strictEqual(names({})[0], 'flameshot');
  assert.strictEqual(names({ZALO_ZCAP_TOOL: 'maim'})[0], 'maim');
  assert.strictEqual(agentModule.requestId(5), '5');
  assert.strictEqual(agentModule.requestId({idReq: 7}), '7');

  // Cancelled capture: no picture, no clipboard write.
  bin = makeBin('cancel', {flameshot: 'cancel'});
  a = startAgent(bin);
  await a.waitFor(f => f.some(x => x.cmd === 'cap:initSuccess'));
  a.send('zalo:capture', {});
  await a.waitFor(f => f.some(x => x.cmd === 'cap:quitAction'));
  assert.deepStrictEqual(a.frames.map(f => f.cmd), ['cap:initSuccess', 'cap:recvReq', 'cap:running', 'cap:cancelScrs', 'cap:quitAction']);
  assert.ok(!fs.existsSync(path.join(bin, 'xclip.log')), 'cancel does not touch the clipboard');
  a.child.stdin.end();
  await new Promise(r => a.child.on('exit', r));

  // No screenshot tool installed: cancel cleanly instead of hanging Zalo's state machine.
  bin = makeBin('none', {flameshot: null, withXclip: false});
  a = startAgent(bin);
  await a.waitFor(f => f.some(x => x.cmd === 'cap:initSuccess'));
  a.send('zalo:capture', {});
  await a.waitFor(f => f.some(x => x.cmd === 'cap:quitAction'));
  assert.ok(a.frames.some(f => f.cmd === 'cap:cancelScrs') && !a.frames.some(f => f.cmd === 'cap:acceptScrs'));
  assert.match(a.errors.join(''), /no screenshot tool found; install one of: flameshot/, 'a clear hint reaches stderr');
  a.child.stdin.end();
  await new Promise(r => a.child.on('exit', r));

  // Unparsable and unknown input never crash the helper.
  bin = makeBin('junk', {flameshot: 'ok'});
  a = startAgent(bin);
  await a.waitFor(f => f.some(x => x.cmd === 'cap:initSuccess'));
  a.child.stdin.write('not json\n');
  a.send('zalo:unknown', {});
  a.send('zalo:convertBitmap', {idReq: 'still-alive'});
  await a.waitFor(f => f.some(x => x.cmd === 'cap:convertBitmap'));
  a.child.stdin.end();
  await new Promise(r => a.child.on('exit', r));

  // The launcher script itself (what main.js spawns): finds a Node runtime, passes args, speaks the protocol.
  {
    const wrapper = path.join(__dirname, 'ZaloCap');
    assert.ok(fs.statSync(wrapper).mode & 0o111, 'ZaloCap launcher is executable');
    const child = spawn(wrapper, ['zalo2017', path.join(root, 'log')], {
      env: {...process.env, ELECTRON_RUN_AS_NODE: '1', ZALO_ZCAP_TMP: path.join(root, 'tmp-wrapper')},
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const out = await new Promise((resolve, reject) => {
      let text = '';
      child.stdout.on('data', chunk => { text += chunk; if (text.includes('@end_cap_resp@')) resolve(text); });
      child.on('error', reject);
      setTimeout(() => reject(new Error('launcher produced no frame')), 8000);
    });
    assert.match(out, /^@cap_resp@\{"id":1,"data":"\{\\"cmd\\":\\"cap:initSuccess\\"\}"\}@end_cap_resp@/);
    child.stdin.end();
    await new Promise(r => child.on('exit', r));
  }

  console.log('PASS ZaloCap: init, capture accept/copy-only/cancel/no-tool, raw-id clipboard replies, tool order, junk input');
  fs.rmSync(root, {recursive: true, force: true});
})().catch(error => { console.error(error); fs.rmSync(root, {recursive: true, force: true}); process.exit(1); });
