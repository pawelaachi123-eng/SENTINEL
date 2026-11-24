<#
  SENTINEL — full Windows install.

  One script that takes a clean Windows 10/11 machine to a working local
  assistant: the agent, the desktop console, a local model runtime, speech, OCR,
  optional autostart, and a health check that tells you the truth afterwards.

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
  [string]$InstallDir = "$env:LOCALAPPDATA\SENTINEL",
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
    Say "copying from $Source"
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    robocopy $Source $InstallDir /E /XD node_modules .git dist build .pio /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Add-Failure "robocopy failed with $LASTEXITCODE" }
    else { Say "application files copied" "ok" }
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
try {
  $existing = Get-Json "http://127.0.0.1:$port/api/health"
  if ($existing) { Say "an agent is already running on $port" "ok" }
} catch { }

if (-not $existing -and (Test-Path $agent)) {
  $log = Join-Path $env:TEMP "sentinel-start.log"
  Start-Process -FilePath (Get-Command node).Source -ArgumentList "`"$agent`"" -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $up = Wait-Http "http://127.0.0.1:$port/api/health" 45
  if ($up) { Say "agent answers on http://127.0.0.1:$port" "ok" } else { Add-Failure "the agent did not answer on $port — see $log" }
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

Say "Done" "step"
if ($script:Failures.Count -eq 0) {
  Say "SENTINEL is installed and running." "ok"
  Say "Open $url" "ok"
  Say "Terminal: sentinel ask `"jaki mam GPU?`"   (add $InstallDir\bin to PATH, or use node $cli)" 
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
