#!/usr/bin/env bash
# 原生宿主构建脚本：自动定位 MSVC 与 Windows SDK，编译 lull_native.dll。
#
# 可覆盖的环境变量：
#   LULL_MSVC_ROOT      MSVC 工具链根目录（包含 bin/Hostx64/x64/cl.exe）
#   LULL_WINSDK_ROOT    Windows SDK 根目录（默认 C:/Program Files (x86)/Windows Kits/10）
#   LULL_WINSDK_VERSION SDK 版本（默认取 Include 下最新版本）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# MSYS 会把 /nologo 之类当成路径改写，必须关掉。
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

# 1) 定位 MSVC：优先环境变量，其次按安装目录扫描，取版本最高的一份。
find_msvc() {
  if [ -n "${LULL_MSVC_ROOT:-}" ]; then
    printf '%s\n' "$LULL_MSVC_ROOT"
    return
  fi
  local cl
  cl="$(
    for base in \
      "/c/Program Files/Microsoft Visual Studio" \
      "/c/Program Files (x86)/Microsoft Visual Studio" \
      "/d/Program Files/Microsoft Visual Studio"; do
      [ -d "$base" ] || continue
      for candidate in "$base"/*/*/VC/Tools/MSVC/*/bin/Hostx64/x64/cl.exe; do
        [ -f "$candidate" ] && printf '%s\n' "$candidate"
      done
    done | sort -V | tail -n 1
  )"
  if [ -z "$cl" ]; then
    return 1
  fi
  # 去掉 /bin/Hostx64/x64/cl.exe，得到 MSVC 工具链根目录（Windows 形式）。
  printf '%s\n' "${cl%/bin/Hostx64/x64/cl.exe}"
}

MSVC_WIN="$(find_msvc || true)"
if [ -z "$MSVC_WIN" ]; then
  echo "找不到 MSVC cl.exe。请安装 Visual Studio 的「使用 C++ 的桌面开发」，或设置 LULL_MSVC_ROOT。" >&2
  exit 1
fi
MSVC="$(cygpath -u "$MSVC_WIN")"

SDK_WIN="${LULL_WINSDK_ROOT:-C:/Program Files (x86)/Windows Kits/10}"
SDK="$(cygpath -u "$SDK_WIN")"
if [ ! -d "$SDK/Include" ]; then
  echo "找不到 Windows SDK：$SDK_WIN" >&2
  exit 1
fi
SDKVER="${LULL_WINSDK_VERSION:-$(ls "$SDK/Include" | sort -V | tail -n 1)}"

W_MSVC="$(cygpath -w "$MSVC")"
W_SDK="$(cygpath -w "$SDK")"

export INCLUDE="$W_MSVC\\include;$W_SDK\\Include\\$SDKVER\\um;$W_SDK\\Include\\$SDKVER\\ucrt;$W_SDK\\Include\\$SDKVER\\shared;$W_SDK\\Include\\$SDKVER\\winrt"
export LIB="$W_MSVC\\lib\\x64;$W_SDK\\Lib\\$SDKVER\\um\\x64;$W_SDK\\Lib\\$SDKVER\\ucrt\\x64"
export PATH="$MSVC/bin/Hostx64/x64:$PATH"

# 2) 纯 Win32 头文件（wallpaper_host.h / monitors.h / timing.h / log_file.h）——
#    本仓库自带副本（native/lull_wallpaper/），不跨仓引用。
LULL_WP="$ROOT/lull_wallpaper"
if [ ! -f "$LULL_WP/wallpaper_host.h" ]; then
  echo "缺少 $LULL_WP/wallpaper_host.h（本地副本被删了？）" >&2
  exit 1
fi

echo "MSVC: $W_MSVC"
echo "Windows SDK: $W_SDK ($SDKVER)"

# 3) 编译
cl /nologo /utf-8 /std:c++17 /Zc:__cplusplus /O2 /W3 /EHsc /MT /LD \
  /DNOMINMAX \
  /I "$(cygpath -w "$ROOT")" \
  /I "$(cygpath -w "$LULL_WP")" \
  /Fo:"$(cygpath -w "$ROOT")\\" \
  /Fe:"$(cygpath -w "$ROOT/lull_native.dll")" \
  lull_native_shim.cpp \
  user32.lib shell32.lib gdi32.lib advapi32.lib

echo "built: $ROOT/lull_native.dll"
ls -la "$ROOT/lull_native.dll"
