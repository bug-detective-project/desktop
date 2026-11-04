# Asks every top-level window whose title contains -Match to close (WM_CLOSE, as the X button does:
# VS Code still asks about unsaved files). Prints how many it asked.
param([string]$Match)
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class Windows { public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
[DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
public static int Close(string match) { int count = 0; EnumWindows((hwnd, lParam) => { var title = new StringBuilder(512); GetWindowText(hwnd, title, 512); if (title.ToString().Contains(match)) { PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); count++; } return true; }, IntPtr.Zero); return count; } }
"@
[Windows]::Close($Match)
