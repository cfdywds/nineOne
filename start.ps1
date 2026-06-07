[CmdletBinding()]
param(
  [ValidateSet("start", "restart", "stop", "status")]
  [string]$Action = "start",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $RootDir "data\config.yaml"
$DataDir = Split-Path -Parent $ConfigPath
$BackendDir = Join-Path $RootDir "backend"
$FrontendDir = Join-Path $RootDir "dist"
$LogDir = Join-Path $DataDir "logs"
$GoCacheDir = Join-Path $DataDir ".cache\go-build"
$FrontendBuildLog = Join-Path $LogDir "frontend-build.log"
$BackendOutLog = Join-Path $LogDir "backend.out.log"
$BackendErrLog = Join-Path $LogDir "backend.err.log"
$FrontendBuildCommand = "npm run build"
$BackendCommand = "go run ./cmd/server"
$BundledGoCommand = Join-Path $RootDir ".tools\go1.26.3\go\bin\go.exe"

function Need-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "missing required command: $Name"
  }
}

function Resolve-ToolCommand {
  param(
    [string]$Name,
    [string[]]$FallbackPaths = @()
  )

  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  foreach ($path in $FallbackPaths) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      return $path
    }
  }

  throw "missing required command: $Name"
}

function Get-BackendPort {
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    return 9191
  }

  $inServer = $false
  foreach ($line in Get-Content -LiteralPath $ConfigPath) {
    if ($line -match '^\s*server\s*:\s*$') {
      $inServer = $true
      continue
    }
    if ($inServer -and $line -match '^\S') {
      $inServer = $false
    }
    if ($inServer -and $line -match '^\s*listen\s*:\s*["'']?([^"''#]+)') {
      $listen = $Matches[1].Trim().Trim('"').Trim("'")
      $portText = ($listen -split ":")[-1]
      $port = 0
      if ([int]::TryParse($portText, [ref]$port)) {
        return $port
      }
    }
  }

  return 9191
}

function Get-PortProcessIds {
  param([int]$Port)

  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    return @(
      Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    )
  }

  return @(
    netstat -ano -p tcp |
      Select-String -Pattern ":$Port\s+.*LISTENING" |
      ForEach-Object { ($_ -split "\s+")[-1] } |
      Sort-Object -Unique
  )
}

function Show-Status {
  $port = Get-BackendPort
  $pids = Get-PortProcessIds -Port $port
  if ($pids.Count -gt 0) {
    Write-Host "running on port $port (pid: $($pids -join ', '))"
    Write-Host "url: http://127.0.0.1:$port/"
    return
  }

  Write-Host "not running on port $port"
}

function Stop-Backend {
  $port = Get-BackendPort
  $pids = Get-PortProcessIds -Port $port
  if ($pids.Count -eq 0) {
    Write-Host "backend is not running on port $port"
    return
  }

  Write-Host "stopping process on port $port (pid: $($pids -join ', '))"
  foreach ($pidValue in $pids) {
    Stop-Process -Id $pidValue -ErrorAction SilentlyContinue
  }

  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if ((Get-PortProcessIds -Port $port).Count -eq 0) {
      return
    }
  }

  throw "port $port is still occupied after stop"
}

function Invoke-FrontendBuild {
  Need-Command "npm"
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

  Write-Host "building frontend: $FrontendBuildCommand"
  Push-Location $RootDir
  try {
    & npm run build 2>&1 | Tee-Object -FilePath $FrontendBuildLog
    if ($LASTEXITCODE -ne 0) {
      throw "frontend build failed; see $FrontendBuildLog"
    }
  }
  finally {
    Pop-Location
  }
}

function Start-Backend {
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "missing config file: $ConfigPath"
  }
  if (-not (Test-Path -LiteralPath $BackendDir)) {
    throw "missing backend directory: $BackendDir"
  }
  if (-not (Test-Path -LiteralPath $FrontendDir)) {
    throw "missing frontend dist directory: $FrontendDir"
  }

  $GoCommand = Resolve-ToolCommand "go" @($BundledGoCommand)
  New-Item -ItemType Directory -Force -Path $LogDir, $GoCacheDir | Out-Null

  $port = Get-BackendPort
  $pids = Get-PortProcessIds -Port $port
  if ($pids.Count -gt 0) {
    Write-Host "already running on port $port (pid: $($pids -join ', '))"
    Write-Host "url: http://127.0.0.1:$port/"
    return
  }

  $env:VIDEO_CONFIG = $ConfigPath
  $env:VIDEO_FRONTEND_DIR = $FrontendDir
  $env:GOCACHE = $GoCacheDir

  Write-Host "starting backend with config: $ConfigPath"
  Write-Host "using go: $GoCommand"
  Write-Host "using data directory from backend cwd: $DataDir"
  $process = Start-Process `
    -FilePath $GoCommand `
    -ArgumentList @("run", "./cmd/server") `
    -WorkingDirectory $BackendDir `
    -RedirectStandardOutput $BackendOutLog `
    -RedirectStandardError $BackendErrLog `
    -WindowStyle Hidden `
    -PassThru

  for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 500
    if ((Get-PortProcessIds -Port $port).Count -gt 0) {
      Write-Host "started on port $port (launcher pid: $($process.Id))"
      Write-Host "url: http://127.0.0.1:$port/"
      Write-Host "logs: $BackendOutLog"
      Write-Host "errors: $BackendErrLog"
      return
    }
    if ($process.HasExited) {
      throw "backend exited early; see $BackendErrLog"
    }
  }

  throw "backend did not listen on port $port; see $BackendErrLog"
}

switch ($Action) {
  "start" {
    if (-not $SkipBuild) {
      Invoke-FrontendBuild
    }
    Start-Backend
  }
  "restart" {
    Stop-Backend
    if (-not $SkipBuild) {
      Invoke-FrontendBuild
    }
    Start-Backend
  }
  "stop" {
    Stop-Backend
  }
  "status" {
    Show-Status
  }
}
