#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 && $# != 3 ]]; then echo 'Usage: test-video-codec.sh NDK_DIR RUNTIME_DIR [--encoded-fd3]' >&2; exit 2; fi
extra_args=()
if [[ $# == 3 ]]; then
  [[ $3 == --encoded-fd3 ]] || exit 2
  extra_args=(--encoded-fd3)
fi
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
runtime_dir=$(realpath "$2")
apk_dir="$runtime_dir/apk/lib/x86_64"
actual=$(sha256sum "$apk_dir/libzrtc.so")
[[ ${actual%% *} == c7e5f005fd5c12dc64d72008a1871638246899a9cf6b034dc13981c014caeefe ]] || exit 2
"$1/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android21-clang" \
  -Wall -Wextra -Werror "$source_dir/video-codec-probe.c" "$source_dir/video-source-linux.c" -ldl -o "$runtime_dir/results/video-codec-probe"
timeout 20 env -u LD_PRELOAD -u LD_AUDIT \
  LD_LIBRARY_PATH="$runtime_dir/results/platform:$apk_dir:$runtime_dir/bionic" \
  "$runtime_dir/bionic/linker64" "$runtime_dir/results/video-codec-probe" "$apk_dir/libzrtc.so" "${extra_args[@]}"
