' Enable autostart: drop a proxy script into the user's Startup folder.
Option Explicit

Dim fso, sh, scriptDir, startupDir, proxy, f
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

startupDir = sh.SpecialFolders("Startup")
proxy = startupDir & "\zc-supplement-widget-overlay.vbs"

Set f = fso.CreateTextFile(proxy, True, False)  ' ASCII: proxy content is ASCII-only
f.WriteLine "' Autostart proxy for the ZCode supplement-widget overlay."
f.WriteLine "' Disable autostart by deleting this file (or run disable-autostart.vbs)."
f.WriteLine "Option Explicit"
f.WriteLine "CreateObject(""WScript.Shell"").Run Chr(34) & """ & scriptDir & "\start-overlay.vbs" & """ & Chr(34), 0, False"
f.Close

MsgBox "Autostart enabled." & vbCrLf & vbCrLf & _
       "Proxy script: " & proxy & vbCrLf & _
       "(To disable, double-click disable-autostart.vbs in the same folder.)", 64, "ZCode supplement-widget"
