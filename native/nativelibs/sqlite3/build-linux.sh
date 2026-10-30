#!/bin/sh
# Build binding/napi-v6-linux-x64/node_sqlite3.node from upstream node-sqlite3
# inside an old-glibc container, so the result loads on older distros too
# (Ubuntu 22.04 / Pop!_OS 22.04 ship glibc 2.35).
#
# A binding built on a current distro picks up versioned symbols such as
# fmod@GLIBC_2.38; on older systems it then fails to load, the database never
# opens and Zalo hangs right after login.
#
# Requires docker. Usage: ./build-linux.sh
set -eu

SQLITE3_NPM_VERSION=${SQLITE3_NPM_VERSION:-6.0.1}   # bundles SQLite 3.52.0
IMAGE=${IMAGE:-node:20-bullseye}                    # Debian 11, glibc 2.31
MAX_GLIBC=${MAX_GLIBC:-2.31}

here=$(cd "$(dirname "$0")" && pwd)
outdir="$here/binding/napi-v6-linux-x64"
mkdir -p "$outdir"

docker run --rm --platform linux/amd64 \
  -e SQLITE3_NPM_VERSION="$SQLITE3_NPM_VERSION" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$outdir:/out" \
  "$IMAGE" bash -euc '
    cd /tmp
    npm pack --silent "sqlite3@$SQLITE3_NPM_VERSION" >/dev/null
    tar xzf sqlite3-*.tgz
    cd package
    npm install --ignore-scripts --no-audit --no-fund --silent
    npx --yes node-gyp@10 rebuild --release
    strip --strip-unneeded build/Release/node_sqlite3.node
    install -m 0755 build/Release/node_sqlite3.node /out/node_sqlite3.node
    chown "$HOST_UID:$HOST_GID" /out/node_sqlite3.node
  '

out="$outdir/node_sqlite3.node"
need=$(objdump -T "$out" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -1)
if [ "$(printf '%s\n%s\n' "$need" "$MAX_GLIBC" | sort -V | tail -1)" != "$MAX_GLIBC" ]; then
  echo "error: $out requires GLIBC_$need (> $MAX_GLIBC)" >&2
  exit 1
fi

echo "built $out (requires GLIBC_$need)"
ls -l "$out"
