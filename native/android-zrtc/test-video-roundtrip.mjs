// Native synthetic frames -> original x264 -> independent FFmpeg decoder.
// Encoded/pixel bytes stay in anonymous pipes; no camera or remote call.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2);
if(args.length!==2) throw new Error('Usage: test-video-roundtrip.mjs NDK_DIR RUNTIME_DIR');
const decoder=spawn('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-f','h264','-i','pipe:0',
  '-map','0:v:0','-fps_mode','passthrough','-f','framemd5','pipe:1'],{stdio:['pipe','pipe','pipe']});
const encoder=spawn('bash',[fileURLToPath(new URL('./test-video-codec.sh',import.meta.url)),...args,'--encoded-fd3'],
  {stdio:['ignore','pipe','pipe','pipe']});
let nativeLog='',decoded='',diagnostics='',pipeError;
encoder.stdout.on('data',b=>nativeLog+=b);
encoder.stderr.on('data',b=>{if(diagnostics.length<65536)diagnostics+=b;});
decoder.stdout.on('data',b=>decoded+=b);
decoder.stderr.on('data',b=>{if(diagnostics.length<65536)diagnostics+=b;});
decoder.stdin.on('error',error=>pipeError=error);
encoder.stdio[3].pipe(decoder.stdin);
const wait=child=>new Promise((resolve,reject)=>{
  child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));
});
const timer=setTimeout(()=>{encoder.kill('SIGTERM');decoder.kill('SIGTERM');},25000);
try {
  const [encodedExit,decodedExit]=await Promise.all([wait(encoder),wait(decoder)]);
  assert.deepEqual(encodedExit,{code:0,signal:null},diagnostics);
  assert.deepEqual(decodedExit,{code:0,signal:null},diagnostics);
  assert.equal(pipeError,undefined);
  const batches=[...nativeLog.matchAll(/original encoded callbacks=(\d+) bytes=(\d+)/g)];
  assert.equal(batches.length,3);
  const expected=batches.reduce((n,m)=>n+Number(m[1]),0);
  assert.ok(expected>=150);
  assert.match(decoded,/#dimensions 0: 480x360/);
  const frames=decoded.split('\n').filter(l=>/^0,/.test(l));
  assert.equal(frames.length,expected);
  const hashes=new Set(frames.map(l=>l.split(',').at(-1).trim()));
  assert.ok(hashes.size>=40,`Decoded image content must vary with changing input (distinct=${hashes.size}, frames=${frames.length})`);
  console.log(`PASS native H.264 roundtrip: ${frames.length} decoded 480x360 frames, ${hashes.size} distinct image hashes; no remote video`);
} finally {clearTimeout(timer);encoder.kill('SIGTERM');decoder.kill('SIGTERM');}
