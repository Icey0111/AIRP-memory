' 一次性 E2E 启动: 带 WebView2 CDP 调试口启动酒馆 (测试用, 测完删除)
Set sh = CreateObject("WScript.Shell")
sh.Environment("PROCESS")("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") = "--remote-debugging-port=9222"
sh.CurrentDirectory = "E:\TauriTavern"
sh.Run """E:\TauriTavern\tauritavern.exe""", 1, False
