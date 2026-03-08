Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)
WshShell.Run "node """ & projectDir & "\dist\index.js"" ingest-all", 0, True
Set fso = Nothing
Set WshShell = Nothing
