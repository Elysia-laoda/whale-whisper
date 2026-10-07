' Launch the ZCode supplement-widget overlay (no console window).
' Double-click this file to start; see enable-autostart.vbs for autostart.
Option Explicit

Dim fso, sh, scriptDir, cand, py, i, envPy, base
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' 0) Explicit override via environment variable (optional)
py = ""
On Error Resume Next
envPy = sh.Environment("PROCESS")("SUPPLEMENT_WIDGET_PYTHON")
On Error GoTo 0
If Len(envPy) > 0 Then
  If fso.FileExists(envPy) Then py = envPy
End If

' 1) pythoncore-style installs (python.org per-user 3.14 layout)
If py = "" Then
  base = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Python"
  If fso.FolderExists(base) Then
    Dim sub_f, subs
    Set subs = fso.GetFolder(base).SubFolders
    Dim best
    best = ""
    For Each sub_f In subs
      If fso.FileExists(sub_f.Path & "\pythonw.exe") Then
        best = sub_f.Path & "\pythonw.exe"
        If InStr(LCase(sub_f.Name), "pythoncore") > 0 Then Exit For
      End If
    Next
    py = best
  End If
End If

' 2) Common pythonw candidates
If py = "" Then
  cand = Array( _
    sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Python\Python314\pythonw.exe", _
    sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Python\Python313\pythonw.exe", _
    "C:\Program Files\Python314\pythonw.exe", _
    "C:\Program Files\Python313\pythonw.exe" _
  )
  For i = 0 To UBound(cand)
    If fso.FileExists(cand(i)) Then
      py = cand(i)
      Exit For
    End If
  Next
End If

' 3) Fall back to pythonw on PATH (WScript.Shell.Run resolves PATH)
If py = "" Then py = "pythonw.exe"

sh.CurrentDirectory = scriptDir
On Error Resume Next
sh.Run """" & py & """ """ & scriptDir & "\overlay.py""", 0, False
If Err.Number <> 0 Then
  On Error GoTo 0
  MsgBox "Python not found. The widget needs PySide6." & vbCrLf & vbCrLf & _
         "Install it first:  pip install PySide6" & vbCrLf & _
         "Or set SUPPLEMENT_WIDGET_PYTHON to the full pythonw.exe path.", 48, "ZCode supplement-widget"
  WScript.Quit 1
End If
