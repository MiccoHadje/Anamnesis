# Create Windows Scheduled Task for Anamnesis ingestion (every 15 minutes)
# Run as Administrator: powershell -ExecutionPolicy Bypass -File scripts/setup-scheduled-task.ps1

$ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path

# Delete existing task if present
schtasks /Delete /TN "Anamnesis Ingest" /F 2>$null

# Create with 15-minute repetition
schtasks /Create `
    /TN "Anamnesis Ingest" `
    /TR "wscript.exe `"$ProjectRoot\scripts\silent-ingest.vbs`"" `
    /SC MINUTE /MO 15 `
    /SD (Get-Date -Format "MM/dd/yyyy") `
    /ST "00:00" `
    /RL LIMITED `
    /F

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Scheduled task 'Anamnesis Ingest' created successfully." -ForegroundColor Green
    Write-Host "Project root: $ProjectRoot"
    Write-Host "Runs every 15 minutes to discover and ingest new transcripts."
    Write-Host ""
    schtasks /Query /TN "Anamnesis Ingest" /V /FO LIST | Select-String "Task Name|Status|Schedule|Next Run|Repeat"
} else {
    Write-Host "Failed to create scheduled task." -ForegroundColor Red
}
