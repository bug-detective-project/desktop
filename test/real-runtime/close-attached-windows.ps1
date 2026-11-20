# Asks every top-level window whose title contains -Match to close (WM_CLOSE, as the X button does:
# VS Code still asks about unsaved files), and asks again until none is left or -Seconds pass: a
# window whose container went away shows a "connection lost" dialog and may not close at the first
# ask. Prints "<asked> <left>": how many it asked, and how many were still open at the end.
param([string]$Match, [int]$Seconds = 15)
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class Windows { public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
[DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
public static List<IntPtr> Find(string match) { var found = new List<IntPtr>(); EnumWindows((hwnd, lParam) => { var title = new StringBuilder(512); GetWindowText(hwnd, title, 512); if (IsWindowVisible(hwnd) && title.ToString().Contains(match)) { found.Add(hwnd); } return true; }, IntPtr.Zero); return found; }
public static void Close(IntPtr hwnd) { PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); } }
"@
$asked = [Windows]::Find($Match).Count
$deadline = (Get-Date).AddSeconds($Seconds)
do {
  $open = [Windows]::Find($Match)
  foreach ($hwnd in $open) { [Windows]::Close($hwnd) }
  if ($open.Count -eq 0) { break }
  Start-Sleep -Milliseconds 1000
} while ((Get-Date) -lt $deadline)
"$asked $([Windows]::Find($Match).Count)"
