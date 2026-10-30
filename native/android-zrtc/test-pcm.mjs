// Actual Pulse/PipeWire round trip on a private null sink: no physical mic/speaker.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const binary = process.argv[2];
if (!binary) throw new Error('Usage: node test-pcm.mjs /path/pcm-host');
const sink = `zrtc_native_test_${process.pid}`;
const children = [];
let moduleId;
function open(direction, device) {
  const child = spawn(binary, [direction, device], {
    env: {...process.env, ZRTC_PCM_READY_FD:'3'}, stdio:['pipe','pipe','pipe','pipe'],
  });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', b => stderr += b);
  child.stdin.on('error', () => {});
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PCM ready timeout: ' + stderr)), 5000);
    child.on('error', e => {clearTimeout(timer); reject(e);});
    child.on('exit', code => {clearTimeout(timer); reject(new Error(`PCM early exit ${code}: ${stderr}`));});
    child.stdio[3].once('data', b => {
      clearTimeout(timer);
      b.toString() === 'R' ? resolve() : reject(new Error('Invalid readiness byte'));
    });
  });
  return {child, ready};
}
try {
  const result = await exec('pactl', ['load-module','module-null-sink',`sink_name=${sink}`,'rate=48000','channels=1']);
  moduleId = result.stdout.trim();
  assert.match(moduleId, /^\d+$/);
  if (['--bridge', '--engine', '--voice'].includes(process.argv[3])) {
    const linker = process.argv[4], probe = process.argv[5], bionic = process.argv[6];
    assert.ok(linker && probe && bionic, 'Usage: test-pcm.mjs PCM_HOST --bridge LINKER PROBE BIONIC_DIR');
    const env = {...process.env, LD_LIBRARY_PATH:bionic, ZRTC_PCM_HOST:binary,
      ZRTC_PCM_SINK:sink, ZRTC_PCM_SOURCE:sink + '.monitor'};
    delete env.LD_PRELOAD; delete env.LD_AUDIT;
    const voice = process.argv[3] === '--voice';
    const engine = voice || process.argv[3] === '--engine';
    const apk = process.argv[7], platform = process.argv[8];
    if (engine) {
      assert.ok(apk && platform, '--engine requires APK_LIB_DIR PLATFORM_DIR');
      env.LD_LIBRARY_PATH = `${platform}:${apk}:${bionic}`;
    }
    const result = await exec(linker, engine ? [probe, `${apk}/libzrtc.so`, voice ? '--compat-voice-pcm' : '--compat-pcm'] : [probe],
      {env, timeout:15000, maxBuffer:1024*1024}).catch(error => {
        if (engine && error.code === 78 && error.stdout?.includes('PASS engine JNI PCM callbacks') &&
            error.stdout?.includes('native stop returned') && !error.stderr?.includes('FORTIFY:') &&
            (!voice || (error.stdout.includes('Peer::initialize returned 0') &&
                        error.stdout.includes('PASS non-audio mode still requires EGL')))) return error;
        throw error;
      });
    process.stdout.write(result.stdout);
  } else {
  const capture = open('record', sink + '.monitor');
  const buffers = [];
  capture.child.stdout.on('data', b => buffers.push(b));
  await capture.ready;
  const playback = open('playback', sink);
  await playback.ready;
  const input = Buffer.alloc(48000 * 2 * 3);
  for (let i = 48000; i < 96000; i++)
    input.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / 48000)), i * 2);
  const playbackExit = new Promise((resolve, reject) => {
    playback.child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Playback exit ${code}`)));
  });
  playback.child.stdin.end(input);
  await Promise.race([playbackExit, new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error('PCM playback timeout')), 10000); t.unref();
  })]);
  await new Promise(resolve => setTimeout(resolve, 200));
  const pcm = Buffer.concat(buffers);
  let maxRms = 0, maxTone = 0;
  for (let offset = 0; offset + 9600 <= pcm.length; offset += 9600) {
    let energy = 0, real = 0, imag = 0;
    for (let i = 0; i < 4800; i++) {
      const s = pcm.readInt16LE(offset + i * 2);
      energy += s * s;
      real += s * Math.cos(2 * Math.PI * 440 * i / 48000);
      imag += s * Math.sin(2 * Math.PI * 440 * i / 48000);
    }
    maxRms = Math.max(maxRms, Math.sqrt(energy / 4800));
    maxTone = Math.max(maxTone, 2 * Math.hypot(real, imag) / 4800);
  }
  assert.ok(pcm.length >= 96000, `recorded only ${pcm.length} bytes`);
  assert.ok(maxRms > 1000 && maxTone > 5000, `missing 440Hz tone: rms=${maxRms} tone=${maxTone}`);
  console.log(`PASS native Pulse PCM loopback: ${pcm.length} bytes, rms=${maxRms.toFixed(0)}, 440Hz=${maxTone.toFixed(0)}`);
  }
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      child.once('exit', resolve);
      const timer = setTimeout(() => {child.kill('SIGKILL'); resolve();}, 1000); timer.unref();
    });
  }
  if (moduleId && /^\d+$/.test(moduleId)) await exec('pactl', ['unload-module', moduleId]);
}
