/**
 * 原生桥接层：以 C ABI 导出壁纸挂载、显示器查询和可见性控制，供 Rust 进程内加载。
 */

#include "wallpaper_host.h"
#include "monitors.h"

#include <cstdio>

using namespace lull::wallpaper;

namespace {

// 全部状态都是 POD（见 README 问题 7 的教训：文件级静态量只能放 POD）。
const int kMaxSlots = 16;

struct Slot {
	HWND hwnd = nullptr;
	SavedState saved;
	Placement placement;
	RECT want_rect = {0, 0, 0, 0};
	bool want_valid = false;
	bool attached = false;
	WNDPROC orig_proc = nullptr; // WM_ERASEBKGND 子类链回用（见 WallpaperEraseProc）
};

Slot g_slots[kMaxSlots];

Slot *FindSlot(HWND p_hwnd) {
	for (Slot &s : g_slots) {
		if (s.attached && s.hwnd == p_hwnd) {
			return &s;
		}
	}
	return nullptr;
}

Slot *AllocSlot(HWND p_hwnd) {
	for (Slot &s : g_slots) {
		if (!s.attached) {
			s = Slot();
			s.hwnd = p_hwnd;
			return &s;
		}
	}
	return nullptr;
}

void FreeSlot(Slot *p_slot) {
	if (p_slot) {
		*p_slot = Slot();
	}
}

// —— 视觉硬化（2026-10-11）——
// 症状：窗口顶部露出 1px 亮线 + 两上角小亮块（窗后浅色层/窗口类背景刷的白色，即"白边"；
// 实测形状像原生标题栏残留——tao 建的窗口带 DWM 帧，清 WS_CAPTION 后 DWM 仍可能残留）。
// 处置：① 关闭该窗口的 DWM 非客户区渲染（边框/圆角/边框色）；② 子类化拦截 WM_ERASEBKGND，
// 把未绘制区涂成页面底色深色——任何残留缝隙不再显白。dwmapi 动态加载，不动构建脚本。

void ApplyDwmAttrs(HWND p_hwnd) {
	HMODULE dwm = LoadLibraryW(L"dwmapi.dll");
	if (!dwm) {
		return;
	}
	typedef HRESULT(WINAPI * DwmSetAttrFn)(HWND, DWORD, LPCVOID, DWORD);
	DwmSetAttrFn fn = reinterpret_cast<DwmSetAttrFn>(
			reinterpret_cast<void *>(GetProcAddress(dwm, "DwmSetWindowAttribute")));
	if (fn) {
		int donotround = 1; // DWMWCP_DONOTROUND
		fn(p_hwnd, 33 /*DWMWA_WINDOW_CORNER_PREFERENCE*/, &donotround, sizeof(donotround));
		DWORD border_none = 0xFFFFFFFE; // DWMWA_COLOR_NONE
		fn(p_hwnd, 34 /*DWMWA_BORDER_COLOR*/, &border_none, sizeof(border_none));
		int nc_disabled = 1; // DWMNCRP_DISABLED
		fn(p_hwnd, 2 /*DWMWA_NCRENDERING_POLICY*/, &nc_disabled, sizeof(nc_disabled));
	}
	FreeLibrary(dwm);
}

HBRUSH g_dark_brush = nullptr;

LRESULT CALLBACK WallpaperEraseProc(HWND p_hwnd, UINT p_msg, WPARAM p_wparam, LPARAM p_lparam) {
	Slot *slot = FindSlot(p_hwnd);
	// ★ 吞掉 WM_DPICHANGED（2026-10-12 源码级定案）：tauri-runtime-wry 的 webview 自适应
	// 用 `size.to_logical(window.scale_factor())` 计算 bounds——tao 的 scale 缓存若在挂载
	// 后被 DPI 变更消息"学习"成 125%（窗口被移到 125% 屏时的 WM_DPICHANGED，投递时机与
	// SetParent 存在竞态），bounds 会被除成 0.8×（"普通模式不全屏"真机制；管理员/时序不同
	// 则缓存保持 1.0 而正常）。壁纸窗永远占满整屏，不应因 DPI 变更改尺寸——吞掉即可，
	// tao 的 scale 缓存钉在 1.0，to_logical 变为恒等。
	if (p_msg == WM_DPICHANGED) {
		return 0;
	}
	if (p_msg == WM_ERASEBKGND) {
		if (!g_dark_brush) {
			g_dark_brush = CreateSolidBrush(RGB(5, 10, 16)); // 页面渐变底色
		}
		RECT rc = {0, 0, 0, 0};
		GetClientRect(p_hwnd, &rc);
		FillRect(reinterpret_cast<HDC>(p_wparam), &rc, g_dark_brush);
		return 1;
	}
	if (p_msg == WM_NCDESTROY) {
		WNDPROC orig = slot ? slot->orig_proc : nullptr;
		if (slot) {
			SetWindowLongPtrW(p_hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(orig));
			slot->orig_proc = nullptr;
		}
		if (orig) {
			return CallWindowProcW(orig, p_hwnd, p_msg, p_wparam, p_lparam);
		}
		return DefWindowProcW(p_hwnd, p_msg, p_wparam, p_lparam);
	}
	if (slot && slot->orig_proc) {
		return CallWindowProcW(slot->orig_proc, p_hwnd, p_msg, p_wparam, p_lparam);
	}
	return DefWindowProcW(p_hwnd, p_msg, p_wparam, p_lparam);
}

} // namespace

extern "C" {

// 看门狗 5（全局宿主门）——Tauri 侧缺失件（2026-10-12 修复）：0x052C 补建口信的调用方。
// 场景：系统壁纸为"纯色/无"时 Windows 不生成静态壁纸宿主 WorkerW → DefView 不透明涂色、
// 壁纸被整块盖住（所有状态位仍报正常——wallpaper_host.h 文件头"形态②"）。WorkerW 已存在
// 时零动作；缺失则 Post 一次补建口信（幂等；重复请求的节流在 Rust 侧 ensure 循环）。
__declspec(dllexport) int lull_native_ensure_host() {
	EnsureDpiAware();
	HWND progman = FindWindowW(L"Progman", nullptr);
	if (!progman) {
		return -1;
	}
	if (WorkerHostPresent(progman)) {
		return 0; // 宿主已在
	}
	return PostSpawnWorkerHost(progman) ? 1 : -2; // 1 = 口信已入队（建成与否下次复查）
}

// 当前进程是否以提升（管理员）权限运行（2026-10-12）。用途：WebView2 数据目录
// 必须按权限分离——浏览器进程组按 user data folder 共享且跨会话残留，高完整性宿主
// 退出后僵尸进程会让后续普通实例跨完整性复用失败（实测"管理员才正常"悬案源头）。
__declspec(dllexport) int lull_native_is_elevated() {
	HANDLE token = nullptr;
	if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
		return -1;
	}
	TOKEN_ELEVATION elev;
	DWORD sz = sizeof(elev);
	const BOOL ok = GetTokenInformation(token, TokenElevation, &elev, sizeof(elev), &sz);
	CloseHandle(token);
	if (!ok) {
		return -1;
	}
	return elev.TokenIsElevated ? 1 : 0;
}

// 显示器数量（EnumMonitors；进程/线程 DPI 上下文一并钉好，返回值 >= 1）。
__declspec(dllexport) int lull_native_monitor_count() {
	EnsureDpiAware();
	MonitorDesc list[kMaxMonitors];
	return EnumMonitors(list, kMaxMonitors);
}

// 单台显示器一行 k=v（按 native 枚举序 —— attach 的 monitor_index 就是这套下标；
// UI 侧要按设备名认屏，不能依赖其它枚举源的顺序）。
// 返回 0 成功；-1 参数无效；-2 下标越界。
__declspec(dllexport) int lull_native_monitor_info(int monitor_index, char *out, int cap) {
	EnsureDpiAware();
	if (!out || cap <= 0) {
		return -1;
	}
	MonitorDesc list[kMaxMonitors];
	const int n = EnumMonitors(list, kMaxMonitors);
	if (monitor_index < 0 || monitor_index >= n) {
		return -2;
	}
	const MonitorDesc &d = list[monitor_index];
	char dev[32];
	int i = 0;
	for (; i < 31 && d.device[i] != 0; ++i) {
		dev[i] = static_cast<char>(d.device[i]); // 设备名全 ASCII（\\.\DISPLAYn）
	}
	dev[i] = 0;
	std::snprintf(out, static_cast<size_t>(cap),
			"device=%s x=%d y=%d w=%d h=%d dpi=%u primary=%d",
			dev,
			static_cast<int>(d.desktop.left), static_cast<int>(d.desktop.top),
			static_cast<int>(d.desktop.right - d.desktop.left),
			static_cast<int>(d.desktop.bottom - d.desktop.top),
			d.dpi, d.primary ? 1 : 0);
	return 0;
}

// 拓扑指纹（monitors.h 的 TopologyHash）：显示器数量/设备名/矩形/DPI/主屏标志/宿主客户区
// 尺寸任一变化 -> 指纹变化。覆盖"改分辨率、改缩放、换主屏、热插拔、Explorer 重启"等全部场景。
__declspec(dllexport) unsigned long long lull_native_topology_hash() {
	EnsureDpiAware();
	MonitorDesc list[kMaxMonitors];
	const int n = EnumMonitors(list, kMaxMonitors);
	Placement pl;
	HWND host = ResolvePlacement(pl) ? pl.host : nullptr;
	return TopologyHash(list, n, host);
}

// monitor_index: -1 = 铺满整个宿主客户区（单窗跨屏兜底）；>=0 = 只占该显示器矩形（每屏一窗）。
// 返回 0 成功；-100 无效 HWND / -101 该 HWND 已挂载 / -102 宿主探测失败 /
// -103 显示器下标越界 / -104 挂载失败（已回滚）/ -105 槽位用尽。
__declspec(dllexport) int lull_native_attach(void *hwnd, int monitor_index) {
	EnsureDpiAware();
	HWND h = static_cast<HWND>(hwnd);
	if (!h || !IsWindow(h)) {
		return -100;
	}
	if (FindSlot(h)) {
		return -101;
	}

	Placement pl;
	if (!ResolvePlacement(pl)) {
		return -102;
	}
	const bool use_layered = (pl.layout == LAYOUT_PROGMAN_LAYERED);

	RECT rc = {0, 0, 0, 0};
	const RECT *prc = nullptr;
	if (monitor_index >= 0) {
		MonitorDesc list[kMaxMonitors];
		const int n = EnumMonitors(list, kMaxMonitors);
		if (monitor_index >= n) {
			return -103;
		}
		rc = DesktopToClient(pl.host, list[monitor_index].desktop);
		// 注：曾在此处做"四边条件外扩"补偿 WebView2 的边缘内缩——根因已修复（tauri 侧
		// .shadow(false)：tao 默认阴影帧使客户区内缩 (8,1,8,8)px，wry 按客户区放置 WebView
		// 导致四边/接缝黑缝）。外扩已整体移除，画面与显示器精确对齐。
		prc = &rc;
	} else {
		GetClientRect(pl.host, &rc);
	}

	Slot *slot = AllocSlot(h);
	if (!slot) {
		return -105;
	}

	// ★ 先装子类再挂载（2026-10-12 竞态闭合）：挂载里的 MoveWindow 把窗口移到 125% 屏时，
	// 系统投递 WM_DPICHANGED；主线程若在子类装上**之前**的微秒级窗口内泵走该消息，tao 的
	// WM_DPICHANGED 处理器会永久把 scale 缓存污染成 1.25 → WebView2 bounds 被除成 0.8×
	// （"不全屏"在个别时序下必现的最后一环）。子类先行 → 消息无论何时到都被吞。
	// 子类过程的 WM_DPICHANGED 分支不依赖 slot（见 WallpaperEraseProc），提前装安全。
	slot->orig_proc = reinterpret_cast<WNDPROC>(
			SetWindowLongPtrW(h, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(WallpaperEraseProc)));

	// 视觉硬化必须在窗口显示之前完成：DWM 非客户区属性一旦在可见后重设，
	// 会触发一次帧重算，表现为开关打开瞬间的 1px 抖动。Rust 侧已经先调过
	// disable_dwm_frame，这里在 Attach（只摆位、不显示）之前再钉一次。
	ApplyDwmAttrs(h);

	Status st;
	if (!Attach(h, use_layered, prc, &slot->placement, &slot->saved, &st)) {
		// 还原原过程再释放槽位，否则崩溃链断在 freed slot 上。
		if (slot->orig_proc) {
			SetWindowLongPtrW(h, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(slot->orig_proc));
		}
		FreeSlot(slot);
		return -104;
	}
	slot->want_rect = rc;
	slot->want_valid = true;
	slot->attached = true;
	// 注意：Attach 现在只摆位、不显示；窗口保持隐藏，由 Rust 在页面首帧完成后
	// 通过 lull_native_set_visible(SW_SHOWNA) 显示。这样开关打开时不会先闪一块
	// 深色/白色 WebView，也不会抢走设置窗焦点。PlaceWallpaperRect 已经在隐藏
	// 状态完成 controller bounds + WRY_WEBVIEW 子窗的同步。
	return 0;
}

// 看门狗替身（每窗口独立）：样式 / 层序 / 矩形三查。返回修复位掩码（1=样式 2=层序 4=矩形），
// 0 = 一切正常。>0 反复出现 = 框架层在跟我们抢窗口。
__declspec(dllexport) int lull_native_ensure(void *hwnd) {
	EnsureDpiAware();
	HWND h = static_cast<HWND>(hwnd);
	Slot *slot = FindSlot(h);
	if (!slot) {
		return -1;
	}
	Placement pl;
	if (!ResolvePlacement(pl)) {
		return -2;
	}
	if (!IsAlive(h, pl.host)) {
		return -3; // 父子断裂（如 Explorer 重启）——交由上层观察/重建
	}
	int fixed = 0;
	if (EnsureStyles(h, pl.layout == LAYOUT_PROGMAN_LAYERED)) {
		fixed |= 1;
	}
	if (EnsureZOrder(h, pl)) {
		fixed |= 2;
	}
	if (slot->want_valid && EnsureRect(h, pl.host, slot->want_rect)) {
		fixed |= 4;
	}
	if (EnsureWebviewCover(h)) {
		fixed |= 8;
	}
	slot->placement = pl;
	return fixed;
}

__declspec(dllexport) int lull_native_detach(void *hwnd) {
	HWND h = static_cast<HWND>(hwnd);
	Slot *slot = FindSlot(h);
	if (!slot) {
		return -1;
	}
	if (slot->orig_proc) {
		SetWindowLongPtrW(h, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(slot->orig_proc));
	}
	const bool ok = Detach(h, slot->saved);
	FreeSlot(slot);
	return ok ? 0 : -2;
}

// 一行 k=v 状态（= HostStatus 现场复核，无槽位依赖，任意 HWND 可查）。返回 0 成功。
__declspec(dllexport) int lull_native_status(void *hwnd, char *out, int cap) {
	EnsureDpiAware();
	if (!out || cap <= 0) {
		return -1;
	}
	HWND h = static_cast<HWND>(hwnd);
	if (!h || !IsWindow(h)) {
		std::snprintf(out, static_cast<size_t>(cap), "target_dead=1");
		return 1;
	}
	Placement pl;
	ResolvePlacement(pl);
	Status st;
	HostStatus(h, pl, st);
	std::snprintf(out, static_cast<size_t>(cap),
			"attached=%d layout=%d parent_ok=%d below_icons=%d wp_host=%d workerw_z=%d "
			"layered=%d transparent=%d visible=%d topmost=%d child=%d "
			"target_z=%d defview_z=%d siblings=%d dpi=%u w=%d h=%d",
			st.attached ? 1 : 0, st.layout, st.parent_ok ? 1 : 0, st.below_icons ? 1 : 0,
			st.wallpaper_host_present ? 1 : 0, st.workerw_z,
			st.has_layered_style ? 1 : 0, st.has_transparent_style ? 1 : 0,
			st.is_visible ? 1 : 0, st.is_topmost ? 1 : 0, st.has_child_style ? 1 : 0,
			st.target_z, st.defview_z, st.sibling_count, st.dpi, st.width, st.height);
	return 0;
}

// 显示/隐藏壁纸窗口（保持挂载在桌面层，仅 ShowWindow；SW_SHOWNA = 显示但不激活/不抢焦点，
// 与 Lull desktop.h 的 set_window_visible 语义一致）。返回应用后实际的可见性。
__declspec(dllexport) int lull_native_set_visible(void *hwnd, int visible) {
	HWND h = static_cast<HWND>(hwnd);
	if (!h || !IsWindow(h)) {
		return -1;
	}
	ShowWindow(h, visible ? SW_SHOWNA : SW_HIDE);
	return IsWindowVisible(h) ? 1 : 0;
}

__declspec(dllexport) int lull_native_get_visible(void *hwnd) {
	HWND h = static_cast<HWND>(hwnd);
	if (!h || !IsWindow(h)) {
		return -1;
	}
	return IsWindowVisible(h) ? 1 : 0;
}

// 关闭 DWM 非客户区渲染（圆角/边框）。**必须在 WebView 创建之前调用**——WebView2 的
// 圆角/内缩模式在渲染控制器创建时读取窗口的圆角偏好，事后设置无效（2026-10-11 实测）。
// 成功关掉后 WebView 边缘不再内缩，接缝/四边白黑条从源头消失。
__declspec(dllexport) int lull_native_disable_dwm_frame(void *hwnd) {
	HWND h = static_cast<HWND>(hwnd);
	if (!h || !IsWindow(h)) {
		return -1;
	}
	ApplyDwmAttrs(h);
	return 0;
}

// 强制全窗重绘（含 WebView2 子窗口）——修复"顶部残留陈旧首帧"的白边（2026-10-11 实测：
// 窗口挂载后顶部 1px + 两上角会残留页面加载前的浅色帧，一次强制重绘即消失）。
// 由 Rust 侧在挂载后按延时多次调用（等页面首帧完成）。
__declspec(dllexport) int lull_native_force_repaint(void *hwnd) {
	HWND h = static_cast<HWND>(hwnd);
	if (!h || !IsWindow(h)) {
		return -1;
	}
	RedrawWindow(h, nullptr, nullptr,
			RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW);
	return 0;
}

} // extern "C"
