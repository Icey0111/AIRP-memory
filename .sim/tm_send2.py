# 发送文本 + Ctrl+Enter (send_on_enter 关闭时的提交方式)
import ctypes
import ctypes.wintypes as wt
import time

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD),
                ("dwFlags", wt.DWORD), ("time", wt.DWORD),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wt.DWORD), ("wParamL", wt.WORD), ("wParamH", wt.WORD)]

class IU(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]

class INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("union", IU)]

INPUT_KEYBOARD = 1
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_KEYUP = 0x0002
VK_RETURN, VK_CONTROL = 0x0D, 0x11

def key(vk, scan, flags):
    i = INPUT(); i.type = INPUT_KEYBOARD
    i.union.ki = KEYBDINPUT(vk, scan, flags, 0, None)
    return i

def send_text(text):
    seq = []
    for ch in text:
        seq += [key(0, ord(ch), KEYEVENTF_UNICODE), key(0, ord(ch), KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]
    user32.SendInput(len(seq), (INPUT * len(seq))(*seq), ctypes.sizeof(INPUT))

def send_ctrl_enter():
    seq = [key(VK_CONTROL, 0, 0), key(VK_RETURN, 0, 0),
           key(VK_RETURN, 0, KEYEVENTF_KEYUP), key(VK_CONTROL, 0, KEYEVENTF_KEYUP)]
    user32.SendInput(len(seq), (INPUT * len(seq))(*seq), ctypes.sizeof(INPUT))

def find_hwnd():
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
    return found[0]

hwnd = find_hwnd()
user32.SetForegroundWindow(hwnd)
time.sleep(0.6)
# 输入框可能还留着上次没发出去的 "continue", 先全选清掉再输
send_text("")
user32.keybd_event(0x11, 0, 0, 0); user32.keybd_event(0x41, 0, 0, 0); user32.keybd_event(0x41, 0, 2, 0); user32.keybd_event(0x11, 0, 2, 0)  # Ctrl+A
time.sleep(0.1)
user32.keybd_event(0x2E, 0, 0, 0); user32.keybd_event(0x2E, 0, 2, 0)  # Del
time.sleep(0.2)
send_text("continue")
time.sleep(0.2)
send_ctrl_enter()
print("OK 已发送 continue + Ctrl+Enter")
