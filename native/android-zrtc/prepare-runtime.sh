#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 3 ]]; then
  echo "Usage: bash prepare-runtime.sh SDK_SYSTEM_IMG APKM NEW_OUTPUT_DIR" >&2
  exit 2
fi
system_img=$(realpath "$1")
apkm=$(realpath "$2")
# Require a new directory so existing user files cannot be overwritten.
mkdir -- "$3"
dest=$(realpath "$3")
scratch=$(mktemp -d "$dest/extract.XXXXXX")
cleanup() {
  # Only remove the three intermediate files created by this script.
  rm -f -- "$scratch/1.super.img" "$scratch/system.img" "$scratch/split_config.x86_64.apk"
  rmdir -- "$scratch"
}
trap cleanup EXIT
mkdir "$dest/bionic" "$dest/apk"
# Requires 7-Zip supporting GPT, Android LP and ext4 (tested with 26.00).
7z x "$system_img" 1.super.img "-o$scratch" -y -bso0
7z x "$scratch/1.super.img" system.img "-o$scratch" -y -bso0
7z e "$scratch/system.img" \
  system/bin/bootstrap/linker64 \
  system/lib64/bootstrap/libc.so system/lib64/bootstrap/libdl.so \
  system/lib64/bootstrap/libm.so system/lib64/libz.so \
  system/lib64/libstdc++.so "-o$dest/bionic" -y -bso0
chmod +x "$dest/bionic/linker64"
unzip -q "$apkm" split_config.x86_64.apk -d "$scratch"
unzip -q "$scratch/split_config.x86_64.apk" 'lib/x86_64/*' -d "$dest/apk"
echo "Runtime: $dest/bionic"
echo "APK libraries: $dest/apk/lib/x86_64"
