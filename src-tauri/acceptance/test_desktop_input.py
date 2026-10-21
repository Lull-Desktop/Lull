"""桌面输入探针：通过真实点击和图标选中状态验证桌面壁纸层不阻断交互。

为什么不用 WindowFromPoint：那只证明「鼠标消息会投递给谁」，不证明「投递过去之后
桌面真的有反应」。本测试直接对桌面图标层 SysListView32 发 LVM_GETSELECTEDCOUNT，
在**真实注入鼠标点击**前后各读一次选中数 —— 这是「桌面能不能选择图标」的因果证据。

用法：
    python test_desktop_input.py probe                  # 只读：图标层状态
    python test_desktop_input.py click <x> <y>          # 在 (x,y) 真点一下并比对选中数
    python test_desktop_input.py click <x> <y> --no-restore   # 不改回原选中状态
"""
import ctypes
import ctypes.wintypes as wt
import os
import sys
import time

u = ctypes.windll.user32
k = ctypes.windll.kernel32

try:
    u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    pass

u.FindWindowW.restype = wt.HWND
u.FindWindowExW.restype = wt.HWND
u.GetWindow.restype = wt.HWND
u.WindowFromPoint.restype = wt.HWND
u.RealChildWindowFromPoint.restype = wt.HWND
u.GetAncestor.restype = wt.HWND

GW_CHILD = 5
GA_ROOT = 2
LVM_GETSELECTEDCOUNT = 0x1032
LVM_GETNEXTITEM = 0x100C
LVNI_SELECTED = 0x0002
SMTO_ABORTIFHUNG = 0x0002

# ctypes 默认把参数当 32 位 int，导致 WPARAM=0xFFFFFFFF（"从 -1 开始找"）溢出报错。
# 64 位下 WPARAM/LPARAM 都是 ULONG_PTR，必须显式声明宽度。
u.SendMessageTimeoutW.argtypes = [
    wt.HWND, wt.UINT, ctypes.c_ulonglong, ctypes.c_ulonglong,
    wt.UINT, wt.UINT, ctypes.POINTER(ctypes.c_ulonglong),
]
u.SendMessageTimeoutW.restype = wt.LPARAM


def cls(h):
    b = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(h, b, 256)
    return b.value


def pid_of(h):
    p = wt.DWORD()
    u.GetWindowThreadProcessId(h, ctypes.byref(p))
    return p.value


def rect(h):
    r = wt.RECT()
    u.GetWindowRect(h, ctypes.byref(r))
    return (r.left, r.top, r.right, r.bottom)


def find_listview():
    """Progman -> SHELLDLL_DefView -> SysListView32"""
    progman = u.FindWindowW("Progman", None)
    if not progman:
        return None, None, None
    dv = u.FindWindowExW(progman, None, "SHELLDLL_DefView", None)
    if not dv:
        # Win10 风格：顶层 WorkerW 里
        found = []

        def cb(h, l):
            d = u.FindWindowExW(h, None, "SHELLDLL_DefView", None)
            if d:
                found.append(d)
            return True

        u.EnumWindows(ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)(cb), 0)
        dv = found[0] if found else None
    if not dv:
        return progman, None, None
    lv = u.FindWindowExW(dv, None, "SysListView32", None)
    if not lv:
        lv = u.FindWindowExW(dv, None, "WorkerW", None)
    return progman, dv, lv


def send_msg_timeout(hwnd, msg, wp=0, lp=0, timeout=2000):
    """跨进程 SendMessage 必须带超时 —— 目标线程忙的话会永久阻塞调用方。"""
    res = ctypes.c_ulonglong(0)
    ok = u.SendMessageTimeoutW(hwnd, msg, wp, lp, SMTO_ABORTIFHUNG, timeout,
                               ctypes.byref(res))
    if not ok:
        return None
    return res.value


def selected_count(lv):
    r = send_msg_timeout(lv, LVM_GETSELECTEDCOUNT)
    return None if r is None else int(r)


def selected_items(lv, limit=8):
    out = []
    idx = send_msg_timeout(lv, LVM_GETNEXTITEM, 0xFFFFFFFF, LVNI_SELECTED)
    n = 0
    while idx is not None and idx >= 0 and n < limit:
        out.append(idx)
        idx = send_msg_timeout(lv, LVM_GETNEXTITEM, idx, LVNI_SELECTED)
        n += 1
    return out


def inject_click(x, y, right=False):
    """SendInput 真鼠标：移动 + 按下 + 抬起。SendMessage 伪造的点击桌面不认。"""
    MOUSEEVENTF_MOVE = 0x0001
    MOUSEEVENTF_LEFTDOWN = 0x0002
    MOUSEEVENTF_LEFTUP = 0x0004
    MOUSEEVENTF_RIGHTDOWN = 0x0008
    MOUSEEVENTF_RIGHTUP = 0x0010
    MOUSEEVENTF_ABSOLUTE = 0x8000

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long),
                    ("mouseData", wt.DWORD), ("dwFlags", wt.DWORD),
                    ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(wt.ULONG))]

    class INPUT(ctypes.Structure):
        class _U(ctypes.Union):
            _fields_ = [("mi", MOUSEINPUT)]
        _anonymous_ = ("u",)
        _fields_ = [("type", wt.DWORD), ("u", _U)]

    cx = u.GetSystemMetrics(0)
    cy = u.GetSystemMetrics(1)
    ax = int(x * 65535 / (cx - 1))
    ay = int(y * 65535 / (cy - 1))
    down = MOUSEEVENTF_RIGHTDOWN if right else MOUSEEVENTF_LEFTDOWN
    up = MOUSEEVENTF_RIGHTUP if right else MOUSEEVENTF_LEFTUP

    def fire(flags):
        inp = INPUT()
        inp.type = 0  # INPUT_MOUSE
        inp.mi.dx = ax
        inp.mi.dy = ay
        inp.mi.dwFlags = flags
        u.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))

    fire(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE)
    time.sleep(0.25)
    fire(down | MOUSEEVENTF_ABSOLUTE)
    time.sleep(0.08)
    fire(up | MOUSEEVENTF_ABSOLUTE)
    time.sleep(0.55)


def _popup_menus():
    """Win32 经典弹出菜单（class=#32768）—— 托盘菜单是这一类。"""
    out = []

    def cb(h, l):
        if cls(h) == "#32768":
            r = wt.RECT()
            u.GetWindowRect(h, ctypes.byref(r))
            out.append((h, pid_of(h), (r.left, r.top, r.right - r.left, r.bottom - r.top)))
        return True

    u.EnumWindows(ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)(cb), 0)
    return out


def _visible_top_level():
    """所有"有实际尺寸"的可见顶层窗口。

    为什么不能只找 #32768：**Win11 的右键菜单已经不是经典菜单了**，它是 XAML 弹出，
    类名是 `Microsoft.UI.Content.PopupWindowSiteBridge` / `Xaml_WindowedPopupClass`
    （属主仍是 explorer.exe）。只查 #32768 会在 Win11 上得到"桌面没反应"的假结论 ——
    这个坑踩过一次，别再退回去。
    """
    out = set()

    def cb(h, l):
        if u.IsWindowVisible(h):
            r = wt.RECT()
            u.GetWindowRect(h, ctypes.byref(r))
            if (r.right - r.left) > 8 and (r.bottom - r.top) > 8:
                out.add(h)
        return True

    u.EnumWindows(ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)(cb), 0)
    return out


def _describe(hwnds):
    lines = []
    for h in hwnds:
        r = wt.RECT()
        u.GetWindowRect(h, ctypes.byref(r))
        lines.append("hwnd=%08X cls=%-42s pid=%-6d rect=(%d,%d)+%dx%d"
                     % (h, cls(h), pid_of(h), r.left, r.top, r.right - r.left, r.bottom - r.top))
    return lines


def _send_escape():
    VK_ESCAPE = 0x1B
    KEYEVENTF_KEYUP = 0x0002
    u.keybd_event(VK_ESCAPE, 0, 0, 0)
    u.keybd_event(VK_ESCAPE, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(0.4)


def probe_chain(x, y):
    p = wt.POINT(x, y)
    w = u.WindowFromPoint(p)
    if not w:
        return "(null)", 0, "(null)"
    # RealChildWindowFromPoint 会忽略 WS_EX_TRANSPARENT 的子窗口，能看出
    # "谁真的接走点击"与"谁只是画在上面"的区别。
    rc = None
    dv = u.FindWindowExW(u.FindWindowW("Progman", None), None, "SHELLDLL_DefView", None)
    if dv:
        rc = u.RealChildWindowFromPoint(dv, p)
    return cls(w), pid_of(w), (cls(rc) if rc else "(null)")


def show_desktop():
    """最小化所有窗口露出桌面 —— 否则点击会落在盖住桌面的窗口上，测出假结果。
    再调一次恢复（Win+D 是开关）。"""
    tray = u.FindWindowW("Shell_TrayWnd", None)
    if tray:
        u.SendMessageW(tray, 0x0111, 419, 0)  # WM_COMMAND / ID_SHOW_DESKTOP
        time.sleep(0.9)


def cmd_rclick(x, y, desktop, wait=1.4):
    """右键点桌面空白处 → 桌面应该弹出它自己的右键菜单。

    判据（Win11 必须这么判，见 _visible_top_level 的注释）：
    右键之后新增的可见顶层窗口里，有没有属于 explorer.exe 的弹出窗口。
    没有 => 这次右键根本没被桌面接走 => 桌面输入被别的窗口截了。
    """
    explorer_pid = 0
    progman = u.FindWindowW("Progman", None)
    if progman:
        explorer_pid = pid_of(progman)

    if desktop:
        show_desktop()
    time.sleep(0.5)

    c, p, rc = probe_chain(x, y)
    print("右键点 (%d,%d) 的命中链: WindowFromPoint=%s pid=%d RealChild=%s" % (x, y, c, p, rc))

    before = _visible_top_level()
    print("右键前可见顶层窗口 %d 个" % len(before))

    inject_click(x, y, right=True)
    time.sleep(wait)
    after = _visible_top_level()
    fresh = [h for h in after if h not in before]
    print("右键后新增 %d 个顶层窗口：" % len(fresh))
    for line in _describe(fresh):
        print("  " + line)

    theirs = [h for h in fresh if pid_of(h) == explorer_pid]
    mine = [h for h in fresh if pid_of(h) != explorer_pid]

    if theirs:
        print("判定: OK —— 桌面弹出了自己的右键菜单（explorer pid=%d，%d 个窗口）"
              % (explorer_pid, len(theirs)))
    elif mine:
        print("判定: FAIL —— 右键弹出的窗不属于 explorer（pid=%s），说明桌面输入被截走了"
              % ", ".join(str(pid_of(h)) for h in mine))
    else:
        print("判定: FAIL —— 右键点了桌面，桌面**毫无反应**（没有弹出任何窗口）")

    for h in fresh:
        u.PostMessageW(h, 0x0010, 0, 0)
    _send_escape()


def cmd_both(x, y, desktop):
    """对照组：同一套判据分别打在「任务栏」和「桌面」上。

    任务栏必须是有反应的 —— 否则说明是本进程注入失败（不是被测对象的毛病），
    这时候桌面的 FAIL 没有任何诊断价值。用一个必须成功的点当参照物，
    才能把"注入失败"和"桌面真的不可操作"区分开。
    """
    tray_h = u.FindWindowW("Shell_TrayWnd", None)
    r = wt.RECT()
    u.GetWindowRect(tray_h, ctypes.byref(r))
    tx = (r.left + r.right) // 2
    ty = (r.top + r.bottom) // 2

    print("########## 对照：右键任务栏 (%d,%d) ##########" % (tx, ty))
    # 参照物要重试：注入偶尔会被系统丢掉（比如刚切过桌面、前台窗口正在切换），
    # 单次失败不能说明"注入不可信"。重试到成功为止，成功不了才判不可信。
    ok_ref = False
    for attempt in range(3):
        ok_ref = _rclick_probe(tx, ty, desktop=False)
        if ok_ref:
            if attempt:
                print("（参照物第 %d 次成功）" % (attempt + 1))
            break
        print("（参照物第 %d 次无反应，重试）" % (attempt + 1))
        time.sleep(1.5)
    print()
    print("########## 被测：右键桌面空白 (%d,%d) ##########" % (x, y))
    ok_desk = _rclick_probe(x, y, desktop=desktop)
    if ok_ref and not ok_desk:
        # 参照物成功、桌面失败 => 才值得复测一次，避免单次抖动给出假结论
        print("（桌面第 1 次无反应，复测一次）")
        time.sleep(1.5)
        ok_desk = _rclick_probe(x, y, desktop=False)
    print()
    print("========== 小结 ==========")
    print("任务栏（参照物）有反应 = %s" % ok_ref)
    print("桌面（被测）有反应     = %s" % ok_desk)
    if not ok_ref:
        print("=> 本次注入不可信（任务栏都没反应），桌面结果无效")
    elif ok_desk:
        print("=> 桌面可操作：右键能弹出桌面自己的菜单")
    else:
        print("=> **桌面不可操作已复现**：参照物有反应、桌面无反应")


def _rclick_probe(x, y, desktop=False, wait=1.4):
    explorer_pid = 0
    progman = u.FindWindowW("Progman", None)
    if progman:
        explorer_pid = pid_of(progman)
    if desktop:
        show_desktop()
    time.sleep(0.5)

    c, p, rc = probe_chain(x, y)
    print("命中链: WindowFromPoint=%s pid=%d RealChild=%s" % (c, p, rc))
    before = _visible_top_level()
    inject_click(x, y, right=True)
    time.sleep(wait)
    fresh = [h for h in _visible_top_level() if h not in before]
    print("新增顶层窗口 %d 个：" % len(fresh))
    for line in _describe(fresh):
        print("  " + line)
    theirs = [h for h in fresh if pid_of(h) == explorer_pid]
    for h in fresh:
        u.PostMessageW(h, 0x0010, 0, 0)
    _send_escape()
    return bool(theirs)


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)

    desktop = "--desktop" in args
    args = [a for a in args if a != "--desktop"]

    progman, dv, lv = find_listview()
    print("Progman=%s  DefView=%s  ListView=%s  listview_rect=%s"
          % (progman, dv, lv, rect(lv) if lv else None))
    if not lv:
        raise SystemExit("找不到 SysListView32 —— 桌面图标层不在这里")
    print("图标数 = %s  选中数 = %s"
          % (send_msg_timeout(lv, 0x1004), selected_count(lv)))  # LVM_GETITEMCOUNT

    if args[0] == "probe":
        return

    if args[0] == "rclick":
        cmd_rclick(int(args[1]), int(args[2]), desktop)
        return

    if args[0] == "both":
        cmd_both(int(args[1]), int(args[2]), desktop)
        return

    if args[0] == "click":
        x, y = int(args[1]), int(args[2])
        if desktop:
            show_desktop()
        before = selected_count(lv)
        before_items = selected_items(lv)
        c, p, rc = probe_chain(x, y)
        print("点击前: 选中数=%s 选中项=%s | WindowFromPoint=%s pid=%d RealChild=%s"
              % (before, before_items, c, p, rc))
        inject_click(x, y)
        after = selected_count(lv)
        after_items = selected_items(lv)
        print("点击后: 选中数=%s 选中项=%s" % (after, after_items))
        if after is None or before is None:
            print("判定: 无法读取（SendMessageTimeout 失败）")
        elif after > 0:
            print("判定: OK —— 桌面图标**能被选中**（选中数 %s）" % after)
        else:
            print("判定: 未选中（该点可能不是图标，或桌面输入被截走）")
        return

    raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
