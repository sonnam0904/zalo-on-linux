#!/bin/sh
# Build nativedirstat for linux-x64 with plain gcc -- no node-gyp, no
# system packages, no network. Only the Node headers that ship inside the
# Node/nvm installation are needed.
#
# Usage: ./build.sh [node-root]
set -eu

here=$(cd "$(dirname "$0")" && pwd)
src="$here/src/nativedirstat.c"
out="$here/linux-x64/nativedirstat.node"

if [ "${1:-}" != "" ]; then
  node_prefix=$1
else
  node_bin=$(command -v node)
  node_prefix=$(cd "$(dirname "$node_bin")/.." && pwd)
fi

inc="$node_prefix/include/node"
if [ ! -f "$inc/node_api.h" ]; then
  echo "error: node_api.h not found under $inc" >&2
  echo "pass the node prefix as the first argument" >&2
  exit 1
fi

mkdir -p "$(dirname "$out")"

${CC:-cc} -O2 -fPIC -shared -fvisibility=hidden \
  -I"$inc" \
  -o "$out" "$src" \
  -Wl,-soname,nativedirstat.node

echo "built $out"
ls -l "$out"
