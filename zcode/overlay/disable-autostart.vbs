' Disable autostart: remove the proxy script from the user's Startup folder.
Option Explicit

Dim fso, sh, startupDir, proxy
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

startupDir = sh.SpecialFolders("Startup")
proxy = startupDir & "\zc-supplement-widget-overlay.vbs"

If fso.FileExists(proxy) Then
  fso.DeleteFile proxy, True
  MsgBox "Autostart disabled.", 64, "ZCode supplement-widget"
Else
  MsgBox "Autostart is not enabled (no proxy script found).", 48, "ZCode supplement-widget"
End If
