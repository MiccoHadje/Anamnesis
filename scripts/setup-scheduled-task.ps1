# Create Windows Scheduled Task for Anamnesis ingestion (every 15 minutes)
# Run as Administrator: powershell -ExecutionPolicy Bypass -File D:\Projects\Anamnesis\scripts\setup-scheduled-task.ps1

# Delete existing task if present
schtasks /Delete /TN "Anamnesis Ingest" /F 2>$null

# Create with 15-minute repetition using schtasks (bypasses PowerShell cmdlet quirks)
schtasks /Create `
    /TN "Anamnesis Ingest" `
    /TR "node D:\Projects\Anamnesis\dist\index.js ingest-all" `
    /SC MINUTE /MO 15 `
    /SD (Get-Date -Format "MM/dd/yyyy") `
    /ST "00:00" `
    /RL LIMITED `
    /F

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Scheduled task 'Anamnesis Ingest' created successfully." -ForegroundColor Green
    Write-Host "Runs every 15 minutes to discover and ingest new transcripts."
    Write-Host ""
    schtasks /Query /TN "Anamnesis Ingest" /V /FO LIST | Select-String "Task Name|Status|Schedule|Next Run|Repeat"
} else {
    Write-Host "Failed to create scheduled task." -ForegroundColor Red
}
