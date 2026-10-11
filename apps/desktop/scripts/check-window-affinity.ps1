param(
  [Parameter(Mandatory = $true)]
  [string]$Hwnd
)

$hexHandle = $Hwnd -replace '^0x', ''
$handleValue = [Convert]::ToInt64($hexHandle, 16)

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class WindowDisplayAffinityProbe {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint affinity);
}
'@

$affinity = [uint32]0
$success = [WindowDisplayAffinityProbe]::GetWindowDisplayAffinity(
  [IntPtr]::new($handleValue),
  [ref]$affinity
)
$errorCode = if ($success) { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
$name = switch ($affinity) {
  0x00 { 'WDA_NONE' }
  0x01 { 'WDA_MONITOR (capture may show black)' }
  0x11 { 'WDA_EXCLUDEFROMCAPTURE' }
  default { 'UNKNOWN' }
}

[pscustomobject]@{
  Hwnd = ('0x{0:X}' -f $handleValue)
  Success = $success
  Affinity = ('0x{0:X2}' -f $affinity)
  Name = $name
  Win32Error = $errorCode
}
