# Create Windows Scheduled Task for Anamnesis ingestion (every 15 minutes)
# Run as Administrator: powershell -ExecutionPolicy Bypass -File scripts/setup-scheduled-task.ps1

$action = New-ScheduledTaskAction `
    -Execute "node" `
    -Argument "D:\Projects\Anamnesis\dist\index.js ingest-all" `
    -WorkingDirectory "D:\Projects\Anamnesis"

$trigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 15) `
    -RepetitionDuration ([timespan]::MaxValue)

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask `
    -TaskName "Anamnesis Ingest" `
    -Description "Ingest new Claude Code transcripts into Anamnesis every 15 minutes" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -User $env:USERNAME `
    -RunLevel Highest `
    -Force

Write-Host "Scheduled task 'Anamnesis Ingest' created successfully."
Write-Host "It will run every 15 minutes to discover and ingest new transcripts."
