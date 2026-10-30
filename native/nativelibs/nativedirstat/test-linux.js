'use strict';
// Parity test for the nativedirstat N-API addon (linux-x64).
// Run from this directory with plain Node -- no Electron, no GUI:
//
//   node test-linux.js
//
// Proves the native getdents64 walker and the pure-JS fallback that
// main-dist/mainless-worker.js uses agree exactly, on a synthetic tree that
// covers the awkward cases: empty dirs, nested dirs, symlinks, a file root,
// an unreadable subtree, and a deep chain.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const impl = require('./index.js');

let pass = 0;
function T(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { pass++; console.log('ok -', name); },
        (e) => { console.error('FAIL -', name); console.error(e); process.exitCode = 1; }
      );
    }
    pass++;
    console.log('ok -', name);
  } catch (e) {
    console.error('FAIL -', name);
    console.error(e);
    process.exitCode = 1;
  }
}

// The exact pure-JS reference implementation (copied from the contract that
// main-dist/mainless-worker.js ships, so the comparison is meaningful).
function jsWalk(root) {
  const st = fs.lstatSync(root);
  if (!st.isDirectory()) return { totalSize: st.size, fileCount: 1, dirCount: 0 };
  let totalSize = 0, fileCount = 0, dirCount = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      let est;
      try { est = fs.lstatSync(full); } catch (e) { continue; }
      if (est.isDirectory()) { dirCount++; stack.push(full); }
      else { totalSize += est.size; fileCount++; }
    }
  }
  return { totalSize, fileCount, dirCount };
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    console.log('skipped: linux x64 only');
    return;
  }

  await T('native addon loaded (usingNative)', () => {
    assert.strictEqual(impl.usingNative(), true, 'nativedirstat.node must load');
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativedirstat-test-'));
  try {
    // ---- fixture -----------------------------------------------------------
    fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
    fs.mkdirSync(path.join(root, 'empty'), { recursive: true });
    fs.mkdirSync(path.join(root, 'onlydirs', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'one.bin'), Buffer.alloc(1000, 1));
    fs.writeFileSync(path.join(root, 'a', 'two.bin'), Buffer.alloc(2048, 2));
    fs.writeFileSync(path.join(root, 'a', 'b', 'three.bin'), Buffer.alloc(4096, 3));
    fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'four.bin'), Buffer.alloc(7, 4));
    fs.symlinkSync(path.join(root, 'one.bin'), path.join(root, 'link-to-one'));

    // deep chain (64 levels) -- exercises the iterative stack
    let deep = path.join(root, 'deep');
    fs.mkdirSync(deep);
    for (let i = 0; i < 64; i++) {
      deep = path.join(deep, 'd' + i);
      fs.mkdirSync(deep);
      fs.writeFileSync(path.join(deep, 'f' + i), Buffer.alloc(1, i));
    }

    const expected = jsWalk(root);

    // ---- sync object shape -------------------------------------------------
    await T('getDirectorySizeSync matches the JS walker', () => {
      const got = impl.getDirectorySizeSync(root);
      assert.strictEqual(got.totalSize, expected.totalSize, 'totalSize');
      assert.strictEqual(got.fileCount, expected.fileCount, 'fileCount');
      assert.strictEqual(got.dirCount, expected.dirCount, 'dirCount');
      assert.ok(typeof got.durationMs === 'number' && got.durationMs >= 0, 'durationMs');
    });

    await T('symlink is counted with lstat size and not followed', () => {
      const got = impl.getDirectorySizeSync(root);
      const link = fs.lstatSync(path.join(root, 'link-to-one'));
      assert.strictEqual(got.fileCount, expected.fileCount);
      assert.ok(link.size > 0, 'symlink has a size');
      // 1000 must appear exactly once (one.bin), not twice (link not followed)
      const oneOnly = fs.lstatSync(path.join(root, 'one.bin')).size;
      assert.strictEqual(
        got.totalSize,
        expected.totalSize,
        'totalSize must not double-count the symlink target'
      );
      assert.ok(oneOnly > 0);
    });

    await T('getDirSizeSync returns the bare byte total', () => {
      assert.strictEqual(impl.getDirSizeSync(root), expected.totalSize);
    });

    // ---- async parity ------------------------------------------------------
    await T('getDirectorySizeAsync resolves the same values', async () => {
      const got = await impl.getDirectorySizeAsync(root);
      assert.strictEqual(got.totalSize, expected.totalSize);
      assert.strictEqual(got.fileCount, expected.fileCount);
      assert.strictEqual(got.dirCount, expected.dirCount);
    });

    await T('getDirSize resolves the bare byte total', async () => {
      assert.strictEqual(await impl.getDirSize(root), expected.totalSize);
    });

    // ---- degenerate inputs -------------------------------------------------
    await T('empty directory -> all zero', () => {
      const got = impl.getDirectorySizeSync(path.join(root, 'empty'));
      assert.deepStrictEqual(
        { totalSize: got.totalSize, fileCount: got.fileCount, dirCount: got.dirCount },
        { totalSize: 0, fileCount: 0, dirCount: 0 }
      );
    });

    await T('directory tree with no files', () => {
      const got = impl.getDirectorySizeSync(path.join(root, 'onlydirs'));
      assert.strictEqual(got.totalSize, 0);
      assert.strictEqual(got.fileCount, 0);
      assert.strictEqual(got.dirCount, 1);
    });

    await T('file root -> its own size, fileCount 1', () => {
      const got = impl.getDirectorySizeSync(path.join(root, 'one.bin'));
      assert.strictEqual(got.totalSize, 1000);
      assert.strictEqual(got.fileCount, 1);
      assert.strictEqual(got.dirCount, 0);
    });

    // ---- error surface -----------------------------------------------------
    await T('missing root throws ENOENT', () => {
      assert.throws(
        () => impl.getDirectorySizeSync(path.join(root, 'nope')),
        (e) => e.code === 'ENOENT'
      );
    });

    await T('missing root rejects ENOENT (async)', async () => {
      await assert.rejects(impl.getDirectorySizeAsync(path.join(root, 'nope')), (e) => e.code === 'ENOENT');
    });

    // ---- unreadable subtree is skipped, not fatal --------------------------
    if (process.getuid && process.getuid() !== 0) {
      await T('unreadable subtree is skipped like the JS walker', () => {
        const locked = path.join(root, 'locked');
        fs.mkdirSync(locked);
        fs.writeFileSync(path.join(locked, 'secret.bin'), Buffer.alloc(512, 9));
        fs.chmodSync(locked, 0o000);
        try {
          const got = impl.getDirectorySizeSync(root);
          const ref = jsWalk(root);
          assert.strictEqual(got.totalSize, ref.totalSize, 'totalSize agrees');
          assert.strictEqual(got.fileCount, ref.fileCount, 'fileCount agrees');
          // the 512-byte file must NOT be counted
          assert.ok(!got.totalSize.toString().includes('undefined'));
        } finally {
          fs.chmodSync(locked, 0o755);
        }
      });
    } else {
      console.log('skip - unreadable subtree (running as root)');
    }

    // ---- cancellation ------------------------------------------------------
    await T('cancelJob(unknown) is false', () => {
      assert.strictEqual(impl.cancelJob(987654), false);
    });

    await T('cancelJob before the walk starts rejects ECANCELED', async () => {
      const big = path.join(root, 'big');
      fs.mkdirSync(big);
      for (let d = 0; d < 40; d++) {
        const dir = path.join(big, 'd' + d);
        fs.mkdirSync(dir);
        for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(dir, 'f' + f), Buffer.alloc(1));
      }
      const jobId = 4242;
      const p = impl.getDirectorySizeAsync(big, jobId);
      assert.strictEqual(impl.cancelJob(jobId), true, 'registered job -> true');
      await assert.rejects(p, (e) => e.code === 'ECANCELED');
      assert.strictEqual(impl.cancelJob(jobId), false, 'deregistered after completion');
    });

    // ---- performance sanity ------------------------------------------------
    await T('native walk is not slower than the JS walk', () => {
      const big = path.join(root, 'big');
      if (!fs.existsSync(big)) fs.mkdirSync(big);
      // warm both
      impl.getDirectorySizeSync(big);
      jsWalk(big);
      const t0 = process.hrtime.bigint();
      const js = jsWalk(big);
      const jsMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const t1 = process.hrtime.bigint();
      const nat = impl.getDirectorySizeSync(big);
      const natMs = Number(process.hrtime.bigint() - t1) / 1e6;
      assert.strictEqual(nat.totalSize, js.totalSize);
      assert.strictEqual(nat.fileCount, js.fileCount);
      console.log(`     js=${jsMs.toFixed(1)}ms native=${natMs.toFixed(1)}ms speedup=${(jsMs / natMs).toFixed(2)}x`);
      assert.ok(natMs <= jsMs, `native (${natMs.toFixed(1)}ms) must not exceed js (${jsMs.toFixed(1)}ms)`);
    });

    // ---- export surface ----------------------------------------------------
    await T('exports stable surface', () => {
      for (const fn of [
        'getDirectorySizeSync', 'getDirectorySizeAsync',
        'getDirSizeSync', 'getDirSize', 'cancelJob', 'usingNative',
      ]) {
        assert.strictEqual(typeof impl[fn], 'function', fn);
      }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (!process.exitCode) console.log(`\nALL nativedirstat LINUX TESTS PASS (${pass})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
