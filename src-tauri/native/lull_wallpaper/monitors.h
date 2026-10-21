/**
 * 显示器枚举与拓扑工具：统一物理坐标换算，并提供监视器快照和拓扑指纹。
 */

#ifndef LULL_MONITORS_H
#define LULL_MONITORS_H

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include <cstdint>
#include <cstring>

// 复用 EnsureDpiAware / DpiAwareness 与 kBaselineDpi（同为纯 Win32，无 Godot 依赖）。
#include "wallpaper_host.h"

namespace lull {
namespace wallpaper {

const int kMaxMonitors = 16;

// 一台显示器。矩形全部是物理像素、桌面坐标。
struct MonitorDesc {
	int index = 0;
	wchar_t device[32] = {0}; // \\.\DISPLAY1
	bool primary = false;
	RECT desktop = {0, 0, 0, 0}; // 物理区域
	RECT work = {0, 0, 0, 0};    // 工作区（扣掉任务栏）
	unsigned int dpi = 96;
};

namespace detail_m {

inline void CopyName(wchar_t *p_dst, int p_cap, const wchar_t *p_src) {
	int i = 0;
	if (p_src) {
		for (; i < p_cap - 1 && p_src[i] != 0; ++i) {
			p_dst[i] = p_src[i];
		}
	}
	p_dst[i] = 0;
}

// 显示器 DPI。动态取 GetDpiForMonitor（shcore），失败退 kBaselineDpi (96)。
// 注意：进程必须是「每显示器 DPI 感知」，否则这里拿到的是被虚拟化的值。
inline unsigned int QueryMonitorDpi(HMONITOR p_mon) {
	typedef HRESULT(WINAPI * GetDpiForMonitorFn)(HMONITOR, int, UINT *, UINT *);
	static GetDpiForMonitorFn s_fn = nullptr;
	static bool s_probed = false;
	if (!s_probed) {
		s_probed = true;
		HMODULE sh = LoadLibraryW(L"shcore.dll");
		if (sh) {
			s_fn = reinterpret_cast<GetDpiForMonitorFn>(
					reinterpret_cast<void *>(GetProcAddress(sh, "GetDpiForMonitor")));
		}
	}
	UINT x = kBaselineDpi, y = kBaselineDpi;
	if (s_fn && p_mon) {
		// MDT_EFFECTIVE_DPI == 0
		if (s_fn(p_mon, 0, &x, &y) != S_OK) {
			return kBaselineDpi;
		}
		return static_cast<unsigned int>(x);
	}
	return kBaselineDpi;
}

struct EnumCtx {
	MonitorDesc *out = nullptr;
	int max = 0;
	int count = 0;
};

inline BOOL CALLBACK MonitorProc(HMONITOR p_mon, HDC, LPRECT, LPARAM p_lp) {
	EnumCtx *c = reinterpret_cast<EnumCtx *>(p_lp);
	if (c->count >= c->max) {
		return FALSE;
	}
	MONITORINFOEXW mi;
	std::memset(&mi, 0, sizeof(mi));
	mi.cbSize = sizeof(MONITORINFOEXW);
	if (!GetMonitorInfoW(p_mon, &mi)) {
		return TRUE;
	}
	MonitorDesc &d = c->out[c->count];
	d.index = c->count;
	CopyName(d.device, 32, mi.szDevice);
	d.primary = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0;
	d.desktop = mi.rcMonitor;
	d.work = mi.rcWork;
	d.dpi = QueryMonitorDpi(p_mon);
	++c->count;
	return TRUE;
}

} // namespace detail_m

// 枚举显示器，按系统顺序写入 p_out。返回实际数量。
inline int EnumMonitors(MonitorDesc *p_out, int p_max) {
	if (!p_out || p_max <= 0) {
		return 0;
	}
	detail_m::EnumCtx c;
	c.out = p_out;
	c.max = p_max;
	EnumDisplayMonitors(nullptr, nullptr, detail_m::MonitorProc, reinterpret_cast<LPARAM>(&c));
	if (c.count == 0) {
		// 极端兜底：连一台都没枚举到就用主屏指标造一条，保证上层不至于无屏可用。
		MonitorDesc &d = p_out[0];
		d.index = 0;
		detail_m::CopyName(d.device, 32, L"\\\\.\\DISPLAY1");
		d.primary = true;
		d.desktop.left = 0;
		d.desktop.top = 0;
		d.desktop.right = GetSystemMetrics(SM_CXSCREEN);
		d.desktop.bottom = GetSystemMetrics(SM_CYSCREEN);
		d.work = d.desktop;
		d.dpi = kBaselineDpi;
		return 1;
	}
	return c.count;
}

// 虚拟桌面**包围盒**（物理像素、桌面坐标）。多屏尺寸不一致时会产生"死区"，
// 例如 A=1920x1080、B=2560x1440 时包围盒是 4480x1440，其中 1920x360 永远看不见。
inline RECT GetVirtualRect() {
	RECT r = {0, 0, 0, 0};
	r.left = GetSystemMetrics(SM_XVIRTUALSCREEN);
	r.top = GetSystemMetrics(SM_YVIRTUALSCREEN);
	r.right = r.left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
	r.bottom = r.top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
	return r;
}

// 画布坐标 → 桌面坐标（画布原点 = 虚拟桌面左上角）。
inline RECT CanvasToDesktop(const RECT &p_virtual, const RECT &p_canvas) {
	RECT r;
	r.left = p_canvas.left + p_virtual.left;
	r.top = p_canvas.top + p_virtual.top;
	r.right = p_canvas.right + p_virtual.left;
	r.bottom = p_canvas.bottom + p_virtual.top;
	return r;
}

// 桌面坐标 → 画布坐标。
inline RECT DesktopToCanvas(const RECT &p_virtual, const RECT &p_desktop) {
	RECT r;
	r.left = p_desktop.left - p_virtual.left;
	r.top = p_desktop.top - p_virtual.top;
	r.right = p_desktop.right - p_virtual.left;
	r.bottom = p_desktop.bottom - p_virtual.top;
	return r;
}

// 桌面坐标 → 某窗口的客户区坐标。壁纸窗口是宿主的 WS_CHILD，必须用这套坐标定位。
inline RECT DesktopToClient(HWND p_host, const RECT &p_desktop) {
	RECT r = p_desktop;
	if (!p_host || !IsWindow(p_host)) {
		return r;
	}
	POINT tl;
	tl.x = p_desktop.left;
	tl.y = p_desktop.top;
	POINT br;
	br.x = p_desktop.right;
	br.y = p_desktop.bottom;
	ScreenToClient(p_host, &tl);
	ScreenToClient(p_host, &br);
	r.left = tl.x;
	r.top = tl.y;
	r.right = br.x;
	r.bottom = br.y;
	return r;
}

// 拓扑指纹：显示器数量 / 设备名 / 矩形 / DPI / 主屏标志，任一变化则指纹变化。
// 热插拔、改分辨率、改缩放、改主屏都会被这里捕捉到。
inline uint64_t TopologyHash(const MonitorDesc *p_list, int p_count, HWND p_host) {
	uint64_t h = 1469598103934665603ull; // FNV-1a offset basis
	const auto mix = [&h](uint64_t v) {
		h ^= v;
		h *= 1099511628211ull;
	};
	mix(static_cast<uint64_t>(p_count));
	for (int i = 0; i < p_count; ++i) {
		const MonitorDesc &d = p_list[i];
		for (int k = 0; k < 32; ++k) {
			wchar_t c = d.device[k];
			if (c == 0) {
				break;
			}
			mix(static_cast<uint64_t>(c));
		}
		mix(static_cast<uint64_t>(d.desktop.left));
		mix(static_cast<uint64_t>(d.desktop.top));
		mix(static_cast<uint64_t>(d.desktop.right));
		mix(static_cast<uint64_t>(d.desktop.bottom));
		mix(static_cast<uint64_t>(d.dpi));
		mix(static_cast<uint64_t>(d.primary ? 1 : 0));
	}
	// 宿主客户区尺寸也纳入：Explorer 重启后宿主换句柄、尺寸可能变。
	if (p_host && IsWindow(p_host)) {
		RECT rc = {0, 0, 0, 0};
		GetClientRect(p_host, &rc);
		mix(static_cast<uint64_t>(rc.right - rc.left));
		mix(static_cast<uint64_t>(rc.bottom - rc.top));
	}
	return h;
}

} // namespace wallpaper
} // namespace lull

#endif // LULL_MONITORS_H
