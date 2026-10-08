$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bootstrap = Join-Path $root 'bootstrap.ps1'
$pythonExe = Join-Path $root 'venv\Scripts\python.exe'

& $bootstrap
& $pythonExe -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
