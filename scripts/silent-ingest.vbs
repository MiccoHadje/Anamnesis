Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "node D:\Projects\Anamnesis\dist\index.js ingest-all", 0, True
Set WshShell = Nothing
