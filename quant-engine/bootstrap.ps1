$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPath = Join-Path $root 'venv'
$pythonExe = Join-Path $venvPath 'Scripts\python.exe'
$requirements = Join-Path $root 'requirements.txt'
$env:PYTHONUTF8 = '1'

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Command
    )

    & $Command[0] $Command[1..($Command.Length - 1)]
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $($Command -join ' ')"
    }
}

function Get-PreferredPython {
    $pyCommand = Get-Command py -ErrorAction SilentlyContinue
    if ($pyCommand) {
        foreach ($version in @('-3.12', '-3.11')) {
            & py $version -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')" 2>$null
            if ($LASTEXITCODE -eq 0) {
                $resolved = & py $version -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"
                return @{
                    Command = @('py', $version)
                    Version = $resolved.Trim()
                }
            }
        }
    }

    $resolved = & python -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"
    if ($LASTEXITCODE -ne 0) {
        throw 'A usable Python interpreter was not found.'
    }

    return @{
        Command = @('python')
        Version = $resolved.Trim()
    }
}

$python = Get-PreferredPython
$venvNeedsRebuild = -not (Test-Path $pythonExe)

if (-not $venvNeedsRebuild) {
    $venvVersion = & $pythonExe -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"
    if ($LASTEXITCODE -ne 0 -or $venvVersion.Trim() -ne $python.Version) {
        Write-Host "[quant-bootstrap] Rebuilding venv with Python $($python.Version)..."
        $venvNeedsRebuild = $true
    }
}

if ($venvNeedsRebuild) {
    Write-Host "[quant-bootstrap] Creating virtual environment with Python $($python.Version)..."
    Invoke-Checked ($python.Command + @('-m', 'venv', '--clear', $venvPath))
}

Write-Host '[quant-bootstrap] Installing pinned requirements into quant-engine/venv...'
Invoke-Checked @($pythonExe, '-m', 'pip', 'install', '--upgrade', 'pip')
Invoke-Checked @($pythonExe, '-m', 'pip', 'install', '-r', $requirements)

Write-Host '[quant-bootstrap] Verifying FastAPI and uvicorn imports...'
Invoke-Checked @($pythonExe, '-c', "import fastapi, uvicorn; print('quant-engine venv ready')")

Write-Host ''
Write-Host 'Bootstrap complete.'
Write-Host "Start command: & '$pythonExe' -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload"
Write-Host 'Smoke check: Invoke-WebRequest http://127.0.0.1:8000/health'
