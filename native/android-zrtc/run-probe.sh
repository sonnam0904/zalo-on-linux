#!/usr/bin/env bash
set -euo pipefail
# Never inject Android libc into Electron/glibc. Run a separate Bionic process.
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ $# != 4 ]]; then
  echo "Usage: bash run-probe.sh NDK_DIR BIONIC_DIR APK_LIB_DIR OUTPUT_DIR" >&2
  exit 2
fi
ndk_dir=$(realpath "$1")
bionic_dir=$(realpath "$2")
apk_lib_dir=$(realpath "$3")
mkdir -p "$4"
output_dir=$(realpath "$4")
compiler="$ndk_dir/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android21-clang"
expected=c7e5f005fd5c12dc64d72008a1871638246899a9cf6b034dc13981c014caeefe
actual=$(sha256sum "$apk_lib_dir/libzrtc.so")
if [[ ${actual%% *} != "$expected" ]]; then
  echo "Unsupported libzrtc build: ABI must be re-verified before calling exports" >&2
  exit 2
fi
for name in linker64 libc.so libdl.so libm.so libz.so libstdc++.so; do
  test -f "$bionic_dir/$name"
done
mkdir -p "$output_dir/platform"
"$compiler" -Wall -Wextra -Werror -shared -fPIC "$source_dir/platform-probe.c" -o "$output_dir/platform/liblog.so"
for name in libOpenSLES.so libGLESv2.so libandroid.so; do
  ln -sfn liblog.so "$output_dir/platform/$name"
done
"$compiler" -Wall -Wextra -Werror "$source_dir/probe.c" -o "$output_dir/probe" -ldl -lm
# Prefer APK C++/codec libraries; use platform adapters only for absent services.
# Clear preload variables so an inherited host injection cannot contaminate Bionic.
status=0
timeout 20 env -u LD_PRELOAD -u LD_AUDIT \
  LD_LIBRARY_PATH="$output_dir/platform:$apk_lib_dir:$bionic_dir" \
  "$bionic_dir/linker64" "$output_dir/probe" "$apk_lib_dir/libzrtc.so" \
  > "$output_dir/probe.log" 2>&1 || status=$?
cat "$output_dir/probe.log"
exit "$status"
