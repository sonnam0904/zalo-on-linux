'use strict';
// nativedirstat -- Linux native directory walker (getdents64 + statx).
//
// Exposes the storage-stat contract the app already calls through the
// mainless worker, with a pure-JS fallback so nothing breaks if the addon
// was not built for this machine:
//
//   getDirectorySizeSync(path)           -> {totalSize,fileCount,dirCount,durationMs}
//   getDirectorySizeAsync(path[, jobId]) -> Promise<same>
//   getDirSizeSync(path)                 -> number
//   getDirSize(path)                     -> Promise<number>
//   cancelJob(jobId)                     -> boolean
//   usingNative()                        -> boolean
//
// Fallback semantics are the ones main-dist/mainless-worker.js uses today
// (readdir + lstat, symlinks not followed, unreadable subtrees skipped), so
// the parity test can compare the two implementations directly.

const fs = require('fs');
const path = require('path');

function loadAddon() {
  try {
    return require('./linux-x64/nativedirstat.node');
  } catch (e) {
    return null;
  }
}

const addon = process.platform === 'linux' ? loadAddon() : null;

// ---- JS fallback -----------------------------------------------------------

function walkSyncFallback(root) {
  const st = fs.lstatSync(root);
  if (!st.isDirectory()) {
    return { totalSize: st.size, fileCount: 1, dirCount: 0 };
  }
  let totalSize = 0;
  let fileCount = 0;
  let dirCount = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue; // unreadable subtree -> skipped
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      let est;
      try {
        est = fs.lstatSync(full);
      } catch (e) {
        continue;
      }
      if (est.isDirectory()) {
        dirCount++;
        stack.push(full);
      } else {
        totalSize += est.size;
        fileCount++;
      }
    }
  }
  return { totalSize, fileCount, dirCount };
}

function elapsed(t0) {
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// ---- public surface --------------------------------------------------------

function getDirectorySizeSync(p) {
  if (addon) return addon.getDirectorySizeSync(p);
  const t0 = process.hrtime.bigint();
  const r = walkSyncFallback(p);
  return { ...r, durationMs: elapsed(t0) };
}

let nextJobId = 1;

async function getDirectorySizeAsync(p, optionsOrJobId, maybeJobId) {
  if (addon) {
    let jobId = 0;
    if (typeof maybeJobId === 'number') jobId = maybeJobId;
    else if (typeof optionsOrJobId === 'number') jobId = optionsOrJobId;
    const abortSignal =
      optionsOrJobId && typeof optionsOrJobId === 'object'
        ? optionsOrJobId.abortSignal
        : null;
    if (abortSignal) {
      if (abortSignal.aborted) {
        const err = new Error('Operation was aborted');
        err.code = 'ECANCELED';
        err.name = 'AbortError';
        throw err;
      }
      if (!jobId) jobId = nextJobId++;
      const onAbort = () => addon.cancelJob(jobId);
      abortSignal.addEventListener('abort', onAbort);
      try {
        return await addon.getDirectorySizeAsync(p, jobId);
      } finally {
        abortSignal.removeEventListener('abort', onAbort);
      }
    }
    return addon.getDirectorySizeAsync(p, jobId);
  }
  return getDirectorySizeSync(p);
}

function getDirSizeSync(p) {
  if (addon) return addon.getDirSizeSync(p);
  return walkSyncFallback(p).totalSize;
}

async function getDirSize(p) {
  if (addon) return addon.getDirSize(p);
  return getDirSizeSync(p);
}

function cancelJob(jobId) {
  if (addon) return addon.cancelJob(jobId);
  return false;
}

function usingNative() {
  return !!addon;
}

module.exports = {
  getDirectorySizeSync,
  getDirectorySizeAsync,
  getDirSizeSync,
  getDirSize,
  cancelJob,
  usingNative,
};
