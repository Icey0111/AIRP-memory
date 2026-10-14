# 截取 TauriTavern 窗口 -> PNG (PrintWindow + PIL)
import ctypes
import ctypes.wintypes as wt
import sys

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

def find_hwnd():
    import subprocess
    hwnd = user32.FindWindowW(None, "TauriTavern")
    if hwnd:
        return hwnd
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq tauritavern.exe", "/FO", "CSV"],
                         capture_output=True).stdout.decode("gbk", errors="ignore")
    pids = [int(l.split('","')[1]) for l in out.splitlines() if l.startswith('"tauritavern')]
    if not pids:
        raise SystemExit("tauritavern 未运行")
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

hwnd = find_hwnd()
if not hwnd:
    raise SystemExit("没有可见窗口")

# DPI 感知, 否则截不全
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    user32.SetProcessDPIAware()

rc = wt.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(rc))
w, h = rc.right - rc.left, rc.bottom - rc.top
print(f"窗口 {rc.left},{rc.top} {w}x{h} 可见={user32.IsWindowVisible(hwnd)} 最小化={user32.IsIconic(hwnd)}")

if user32.IsIconic(hwnd):
    user32.ShowWindow(hwnd, 9)
    import time; time.sleep(1)

hdc = user32.GetWindowDC(hwnd)
mem = gdi32.CreateCompatibleDC(hdc)
bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
gdi32.SelectObject(mem, bmp)
# PW_RENDERFULLCONTENT = 2 (Win8.1+, 能抓 DWM 合成内容/部分硬件加速窗口)
ok = user32.PrintWindow(hwnd, mem, 2)

class BMPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
                ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
                ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
                ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int32),
                ("biYPelsPerMeter", ctypes.c_int32), ("biClrUsed", ctypes.c_uint32),
                ("biClrImportant", ctypes.c_uint32)]

bi = BMPINFOHEADER(ctypes.sizeof(BMPINFOHEADER), w, -h, 1, 32, 0, 0, 0, 0, 0, 0)
buf = ctypes.create_string_buffer(w * h * 4)
gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), 0)

from PIL import Image
img = Image.frombuffer("RGBA", (w, h), buf.raw, "raw", "BGRA", 0, 1)
out = r"E:\记忆系统\.sim\tavern_window.png"
img.convert("RGB").save(out)
print(f"PrintWindow ok={ok} 已保存 {out}")
