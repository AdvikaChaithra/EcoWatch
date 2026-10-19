# EcoWatch demo launcher: opens three terminals (API, vision engine, web app) from the repo root.
# Usage:  powershell -ExecutionPolicy Bypass -File .\start_demo.ps1 [-Source "demo\clip.mp4"]
param([string]$Source = "")

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "Running preflight..." -ForegroundColor Cyan
python scripts/preflight.py
if ($LASTEXITCODE -ne 0) {
    Write-Host "`nPreflight has FAILs (see above). Starting anyway in 5s - Ctrl+C to abort." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}

$engineEnv = ""
if ($Source -ne "") { $engineEnv = "`$env:CAMERA_SOURCE='$Source'; `$env:CAMERA_LOOP='true'; " }

Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root'; python -m uvicorn backend.main:app --port 8000"
Start-Sleep -Seconds 6   # let the API load the face model
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root'; $engineEnv python -m backend.vision_engine"
# Production build (fast pages). Rebuild only when sources are newer than the last build.
if (-not (Test-Path "$root\.next\BUILD_ID")) {
    Write-Host "Building the website (first run, ~1 min)..." -ForegroundColor Cyan
    npx next build
}
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root'; npm start"

Write-Host "`nOpen http://localhost:3000  (citizen: /citizen   admin: /admin   camera: /surveillance)" -ForegroundColor Green
