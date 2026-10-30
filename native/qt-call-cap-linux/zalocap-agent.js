'use strict';
// ZaloCap (Linux): screen-capture helper for the "screencap" module of main-dist/main.js.
//
// Protocol, taken from that module:
//   main -> helper (stdin, one JSON per line): {"cmd":"zalo:capture"|"zalo:getDataClipboard"|
//     "zalo:convertBitmap"|"zalo:recvAck"|"zalo:editPhoto","data":{...}}
//   helper -> main (stdout): "@cap_resp@" + JSON({id, data: JSON({cmd, data})}) + "@end_cap_resp@",
//     where `data` is a raw string for cap:recvReq and a JSON string for cap:getClipboard /
//     cap:convertBitmap. main parses only the first frame of each chunk, so frames are spaced out.
// Verified against the renderer bundles:
//   * "zalo:getDataClipboard" / "zalo:convertBitmap" carry the raw request id as `data` (a number
//     or a string, not an object). The reply needs `idReq` as a STRING (the renderer compares
//     `requestId === id.toString()`), and cap:getClipboard `urls` are plain absolute paths.
//   * After cap:acceptScrs the renderer reads the picture with $zelectronNative.getClipboardImage(),
//     so the picture must be on the system clipboard as image/png before acceptScrs is sent.
//   * cap:copyScrs + zalo:changeDataClipboard make main emit "clipboard-change" {isCopyFromCap:1},
//     which tells the renderer the clipboard image came from the screenshot tool.
//   * accept (send into the open chat) only when the request has enableAccept; otherwise the picture
//     is only copied. "Send to my cloud" and forwarding are not offered (no toolbar of our own).
// The region picker is whichever screenshot tool the desktop already has.
const {spawn, execFile} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = process.env.ZALO_ZCAP_TMP || path.join(os.homedir(), '.config', 'ZaloData', 'cap-tmp');
const FRAME_GAP_MS = 40;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
let seq = 0;
let fileSeq = 0;
let lastCapture = null; // {file, time}
let busy = false;

function warn(...args) {
  const line = '[ZaloCap] ' + args.join(' ') + '\n';
  try { process.stderr.write(line); } catch (e) { /* closed */ }
  if (process.env.ZALO_ZCAP_LOG === '0') return;
  try { fs.appendFileSync(path.join(process.env.HOME || os.homedir(), '.config', 'ZaloData', 'zcap-agent.log'), new Date().toISOString() + ' ' + line); } catch (e) { /* no log dir */ }
}

// ---- output frames ---------------------------------------------------------
const outbox = [];
let draining = false;
function emit(cmd, payload) {
  const data = payload === undefined ? undefined : (typeof payload === 'string' ? payload : JSON.stringify(payload));
  const inner = JSON.stringify(data === undefined ? {cmd} : {cmd, data});
  outbox.push('@cap_resp@' + JSON.stringify({id: ++seq, data: inner}) + '@end_cap_resp@\n');
  if (!draining) drain();
}
function drain() {
  draining = true;
  const next = outbox.shift();
  if (next === undefined) { draining = false; return; }
  process.stdout.write(next);
  setTimeout(drain, FRAME_GAP_MS);
}

// ---- helpers ---------------------------------------------------------------
function run(cmd, args, options = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, {encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, ...options}, (error, stdout, stderr) =>
      resolve({error, stdout, stderr, code: error ? (typeof error.code === 'number' ? error.code : -1) : 0}));
  });
}
async function have(cmd) {
  const r = await run('sh', ['-c', 'command -v "$0"', cmd]);
  return r.code === 0 && r.stdout.length > 0;
}
function tmpFile(ext) {
  fs.mkdirSync(TMP_DIR, {recursive: true, mode: 0o700});
  return path.join(TMP_DIR, `cap-${Date.now()}-${process.pid}-${++fileSeq}.${ext}`);
}
function cleanOld() {
  try {
    for (const name of fs.readdirSync(TMP_DIR))
      if (name.startsWith('cap-') && Date.now() - fs.statSync(path.join(TMP_DIR, name)).mtimeMs > 24 * 3600 * 1000)
        fs.unlinkSync(path.join(TMP_DIR, name));
  } catch (e) { /* no directory yet */ }
}
const isPng = buf => buf && buf.length > 8 && buf.subarray(0, 4).equals(PNG_SIGNATURE);

// ---- region capture: first available tool wins -----------------------------
// Each returns {file} on success, {cancelled:true} when the user aborted, or null if the tool is missing.
const TOOLS = [
  ['flameshot', async () => {
    const r = await run('flameshot', ['gui', '--raw']);
    if (isPng(r.stdout)) { const file = tmpFile('png'); fs.writeFileSync(file, r.stdout); return {file}; }
    return {cancelled: true};
  }],
  ['spectacle', async () => {
    const file = tmpFile('png');
    await run('spectacle', ['--background', '--nonotify', '--region', '--output', file]);
    return fs.existsSync(file) && fs.statSync(file).size > 0 ? {file} : {cancelled: true};
  }],
  ['gnome-screenshot', async () => {
    const file = tmpFile('png');
    await run('gnome-screenshot', ['--area', '--file', file]);
    return fs.existsSync(file) && fs.statSync(file).size > 0 ? {file} : {cancelled: true};
  }],
  ['grim+slurp', async () => {
    const area = await run('slurp', []);
    const geometry = area.stdout.toString().trim();
    if (area.code !== 0 || !geometry) return {cancelled: true};
    const file = tmpFile('png');
    await run('grim', ['-g', geometry, file]);
    return fs.existsSync(file) && fs.statSync(file).size > 0 ? {file} : {cancelled: true};
  }],
  ['maim', async () => {
    const file = tmpFile('png');
    await run('maim', ['--select', file]);
    return fs.existsSync(file) && fs.statSync(file).size > 0 ? {file} : {cancelled: true};
  }],
  ['import', async () => {
    const file = tmpFile('png');
    await run('import', [file]);
    return fs.existsSync(file) && fs.statSync(file).size > 0 ? {file} : {cancelled: true};
  }]
];
function orderedTools(env = process.env) {
  const desktop = String(env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const preferred = env.ZALO_ZCAP_TOOL ? [env.ZALO_ZCAP_TOOL]
    : desktop.includes('kde') ? ['spectacle', 'flameshot']
      : desktop.includes('gnome') ? ['gnome-screenshot', 'flameshot']
        : ['flameshot'];
  const rank = name => { const i = preferred.indexOf(name.split('+')[0]); return i < 0 ? preferred.length : i; };
  return TOOLS.map((tool, index) => [tool, index]).sort((a, b) => rank(a[0][0]) - rank(b[0][0]) || a[1] - b[1]).map(x => x[0]);
}
async function captureRegion() {
  for (const [name, capture] of orderedTools()) {
    const binaries = name.split('+');
    let present = true;
    for (const binary of binaries) if (!(await have(binary))) present = false;
    if (!present) continue;
    const result = await capture();
    if (result) { warn('capture with', name, result.cancelled ? '(cancelled)' : 'ok'); return result; }
  }
  warn('no screenshot tool found; install one of: flameshot, spectacle (KDE), gnome-screenshot (GNOME), grim+slurp (Wayland), maim (X11)');
  return {cancelled: true, missing: true};
}

// ---- clipboard -------------------------------------------------------------
async function copyImage(file) {
  let copied = false;
  // Zalo's Electron runs on X11 (XWayland on Wayland sessions), so the X selection is what it reads.
  if (await have('xclip')) {
    spawn('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i', file], {stdio: 'ignore', detached: true}).unref();
    copied = true;
  }
  if (process.env.WAYLAND_DISPLAY && await have('wl-copy')) {
    spawn('sh', ['-c', 'wl-copy --type image/png < "$0"', file], {stdio: 'ignore', detached: true}).unref();
    copied = true;
  }
  if (copied) await new Promise(resolve => setTimeout(resolve, 150)); // let the selection owner settle
  return copied;
}
async function readClipboardUrls() {
  const urls = [];
  const reads = [];
  if (process.env.WAYLAND_DISPLAY && await have('wl-paste')) {
    reads.push(['wl-paste', ['--list-types'], type => ['wl-paste', ['--type', type]]]);
  }
  if (await have('xclip')) {
    reads.push(['xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], type => ['xclip', ['-selection', 'clipboard', '-t', type, '-o']]]);
  }
  for (const [tool, listArgs, readArgs] of reads) {
    const types = (await run(tool, listArgs)).stdout.toString().split(/\s+/).filter(Boolean);
    if (types.includes('text/uri-list')) {
      const [cmd, args] = readArgs('text/uri-list');
      const text = (await run(cmd, args)).stdout.toString();
      for (const line of text.split(/\r?\n/))
        if (line.startsWith('file://')) { try { urls.push(decodeURIComponent(new URL(line).pathname)); } catch (e) { /* skip */ } }
      if (urls.length) return urls;
    }
    if (types.includes('image/png')) {
      const [cmd, args] = readArgs('image/png');
      const image = (await run(cmd, args)).stdout;
      if (isPng(image)) { const file = tmpFile('png'); fs.writeFileSync(file, image); return [file]; }
    }
  }
  // Fall back to the picture we just took (clipboard owners can lag behind).
  if (lastCapture && Date.now() - lastCapture.time < 60000 && fs.existsSync(lastCapture.file)) return [lastCapture.file];
  return urls;
}

// ---- commands --------------------------------------------------------------
async function handleCapture(options) {
  if (busy) return;
  busy = true;
  const accept = !!options && (options.enableAccept === 1 || options.enableAccept === true);
  emit('cap:recvReq', 'zalo:capture');
  emit('cap:running');
  try {
    const result = await captureRegion();
    if (result.file) {
      lastCapture = {file: result.file, time: Date.now()};
      const copied = await copyImage(result.file);
      if (!copied) warn('no clipboard tool (xclip or wl-copy); the picture is kept at', result.file);
      emit('cap:copyScrs');
      emit('zalo:changeDataClipboard');
      if (accept && copied) emit('cap:acceptScrs');
    } else {
      emit('cap:cancelScrs');
    }
  } catch (error) {
    warn('capture failed:', error && error.message);
    emit('cap:cancelScrs');
  } finally {
    emit('cap:quitAction');
    busy = false;
  }
}
const requestId = data => String(data !== null && typeof data === 'object' ? data.idReq : data);
async function handleLine(line) {
  let message;
  try { message = JSON.parse(line); } catch (e) { warn('ignored unparsable line'); return; }
  const data = message ? message.data : undefined;
  switch (message && message.cmd) {
    case 'zalo:capture': return handleCapture(data && typeof data === 'object' ? data : {});
    case 'zalo:getDataClipboard': {
      let urls = [];
      try { urls = await readClipboardUrls(); } catch (e) { warn('clipboard read failed:', e && e.message); }
      return emit('cap:getClipboard', {idReq: requestId(data), urls});
    }
    case 'zalo:convertBitmap': return emit('cap:convertBitmap', {idReq: requestId(data), isSuccess: true});
    case 'zalo:recvAck': return undefined;
    case 'zalo:editPhoto': return warn('photo editing is not available on Linux');
    default: return warn('unknown command', String(message && message.cmd));
  }
}

function main() {
  cleanOld();
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handleLine(line).catch(error => warn('command failed:', error && error.message));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  emit('cap:initSuccess');
}

if (require.main === module) main();
module.exports = {emit, TOOLS, orderedTools, requestId};
