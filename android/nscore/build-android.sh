#!/bin/sh
# Build libnscore for the Android ABIs the app ships and drop each into
# app/src/main/jniLibs/<abi>/, where Gradle packs it into the APK.
#
# Needs the Rust targets (rustup target add aarch64-linux-android
# armv7-linux-androideabi x86_64-linux-android) and an NDK: ANDROID_NDK_HOME,
# else ANDROID_NDK_LATEST_HOME (what GitHub's runners set). No cargo-ndk: the
# NDK's own clang wrappers are the linkers, named per target and API level.
set -eu
cd "$(dirname "$0")"
NDK="${ANDROID_NDK_HOME:-${ANDROID_NDK_LATEST_HOME:-}}"
[ -n "$NDK" ] || { echo "build-android.sh: set ANDROID_NDK_HOME" >&2; exit 1; }
TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
API=26  # the app's minSdk
# 16 KB pages (Android 15 devices may use them): a library aligned for 4 KB
# refuses to load there.
export RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$TC/aarch64-linux-android$API-clang"
export CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER="$TC/armv7a-linux-androideabi$API-clang"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$TC/x86_64-linux-android$API-clang"
for pair in "aarch64-linux-android arm64-v8a" "armv7-linux-androideabi armeabi-v7a" "x86_64-linux-android x86_64"; do
  set -- $pair
  cargo build --release --target "$1"
  mkdir -p "../app/src/main/jniLibs/$2"
  cp "target/$1/release/libnscore.so" "../app/src/main/jniLibs/$2/"
done
