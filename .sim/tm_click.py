# 点击 TauriTavern 窗口内指定位置 (参数用 1080 宽截图坐标系, 运行时换算)
import ctypes
import ctypes.wintypes as wt
import sys
import time

user32 = ctypes.windll.user32

def find_hwnd():
    hwnd = user32.FindWindowW(None, "TauriTavern")
    if hwnd:
        return hwnd
    import subprocess
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq tauritavern.exe", "/FO", "CSV"],
                         capture_output=True).stdout.decode("gbk", errors="ignore")
    pids = [int(l.split('","')[1]) for l in out.splitlines() if l.startswith('"tauritavern')]
    found = []
    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def cb(h, l):
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(h, ctypes.byref(pid))
        if pid.value in pids and user32.IsWindowVisible(h):
            found.append(h)
        return True
    user32.EnumWindows(cb, 0)
    return found[0] if found else None

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    user32.SetProcessDPIAware()

IMG_W = 1080.0
ix, iy = float(sys.argv[1]), float(sys.argv[2])
hwnd = find_hwnd()
rc = wt.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(rc))
scale = (rc.right - rc.left) / IMG_W
ax = int(rc.left + ix * scale)
ay = int(rc.top + iy * scale)
user32.SetForegroundWindow(hwnd)
time.sleep(0.3)
user32.SetCursorPos(ax, ay)
time.sleep(0.15)
user32.mouse_event(2, 0, 0, 0, 0)   # LEFTDOWN
time.sleep(0.05)
user32.mouse_event(4, 0, 0, 0, 0)   # LEFTUP
print(f"clicked img({ix},{iy}) -> abs({ax},{ay})")
