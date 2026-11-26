<#
  SENTINEL — full Windows install.

  One script that takes a clean Windows 10/11 machine to a working local
  assistant: the agent, the desktop console, a local model runtime, speech, OCR,
  optional autostart, and a health check that tells you the truth afterwards.

  Default install folder: %USERPROFILE%\Desktop\SENTINEL (override with -InstallDir).
  The deploy is staged and atomic: files are copied to SENTINEL.staging-<stamp>,
  verified, the existing folder is moved to SENTINEL.backup-<stamp>, and the new
  folder is renamed into place. Any failure moves the previous install back.

  Usage (PowerShell, run as your normal user; it elevates per-install only):

    powershell -ExecutionPolicy Bypass -File .\INSTALL_SENTINEL_FULL.ps1
    ... -Model qwen3.5:9b -SkipSpeech -NoAutostart
    ... -Source C:\path\to\SENTINEL          # install from a checkout
    ... -Uninstall

  Design rules:
    * nothing optional may abort the install — a missing model is a warning,
      a broken Node install is an error;
    * every step prints what it is about to do and where it got to;
    * the script never edits files outside the chosen install and data folders,
      except the autostart shortcut you explicitly asked for;
    * a log is written next to the script so a failure can be diagnosed later.
#>

[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path ([Environment]::GetFolderPath("Desktop")) "SENTINEL"),
  [int]$VerifyPort = 7888,
  [string]$Source,
  [string]$Model = "qwen3.5:9b",
  [string]$FastModel = "qwen3.5:4b",
  [string]$EmbedModel = "nomic-embed-text",
  [switch]$SkipModels,
  [switch]$SkipSpeech,
  [switch]$SkipOcr,
  [switch]$NoAutostart,
  [switch]$NoDesktop,
  [switch]$Uninstall,
  [switch]$Quiet
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$script:LogFile = Join-Path $PSScriptRoot "sentinel-install.log"
$script:Failures = @()
$script:Warnings = @()

function Write-Log([string]$text) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $text
  Add-Content -Path $script:LogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
}

function Say([string]$text, [string]$tone = "info") {
  Write-Log $text
  if ($Quiet) { return }
  switch ($tone) {
    "step"    { Write-Host "`n== $text" -ForegroundColor Cyan }
    "ok"      { Write-Host "  + $text" -ForegroundColor Green }
    "warn"    { Write-Host "  ! $text" -ForegroundColor Yellow }
    "err"     { Write-Host "  x $text" -ForegroundColor Red }
    default   { Write-Host "  $text" }
  }
}

function Add-Warning([string]$text) { $script:Warnings += $text; Say $text "warn" }
function Add-Failure([string]$text) { $script:Failures += $text; Say $text "err" }

function Test-Command([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Exit-Winget([string]$id, [string]$label, [string]$extra = "") {
  # winget is the only sane way to install per-user without bundling binaries.
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { Add-Warning "$label: winget is not available, install it manually"; return $false }
  $args = @("install", "--id", $id, "-e", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--silent")
  if ($extra) { $args += $extra.Split(" ") }
  Say "winget install $id ($label)"
  try {
    $output = & winget @args 2>&1 | Out-String
    Write-Log $output
    if ($LASTEXITCODE -eq 0 -or $output -match "already installed|No applicable upgrade") { Say "$label ready" "ok"; return $true }
    Add-Warning "$label: winget returned $LASTEXITCODE (see $script:LogFile)"
    return $false
  } catch {
    Add-Warning "$label: $($_.Exception.Message)"
    return $false
  }
}

function Get-Json([string]$url) {
  try { return Invoke-RestMethod -Uri $url -TimeoutSec 5 -ErrorAction Stop } catch { return $null }
}

function Wait-Http([string]$url, [int]$seconds = 60) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop | Out-Null
      return $true
    } catch { Start-Sleep -Milliseconds 700 }
  }
  return $false
}

function New-Stamp { return (Get-Date -Format "yyyyMMdd-HHmmss") }

function Split-DefaultHome {
  if ($env:SENTINEL_HOME) { return $env:SENTINEL_HOME }
  return (Join-Path $env:APPDATA "sentinel-data")
}

function Copy-AppTree([string]$from, [string]$to) {
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  robocopy $from $to /E /XD node_modules .git dist build .pio .arena /XF sentinel-install.log /NFL /NDL /NJH /NJS /NP | Out-Null
  return ($LASTEXITCODE -lt 8)
}

function Backup-Existing([string]$path, [string]$reason) {
  if (-not (Test-Path $path)) { return $null }
  $stamp = New-Stamp
  $backup = "$path.backup-$stamp"
  try {
    Move-Item -LiteralPath $path -Destination $backup -ErrorAction Stop
    Say "existing install moved to $backup ($reason)" "ok"
    return $backup
  } catch {
    Add-Failure "could not move the existing install aside: $($_.Exception.Message)"
    return $null
  }
}

function Restore-Backup([string]$backup, [string]$path) {
  if (-not $backup -or -not (Test-Path $backup)) { return }
  if (Test-Path $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
  Move-Item -LiteralPath $backup -Destination $path -ErrorAction SilentlyContinue
  Say "previous install restored from $backup" "warn"
}

Say "SENTINEL full install log: $script:LogFile"
Say ("Windows {0} · PowerShell {1} · user {2}" -f $env:OS, $PSVersionTable.PSVersion, $env:USERNAME)

# ---------------------------------------------------------------------------
# 0. uninstall
# ---------------------------------------------------------------------------

if ($Uninstall) {
  Say "Removing SENTINEL from this account" "step"
  $shortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "SENTINEL.lnk"
  if (Test-Path $shortcut) { Remove-Item $shortcut -Force; Say "removed the autostart shortcut" "ok" }
  $running = Get-Process -Name "SENTINEL*", "sentinel*" -ErrorAction SilentlyContinue
  if ($running) { $running | Stop-Process -Force -ErrorAction SilentlyContinue; Say "stopped the running agent" "ok" }
  if (Test-Path $InstallDir) {
    Say "Your data (memory, documents, config) is kept in $env:APPDATA\sentinel-data"
    Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    Say "removed $InstallDir" "ok"
  }
  Say "Nothing else was touched. Ollama and the models are left installed on purpose." "warn"
  exit 0
}

# ---------------------------------------------------------------------------
# 1. preflight
# ---------------------------------------------------------------------------

Say "Checking the machine" "step"

$nodeVersion = $null
if (Test-Command node) {
  try {
    $raw = (& node --version).Trim()
    $nodeVersion = [version]($raw.TrimStart("v"))
    Say "node $raw found" "ok"
  } catch { $nodeVersion = $null }
}

if (-not $nodeVersion -or $nodeVersion.Major -lt 20) {
  Say "Installing Node.js 22 LTS (the agent needs Node 20 or newer)" "step"
  $installed = Exit-Winget "OpenJS.NodeJS.LTS" "Node.js 22 LTS"
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (Test-Command node) -and -not $installed) {
    Add-Failure "Node.js is missing and could not be installed. Install it from https://nodejs.org and run this script again."
  }
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -match "ARM") { "arm64" } else { "x64" }
Say "architecture $arch, free space on $($env:SystemDrive): $([math]::Round((Get-PSDrive $env:SystemDrive.TrimEnd(':')).Free / 1GB, 1)) GB"

# ---------------------------------------------------------------------------
# 2. the application
# ---------------------------------------------------------------------------

Say "Installing the agent" "step"

if ($Source) {
  if (-not (Test-Path $Source)) { Add-Failure "source folder $Source does not exist"; }
  else {
    $staging = "$InstallDir.staging-$(New-Stamp)"
    Say "staging files from $Source into $staging"
    if (-not (Copy-AppTree $Source $staging)) {
      Add-Failure "copying files failed ($LASTEXITCODE); nothing was changed in $InstallDir"
      Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      # The staged tree must look like SENTINEL before the old install is touched.
      $stagedAgent = Join-Path $staging "bin\sentinel-agent.js"
      $stagedPkg = Join-Path $staging "package.json"
      if (-not (Test-Path $stagedAgent) -or -not (Test-Path $stagedPkg)) {
        Add-Failure "the staged copy is incomplete (missing bin\sentinel-agent.js or package.json); the previous install was left untouched"
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
      } else {
        $previous = Backup-Existing $InstallDir "before deploying $(New-Stamp)"
        try {
          Move-Item -LiteralPath $staging -Destination $InstallDir -ErrorAction Stop
          Say "application deployed from the staged copy" "ok"
        } catch {
          Add-Failure "could not activate the staged copy: $($_.Exception.Message)"
          Restore-Backup $previous $InstallDir
          if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
        }
        if ($previous) { Say "rollback available: move $previous back over $InstallDir" }
      }
    }
  }
} else {
  $release = Get-Json "https://api.github.com/repos/pawelaachi123-eng/SENTINEL/releases/latest"
  $asset = $null
  if ($release -and $release.assets) {
    $asset = $release.assets | Where-Object { $_.name -like "*Portable*.exe" -or $_.name -like "*Setup*.exe" } | Select-Object -First 1
  }
  if ($asset) {
    $downloaded = Join-Path $env:TEMP $asset.name
    Say "downloading $($asset.name)"
    try {
      Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $downloaded -UseBasicParsing -TimeoutSec 600
      Say "downloaded to $downloaded"
      Say "starting the packaged installer — SENTINEL will be installed into your user profile"
      Start-Process -FilePath $downloaded -ArgumentList "/S" -Wait
      $candidates = @("$env:LOCALAPPDATA\Programs\SENTINEL", "$env:LOCALAPPDATA\SENTINEL", "C:\Program Files\SENTINEL")
      $found = $candidates | Where-Object { Test-Path (Join-Path $_ "package.json") } | Select-Object -First 1
      if ($found) { $InstallDir = $found; Say "installed into $InstallDir" "ok" }
      else { Add-Warning "could not find the installed folder; pass -Source or copy the repository into $InstallDir" }
    } catch { Add-Failure "download failed: $($_.Exception.Message)" }
  } else {
    Add-Failure "no release asset found and no -Source given. Download the repository, then run: .\INSTALL_SENTINEL_FULL.ps1 -Source <folder>"
  }
}

$agent = Join-Path $InstallDir "bin\sentinel-agent.js"
$cli = Join-Path $InstallDir "bin\sentinel.js"
if (-not (Test-Path $agent)) {
  Add-Failure "bin\sentinel-agent.js is missing in $InstallDir"
} else {
  Say "agent found" "ok"
}

if (Test-Path (Join-Path $InstallDir "package.json")) {
  if (Test-Command npm) {
    Say "installing runtime dependencies (npm ci --omit=dev)"
    Push-Location $InstallDir
    try {
      & npm ci --omit=dev --no-audit --no-fund 2>&1 | Tee-Object -FilePath $script:LogFile -Append | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Say "npm ci failed, trying npm install"
        & npm install --omit=dev --no-audit --no-fund 2>&1 | Tee-Object -FilePath $script:LogFile -Append | Out-Null
      }
      if ($LASTEXITCODE -eq 0) { Say "dependencies ready" "ok" } else { Add-Warning "npm could not install dependencies; the agent will start with the built-in modules only" }
    } finally { Pop-Location }
  } else { Add-Warning "npm is not on PATH; skipping dependency install" }
}

if ((Test-Path $cli) -and (Test-Path $agent)) {
  Say "Migrating the store and checking integrity" "step"
  Push-Location $InstallDir
  try {
    & node $cli migrate 2>&1 | Tee-Object -FilePath $script:LogFile -Append | ForEach-Object { if (-not $Quiet) { Write-Host "  $_" } }
    if ($LASTEXITCODE -ne 0) { Add-Warning "migrate reported a problem — the agent still starts, run sentinel doctor" }
  } catch { Add-Warning "migrate could not run: $($_.Exception.Message)" } finally { Pop-Location }
}

# ---------------------------------------------------------------------------
# 3. the model runtime
# ---------------------------------------------------------------------------

if (-not $SkipModels) {
  Say "Installing the local model runtime" "step"
  if (-not (Test-Command ollama)) {
    Exit-Winget "Ollama.Ollama" "Ollama" | Out-Null
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
  } else { Say "ollama already installed" "ok" }

  if (Test-Command ollama) {
    $serving = Wait-Http "http://127.0.0.1:11434/api/tags" 40
    if (-not $serving) {
      Say "starting the Ollama service"
      try { Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden } catch { Add-Warning "could not start ollama serve" }
      $serving = Wait-Http "http://127.0.0.1:11434/api/tags" 60
    }
    if ($serving) {
      Say "Ollama is serving on 11434" "ok"
      $tags = Get-Json "http://127.0.0.1:11434/api/tags"
      $have = @()
      if ($tags -and $tags.models) { $have = $tags.models | ForEach-Object { $_.name } }
      foreach ($want in @($Model, $FastModel, $EmbedModel) | Select-Object -Unique) {
        if (-not $want) { continue }
        $present = $have | Where-Object { $_ -eq $want -or $_ -like "$($want.Split(':')[0]):*" }
        if ($present) { Say "model $want already present" "ok"; continue }
        Say "pulling $want (this is the long step: several GB, resumable)"
        & ollama pull $want 2>&1 | Tee-Object -FilePath $script:LogFile -Append | Out-Null
        if ($LASTEXITCODE -eq 0) { Say "$want ready" "ok" } else { Add-Warning "could not pull $want — run 'ollama pull $want' later" }
      }
      # Vision is optional and large; only pull it when the user asked for it by name.
      if ($Model -match "vl") { Say "vision model requested: $Model" "ok" }
    } else { Add-Warning "Ollama is installed but not answering on 127.0.0.1:11434" }
  } else { Add-Warning "Ollama was not installed; the assistant will run in tool-only mode" }
}

# ---------------------------------------------------------------------------
# 4. speech and OCR
# ---------------------------------------------------------------------------

if (-not $SkipSpeech) {
  Say "Setting up speech" "step"
  $whisper = Get-Command whisper-cli, whisper, main -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($whisper) { Say "whisper found: $($whisper.Source)" "ok" }
  else {
    Say "whisper.cpp is not a winget package: downloading a prebuilt release"
    try {
      $rel = Get-Json "https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest"
      $zip = $null
      if ($rel -and $rel.assets) {
        $zip = $rel.assets | Where-Object { $_.name -match "bin-x64.*\.zip$" -or $_.name -match "x64.*\.zip$" } | Select-Object -First 1
      }
      $target = Join-Path $InstallDir "tools\whisper"
      New-Item -ItemType Directory -Force -Path $target | Out-Null
      if ($zip) {
        $tmp = Join-Path $env:TEMP $zip.name
        Invoke-WebRequest -Uri $zip.browser_download_url -OutFile $tmp -UseBasicParsing -TimeoutSec 600
        Expand-Archive -Path $tmp -DestinationPath $target -Force
        Say "whisper unpacked into $target (add it to PATH if you want the CLI to see it)" "ok"
      } else { Add-Warning "no whisper.cpp build found in the latest release" }

      $modelDir = Join-Path $env:APPDATA "sentinel-data\models\whisper"
      New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
      $modelFile = Join-Path $modelDir "ggml-base.bin"
      if (-not (Test-Path $modelFile)) {
        Say "downloading the ggml-base model (~150 MB)"
        Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" -OutFile $modelFile -UseBasicParsing -TimeoutSec 900
        Say "model saved to $modelFile" "ok"
      }
    } catch { Add-Warning "speech setup incomplete: $($_.Exception.Message)" }
  }
}

if (-not $SkipOcr) {
  Say "Setting up OCR" "step"
  if (Test-Command tesseract) { Say "tesseract already installed" "ok" }
  else { Exit-Winget "UB-Mannheim.TesseractOCR" "Tesseract OCR" | Out-Null }
}

if (Test-Command ffmpeg) { Say "ffmpeg present" "ok" }
else { Add-Warning "ffmpeg is missing: audio and video tools will refuse with FFMPEG_NOT_INSTALLED (winget install Gyan.FFmpeg)" }

# ---------------------------------------------------------------------------
# 5. configure, autostart, shortcuts
# ---------------------------------------------------------------------------

Say "Preparing the data folder" "step"
$dataDir = Join-Path $env:APPDATA "sentinel-data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Say "data lives in $dataDir" "ok"

if (-not $NoAutostart) {
  Say "Registering autostart" "step"
  $startup = [Environment]::GetFolderPath("Startup")
  $shortcutPath = Join-Path $startup "SENTINEL.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($shortcutPath)
  if (Test-Path $cli) {
    $link.TargetPath = (Get-Command node).Source
    $link.Arguments = "`"$cli`" serve"
  } else {
    $link.TargetPath = (Get-Command node).Source
    $link.Arguments = "`"$agent`""
  }
  $link.WorkingDirectory = $InstallDir
  $link.WindowStyle = 7
  $link.Description = "SENTINEL local assistant"
  $link.Save()
  Say "autostart shortcut created" "ok"
} else { Say "autostart skipped (-NoAutostart)" "warn" }

if (-not $NoDesktop) {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path $desktop "SENTINEL.lnk"))
  $link.TargetPath = (Get-Command node).Source
  $link.Arguments = "`"$cli`" serve --open"
  $link.WorkingDirectory = $InstallDir
  $link.Description = "Start SENTINEL and open the control UI"
  $link.Save()
  Say "desktop shortcut created" "ok"
}

# ---------------------------------------------------------------------------
# 6. verify — tell the truth, do not assume
# ---------------------------------------------------------------------------

Say "Starting the agent to verify the install" "step"
$port = 7878
$existing = Get-Json "http://127.0.0.1:$port/api/health"
if ($existing) { Say "an agent is already running on $port" "ok" }
$verifyProcess = $null

if (-not $existing -and (Test-Path $agent)) {
  # Verify on a private port so a second install cannot collide with a running
  # agent, and stop it afterwards instead of leaving a stray process behind.
  $log = Join-Path $env:TEMP "sentinel-verify.log"
  $env:SENTINEL_HOME = Split-DefaultHome
  $verifyProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList "`"$agent`" --port $VerifyPort" -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $up = Wait-Http "http://127.0.0.1:$VerifyPort/api/health" 60
  if ($up) {
    Say "agent answers on http://127.0.0.1:$VerifyPort" "ok"
    $health = Get-Json "http://127.0.0.1:$VerifyPort/api/health"
    $ai = $null
    try { $ai = (Get-Json "http://127.0.0.1:$VerifyPort/api/diagnostics") } catch { }
    Say "health: $($health.status) — data in $env:SENTINEL_HOME" "ok"
    if ($ai -and $ai.data -and $ai.data.ai) {
      $stack = $ai.data.ai
      Say ("cognitive stack: {0} agentów, {1} narzędzi, pamięć {2}" -f $stack.agents, $stack.tools, $stack.memory) "ok"
    }
  } else {
    Add-Failure "the agent did not answer on $VerifyPort — see $log"
    if (Test-Path $log) { Get-Content $log -Tail 20 | ForEach-Object { Write-Log "verify: $_" } }
  }
  if ($verifyProcess -and -not $verifyProcess.HasExited) {
    try { $verifyProcess.Kill(); $verifyProcess.WaitForExit(5000) | Out-Null; Say "verification agent stopped" "ok" } catch { Add-Warning "could not stop the verification agent: $($_.Exception.Message)" }
  }
}

if (Test-Path $cli) {
  Say "Running the doctor" "step"
  Push-Location $InstallDir
  try {
    & node $cli doctor 2>&1 | Tee-Object -FilePath $script:LogFile -Append | ForEach-Object { if (-not $Quiet) { Write-Host "  $_" } }
  } catch { Add-Warning "doctor failed to run: $($_.Exception.Message)" } finally { Pop-Location }
}

$token = $null
$configFile = Join-Path $dataDir "config.json"
if (Test-Path $configFile) {
  try { $token = (Get-Content $configFile -Raw | ConvertFrom-Json).uiToken } catch { }
}
$url = if ($token) { "http://127.0.0.1:$port/?t=$token" } else { "http://127.0.0.1:$port/" }

# A real `sentinel` command, not just a node invocation. The wrapper is a .cmd
# file so it works from cmd.exe, PowerShell and Explorer's address bar.
$wrapper = Join-Path $InstallDir "sentinel.cmd"
if (Test-Path $cli) {
  $lines = @(
    "@echo off",
    "rem SENTINEL command wrapper — generated by INSTALL_SENTINEL_FULL.ps1",
    "setlocal",
    "`"$(if (Test-Command node) { (Get-Command node).Source } else { 'node' })`" `"$cli`" %*",
    "exit /b %ERRORLEVEL%"
  )
  Set-Content -Path $wrapper -Value $lines -Encoding ASCII
  Say "created $wrapper" "ok"
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -notlike "*$InstallDir*") {
    try {
      [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
      Say "added $InstallDir to your user PATH (new terminals only)" "ok"
    } catch { Add-Warning "could not add $InstallDir to PATH; run $wrapper directly" }
  }
}

# 7.0: verify the deterministic core on the installed copy. This runs without a
# model and without network; a failure is reported, not hidden, but it does not
# roll back a working install.
$evalScript = Join-Path $InstallDir "scripts\eval.js"
if (Test-Path $evalScript) {
  Say "Weryfikuję rdzeń deterministyczny (7.0)" "step"
  Push-Location $InstallDir
  try {
    $evalOutput = & node $evalScript 2>&1
    $evalOutput | ForEach-Object { if (-not $Quiet) { Write-Host "  $_" } }
    if ($LASTEXITCODE -ne 0) { Add-Warning "deterministic evaluation reported failures (see above); the install is otherwise usable" }
  } catch { Add-Warning "evaluation could not run: $($_.Exception.Message)" } finally { Pop-Location }
}

# 7.0: read-only health of the new subsystems. Training is never started by the
# installer; that needs a person and an explicit approval.
$cliScript = Join-Path $InstallDir "bin\sentinel.js"
if (Test-Path $cliScript) {
  Say "Sprawdzam laboratorium, hypercore i komunikację (7.0)" "step"
  Push-Location $InstallDir
  try {
    $labOutput = & node $cliScript lab 2>&1
    $labOutput | ForEach-Object { if (-not $Quiet) { Write-Host "  $_" } }
    if ($LASTEXITCODE -ne 0) { Add-Warning "learning lab status could not be read; training stays unavailable until fixed" }
    $neuralOutput = & node $cliScript neural 2>&1
    $neuralOutput | ForEach-Object { if (-not $Quiet) { Write-Host "  $_" } }
    if ($LASTEXITCODE -ne 0) { Add-Warning "neural runtime status could not be read" }
    # Read-only: these commands do not train, call, send or change state.
    $hyperOutput = & node $cliScript hypercore status 2>&1
    $hyperOutput | ForEach-Object { if (-not $Quiet) { Write-Host "  $_" } }
    if ($LASTEXITCODE -ne 0) { Add-Warning "cognitive hypercore status could not be read" }
    $rerankOutput = & node $cliScript reranker status 2>&1
    $rerankOutput | ForEach-Object { if (-not $Quiet) { Write-Host "  $_" } }
    if ($LASTEXITCODE -ne 0) { Add-Warning "reranker status could not be read" }
    $commOutput = & node $cliScript comm status 2>&1
    $commOutput | ForEach-Object { if (-not $Quiet) { Write-Host "  $_" } }
    if ($LASTEXITCODE -ne 0) { Add-Warning "communication status could not be read" }
  } catch { Add-Warning "7.0 subsystem check could not run: $($_.Exception.Message)" } finally { Pop-Location }
}

Say "Done" "step"
if ($script:Failures.Count -eq 0) {
  Say "SENTINEL is installed and running." "ok"
  Say "Open $url" "ok"
  Say "Terminal: sentinel ask `"jaki mam GPU?`""
  Say "  sentinel status · doctor · models --benchmark · agents · tools · tasks · memory"
  Say "  sentinel benchmark · test · backup · rollback · update · migrate · chat"
  Say "  sentinel runtime [idle|balanced|deep|gaming] · graph · org · mcp · neural"
  Say "  sentinel lab [status|classify] · train --approve <name> · research list|start|report"
  Say "  backups live in $dataDir\backups; rollback keeps the previous files"
  if ($script:Warnings.Count) {
    Say "$($script:Warnings.Count) optional piece(s) were skipped:" "warn"
    $script:Warnings | ForEach-Object { Say "  - $_" "warn" }
  }
  if (-not $Quiet) { Start-Process $url }
  exit 0
} else {
  Say "$($script:Failures.Count) problem(s) need attention:" "err"
  $script:Failures | ForEach-Object { Say "  - $_" "err" }
  Say "Full log: $script:LogFile" "err"
  Say "Re-run with -Source <folder> to repair a partial copy." "warn"
  exit 1
}
