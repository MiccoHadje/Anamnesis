Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Only run between 1:00 AM and 6:45 AM (covers overnight + morning catch-up)
' If the machine slept through the night, it catches up on wake.
' Last run should finish well before daytime heat hours.
Dim currentHour, currentMinute
currentHour = Hour(Now)
currentMinute = Minute(Now)
If currentHour < 1 Or currentHour > 6 Or (currentHour = 6 And currentMinute > 45) Then
    WScript.Quit 0
End If

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)
WshShell.Run "node """ & projectDir & "\dist\index.js"" ingest-all", 0, True
Set fso = Nothing
Set WshShell = Nothing
