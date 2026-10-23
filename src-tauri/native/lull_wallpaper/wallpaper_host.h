/**
 * 桌面壁纸层工具：封装 Win32 窗口挂载、层级、样式、DPI、可见性和状态还原。
 */

#ifndef LULL_WALLPAPER_HOST_H
#define LULL_WALLPAPER_HOST_H

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

// 定点耗时记录（2026-10-09 复审要求：给 Attach/Detach 里的每个 Win32 窗口操作计时，
// 用数据回答"重挂路径会不会阻塞 UI 线程"。纯 Win32、零行为影响，详见 timing.h）。
#include "timing.h"

namespace lull {
namespace wallpaper {

// ---------------------------------------------------------------------------
// 常量（样式掩码 / DPI / 手感参数，供本头文件内的挂载与看门狗共用）
// ---------------------------------------------------------------------------

// 壁纸窗口的 GWL_STYLE 里要清掉的"非客户区"样式位。Attach（一次性）与
// EnsureStyles（每帧复核）都以它为基准。
const LONG kWallpaperStyleClear = WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU |
		WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_OVERLAPPED;
// 仅 Attach 一次性额外清掉的残留位（EnsureStyles 的日常复核不碰它们 —— 两个调用点
// 的原始行为就是这样划分的，保持不变）。
const LONG kWallpaperStyleClearAttachOnly = WS_BORDER | WS_DLGFRAME | WS_VSCROLL | WS_HSCROLL;
// 壁纸窗口的 GWL_EXSTYLE 里要清掉的任务栏 / Alt+Tab / 置顶相关位。
const LONG kWallpaperExStyleClear = WS_EX_TOOLWINDOW | WS_EX_APPWINDOW | WS_EX_TOPMOST;

// 分层窗口完全不透明的 alpha（SetLayeredWindowAttributes 的 LWA_ALPHA 参数）。
const BYTE kLayeredAlphaOpaque = 0xFF;
// Attach 时"先设一个中间尺寸再设回最终尺寸"的收缩量（强制底层刷新，GDI / 位块传输类
// 实现需要；发生在隐藏状态下，用户看不到）。
const int kRepaintNudgePx = 4;

// 基准 DPI（= 100% 缩放）。拿不到真实 DPI 时的兜底值，也是 scale = dpi / kBaselineDpi。
const unsigned int kBaselineDpi = 96;

enum Layout {
	LAYOUT_NONE = 0,
	LAYOUT_PROGMAN_LAYERED = 1, // Win11 24H2+：Progman 同时持有 DefView 与 WorkerW
	LAYOUT_CLASSIC_WORKERW = 2, // Win10 / 早期 Win11：顶层 WorkerW 承载 DefView
};

// 让 Progman（重新）生成"静态壁纸宿主" WorkerW 的经典口信。
// 它不是用来"找宿主"的，而是用来**保证宿主存在**的 —— 少了它，形态 ②（背景由 DefView
// 自己画）会让壁纸整块被盖住而所有状态位仍报"正常"。见文件头说明。
const UINT kProgmanSpawnWallpaperHost = 0x052C;

struct Placement {
	int layout = LAYOUT_NONE;
	HWND progman = nullptr;
	HWND host = nullptr;    // 挂载目标父窗口
	HWND defview = nullptr; // 图标层；我们把窗口插到它之后（NULL 则用 HWND_TOP）
	// 静态壁纸宿主（DefView 的兄弟子窗口）。**为 NULL 就意味着壁纸会被 DefView 盖住** ——
	// 这是个必须报警的状态，不是"可选信息"，所以单独留一个字段而不是靠现场再查一次。
	HWND workerw = nullptr;
	bool wallpaper_host_present = false;
};

// 挂载前的原始状态，用于 detach 时还原（否则窗口留在桌面层里再也回不来）。
struct SavedState {
	LONG style = 0;
	LONG ex_style = 0;
	HWND parent = nullptr;
	RECT rect = {0, 0, 0, 0};
	bool valid = false;
};

// 一次完整的挂载结果快照，用于日志与自检。
struct Status {
	bool attached = false;
	int layout = LAYOUT_NONE;
	HWND target = nullptr;
	HWND host = nullptr;
	HWND defview = nullptr;
	bool target_alive = false;
	bool host_alive = false;
	bool defview_alive = false;
	bool parent_ok = false;      // GetParent(target) == host
	bool has_child_style = false;
	bool has_popup_style = false;
	bool has_layered_style = false;
	bool has_transparent_style = false; // WS_EX_TRANSPARENT —— 鼠标穿透，桌面可操作的前提
	bool is_topmost = false;
	bool is_visible = false;
	int target_z = -1;           // 在 host 子窗口 z 序中的下标（0 = 最上）
	int defview_z = -1;
	int sibling_count = 0;
	bool below_icons = false;    // 壁纸层在图标层之下 —— 本阶段的硬指标
	// Progman 下存在 WorkerW 静态壁纸宿主。**false = 壁纸虽然"挂上了"但会被 DefView
	// 整块盖住**（形态 ②），此时上面的 below_icons/visible 全是"正常"的假信号。
	bool wallpaper_host_present = false;
	// 宿主在宿主子窗口 z 序里的下标（-1 = 不在）。健康的布局是 defview_z=0、workerw_z 在
	// 我们之后；若 workerw_z < defview_z（宿主跑到图标层上面），壁纸层那条缝不存在。
	int workerw_z = -1;
	int width = 0;
	int height = 0;
	unsigned int dpi = kBaselineDpi;
};

// ---------------------------------------------------------------------------
// DPI 工具（进程级 + 线程级）
// ---------------------------------------------------------------------------

// 每显示器 DPI 感知 —— 进程级 + **线程级**，两级都要做。
//
// 为什么必须两级（本机实测踩过的坑）：
//   进程级 SetProcessDpiAwarenessContext 每个进程只能生效一次，Godot 抢先设过就
//   改不动了；更要命的是 Godot 自己的窗口操作会 **临时改当前线程的 DPI 上下文**
//   （DisplayServerWindows 在按显示器 DPI 创建窗口时会调 SetThreadDpiAwarenessContext）。
//   结果就是：同一个进程中，两次 EnumDisplayMonitors 拿到的坐标精度可能不一样 ——
//   实测 DISPLAY2 (2560x1440@125%) 先被报成 2048x1152，后一次才对成 2560x1440。
//   靠这种数据算壁纸矩形必然错。
//
// 所以这里每次都顺手把**当前线程**的上下文钉死在 per-monitor v2（线程级可反复设置，
// 立刻生效，且只影响本线程）。调用方仍应用 DpiAwareness() 复核。
inline bool EnsureDpiAware() {
	HMODULE u = GetModuleHandleW(L"user32.dll");
	// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == (HANDLE)-4
	void *const ctx = reinterpret_cast<void *>(static_cast<INT_PTR>(-4));

	bool thread_ok = false;
	typedef HANDLE(WINAPI * SetThreadCtxFn)(void *);
	if (u) {
		SetThreadCtxFn fn_thread = reinterpret_cast<SetThreadCtxFn>(
				reinterpret_cast<void *>(GetProcAddress(u, "SetThreadDpiAwarenessContext")));
		if (fn_thread) {
			thread_ok = fn_thread(ctx) != nullptr;
		}
	}

	bool proc_ok = false;
	typedef BOOL(WINAPI * SetDpiCtxFn)(void *);
	if (u) {
		SetDpiCtxFn fn = reinterpret_cast<SetDpiCtxFn>(
				reinterpret_cast<void *>(GetProcAddress(u, "SetProcessDpiAwarenessContext")));
		if (fn) {
			proc_ok = fn(ctx) != FALSE;
		}
	}
	if (!proc_ok) {
		proc_ok = SetProcessDPIAware() != FALSE; // 老 API 兜底（Win Vista+）
	}
	return thread_ok || proc_ok;
}

// 当前进程的 DPI 感知状态：2 = 每显示器感知，1 = 系统感知，0 = 不感知，-1 = 未知。
// 只有 < 2 时枚举出来的显示器矩形才是被虚拟化缩放的，那种数据不能用。
inline int DpiAwareness() {
	typedef HANDLE(WINAPI * GetCtxFn)();
	typedef int(WINAPI * GetAwarenessFn)(HANDLE);
	static GetCtxFn s_get = nullptr;
	static GetAwarenessFn s_aware = nullptr;
	static bool s_probed = false;
	if (!s_probed) {
		s_probed = true;
		HMODULE u = GetModuleHandleW(L"user32.dll");
		if (u) {
			s_get = reinterpret_cast<GetCtxFn>(
					reinterpret_cast<void *>(GetProcAddress(u, "GetThreadDpiAwarenessContext")));
			s_aware = reinterpret_cast<GetAwarenessFn>(reinterpret_cast<void *>(
					GetProcAddress(u, "GetAwarenessFromDpiAwarenessContext")));
		}
	}
	if (s_get && s_aware) {
		HANDLE ctx = s_get();
		if (ctx) {
			return s_aware(ctx);
		}
	}
	return -1;
}

inline const char *DpiAwarenessName() {
	switch (DpiAwareness()) {
		case 2:
			return "per-monitor";
		case 1:
			return "system";
		case 0:
			return "unaware";
		default:
			return "unknown";
	}
}

inline unsigned int QueryDpi(HWND hwnd) {
	typedef UINT(WINAPI * GetDpiFn)(HWND);
	HMODULE u = GetModuleHandleW(L"user32.dll");
	if (u) {
		GetDpiFn fn = reinterpret_cast<GetDpiFn>(
				reinterpret_cast<void *>(GetProcAddress(u, "GetDpiForWindow")));
		if (fn && hwnd) {
			return static_cast<unsigned int>(fn(hwnd));
		}
	}
	return kBaselineDpi;
}

// ---------------------------------------------------------------------------
// WebView2 子窗覆盖
// ---------------------------------------------------------------------------

// WebView2 子窗（WRY_WEBVIEW）尺寸必须等于窗口客户区（物理像素）。
// 实测非管理员启动下，某些父窗/桌面事件会让 wry 的自动调整按"逻辑化"坐标把子窗
// 缩到 ÷系统缩放（125% 屏 = 0.8×），页面只铺屏幕的 80% 且不自愈。必须在
// ShowWindow 之前调用，否则用户先看到小窗、再看到它被拉满。
inline bool EnsureWebviewCover(HWND p_hwnd) {
	if (!p_hwnd || !IsWindow(p_hwnd)) {
		return false;
	}
	HWND wv = FindWindowExW(p_hwnd, nullptr, L"WRY_WEBVIEW", nullptr);
	if (!wv) {
		return false;
	}
	RECT cr = {0, 0, 0, 0};
	GetClientRect(p_hwnd, &cr);
	RECT wr = {0, 0, 0, 0};
	GetWindowRect(wv, &wr);
	if ((wr.right - wr.left) == cr.right && (wr.bottom - wr.top) == cr.bottom) {
		return false;
	}
	SetWindowPos(wv, nullptr, 0, 0, cr.right, cr.bottom, SWP_NOZORDER | SWP_NOACTIVATE);
	return true;
}

// ---------------------------------------------------------------------------
// 桌面结构探测
// ---------------------------------------------------------------------------

namespace detail {

struct ClassicCtx {
	bool seen_defview = false;
	HWND defview = nullptr;
	HWND host = nullptr;
};

// EnumWindows 自上而下遍历。找到承载 SHELLDLL_DefView 的窗口之后，
// z 序再往下的第一个 WorkerW 就是经典结构里的壁纸宿主。
inline BOOL CALLBACK ClassicEnumProc(HWND top, LPARAM lp) {
	ClassicCtx *c = reinterpret_cast<ClassicCtx *>(lp);
	if (c->host) {
		return FALSE;
	}
	if (!c->seen_defview) {
		HWND dv = FindWindowExW(top, nullptr, L"SHELLDLL_DefView", nullptr);
		if (dv) {
			c->seen_defview = true;
			c->defview = dv;
		}
		return TRUE;
	}
	wchar_t cls[64] = {0};
	if (GetClassNameW(top, cls, 64) > 0 && wcscmp(cls, L"WorkerW") == 0) {
		c->host = top;
		return FALSE;
	}
	return TRUE;
}

// 遍历 p_host 的子窗口 z 序，返回子窗口总数；r_target_z / r_defview_z 输出两个窗口
// 在 z 序里的下标（0 = 最上；不在宿主下则保持 -1）。HostStatus 与 EnsureZOrder 共用。
inline int ScanChildZOrder(HWND p_host, HWND p_target, HWND p_defview, int *r_target_z,
		int *r_defview_z) {
	*r_target_z = -1;
	*r_defview_z = -1;
	int i = 0;
	for (HWND c = GetWindow(p_host, GW_CHILD); c; c = GetWindow(c, GW_HWNDNEXT)) {
		if (c == p_target) {
			*r_target_z = i;
		}
		if (p_defview && c == p_defview) {
			*r_defview_z = i;
		}
		++i;
	}
	return i;
}

// 计算壁纸窗口应取的扩展样式（纯函数，Attach 与 EnsureStyles 共用，保证两处永不漂移）：
//   * 清掉任务栏 / Alt+Tab / 置顶相关位（窗口一旦成为 Progman 的子窗口就不会出现在
//     Alt+Tab 里，这里是双保险）；
//   * 置上 WS_EX_TRANSPARENT —— 壁纸永远不接收鼠标输入，见 EnsureMouseThrough 的注释；
//   * layered 按需开关（只在 Progman 分层结构下要）。
inline LONG WallpaperExStyle(LONG p_ex, bool p_layered) {
	LONG want = p_ex & ~kWallpaperExStyleClear;
	want |= WS_EX_TRANSPARENT;
	if (p_layered) {
		want |= WS_EX_LAYERED;
	} else {
		want &= ~WS_EX_LAYERED;
	}
	return want;
}

// Attach 第 1 步：快照当前样式 / 父窗口 / 矩形（只记一次，后续重挂不再覆盖）。
inline void SnapshotWindowState(HWND p_target, SavedState &r_saved) {
	r_saved.style = GetWindowLongW(p_target, GWL_STYLE);
	r_saved.ex_style = GetWindowLongW(p_target, GWL_EXSTYLE);
	r_saved.parent = GetParent(p_target);
	GetWindowRect(p_target, &r_saved.rect);
	r_saved.valid = true;
}

// Attach 第 2-3 步：套用壁纸窗口的客戶区样式与扩展样式，并摘掉 TOPMOST。
//   客戶区样式：跨进程改 GWL_STYLE/GWL_EXSTYLE 是允许的（只有 GWLP_WNDPROC /
//   GWLP_HINSTANCE 不允许）。必须清掉全部非客户区样式，否则边框 / 标题栏会残留。
inline void ApplyWallpaperStyles(HWND p_target, bool p_want_layered) {
	LONG style = GetWindowLongW(p_target, GWL_STYLE);
	style &= ~(kWallpaperStyleClear | kWallpaperStyleClearAttachOnly);
	// ★ 不要在这里加 WS_VISIBLE：可见性由 Rust 的 set_visible(SW_SHOWNA) 控制。
	//   Attach 只负责摆位；如果这时带上 WS_VISIBLE，SetWindowLong 之后的
	//   SetParent / SetWindowPos 会让窗口按旧位置/旧尺寸提前显示一帧——开关打开
	//   瞬间的闪动就来自这里。ShowWindow(SW_SHOWNA) 会自己补回 WS_VISIBLE。
	style |= (WS_CHILD | WS_CLIPSIBLINGS);
	SetLastError(0);
	SetWindowLongW(p_target, GWL_STYLE, style);

	SetWindowLongW(p_target, GWL_EXSTYLE, WallpaperExStyle(
			GetWindowLongW(p_target, GWL_EXSTYLE), p_want_layered));
	SetWindowPos(p_target, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

// Attach 第 6 步：摆位置与尺寸（子窗口坐标相对父窗口客户区）。
//   p_client_rect 为空时铺满宿主（单显示器老行为）；多显示器场景必须传各自矩形，
//   否则 N 个窗口会全部叠在同一个 4480x1440 上互相覆盖。
//
// 顺序很重要：**先藏起来 → 把位置尺寸摆好 → 同步 WebView2 覆盖**。
// 这里不再 ShowWindow：显示时机交给 Rust 的页面首帧门（native set_visible 使用
// SW_SHOWNA，不抢焦点）。MoveWindow 会让 Godot 的 OpenGL 渲染目标重建，中间那次
// kRepaintNudgePx 的尺寸差如果发生在可见状态下，用户会看到画面闪一下；所以整个
// 摆位过程都在隐藏状态完成。
inline void PlaceWallpaperRect(HWND p_target, HWND p_host, const RECT *p_client_rect) {
	RECT rc = {0, 0, 0, 0};
	if (p_client_rect) {
		rc = *p_client_rect;
	} else {
		GetClientRect(p_host, &rc);
	}
	int w = rc.right - rc.left;
	int h = rc.bottom - rc.top;
	if (w <= 0 || h <= 0) {
		w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
		h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
	}
	if (w <= 0 || h <= 0) {
		w = GetSystemMetrics(SM_CXSCREEN);
		h = GetSystemMetrics(SM_CYSCREEN);
	}
	const int x = rc.left;
	const int y = rc.top;
	{
		lull::timing::ScopedTimer t(lull::timing::kTagAttachHide);
		ShowWindow(p_target, SW_HIDE);
	}
	// 先设一个中间尺寸再设回最终尺寸，强制底层刷新（GDI / 位块传输类实现需要）。
	{
		lull::timing::ScopedTimer t(lull::timing::kTagAttachMove1);
		MoveWindow(p_target, x, y, w > kRepaintNudgePx ? w - kRepaintNudgePx : w,
				h > kRepaintNudgePx ? h - kRepaintNudgePx : h, TRUE);
	}
	{
		// ★ bRepaint=TRUE 的 MoveWindow 会同步走窗口消息与重绘路径（渲染目标重建），
		//    是复审点名要单独计时的对象之一。
		lull::timing::ScopedTimer t(lull::timing::kTagAttachMove2);
		MoveWindow(p_target, x, y, w, h, TRUE);
	}
	// 在显示之前同步补一次 WM_SIZE：wry 的父窗口子类会在这里把 WebView2 controller
	// bounds 与 WRY_WEBVIEW 子窗一起设成最终尺寸。只依赖 MoveWindow 的 WM_SIZE 时，
	// 挂载发生在 Tauri 事件循环启动前，Resized 消息可能被合并/迟到；于是窗口已经全屏、
	// WebView 仍按创建时的 800x600 画出第一帧，等看门狗（≤700ms）才拉回全屏。
	// 这就是"壁纸先小窗、再突然铺满"的直接来源。SendMessage 在隐藏状态完成，
	// 第一帧可见画面就是最终尺寸。
	SendMessageW(p_target, WM_SIZE, SIZE_RESTORED,
			MAKELPARAM(static_cast<WORD>(w), static_cast<WORD>(h)));
	// controller bounds 是异步的；再直接复核一次 WRY 子窗，确保它也在隐藏状态到位。
	EnsureWebviewCover(p_target);
}

} // namespace detail

// ---------------------------------------------------------------------------
// 保证"静态壁纸宿主 WorkerW"存在 —— 24H2 布局成立的前提（**异步版**，2026-10-09 重写）
// ---------------------------------------------------------------------------

// 为什么要发 0x052C：Progman 的子窗口有两种形态（见文件头"最隐蔽的一个前提"）。
//   形态 ② 时 DefView 自己把桌面背景涂成不透明，插在它后面的壁纸会被整块盖住，
//   而所有状态位仍然报"正常"。0x052C 就是让 Progman 把 WorkerW 建起来的经典口信
//   （wParam=0、lParam=1，与流传配方一致）。
//
// ★ 为什么必须异步：ResolvePlacement / poll_slots 都跑在 Godot 的 UI 线程。旧版补建是
//   SendMessageTimeout(SMTO_NORMAL,1000ms) + Sleep(50)×30 轮询（最长 1500ms 不泵消息）。
//   浮窗拖拽正持有鼠标捕获时本线程不泵消息，Windows 会把**全部鼠标输入**排进这个线程：
//   桌面点击/框选/右键集体沉默、线程醒来后集中释放 —— "拖完浮窗桌面卡一段"的最优嫌疑。
//   现在：PostMessage 发完即回，建成与否由看门狗 5 的后续 tick 复查。
//   幂等与安静：WorkerW 已存在时绝不发口信；重试节流（5s）在调用方 desktop.cpp 里。

// Progman 下现在是否存在 WorkerW 子窗口（纯探测，零副作用）。
inline bool WorkerHostPresent(HWND p_progman) {
	if (!p_progman || !IsWindow(p_progman)) {
		return false;
	}
	return FindWindowExW(p_progman, nullptr, L"WorkerW", nullptr) != nullptr;
}

// 向 Progman 发一次 0x052C 补建口信（PostMessage：不等回执、不睡眠、立即返回）。
// 返回 true = 口信已入队；是否建成由调用方稍后用 WorkerHostPresent 复查。
// ★ 全进程**唯一**调用点应当是 desktop.cpp 的看门狗 5 宿主门（全局去重 + 5s 节流 +
// 失败留痕）；别处（尤其挂载路径）不要自己直发，否则多槽位/多路径会重复灌口信。
inline bool PostSpawnWorkerHost(HWND p_progman) {
	if (!p_progman || !IsWindow(p_progman)) {
		return false;
	}
	return PostMessageW(p_progman, kProgmanSpawnWallpaperHost, 0, 1) != FALSE;
}

// 探测桌面结构，解析出挂载目标。**纯探测、零副作用**（2026-10-09 起不再内嵌发口信：
// 补建请求统一收口到 desktop.cpp 的全局宿主门，按 Progman 实例去重与节流）。
inline bool ResolvePlacement(Placement &out) {
	out = Placement();

	HWND progman = FindWindowW(L"Progman", nullptr);
	out.progman = progman;

	if (progman) {
		HWND dv = FindWindowExW(progman, nullptr, L"SHELLDLL_DefView", nullptr);
		if (dv) {
			out.layout = LAYOUT_PROGMAN_LAYERED;
			out.host = progman;
			out.defview = dv;
			// 只读地看一眼静态壁纸宿主在不在（形态 ② 的判据）；请求补建是看门狗 5 的事。
			out.workerw = FindWindowExW(progman, nullptr, L"WorkerW", nullptr);
			out.wallpaper_host_present = (out.workerw != nullptr);
			return true;
		}
	}

	detail::ClassicCtx c;
	EnumWindows(detail::ClassicEnumProc, reinterpret_cast<LPARAM>(&c));
	if (c.host) {
		out.layout = LAYOUT_CLASSIC_WORKERW;
		out.host = c.host;
		out.defview = nullptr;
		out.workerw = c.host; // 经典结构里宿主本身就是那个顶层 WorkerW
		out.wallpaper_host_present = true;
		return true;
	}
	if (c.defview) {
		HWND root = GetAncestor(c.defview, GA_ROOT);
		if (root) {
			out.layout = LAYOUT_CLASSIC_WORKERW;
			out.host = root;
			out.defview = c.defview;
			out.workerw = root;
			out.wallpaper_host_present = true;
			return true;
		}
	}
	return false;
}

// 采集当前层级状态。defview 为 NULL 时相关字段留空。
inline void HostStatus(HWND target, const Placement &pl, Status &st) {
	st = Status();
	st.layout = pl.layout;
	st.target = target;
	st.host = pl.host;
	st.defview = pl.defview;
	// 宿主是**现场复核**的：Explorer 随时可能把 WorkerW 收走（重启 shell 等），
	// 那时壁纸会无声无息地被 DefView 盖住 —— 光看挂载时的快照发现不了。
	st.wallpaper_host_present = pl.workerw ? (IsWindow(pl.workerw) != FALSE)
			: (pl.layout == LAYOUT_CLASSIC_WORKERW);
	if (pl.layout == LAYOUT_PROGMAN_LAYERED && pl.progman && IsWindow(pl.progman)) {
		st.wallpaper_host_present =
				(FindWindowExW(pl.progman, nullptr, L"WorkerW", nullptr) != nullptr);
	}

	st.target_alive = (target && IsWindow(target)) != FALSE;
	st.host_alive = (pl.host && IsWindow(pl.host)) != FALSE;
	st.defview_alive = (pl.defview && IsWindow(pl.defview)) != FALSE;
	st.parent_ok = st.target_alive && st.host_alive && GetParent(target) == pl.host;
	st.attached = st.parent_ok;

	if (st.target_alive) {
		LONG s = GetWindowLongW(target, GWL_STYLE);
		LONG e = GetWindowLongW(target, GWL_EXSTYLE);
		st.has_child_style = (s & WS_CHILD) != 0;
		st.has_popup_style = (s & WS_POPUP) != 0;
		st.has_layered_style = (e & WS_EX_LAYERED) != 0;
		st.has_transparent_style = (e & WS_EX_TRANSPARENT) != 0;
		st.is_topmost = (e & WS_EX_TOPMOST) != 0;
		st.is_visible = IsWindowVisible(target) != FALSE;
		RECT r = {0, 0, 0, 0};
		GetWindowRect(target, &r);
		st.width = r.right - r.left;
		st.height = r.bottom - r.top;
		st.dpi = QueryDpi(target);
	}

	if (st.host_alive) {
		st.sibling_count = detail::ScanChildZOrder(pl.host, target, pl.defview, &st.target_z,
				&st.defview_z);
		st.below_icons = (st.target_z >= 0 && st.defview_z >= 0 && st.target_z > st.defview_z);
		HWND workerw = FindWindowExW(pl.host, nullptr, L"WorkerW", nullptr);
		if (workerw) {
			int tz = -1;
			detail::ScanChildZOrder(pl.host, target, workerw, &tz, &st.workerw_z);
		}
	}
}

// ---------------------------------------------------------------------------
// 挂载 / 卸载
// ---------------------------------------------------------------------------

// 让壁纸窗口在"命中测试"里消失，鼠标消息直接落到下层（桌面图标层）。
//
// 为什么光靠层序不够（本项目实际遇到过的问题）：
//   `EnsureZOrder` 只能把窗口按回图标层之下，而它是**每帧**跑的。Godot 在窗口状态变化
//   （WM_SIZE / 显示 / 尺寸变化）时会按自己的簿记重新 SetWindowPos 且不带 SWP_NOZORDER，
//   实测能把壁纸窗口顶到 SHELLDLL_DefView 之上。从"被顶上去"到"看门狗拉回来"之间的
//   那段时间里，壁纸窗口会**吃掉桌面的鼠标消息** —— 用户看到的现象就是
//   「桌面图标点不动、桌面右键没反应、整个桌面不可操作」。
//
// 为什么不是 WM_NCHITTEST 返回 HTTRANSPARENT：
//   那条规则只在**同一个线程**内向下传递（MSDN 原文：the message will be sent to
//   underlying windows in the same thread）。SHELLDLL_DefView 属于 explorer.exe 的线程，
//   跟我们不同线程，返回 HTTRANSPARENT 不会把点击交给它。
//
//   WS_EX_TRANSPARENT 由窗口管理器在命中测试阶段统一跳过，跨线程有效，
//   因此是这里唯一正确的做法。
//
// ★ 频率事实（2026-10-09 更正旧注释）：本组 Ensure* 看门狗**不是每帧跑的** ——
//   GDScript 侧按 WATCHDOG_INTERVAL=0.25s 节流调用 poll_slots（wallpaper_manager.gd），
//   即 4Hz。旧注释写"每帧"与实现不符，曾误导外部分析把"轮询过重"列为嫌疑。
inline bool EnsureMouseThrough(HWND target) {
	if (!target || !IsWindow(target)) {
		return false;
	}
	LONG e = GetWindowLongW(target, GWL_EXSTYLE);
	if ((e & WS_EX_TRANSPARENT) != 0) {
		return false;
	}
	SetWindowLongW(target, GWL_EXSTYLE, e | WS_EX_TRANSPARENT);
	return true;
}

// 把 target 挂成桌面壁纸层。
//   use_layered：24H2 结构下必须为 true（见文件头说明）；经典 WorkerW 结构下应为 false。
//   client_rect：**宿主客户区坐标**下的目标矩形；传 nullptr 表示"铺满宿主客户区"。
//                多显示器场景下每个显示器传各自的矩形（见 monitors.h 的 DesktopToClient），
//                这样每个显示器一个窗口，而不是一个窗口横跨虚拟屏。
//   out_placement / out_status：可选输出，用于看门狗与日志。
//   saved：可选；首次挂载时记录原始状态，供 Detach 还原。
inline bool Attach(HWND target, bool use_layered, const RECT *client_rect, Placement *out_placement,
		SavedState *saved, Status *out_status) {
	lull::timing::ScopedTimer t_total(lull::timing::kTagAttachTotal);
	if (!target || !IsWindow(target)) {
		return false;
	}

	Placement pl;
	{
		lull::timing::ScopedTimer t(lull::timing::kTagAttachResolve);
		if (!ResolvePlacement(pl)) {
			return false;
		}
	}

	// 1) 快照（只记一次，后续重挂不再覆盖）。
	if (saved && !saved->valid) {
		detail::SnapshotWindowState(target, *saved);
	}

	// 2)+3) 客户区样式 + 扩展样式（含鼠标穿透），并摘掉 TOPMOST。
	const bool want_layered = use_layered && (pl.layout == LAYOUT_PROGMAN_LAYERED);
	{
		lull::timing::ScopedTimer t(lull::timing::kTagAttachApplyStyles);
		detail::ApplyWallpaperStyles(target, want_layered);
	}

	// 4) 挂载。SetParent 返回的是旧 owner：顶层窗口时返回 NULL 且 GetLastError 仍为
	//    ERROR_SUCCESS，所以只能用 GetParent() 校验成败。
	// ★ 定点计时重点：SetParent 让宿主（Explorer 线程的 Progman/WorkerW）参与窗口重组，
	//    是跨进程调用、理论上可被对方线程拖住 —— "重挂路径会不会卡 UI 线程"就靠这条数据判定。
	{
		lull::timing::ScopedTimer t(lull::timing::kTagAttachSetParent);
		SetLastError(0);
		SetParent(target, pl.host);
	}
	bool parent_ok = false;
	{
		lull::timing::ScopedTimer t(lull::timing::kTagAttachParentCheck);
		parent_ok = (GetParent(target) == pl.host);
	}
	if (!parent_ok) {
		// 失败必须回滚成隐藏状态，否则它会是一个覆盖全屏的普通窗口。
		lull::timing::ScopedTimer t_rb(lull::timing::kTagAttachRollback);
		ShowWindow(target, SW_HIDE);
		if (saved && saved->valid) {
			SetWindowLongW(target, GWL_STYLE, saved->style);
			SetWindowLongW(target, GWL_EXSTYLE, saved->ex_style);
		}
		return false;
	}

	if (want_layered) {
		lull::timing::ScopedTimer t(lull::timing::kTagAttachLayered);
		SetLayeredWindowAttributes(target, 0, kLayeredAlphaOpaque, LWA_ALPHA);
	}

	// 5) Z 序：插到 DefView 之后 = 图标层之下、壁纸宿主之上。
	HWND insert_after = HWND_TOP;
	if (pl.defview && GetParent(pl.defview) == pl.host) {
		insert_after = pl.defview;
	}
	{
		lull::timing::ScopedTimer t(lull::timing::kTagAttachZPos);
		SetWindowPos(target, insert_after, 0, 0, 0, 0,
				SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
	}

	// 6) 尺寸与位置。
	detail::PlaceWallpaperRect(target, pl.host, client_rect);

	if (out_placement) {
		*out_placement = pl;
	}
	if (out_status) {
		lull::timing::ScopedTimer t(lull::timing::kTagAttachProbe);
		HostStatus(target, pl, *out_status);
	}
	return true;
}

// 还原到挂载前的样子 —— 样式 / 父窗口 / 矩形都还原，但**保持隐藏**。
//
// 为什么不把窗口重新显示出来（本项目踩过的坑）：
//   挂载前的主窗口是一个 1920x1080 无边框的普通顶层窗口 —— 也就是**一块盖满主屏、
//   会把桌面鼠标消息全吃掉的可见窗口**。rebuild() 的流程是"先把所有壁纸窗口 detach，
//   再重新 attach"，如果 Detach 顺手把它显示出来，中间那一瞬间用户看到的就是
//   ① 画面闪一下；② 桌面点不动（那块全屏窗口在吞点击）。
//   detach 之后要么紧接着 rebuild（Rust 会在新窗口页面首帧后调用 set_visible 显示），
//   要么就是应用退出 —— 两种情况下"隐藏"都是正确的状态。
inline bool Detach(HWND target, const SavedState &saved) {
	lull::timing::ScopedTimer t_total(lull::timing::kTagDetachTotal);
	if (!target || !IsWindow(target)) {
		return false;
	}
	{
		lull::timing::ScopedTimer t(lull::timing::kTagDetachHide);
		ShowWindow(target, SW_HIDE);
	}
	if (!saved.valid) {
		return true;
	}
	SetWindowLongW(target, GWL_STYLE, saved.style);
	SetWindowLongW(target, GWL_EXSTYLE, saved.ex_style);
	{
		// 同样是跨进程 SetParent（回摘到原父窗口），单独计时。
		lull::timing::ScopedTimer t(lull::timing::kTagDetachSetParent);
		SetParent(target, saved.parent);
	}
	{
		// 还原位置的 SetWindowPos 也带 SWP_FRAMECHANGED（复审点名的遗漏调用）。
		lull::timing::ScopedTimer t(lull::timing::kTagDetachSetPos);
		SetWindowPos(target, nullptr, saved.rect.left, saved.rect.top,
				saved.rect.right - saved.rect.left, saved.rect.bottom - saved.rect.top,
				SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
	}
	// 注意：这里**不**调 ShowWindow(SW_SHOW)，见上面的说明。
	return true;
}

// 确保 Z 序在图标层（DefView）**之下**、且在静态壁纸宿主（WorkerW）**之上**。
// 返回 true 表示这次做了修正。
//
// 两个条件缺一不可：
//   * 在 DefView 之下 —— 否则会盖住桌面图标（Godot 的 SetWindowPos 不带 SWP_NOZORDER，
//     实测几秒内就会把壁纸顶上去）；
//   * 在 WorkerW 之上 —— WorkerW 是**可见的**静态壁纸宿主，掉到它下面同样一个像素都看不见
//     （经典 WorkerW 方案用 HWND_BOTTOM 就踩这条）。
// 两者之间就是"壁纸层"这一条窄缝，也是插到 DefView 之后的天然结果。
//
// 判据必须是"在 DefView 之后"而**不能**是"紧跟 DefView 之后"：
// 多显示器下一个进程有 N 个壁纸窗口，其中只有一个能紧邻 DefView，其余必然在更下面。
// 用"紧跟"判据的话每一拍都会把另一个窗口又挪上来，两个窗口互相顶、永久抖动 ——
// 实测 25 秒里纠偏了 2850 次（≈114 次/秒），既是性能灾难也会造成画面闪动。
inline bool EnsureZOrder(HWND target, const Placement &pl) {
	if (!target || !pl.host || !pl.defview) {
		return false;
	}
	if (!IsWindow(target) || !IsWindow(pl.defview)) {
		return false;
	}
	if (GetParent(target) != pl.host || GetParent(pl.defview) != pl.host) {
		return false;
	}

	// 找出两者在宿主子窗口 z 序里的位置（0 = 最上）。target_z > defview_z 即"在图标层之下"。
	int target_z = -1;
	int defview_z = -1;
	detail::ScanChildZOrder(pl.host, target, pl.defview, &target_z, &defview_z);
	if (target_z < 0 || defview_z < 0) {
		return false; // 有一个已经不在宿主下了，交给 PollSlot 的重挂逻辑
	}
	bool ok = (target_z > defview_z);
	int workerw_z = -1;
	HWND workerw = FindWindowExW(pl.host, nullptr, L"WorkerW", nullptr);
	if (ok && workerw) {
		// 再确认没有掉到静态壁纸宿主下面。宿主的 z 序必须**在 DefView 之后**（图标层之下）
		// —— 那样"插到 DefView 之后"自然就落在宿主之上。宿主"在图标层之上"时壁纸层这条
		// 窄缝根本不存在（我们无论怎么插都会被它盖住），此时**不做任何动作**：
		// 否则每 250ms 一次 SetWindowPos 也永远修不好，只会变成白白的抖动与日志刷屏。
		int tz = -1;
		detail::ScanChildZOrder(pl.host, target, workerw, &tz, &workerw_z);
		ok = (tz >= 0 && workerw_z >= 0 && tz < workerw_z);
	}
	if (ok) {
		return false; // 已经正确
	}
	if (workerw && workerw_z >= 0 && workerw_z < defview_z) {
		// 宿主跑到了图标层上面 —— 这条缝不存在，插入也白插。留给状态位暴露（不做动作）。
		return false;
	}
	// ★ 真正执行的修正调用单独计时（复审：光测"整段"分不出是 SetWindowPos 慢还是扫描慢）。
	{
		lull::timing::ScopedTimer t(lull::timing::kTagEnsureZOrderSetPos);
		SetWindowPos(target, pl.defview, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
	}
	return true;
}

// 确保位置与尺寸没被外部改动。返回 true 表示这次做了修正。
//
// 为什么需要它：多显示器下每个壁纸窗口有各自的矩形，Godot 在窗口状态变化时会按自己
// 的簿记重新 SetWindowPos，把窗口挪回它以为的位置。位置一错，画面就跑到别的显示器去了。
// client_want 用**宿主客户区坐标**。
inline bool EnsureRect(HWND target, HWND host, const RECT &client_want) {
	if (!target || !host || !IsWindow(target) || !IsWindow(host)) {
		return false;
	}
	RECT wr = {0, 0, 0, 0};
	if (!GetWindowRect(target, &wr)) {
		return false;
	}
	POINT tl;
	tl.x = wr.left;
	tl.y = wr.top;
	POINT br;
	br.x = wr.right;
	br.y = wr.bottom;
	ScreenToClient(host, &tl);
	ScreenToClient(host, &br);

	const LONG want_w = client_want.right - client_want.left;
	const LONG want_h = client_want.bottom - client_want.top;
	if (tl.x == client_want.left && tl.y == client_want.top && (br.x - tl.x) == want_w &&
			(br.y - tl.y) == want_h) {
		return false; // 已经正确
	}
	// ★ 真正执行的修正 MoveWindow 单独计时（bRepaint=TRUE，同 Attach 路径的两个 Move）。
	{
		lull::timing::ScopedTimer t(lull::timing::kTagEnsureRectMove);
		MoveWindow(target, client_want.left, client_want.top, want_w, want_h, TRUE);
	}
	return true;
}

// 挂载是否仍然有效（看门狗调用；Explorer 重启后 Progman 会换句柄）。
inline bool IsAlive(HWND target, HWND host) {
	return target && host && IsWindow(target) && IsWindow(host) && GetParent(target) == host;
}

// 确保常规复核（4Hz）下必需的样式仍在。Godot 在窗口状态变化时可能把自己原来的样式写回去，
// 把 WS_CHILD / WS_EX_LAYERED 冲掉，这时画面会直接消失。
// 返回 true 表示这次确实修改了样式（可用于日志）。
inline bool EnsureStyles(HWND target, bool use_layered) {
	if (!target || !IsWindow(target)) {
		return false;
	}

	LONG s = GetWindowLongW(target, GWL_STYLE);
	// 注意：**不**强制 WS_VISIBLE——可见性是应用侧状态（ShowWindow 隐藏后该位会被清掉），
	// 看门狗若把它写回，会每 700ms 把"故意隐藏"的壁纸窗重新显示出来（2026-10-11 实测：
	// 总开关隐藏后 1 个保单周期内被复活）。保留样例中的 WS_VISIBLE 现状即可。
	LONG want_s = (s & ~kWallpaperStyleClear) | WS_CHILD;
	if (want_s != s) {
		// ★ 写路径单独计时（跨线程窗口改样式内部要走消息路径，是运行期最可疑的同步调用之一）。
		lull::timing::ScopedTimer t(lull::timing::kTagEnsureStylesSetLong);
		SetWindowLongW(target, GWL_STYLE, want_s);
	}

	// 扩展样式整组重算（含鼠标穿透）。WS_EX_TRANSPARENT 必须常规复核：
	// Godot 换样式时不会带上它，一旦被冲掉，只要层序同时被顶上去，
	// 桌面就会有一段时间点不动（详见 EnsureMouseThrough 的注释）。
	LONG e = GetWindowLongW(target, GWL_EXSTYLE);
	LONG want_e = detail::WallpaperExStyle(e, use_layered);
	if (want_e != e) {
		{
			lull::timing::ScopedTimer t(lull::timing::kTagEnsureStylesSetLong);
			SetWindowLongW(target, GWL_EXSTYLE, want_e);
		}
		if (use_layered) {
			lull::timing::ScopedTimer t(lull::timing::kTagEnsureStylesLayered);
			SetLayeredWindowAttributes(target, 0, kLayeredAlphaOpaque, LWA_ALPHA);
		}
	}

	return want_s != s || want_e != e;
}

} // namespace wallpaper
} // namespace lull

#endif // LULL_WALLPAPER_HOST_H
