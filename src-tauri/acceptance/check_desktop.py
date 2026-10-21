"""桌面验收助手：检查桌面层序、命中测试、动画差分和退出后的桌面恢复状态。

子命令：
  verify --artifacts DIR   完整验收：层序 + 命中双视角（含"抬到最上"对照）+ 动画差分 -> PASS/FAIL
  status                   只做层序 + 命中双视角（不改变窗口层序之外的状态）
  close                    壁纸会话收尾：WM_CLOSE 壁纸窗口（还原桌面）+ 结束本应用进程
                           （新退出模型下主窗口 X = 隐藏，WM_CLOSE 不再能退出应用）
  wait-restore             等待桌面还原（Progman children == 2 且无 Tauri 窗口），超时返回 1
"""
import argparse
import ctypes
import ctypes.wintypes as wt
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify_shot  # 复用其 GDI 截屏 capture()（同目录副本）

u = ctypes.windll.user32
try:
    u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    pass

u.FindWindowW.restype = wt.HWND
u.FindWindowW.argtypes = [wt.LPCWSTR, wt.LPCWSTR]
u.FindWindowExW.restype = wt.HWND
u.FindWindowExW.argtypes = [wt.HWND, wt.HWND, wt.LPCWSTR, wt.LPCWSTR]
u.GetWindow.restype = wt.HWND
u.GetWindow.argtypes = [wt.HWND, wt.UINT]
u.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
u.EnumWindows.argtypes = [ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM), wt.LPARAM]
u.EnumChildWindows.argtypes = [wt.HWND, ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM), wt.LPARAM]
u.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
u.ChildWindowFromPointEx.restype = wt.HWND
u.ChildWindowFromPointEx.argtypes = [wt.HWND, wt.POINT, wt.UINT]
u.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
                           ctypes.c_int, ctypes.c_int, wt.UINT]
u.ScreenToClient.argtypes = [wt.HWND, ctypes.POINTER(wt.POINT)]
u.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
u.PostMessageW.argtypes = [wt.HWND, wt.UINT, ctypes.c_ulonglong, ctypes.c_longlong]
u.GetParent.restype = wt.HWND
u.GetParent.argtypes = [wt.HWND]

GW_CHILD, GW_HWNDNEXT = 5, 2
CWP_BASE = 0x0001 | 0x0002
CWP_SKIPTRANSPARENT = 0x0004
SWP_NOSIZE_MOVE_NOACT = 0x0002 | 0x0001 | 0x0010
OURS_CLASS = "Tauri Window"
WM_CLOSE = 0x0010
CB = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def cls(h):
    if not h:
        return "(null)"
    b = ctypes.create_unicode_buffer(128)
    u.GetClassNameW(h, b, 128)
    return b.value


def find_state():
    """返回 (progman, defview, ours, children[列表])。ours = Progman 下第一个类名 Tauri Window 的子窗口。"""
    progman = u.FindWindowW("Progman", None)
    children = []
    if not progman:
        return None, None, None, children
    c = u.GetWindow(progman, GW_CHILD)
    while c:
        children.append(c)
        c = u.GetWindow(c, GW_HWNDNEXT)
    defview = next((h for h in children if cls(h) == "SHELLDLL_DefView"), None)
    ours = next((h for h in children if cls(h) == OURS_CLASS), None)
    return progman, defview, ours, children


def layer_report():
    progman, defview, ours, children = find_state()
    names = [cls(h) for h in children]
    print("Progman 子窗口(z 0 最上): %s" % names)
    ok = False
    if progman and defview and ours:
        ok = names.index(OURS_CLASS) > names.index("SHELLDLL_DefView")
    print("层序(壁纸在 DefView 之后): %s" % ("PASS" if ok else "FAIL"))
    return ok, progman, defview, ours


def hit_sample(progman, defview, point_screen):
    cli = wt.POINT(point_screen[0], point_screen[1])
    u.ScreenToClient(progman, ctypes.byref(cli))
    raw = u.ChildWindowFromPointEx(progman, cli, CWP_BASE)
    skip = u.ChildWindowFromPointEx(progman, cli, CWP_BASE | CWP_SKIPTRANSPARENT)
    return raw, skip


def cmd_status(raise_test):
    ok, progman, defview, ours = layer_report()
    if not (progman and defview and ours):
        print("命中测试: SKIP（找不到目标窗口）")
        return 0 if ok else 1
    r = wt.RECT()
    u.GetWindowRect(defview, ctypes.byref(r))
    pt = (r.left + 150, r.top + 150)

    raw, skip = hit_sample(progman, defview, pt)
    base_ok = (raw == defview and skip == defview)
    print("命中(正常位置): 不跳透明->%s | 跳透明->%s  => %s"
          % (cls(raw), cls(skip), "PASS" if base_ok else "FAIL"))
    result = ok and base_ok

    if raise_test:
        # 注意：壁纸层自带的 700ms ensure 看门狗会把窗口自动拉回 DefView 之后——抬升后必须
        # **立即采样**（不给 tick 插入的机会），且快速重试几次以防刚好撞上 tick（实测踩过）。
        raised_ok = False
        last = (None, None)
        for _ in range(6):
            u.SetWindowPos(ours, 0, 0, 0, 0, 0, SWP_NOSIZE_MOVE_NOACT)  # HWND_TOP
            raw, skip = hit_sample(progman, defview, pt)
            last = (raw, skip)
            if raw == ours:
                raised_ok = (skip == defview)
                break
            time.sleep(0.05)
        print("命中(人为抬到最上): 不跳透明->%s | 跳透明->%s  => %s"
              % (cls(last[0]), cls(last[1]), "PASS" if raised_ok else "FAIL"))
        u.SetWindowPos(ours, defview, 0, 0, 0, 0, SWP_NOSIZE_MOVE_NOACT)  # 复位到 DefView 之后
        time.sleep(0.25)
        raw2, skip2 = hit_sample(progman, defview, pt)
        reset_ok = (skip2 == defview)
        print("复位后: 跳透明->%s  => %s" % (cls(skip2), "PASS" if reset_ok else "FAIL"))
        result = result and raised_ok and reset_ok

    return 0 if result else 1


def cmd_verify(artifacts):
    status_rc = cmd_status(raise_test=True)

    os.makedirs(artifacts, exist_ok=True)
    a = os.path.join(artifacts, "verify_a.png")
    b = os.path.join(artifacts, "verify_b.png")
    # 截图前先"显示桌面"露出壁纸——否则抓到的可能是盖满桌面的用户窗口，
    # 动画差分量的是别人的画面（实测踩过：0.02% 假 FAIL）。抓完立即还原。
    try:
        verify_shot.show_desktop()
        time.sleep(0.9)
        verify_shot.capture(a)
        time.sleep(1.6)
        verify_shot.capture(b)
    finally:
        try:
            verify_shot.show_desktop()
            time.sleep(0.4)
        except Exception:
            pass

    from PIL import Image, ImageChops
    dif = ImageChops.difference(Image.open(a).convert("RGB"), Image.open(b).convert("RGB")).convert("L")
    hist = dif.histogram()
    total = dif.width * dif.height
    pct = 100.0 * sum(hist[9:]) / total
    anim_ok = pct > 0.5
    print("动画差分: %.2f%% 像素变化（两帧 +1.6s）  => %s" % (pct, "PASS" if anim_ok else "FAIL"))
    print("截图: %s / %s" % (a, b))

    ok = (status_rc == 0) and anim_ok
    print("== 验收结果: %s ==" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_TERMINATE = 0x0001
k32 = ctypes.windll.kernel32
k32.OpenProcess.restype = wt.HANDLE
k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
k32.TerminateProcess.restype = wt.BOOL
k32.TerminateProcess.argtypes = [wt.HANDLE, wt.DWORD]
k32.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]

OUR_EXE = "lull.exe"


def pid_of(h):
    p = wt.DWORD()
    u.GetWindowThreadProcessId(h, ctypes.byref(p))
    return p.value


def proc_name(pid):
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return "?"
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(1024)
        if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value)
        return "?"
    finally:
        k32.CloseHandle(h)


def tauri_windows():
    """只匹配**本应用**的窗口："Tauri Window" 是所有 Tauri 应用的默认类名
    （本机实测撞到过 cc-switch 的隐藏窗口），必须再按进程映像名过滤。"""
    out = []

    def cb(h, l):
        if cls(h) == OURS_CLASS and proc_name(pid_of(h)).lower() == OUR_EXE:
            out.append(h)
        return True

    u.EnumWindows(CB(cb), 0)
    progman = u.FindWindowW("Progman", None)
    if progman:
        u.EnumChildWindows(progman, CB(cb), 0)
    return out


def cmd_close():
    """壁纸会话收尾（适配新退出模型：主窗口 X = 隐藏，WM_CLOSE 不再能结束应用）：
    ① WM_CLOSE 壁纸窗口 → 壁纸层随之还原；② 结束本应用进程（此时桌面已还原，强杀不影响桌面）。
    只针对「本 exe 的窗口/进程」，不误伤机器上其它 Tauri 应用。"""
    progman = u.FindWindowW("Progman", None)
    wins = tauri_windows()
    pids = sorted({pid_of(h) for h in wins})
    wallpaper_wins = [h for h in wins if progman and u.GetParent(h) == progman]
    for h in wallpaper_wins:
        u.PostMessageW(h, WM_CLOSE, 0, 0)
    if wallpaper_wins:
        time.sleep(1.0)  # 等壁纸窗口销毁、桌面还原
    killed = []
    for pid in pids:
        h = k32.OpenProcess(PROCESS_TERMINATE, False, pid)
        if h:
            if k32.TerminateProcess(h, 1):
                killed.append(pid)
            k32.CloseHandle(h)
    print("close：WM_CLOSE 壁纸窗口 %d 个；结束进程 %s" % (len(wallpaper_wins), killed))
    return 0


def cmd_wait_restore(timeout=15.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        progman, defview, ours, children = find_state()
        if progman and len(children) == 2 and not tauri_windows():
            print("桌面还原: PASS (Progman children = 2，无 Tauri 窗口)")
            return 0
        time.sleep(0.5)
    progman, defview, ours, children = find_state()
    print("桌面还原: FAIL/超时 (children=%d: %s；Tauri 窗口 %d 个)"
          % (len(children), [cls(h) for h in children], len(tauri_windows())))
    return 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["verify", "status", "close", "wait-restore"])
    ap.add_argument("--artifacts", default=os.path.join(os.environ.get("TEMP", "."), "lull"))
    args = ap.parse_args()
    if args.mode == "verify":
        sys.exit(cmd_verify(args.artifacts))
    elif args.mode == "status":
        sys.exit(cmd_status(False))
    elif args.mode == "close":
        sys.exit(cmd_close())
    else:
        sys.exit(cmd_wait_restore())
