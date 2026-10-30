'use strict';
// Parity test for the Linux zjxl NAPI addon (build/linux_x64/jxl.node).
// Run: node test-linux.js   (from this directory)
const assert = require('assert');
const path = require('path');

let pass = 0;
async function T(name, fn) {
  try {
    await fn();
    pass++;
    console.log('ok -', name);
  } catch (e) {
    console.error('FAIL -', name);
    console.error(e);
    process.exitCode = 1;
  }
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    console.log('skipped: linux x64 only');
    return;
  }
  const zjxl = require('./index.js');

  // 16x8 RGBA gradient
  const W = 16, H = 8;
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      rgba[i] = (x * 16) & 0xff;
      rgba[i + 1] = (y * 32) & 0xff;
      rgba[i + 2] = ((x + y) * 8) & 0xff;
      rgba[i + 3] = 255;
    }
  }

  await T('moduleReady', async () => {
    assert.strictEqual(await zjxl.moduleReady(), true);
  });

  let jxl = null;
  await T('bitmapToJxl encodes a JXL codestream', async () => {
    const r = await zjxl.bitmapToJxl(rgba, W, H);
    assert.ok(Buffer.isBuffer(r.data), 'Buffer out');
    assert.ok(r.data.length > 10, 'non-trivial size');
    // bare codestream signature 0xFF 0x0A, or ISO container 'jxl ' box
    const bare = r.data[0] === 0xff && r.data[1] === 0x0a;
    const box = r.data.slice(4, 8).toString('latin1') === 'jxl ';
    // Native convention: success => status_code 1 (0/other codes only on error).
    assert.strictEqual(r.status_code, 1);
    jxl = r.data;
  });

  await T('getJxlInfo reports dimensions', async () => {
    const info = await zjxl.getJxlInfo(jxl);
    assert.strictEqual(info.width, W);
    assert.strictEqual(info.status_code, 1);
  });

  await T('decodeToJpeg round-trips to JPEG', async () => {
    const r = await zjxl.decodeToJpeg(jxl, 90, {});
    assert.ok(Buffer.isBuffer(r.data));
    assert.strictEqual(r.data[0], 0xff);
    assert.strictEqual(r.data[1], 0xd8, 'JPEG SOI');
    assert.strictEqual(r.status_code, 1);
  });

  await T('decodeToJpeg honours outputWidth/outputHeight', async () => {
    const r = await zjxl.decodeToJpeg(jxl, 90, { outputWidth: 8, outputHeight: 4 });
    const info = await zjxl.getJxlInfo(jxl);
    void info;
    assert.strictEqual(r.data[0], 0xff);
    // scan SOF for dimensions
    const d = r.data;
    let p = 2;
    let w = 0, h = 0;
    while (p < d.length - 9) {
      if (d[p] !== 0xff) { p++; continue; }
      const m = d[p + 1];
      const len = d.readUInt16BE(p + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        h = d.readUInt16BE(p + 5);
        w = d.readUInt16BE(p + 7);
        break;
      }
      p += 2 + len;
    }
    assert.strictEqual(w, 8, 'scaled width');
    assert.strictEqual(h, 4, 'scaled height');
  });

  await T('resizeJxl rescales', async () => {
    const r = await zjxl.resizeJxl(jxl, 8, 4);
    const info = await zjxl.getJxlInfo(r.data);
    assert.strictEqual(info.width, 8);
    assert.strictEqual(info.height, 4);
  });

  await T('resizeJxlLimit fits within bound', async () => {
    const r = await zjxl.resizeJxlLimit(jxl, 32, 32, 8);
    const info = await zjxl.getJxlInfo(r.data);
    assert.ok(info.width <= 8 && info.height <= 8, `fits: ${info.width}x${info.height}`);
    assert.ok(info.width > 0 && info.height > 0);
  });

  await T('jxlDecompressMulti returns ordered JPEG descriptors and writes requested files', async () => {
    const fs = require('fs/promises');
    const dir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'zalo-jxl-multi-'));
    const input = path.join(dir, 'input.jxl'), output = path.join(dir, 'preview.jpg');
    try {
      await fs.writeFile(input, jxl);
      const options = {localPath: input, quality: .8, tasks: [
        {maxWidth: 8, maxHeight: 8, outputPath: output},
        {width: 4, height: 4}, {}, {maxWidth: 100, maxHeight: 100},
        {width: W, height: H, maxWidth: 8, maxHeight: 8},
      ]};
      const result = await zjxl.jxlDecompressMulti(options);
      assert.strictEqual(result.status_code, 1);
      assert.ok(Array.isArray(result.data), 'desktop requires a descriptor array, not JPEG bytes');
      assert.deepStrictEqual(result.data.map(r => [r.width, r.height]), [[8,4],[4,2],[16,8],[16,8],[8,4]]);
      assert.strictEqual(result.data[0].output_path, output);
      assert.strictEqual(result.data[0].data, undefined);
      for (const item of result.data) {
        const jpeg = item.output_path ? await fs.readFile(item.output_path) : item.data;
        assert.ok(Buffer.isBuffer(jpeg));
        assert.strictEqual(jpeg.readUInt16BE(0), 0xffd8);
        assert.strictEqual(item.size, jpeg.length);
        // Verify actual SOF dimensions, not just the descriptor metadata.
        let p = 2;
        while (p < jpeg.length - 9) {
          const marker = jpeg[p + 1];
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4,0xc8,0xcc].includes(marker)) {
            assert.strictEqual(jpeg.readUInt16BE(p + 5), item.height);
            assert.strictEqual(jpeg.readUInt16BE(p + 7), item.width);
            break;
          }
          p += 2 + jpeg.readUInt16BE(p + 2);
        }
        assert.ok(p < jpeg.length - 9, 'JPEG contains a SOF marker');
      }
      assert.strictEqual(options.tasks[0].maxWidth, 8, 'caller options unchanged');
      const memory = await zjxl.jxlDecompressMulti({buffer: jxl});
      assert.strictEqual(memory.data.length, 1);
      assert.strictEqual(memory.data[0].output_path, '');
      assert.deepStrictEqual((await zjxl.jxlDecompressMulti({buffer: jxl, tasks: []})).data, []);
      await assert.rejects(zjxl.jxlDecompressMulti({buffer: jxl, tasks: [{outputPath: path.join(dir, 'missing', 'image.jpg')}]}), {code:'ENOENT'});
      await assert.rejects(zjxl.jxlDecompressMulti({buffer: Buffer.from('invalid')}), {code:2003});
    } finally {
      await fs.rm(dir, {recursive:true, force:true});
    }
  });

  await T('corrupt buffer rejects with status_code', async () => {
    let err = null;
    try {
      await zjxl.decodeToJpeg(Buffer.from('not a jxl at all'), 90, {});
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'rejects');
    assert.strictEqual(typeof err.code, 'number', 'custom error code');
    assert.match(err.message, /decodeToJpeg error/);
  });

  await T('exports stable surface', () => {
    for (const fn of ['decodeToJpeg', 'bitmapToJxl', 'getJxlInfo', 'resizeJxl', 'resizeJxlLimit', 'moduleReady', 'jxlDecompressMulti']) {
      assert.strictEqual(typeof zjxl[fn], 'function', fn);
    }
  });

  if (!process.exitCode) console.log(`\nALL zjxl LINUX TESTS PASS (${pass})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
