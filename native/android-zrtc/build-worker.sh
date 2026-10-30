#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 4 ]]; then
  echo 'Usage: build-worker.sh NDK_DIR BIONIC_DIR APK_LIB_DIR OUTPUT_DIR' >&2; exit 2
fi
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bash "$source_dir/run-probe.sh" "$@"
cc -O2 -Wall -Wextra -Werror "$source_dir/pcm-host.c" -o "$4/pcm-host" -ldl
compiler="$1/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android21-clang"
"$compiler" -g -Wall -Wextra -Werror "$source_dir/worker.c" "$source_dir/compat-jni.c" \
  "$source_dir/call-events.c" "$source_dir/pcm-bridge.c" "$source_dir/voice-platform.c" \
  "$source_dir/video-peer-linux.c" "$source_dir/video-source-linux.c" "$source_dir/video-frame-store.c" \
  -o "$4/zrtc-worker" -ldl
