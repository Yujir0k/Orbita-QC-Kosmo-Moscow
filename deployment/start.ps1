param([string]$OpenSsl = 'openssl', [int]$Replicas = 2)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if ($projectRoot -match '[^\x00-\x7F]') { throw 'Clone the project into an ASCII path, for example A:\orbita-qc, for Docker Desktop.' }
& (Join-Path $PSScriptRoot 'initialize.ps1') -OpenSsl $OpenSsl
Push-Location $projectRoot
try {
    docker build -t orbita-qc-api:local --target api -f Dockerfile .
    if ($LASTEXITCODE -ne 0) { throw 'API image build failed' }
    docker build -t orbita-qc-web:local --target web -f Dockerfile .
    if ($LASTEXITCODE -ne 0) { throw 'Web image build failed' }
    docker compose up -d --no-build --scale "api=$Replicas" --wait --wait-timeout 180
    if ($LASTEXITCODE -ne 0) { throw 'Stack did not become healthy. Check docker compose logs.' }
    Write-Output 'Open https://localhost:8443. Persistent files are in .runtime; secrets are in .secrets.'
} finally { Pop-Location }
