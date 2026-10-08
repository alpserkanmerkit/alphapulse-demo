$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$quantScript = Join-Path $root 'quant-engine\start.ps1'

function Test-Endpoint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url
    )

    $candidates = @($Url)
    if ($Url -like 'http://localhost*') {
        $candidates += $Url -replace 'http://localhost', 'http://127.0.0.1'
    } elseif ($Url -like 'http://127.0.0.1*') {
        $candidates += $Url -replace 'http://127.0.0.1', 'http://localhost'
    }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $candidate -TimeoutSec 2 | Out-Null
            return $true
        } catch {
        }
    }

    return $false
}

function Start-DetachedPowerShell {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string]$Command
    )

    $escapedWorkingDirectory = $WorkingDirectory.Replace("'", "''")
    $fullCommand = "Set-Location -LiteralPath '$escapedWorkingDirectory'; $Command"

    Write-Host "[stack] Starting $Name..."
    Start-Process powershell -WorkingDirectory $WorkingDirectory -ArgumentList @(
        '-NoExit',
        '-ExecutionPolicy', 'Bypass',
        '-Command', $fullCommand
    ) | Out-Null
}

function Wait-ForEndpoint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [int]$TimeoutSeconds = 120
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Endpoint -Url $Url) {
            Write-Host "[stack] $Name ready -> $Url"
            return
        }

        Start-Sleep -Seconds 2
    }

    throw "$Name did not become ready within ${TimeoutSeconds}s ($Url)."
}

if (-not (Test-Endpoint -Url 'http://127.0.0.1:8000/health')) {
    Start-DetachedPowerShell -Name 'quant-engine' -WorkingDirectory (Join-Path $root 'quant-engine') -Command "& '$quantScript'"
} else {
    Write-Host '[stack] quant-engine already running.'
}

if (-not (Test-Endpoint -Url 'http://localhost:3001/health')) {
    Start-DetachedPowerShell -Name 'backend' -WorkingDirectory $root -Command 'npm run dev:server'
} else {
    Write-Host '[stack] backend already running.'
}

if (-not (Test-Endpoint -Url 'http://localhost:3000')) {
    Start-DetachedPowerShell -Name 'frontend' -WorkingDirectory $root -Command 'npm run dev'
} else {
    Write-Host '[stack] frontend already running.'
}

Wait-ForEndpoint -Name 'quant-engine' -Url 'http://127.0.0.1:8000/health'
Wait-ForEndpoint -Name 'backend' -Url 'http://localhost:3001/health'
Wait-ForEndpoint -Name 'frontend' -Url 'http://localhost:3000'

Write-Host ''
Write-Host 'AlphaPulse local stack is ready.'
Write-Host 'Frontend:  http://localhost:3000'
Write-Host 'Backend:   http://localhost:3001/health'
Write-Host 'Quant:     http://127.0.0.1:8000/health'
