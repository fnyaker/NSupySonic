#!/bin/sh
# Rebuild kernel.wasm. The OUTPUT is committed on purpose: nobody needs a
# WebAssembly toolchain to work on this repository, and the SPA build stays a
# plain `npm run build`. Run this only when kernel.c changes.
set -e
cd "$(dirname "$0")"
clang --target=wasm32 -O3 -msimd128 -nostdlib -ffreestanding \
  -Wl,--no-entry -Wl,--export-all -Wl,--allow-undefined \
  -o kernel.wasm kernel.c
ls -l kernel.wasm
