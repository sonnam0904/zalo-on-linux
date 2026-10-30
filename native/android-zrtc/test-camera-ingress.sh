#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 ]]; then
  echo 'Usage: test-camera-ingress.sh NDK_DIR RUNTIME_DIR' >&2; exit 2
fi
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
runtime_dir=$(realpath "$2")
apk_dir="$runtime_dir/apk/lib/x86_64"
actual=$(sha256sum "$apk_dir/libzrtc.so")
[[ ${actual%% *} == c7e5f005fd5c12dc64d72008a1871638246899a9cf6b034dc13981c014caeefe ]] || exit 2
"$1/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android21-clang" \
  -Wall -Wextra -Werror "$source_dir/video-source-probe.c" "$source_dir/video-source-linux.c" -ldl -o "$runtime_dir/results/video-source-probe"
# The original Android byte-buffer path is NV21. Verify non-neutral V/U planes
# directly before opening a physical device, so a UV regression fails clearly.
timeout 15 env -u LD_PRELOAD -u LD_AUDIT \
  LD_LIBRARY_PATH="$runtime_dir/results/platform:$apk_dir:$runtime_dir/bionic" \
  "$runtime_dir/bionic/linker64" "$runtime_dir/results/video-source-probe" \
  "$apk_dir/libzrtc.so" --verify-nv21
# Explicit camera only. Frames are piped, never saved or transmitted.
ffmpeg -hide_banner -loglevel error -nostdin -f v4l2 -input_format mjpeg \
  -video_size 640x480 -framerate 30 -i /dev/video0 -frames:v 30 -pix_fmt nv21 -f rawvideo - |
  timeout 15 env -u LD_PRELOAD -u LD_AUDIT \
    LD_LIBRARY_PATH="$runtime_dir/results/platform:$apk_dir:$runtime_dir/bionic" \
    "$runtime_dir/bionic/linker64" "$runtime_dir/results/video-source-probe" "$apk_dir/libzrtc.so"
