'use strict';
// Synthetic pixels only: exercise destination growth beyond the former 32 KiB
// buffer and decode the actual JPEG with an independent decoder.
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const addon = require(process.argv[2] || './build/linux_x64/jxl.node');
const invoke = (method, options) => new Promise((resolve, reject) => {
  addon[method](options, (error, data, status) => {
    if (error) reject(error);
    else {assert.equal(status, 1); resolve(data);}
  });
});

(async () => {
  const width = 1024, height = 1536;
  const rgba = Buffer.alloc(width * height * 4);
  const expected = Buffer.alloc(width * height);
  let seed = 12345;
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const gray = 16 + (seed >>> 24) % 224;
      for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) {
        const p = y * width + x;
        expected[p] = gray;
        rgba[p * 4] = rgba[p * 4 + 1] = rgba[p * 4 + 2] = gray;
        rgba[p * 4 + 3] = 255;
      }
    }
  }
  const jxl = await invoke('bitmapToJxl', {buffer: rgba, width, height});
  for (const quality of [80, 95]) {
    const jpeg = await invoke('jxlToJpeg', {buffer: jxl, quality});
    assert.ok(jpeg.length > 32768, 'fixture must grow the JPEG destination');
    const decoded = spawnSync(process.env.ZALO_FFMPEG || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-err_detect', 'explode',
      '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ], {input: jpeg, timeout: 30000, maxBuffer: width * height * 4});
    assert.ifError(decoded.error);
    assert.equal(decoded.status, 0, decoded.stderr?.toString());
    assert.equal(decoded.stderr.length, 0, 'JPEG must decode without corrupt-bitstream warnings');
    assert.equal(decoded.stdout.length, expected.length);
    let totalError = 0, maxError = 0;
    for (let i = 0; i < expected.length; i++) {
      const error = Math.abs(decoded.stdout[i] - expected[i]);
      totalError += error;
      maxError = Math.max(maxError, error);
    }
    const meanError = totalError / expected.length;
    assert.ok(meanError < 3 && maxError < 12,
      `all rows must preserve pixels: mean=${meanError}, max=${maxError}`);
    console.log(`PASS large JPEG quality=${quality}: ${jpeg.length} bytes, mean pixel error=${meanError.toFixed(3)}, max=${maxError}`);
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
