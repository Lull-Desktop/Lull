"""桌面层级与截图验证工具：报告窗口树、命中测试并采集整屏结果。

用法（在真实桌面会话里运行，不要放在沙箱里 —— 沙箱进程看不到 Explorer 的窗口树）：

    python verify_shot.py info                  # 打印桌面窗口层级报告 + 命中测试
    python verify_shot.py info --show-desktop   # 同上，但先"显示桌面"再采样（推荐）
    python verify_shot.py wins --family Godot   # 按进程名列窗口（顶层 + Progman 子窗口）
    python verify_shot.py wins --pid 1234       # 按 pid 列窗口，看 owner / parent 落在哪
    python verify_shot.py shot out.png          # 抓整个虚拟屏幕
    python verify_shot.py shot out.png --show-desktop
                                                # 先"显示桌面"露出壁纸，抓完再恢复

`info` 会列出 Progman 的全部子窗口（z 序 / 类名 / 矩形 / 可见性 /
WS_EX_LAYERED / 所属进程），这样能直接看出壁纸窗口是否插在
SHELLDLL_DefView 之后、是不是 Godot 进程的窗口。
它还会对 DefView 区域内若干点做 WindowFromPoint 命中测试，判断输入是否
仍然归桌面图标层 —— 这个测试**必须**配合 `--show-desktop`，否则采样点被
其它顶层窗口盖住，会得到与被测层级无关的假 FAIL。
"""
import ctypes
import ctypes.wintypes as wt
import os
import sys

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32

# 必须先把本进程设成 per-monitor DPI 感知：否则 Windows 会虚拟化坐标，
# GetWindowRect / SM_CXVIRTUALSCREEN 返回的是被缩放过的值（本机 125% 时
# 4480x1440 会变成 3584x1152），抓出来的图会缺一块、层级报告里的尺寸也是错的。
try:
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # PER_MONITOR_AWARE_V2
except Exception:
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass

# ctypes 默认把返回值当 C int（32 位），会把 64 位 HWND 截断，比较就全错了。
# 所有返回句柄的函数都必须显式声明 restype。
user32.FindWindowW.restype = wt.HWND
user32.FindWindowW.argtypes = [wt.LPCWSTR, wt.LPCWSTR]
user32.FindWindowExW.restype = wt.HWND
user32.FindWindowExW.argtypes = [wt.HWND, wt.HWND, wt.LPCWSTR, wt.LPCWSTR]
user32.GetWindow.restype = wt.HWND
user32.GetWindow.argtypes = [wt.HWND, wt.UINT]
user32.GetAncestor.restype = wt.HWND
user32.GetAncestor.argtypes = [wt.HWND, wt.UINT]
user32.GetParent.restype = wt.HWND
user32.GetParent.argtypes = [wt.HWND]
user32.WindowFromPoint.restype = wt.HWND
user32.WindowFromPoint.argtypes = [wt.POINT]

SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79

SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0
WM_COMMAND = 0x0111
ID_SHOW_DESKTOP = 419

WS_CHILD = 0x40000000
WS_VISIBLE = 0x10000000
WS_POPUP = 0x80000000
WS_EX_LAYERED = 0x00080000
WS_EX_TOPMOST = 0x00000008
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
WS_EX_NOACTIVATE = 0x08000000

GWL_STYLE = -16
GWL_EXSTYLE = -20
GW_CHILD = 5
GW_HWNDNEXT = 2
GW_OWNER = 4
GA_ROOT = 2

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD),
        ("biWidth", ctypes.c_long),
        ("biHeight", ctypes.c_long),
        ("biPlanes", wt.WORD),
        ("biBitCount", wt.WORD),
        ("biCompression", wt.DWORD),
        ("biSizeImage", wt.DWORD),
        ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", wt.DWORD),
        ("biClrImportant", wt.DWORD),
    ]


def hwnd_str(h):
    return "0x%X" % (h & 0xFFFFFFFFFFFFFFFF) if h else "None"


def proc_name(pid):
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return "?"
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value)
        return "?"
    finally:
        kernel32.CloseHandle(h)


def class_name(h):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(h, buf, 256)
    return buf.value


def window_pid(h):
    pid = wt.DWORD(0)
    user32.GetWindowThreadProcessId(h, ctypes.byref(pid))
    return pid.value


def rect_of(h):
    r = wt.RECT()
    user32.GetWindowRect(h, ctypes.byref(r))
    return (r.left, r.top, r.right, r.bottom)


# ---------------------------------------------------------------------------
# info
# ---------------------------------------------------------------------------

def show_desktop():
    tray = user32.FindWindowW("Shell_TrayWnd", None)
    if not tray:
        raise SystemExit("Shell_TrayWnd not found")
    user32.SendMessageW(tray, WM_COMMAND, ID_SHOW_DESKTOP, 0)


def cmd_info():
    progman = user32.FindWindowW("Progman", None)
    print("Progman = %s" % hwnd_str(progman))

    defview_z = -1
    our_z = -1
    kids = []
    if progman:
        i = 0
        child = user32.GetWindow(progman, GW_CHILD)
        while child:
            cls = class_name(child)
            style = user32.GetWindowLongW(child, GWL_STYLE)
            ex = user32.GetWindowLongW(child, GWL_EXSTYLE)
            pid = window_pid(child)
            r = rect_of(child)
            kids.append((i, child, cls, style, ex, pid, r))
            if cls == "SHELLDLL_DefView":
                defview_z = i
            i += 1
            child = user32.GetWindow(child, GW_HWNDNEXT)

    # Explorer 的 pid（Progman 所属）
    explorer_pid = window_pid(progman) if progman else 0

    print("Progman children = %d  (z 0 = topmost)" % len(kids))
    for i, h, cls, style, ex, pid, r in kids:
        ours = pid and pid != explorer_pid
        if ours:
            globals()["_our_z"] = i
        print(
            "  z[%2d] %-20s hwnd=%-10s pid=%-6d %-28s rect=(%d,%d,%d,%d) "
            "vis=%d child=%d popup=%d layered=%d topmost=%d tool=%d%s"
            % (
                i,
                cls,
                hwnd_str(h),
                pid,
                proc_name(pid),
                r[0],
                r[1],
                r[2],
                r[3],
                (style & WS_VISIBLE) != 0,
                (style & WS_CHILD) != 0,
                (style & WS_POPUP) != 0,
                (ex & WS_EX_LAYERED) != 0,
                (ex & WS_EX_TOPMOST) != 0,
                (ex & WS_EX_TOOLWINDOW) != 0,
                "   <== 非 Explorer 进程的窗口（我们的壁纸）" if ours else "",
            )
        )

    our_z = globals().get("_our_z", -1)

    # 顶层 WorkerW 统计
    stats = {"total": 0, "workerw": 0, "workerw_visible": 0}

    WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

    def cb(h, l):
        stats["total"] += 1
        if class_name(h) == "WorkerW":
            stats["workerw"] += 1
            if user32.IsWindowVisible(h):
                stats["workerw_visible"] += 1
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)

    print(
        "top-level windows=%d  WorkerW=%d (visible=%d)"
        % (stats["total"], stats["workerw"], stats["workerw_visible"])
    )

    print("--- verdict ---")
    if defview_z < 0:
        print("SHELLDLL_DefView not found under Progman (unexpected layout)")
    elif our_z < 0:
        print("FAIL: 没有找到挂在 Progman 下的外部进程窗口")
    elif our_z > defview_z:
        print(
            "OK: 壁纸窗口在 DefView 之后 (defview z=%d, ours z=%d) => 位于图标层之下"
            % (defview_z, our_z)
        )
    else:
        print(
            "FAIL: 壁纸窗口在 DefView 之前 (defview z=%d, ours z=%d) => 会盖住桌面图标"
            % (defview_z, our_z)
        )

    cmd_hit_test(progman, defview_z, kids)


def cmd_hit_test(progman, defview_z, kids):
    """命中测试：桌面图标区域上的鼠标点击会被哪个窗口接走。

    这是「桌面图标还能点 / 拖 / 右键」的客观代理指标。判据分四类，**别只看 pid**：

      * 命中链上出现我们的壁纸窗口                        -> FAIL（输入被壁纸截走，真 bug）
      * 命中 SHELLDLL_DefView / SysListView32，或祖先链里有 Progman -> OK
      * 命中我们自己的 UI 浮窗                            -> INCONCLUSIVE（浮窗本来就该在上层）
      * 命中其它第三方窗口                                -> INCONCLUSIVE（被无关窗口遮挡）

    后两类必须单独列出来：早先的版本把它们一律算 FAIL，于是每次 WorkBuddy 自己的
    窗口盖住桌面就报一个纯属环境干扰的假失败。判定顺序也很关键 —— 我们的壁纸窗口
    是 Progman 的子窗口，祖先链里同样有 Progman，所以必须先查"是不是我们的窗口"。
    """
    defview = None
    explorer_pid = 0
    for i, h, cls, style, ex, pid, r in kids:
        if cls == "SHELLDLL_DefView":
            defview = (h, r)
            explorer_pid = pid
            break
    if not defview:
        print("hit-test: skipped (no DefView)")
        return

    # 挂进 Progman 但不属于 explorer 的窗口 = 我们的壁纸（同进程的 UI 浮窗也是这个 pid）
    wallpaper = set()
    our_pids = set()
    for i, h, cls, style, ex, pid, r in kids:
        if pid and pid != explorer_pid:
            wallpaper.add(h)
            our_pids.add(pid)

    h, r = defview
    POINT = wt.POINT
    pts = []
    cols, rows = 6, 4
    for cx in range(cols):
        for cy in range(rows):
            pts.append((
                r[0] + 60 + (r[2] - r[0] - 120) * cx // max(cols - 1, 1),
                r[1] + 60 + (r[3] - r[1] - 120) * cy // max(rows - 1, 1),
            ))

    print("hit-test (WindowFromPoint)  %d 个采样点：" % len(pts))
    n_ok = n_fail = n_ours_ui = n_blocked = 0
    for (x, y) in pts:
        p = POINT(x, y)
        w = user32.WindowFromPoint(p)
        if not w:
            n_blocked += 1
            print("  point(%5d,%5d) -> (null)" % (x, y))
            continue

        # 从命中窗口一路往上走，看链上有没有我们的壁纸窗口
        chain = []
        cur = w
        for _ in range(8):
            if not cur:
                break
            chain.append(cur)
            nxt = user32.GetParent(cur)
            if not nxt or nxt == cur:
                break
            cur = nxt

        cls = class_name(w)
        pid = window_pid(w)
        root = user32.GetAncestor(w, GA_ROOT)
        rcls = class_name(root) if root else "None"
        hit_wallpaper = [c for c in chain if c in wallpaper]

        if hit_wallpaper:
            n_fail += 1
            tag = "FAIL  被壁纸窗口(hwnd=%s)截走" % hwnd_str(hit_wallpaper[0])
        elif cls in ("SHELLDLL_DefView", "SysListView32") or (root and root == progman):
            n_ok += 1
            tag = "OK    归桌面图标层 (explorer)"
        elif pid in our_pids:
            n_ours_ui += 1
            tag = "遮挡  我们自己的 UI 浮窗"
        else:
            n_blocked += 1
            tag = "遮挡  第三方窗口 %s" % proc_name(pid)

        print("  point(%5d,%5d) -> %-18s pid=%-6d root=%-10s %s"
              % (x, y, cls, pid, rcls, tag))

    print("hit-test 汇总: OK=%d  FAIL=%d  被自家UI遮挡=%d  被第三方遮挡=%d"
          % (n_ok, n_fail, n_ours_ui, n_blocked))
    if n_fail:
        print("hit-test result: FAIL（壁纸窗口截走了桌面输入）")
    elif n_ok:
        print("hit-test result: OK")
    else:
        print("hit-test result: INCONCLUSIVE（没有干净采样点；"
              "先关掉盖在桌面上的窗口，或加 --show-desktop 重跑）")


def cmd_wins(family=None, pid=None):
    """列出指定进程（或指定进程名）的**全部**窗口，含 Progman 子窗口。

    用途：多窗口架构下判断一个窗口到底在哪。
      * 顶层且 owner==0  => 独立浮窗，会进 Alt+Tab / 任务栏
      * 顶层但 owner!=0  => 从属浮窗，不进 Alt+Tab
      * parent==Progman  => 已被挂进桌面壁纸层级

    EnumWindows 只枚举**顶层**窗口，挂进 Progman 的壁纸窗口不在其中，
    所以这里额外把 Progman 的子窗口也扫一遍。
    """
    progman = user32.FindWindowW("Progman", None)
    roots = []

    WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

    def match(h):
        p = window_pid(h)
        if pid is not None and p != pid:
            return False
        if family and family.lower() not in proc_name(p).lower():
            return False
        return True

    def cb(h, l):
        if match(h):
            roots.append(("top-level", h))
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)

    # 挂进 Progman 的壁纸窗口是**子窗口**，EnumWindows 看不到，必须单独扫一遍。
    if progman:
        c = user32.GetWindow(progman, GW_CHILD)
        while c:
            if match(c):
                roots.append(("progman-child", c))
            c = user32.GetWindow(c, GW_HWNDNEXT)

    print("Progman = %s" % hwnd_str(progman))
    print("matched top-level / progman-child = %d" % len(roots))
    print()

    n_alttab = 0
    n_wallpaper = 0
    n_child = 0
    seen = set()

    def classify(h):
        style = user32.GetWindowLongW(h, GWL_STYLE)
        ex = user32.GetWindowLongW(h, GWL_EXSTYLE)
        gparent = user32.GetParent(h)
        # 注意：ctypes 把 HWND 声明成 c_void_p，空句柄返回 None 而不是 0，
        # 所以判断"没有 owner"必须用 `not owner`，写成 `owner == 0` 永远为假。
        owner = user32.GetWindow(h, GW_OWNER)
        vis = bool(style & WS_VISIBLE)
        child = bool(style & WS_CHILD)
        tool = bool(ex & WS_EX_TOOLWINDOW)
        if child and progman and gparent == progman:
            verdict = "壁纸：挂进 Progman 桌面层级 => 不进 Alt+Tab"
        elif child:
            verdict = "WS_CHILD 子窗口：父=%s => 在父窗口客户区里，不是独立浮窗" % hwnd_str(gparent)
        elif vis and not owner and not tool:
            verdict = "独立顶层浮窗 => 进 Alt+Tab / 任务栏"
        elif vis and owner:
            verdict = "顶层但从属窗口：owner=%s => 不进 Alt+Tab" % hwnd_str(owner)
        elif vis and tool:
            verdict = "顶层工具窗口(WS_EX_TOOLWINDOW) => 不进 Alt+Tab"
        else:
            verdict = "不可见"
        return style, ex, gparent, owner, vis, child, tool, verdict

    def walk(h, kind, indent):
        if h in seen:
            return
        seen.add(h)
        style, ex, gparent, owner, vis, child, tool, verdict = classify(h)
        r = rect_of(h)
        p = window_pid(h)
        print("%s%-14s hwnd=%-10s class=%-22s pid=%-6d %s" % (indent, kind, hwnd_str(h), class_name(h), p, proc_name(p)))
        print("%s  rect=(%d,%d,%d,%d) size=%dx%d" % (indent, r[0], r[1], r[2], r[3], r[2] - r[0], r[3] - r[1]))
        print(
            "%s  vis=%d child=%d popup=%d layered=%d topmost=%d tool=%d appwindow=%d"
            % (
                indent,
                vis,
                child,
                bool(style & WS_POPUP),
                bool(ex & WS_EX_LAYERED),
                bool(ex & WS_EX_TOPMOST),
                tool,
                bool(ex & WS_EX_APPWINDOW),
            )
        )
        print("%s  GetParent=%s  GW_OWNER=%s  GA_ROOT=%s" % (indent, hwnd_str(gparent), hwnd_str(owner), hwnd_str(user32.GetAncestor(h, GA_ROOT))))
        print("%s  => %s" % (indent, verdict))

        nonlocal n_alttab, n_wallpaper, n_child
        if verdict.startswith("壁纸"):
            n_wallpaper += 1
        elif verdict.startswith("独立顶层浮窗"):
            n_alttab += 1
        elif verdict.startswith("WS_CHILD"):
            n_child += 1

        # 递归子窗口：Godot 的 Window 节点有可能被创建成主窗口的 WS_CHILD，
        # 那样 EnumWindows 和 Progman 扫描都看不见它，只有递归才能发现。
        c = user32.GetWindow(h, GW_CHILD)
        while c:
            walk(c, "child", indent + "    ")
            c = user32.GetWindow(c, GW_HWNDNEXT)

    if not roots:
        print("(没有匹配的窗口 —— 检查 --pid / --family 参数，或窗口还没创建)")
    for kind, h in roots:
        walk(h, kind, "")
        print()

    print("--- 小结 ---")
    print("  挂进桌面层级的壁纸窗口 : %d" % n_wallpaper)
    print("  独立顶层浮窗(进Alt+Tab): %d" % n_alttab)
    print("  WS_CHILD 子窗口        : %d   (不是独立浮窗)" % n_child)


# ---------------------------------------------------------------------------
# shot
# ---------------------------------------------------------------------------

def capture(path):
    x = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
    y = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    w = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
    h = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)

    hdc_screen = user32.GetDC(0)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbm = gdi32.CreateCompatibleBitmap(hdc_screen, w, h)
    gdi32.SelectObject(hdc_mem, hbm)
    gdi32.BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, x, y, SRCCOPY)

    bih = BITMAPINFOHEADER()
    bih.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bih.biWidth = w
    bih.biHeight = -h
    bih.biPlanes = 1
    bih.biBitCount = 32

    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(hdc_mem, hbm, 0, h, buf, ctypes.byref(bih), DIB_RGB_COLORS)

    from PIL import Image

    Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB").save(path)

    gdi32.DeleteObject(hbm)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(0, hdc_screen)
    print("saved %s (%dx%d)" % (path, w, h))


def cmd_shot(out, show, also=None, delay=1.0):
    if show:
        show_desktop()
        ctypes.windll.kernel32.Sleep(800)
    try:
        capture(out)
        if also:
            # 同一次「显示桌面」期间再抓一张，用来做逐帧差分、证明动画在跑。
            ctypes.windll.kernel32.Sleep(int(delay * 1000))
            capture(also)
    finally:
        if show:
            show_desktop()
            ctypes.windll.kernel32.Sleep(400)
            print("desktop restored")


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    if args[0] == "info":
        # --show-desktop：先切到桌面（最小化所有窗口）再采样。
        # 命中测试的必要前提：采样点若被别的顶层窗口（编辑器/浏览器/终端）盖住，
        # WindowFromPoint 必然返回那个窗口，测出来是假 FAIL —— 与被测的壁纸层级无关。
        show = "--show-desktop" in args
        if show:
            show_desktop()
            ctypes.windll.kernel32.Sleep(900)
        try:
            cmd_info()
        finally:
            if show:
                show_desktop()
                ctypes.windll.kernel32.Sleep(400)
                print("desktop restored")
    elif args[0] == "shot":
        out = args[1] if len(args) > 1 else "shot.png"
        also = None
        delay = 1.0
        if "--also" in args:
            also = args[args.index("--also") + 1]
        if "--delay" in args:
            delay = float(args[args.index("--delay") + 1])
        cmd_shot(out, "--show-desktop" in args, also, delay)
    elif args[0] == "wins":
        # wins [--family Godot] [--pid 1234]
        fam = None
        wpid = None
        if "--family" in args:
            fam = args[args.index("--family") + 1]
        if "--pid" in args:
            wpid = int(args[args.index("--pid") + 1])
        cmd_wins(fam, wpid)
    else:
        raise SystemExit(__doc__)
