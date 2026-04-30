$ErrorActionPreference = "Continue"

Write-Host "Checking port 3000..."
$lines = netstat -ano | Select-String ":3000"
if (-not $lines) {
  Write-Host "no_listeners_3000"
  exit 0
}

$pids =
  $lines |
  ForEach-Object { ($_ -replace "\s+", " ").Trim() } |
  ForEach-Object { ($_ -split " ")[-1] } |
  Sort-Object -Unique

foreach ($procId in $pids) {
  if ($procId -match "^[0-9]+$") {
    Write-Host "killing_pid $procId"
    taskkill /PID $procId /F | Out-Null
  }
}

