$ErrorActionPreference = "Stop"

$paths = @(
  "dist/ui/index.html",
  "src/ui/index.html"
)

foreach ($p in $paths) {
  if (-not (Test-Path $p)) {
    Write-Host "$p missing"
    continue
  }

  $content = Get-Content -Raw -Encoding UTF8 $p
  $end = $content.IndexOf("</html>", [StringComparison]::OrdinalIgnoreCase)
  if ($end -lt 0) {
    Write-Host "$p no_closing_html"
    continue
  }

  $out = $content.Substring(0, $end + 7).TrimEnd() + "`n"

  Set-Content -NoNewline -Encoding UTF8 -Path $p -Value $out
  $bytes = [Text.Encoding]::UTF8.GetByteCount($out)
  Write-Host "$p trimmed_bytes $bytes"
}

