$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Thiếu Node.js/npm.' }
Push-Location -LiteralPath (Join-Path $ProjectRoot 'frontend')
try {
    & npm.cmd run dev
    if ($LASTEXITCODE -ne 0) { throw "Frontend dừng với exit code $LASTEXITCODE" }
} finally { Pop-Location }
