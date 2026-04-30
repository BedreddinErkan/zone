$ErrorActionPreference = "Stop"

$resp = Invoke-WebRequest -UseBasicParsing "http://localhost:3000/"
$body = [string]$resp.Content
$bytes = [Text.Encoding]::UTF8.GetByteCount($body)

Set-Content -Encoding UTF8 -NoNewline -Path "debug-served.html" -Value $body

Write-Host "bytes $bytes"
Write-Host ("has_ibmplex " + ($body -like "*IBM Plex Sans*"))
Write-Host ("has_setRoleSilently " + ($body -like "*setRoleSilently*"))
Write-Host ("has_NewThread_exact " + ($body -clike "*New Thread*"))

$m = Select-String -Path "debug-served.html" -Pattern "New Thread" -SimpleMatch | Select-Object -First 5
if ($m) {
  Write-Host "NewThread_matches:"
  $m | ForEach-Object { Write-Host ("  line " + $_.LineNumber + ": " + $_.Line.Trim()) }
}

