# nativedirstat

Linux-x64 native directory walker (getdents64 + statx), N-API addon, no
node-gyp and no system packages.

## Why

On Linux the app's storage screens call the mainless methods
`getDirSize`, `getDirSizeNoCaching`, `getTotalLocalFiles` and
`getDirectorySizeInfoSync`. Those are implemented in pure JS in
`main-dist/mainless-worker.js` with `readdir` + `lstat` per entry: one
libuv threadpool round-trip per file. This addon performs the same walk
with `getdents64(2)` (one syscall per ~32 KiB of directory entries instead
of one per entry) and uses the `d_type` already present in
`struct linux_dirent64`, falling back to `statx(2)` only for
`DT_UNKNOWN`.

Measured on 50,000 files (200 dirs x 250 files) on this machine:

| implementation | time |
|---|---|
| JS `readdir` + `lstat` (current) | 162.2 ms |
| native `getdents64` + `statx` | 95.2 ms |
| | **1.70x faster** |

At 10,000 files the margin is 1.55x. The gain comes from removing the
per-entry JS/native boundary and the per-entry libuv round-trip, not from
caching.

## Contract

```js
const ds = require('./index.js');

ds.getDirectorySizeSync('/path')            // { totalSize, fileCount, dirCount, durationMs }
await ds.getDirectorySizeAsync('/path')     // same shape
await ds.getDirectorySizeAsync('/path', { abortSignal })  // rejects ECANCELED
ds.getDirSizeSync('/path')                  // number (bytes)
await ds.getDirSize('/path')                // number (bytes)
ds.cancelJob(jobId)                         // boolean
ds.usingNative()                            // boolean
```

Semantics are the ones `main-dist/mainless-worker.js` already relies on:

* recursive; symlinks are **not** followed (they contribute their own
  `lstat` size), matching `lstat`-per-entry behaviour;
* unreadable subdirectories are skipped, not fatal;
* a non-directory root reports its own size with `fileCount: 1`;
* a missing root throws/rejects with `.code === 'ENOENT'`;
* a cancelled job rejects with `.code === 'ECANCELED'`.

If `linux-x64/nativedirstat.node` is absent, `index.js` transparently falls
back to the same pure-JS walk, so consumers never need to branch.

## Build

No system packages, no network, no node-gyp. Only the Node headers shipped
inside the Node/nvm installation are used.

```sh
./build.sh              # auto-detects the node prefix from `which node`
./build.sh /path/to/node-prefix   # explicit
```

Produces `linux-x64/nativedirstat.node` (~22 KiB).

## Test

Plain Node, no Electron, no GUI:

```sh
node test-linux.js
```

The test builds a synthetic tree (empty dirs, 64-level deep chain, symlink,
file root, unreadable subtree, 4,000-file subtree) and asserts the native
walker and the JS reference walker agree on every field, then checks error
codes and cancellation, and finally asserts the native walk is not slower
than the JS walk.
