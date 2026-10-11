param([switch]$Reload)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $Python)) { throw 'Chưa có .venv. Xem README để thiết lập.' }
Push-Location -LiteralPath $ProjectRoot
try {
    $UvArgs = @('-m', 'uvicorn', 'backend.app.main:app', '--host', '127.0.0.1', '--port', '8000')
    if ($Reload) { $UvArgs += @('--reload', '--reload-dir', 'backend') }
    & $Python @UvArgs
    if ($LASTEXITCODE -ne 0) { throw "Backend dừng với exit code $LASTEXITCODE" }
} finally { Pop-Location }
