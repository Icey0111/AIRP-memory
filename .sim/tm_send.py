# 往 TauriTavern 窗口注入键盘输入: SetForegroundWindow + SendInput (UNICODE 字符 + 回车)
# 用法: python tm_send.py <文本>
import ctypes
import ctypes.wintypes as wt
import sys
import time

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# INPUT / KEYBDINPUT 结构 (UNICODE 输入)
class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD),
                ("dwFlags", wt.DWORD), ("time", wt.DWORD),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wt.DWORD), ("wParamL", wt.WORD), ("wParamH", wt.WORD)]

class INPUTunion(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]

class INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("union", INPUTunion)]

INPUT_KEYBOARD = 1
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_KEYUP = 0x0002
VK_RETURN = 0x0D

def send_char(ch):
    def key(scan, flags):
        i = INPUT()
        i.type = INPUT_KEYBOARD
        i.union.ki = KEYBDINPUT(0, scan, flags, 0, None)
        return i
    seq = [key(ord(ch), KEYEVENTF_UNICODE), key(ord(ch), KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]
    sent = user32.SendInput(len(seq), (INPUT * len(seq))(*seq), ctypes.sizeof(INPUT))
    if sent != len(seq):
        raise OSError("SendInput 被拒绝 (UIPI?)")

def send_enter():
    seq = []
    for flags in (0, KEYEVENTF_KEYUP):
        i = INPUT()
        i.type = INPUT_KEYBOARD
        i.union.ki = KEYBDINPUT(VK_RETURN, 0, flags, 0, None)
        seq.append(i)
    user32.SendInput(len(seq), (INPUT * len(seq))(*seq), ctypes.sizeof(INPUT))

def find_window():
    # 先按标题精确找, 找不到再枚举 tauritavern 进程的主窗口
    hwnd = user32.FindWindowW(None, "TauriTavern")
    if hwnd:
        return hwnd
    # 枚举: 按 pid 找
    import subprocess
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq tauritavern.exe", "/FO", "CSV"],
                         capture_output=True).stdout.decode("gbk", errors="ignore")
    pids = []
    for line in out.splitlines():
        if line.startswith('"tauritavern'):
            pids.append(int(line.split('","')[1]))
    if not pids:
        raise SystemExit("tauritavern 进程不存在")
    found = []
    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def cb(h, l):
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(h, ctypes.byref(pid))
        if pid.value in pids and user32.IsWindowVisible(h):
            found.append(h)
        return True
    user32.EnumWindows(cb, 0)
    if not found:
        raise SystemExit("没找到可见的 TauriTavern 窗口")
    return found[0]

def main():
    text = sys.argv[1] if len(sys.argv) > 1 else "continue"
    hwnd = find_window()
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    if not user32.SetForegroundWindow(hwnd):
        # 前台锁: 借 AttachThreadInput 绕
        cur = kernel32.GetCurrentThreadId()
        target = user32.GetWindowThreadProcessId(hwnd, None)
        user32.AttachThreadInput(cur, target, True)
        user32.SetForegroundWindow(hwnd)
        user32.AttachThreadInput(cur, target, False)
    time.sleep(0.6)
    fg = user32.GetForegroundWindow()
    if fg != hwnd:
        raise SystemExit("没能把 TauriTavern 调到前台 (fg=%s)" % fg)
    for ch in text:
        send_char(ch)
        time.sleep(0.01)
    time.sleep(0.15)
    send_enter()
    print(f"OK 已发送: {text!r}")

if __name__ == "__main__":
    main()
