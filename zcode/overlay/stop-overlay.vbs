' Stop a running ZCode supplement-widget overlay.
' Runs overlay.py --stop with the same interpreter search as start-overlay.vbs.
Option Explicit

Dim fso, sh, scriptDir, cand, py, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

py = ""
cand = Array( _
  sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Python\Python314\python.exe", _
  sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Python\Python313\python.exe", _
  "C:\Program Files\Python314\python.exe", _
  "C:\Program Files\Python313\python.exe" _
)
For i = 0 To UBound(cand)
  If fso.FileExists(cand(i)) Then
    py = cand(i)
    Exit For
  End If
Next
If py = "" Then py = "python.exe"

sh.CurrentDirectory = scriptDir
sh.Run """" & py & """ """ & scriptDir & "\overlay.py"" --stop", 0, False
