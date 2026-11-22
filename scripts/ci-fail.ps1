# PowerShell twin of ci-fail.sh for the Windows runner.
param(
  [string]$LogFile = "build.log",
  [string]$Label = "build"
)
if (Test-Path $LogFile) {
  $tail = Get-Content $LogFile -Tail 120
  foreach ($line in $tail) {
    $escaped = ($line -replace '%', '%25') -replace "`r", ''
    Write-Output "::error title=$Label::$escaped"
  }
  if ($env:GITHUB_STEP_SUMMARY) {
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "### $Label failed`n``````"
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value ($tail -join "`n")
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "``````"
  }
  New-Item -ItemType Directory -Force -Path ci-logs | Out-Null
  Copy-Item $LogFile "ci-logs/$Label.log" -Force
  git config user.name "sentinel-ci"
  git config user.email "ci@sentinel.invalid"
  git add -f ci-logs
  git commit -qm "ci: $Label failure log"
  git push -q --force origin "HEAD:refs/heads/ci-logs"
} else {
  Write-Output "::error title=$Label::no log produced"
}
exit 1
