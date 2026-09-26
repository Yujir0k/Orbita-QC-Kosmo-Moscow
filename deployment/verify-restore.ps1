param([Parameter(Mandatory=$true)][string]$BackupFile)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$backupRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.runtime/backups'))
$resolved = (Resolve-Path -LiteralPath $BackupFile).Path
if (-not $resolved.StartsWith($backupRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Select a backup inside this project .runtime/backups directory.' }
$name = 'orbita_restore_' + [Guid]::NewGuid().ToString('N')
if ($name -notmatch '^orbita_restore_[a-f0-9]{32}$') { throw 'Invalid isolated database name' }
$hash = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
Push-Location $projectRoot
try {
    foreach ($service in @('db','media-db')) {
        docker compose exec -T $service createdb -U orbita_owner -O orbita_app $name
        if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated restore target' }
        docker compose exec -T $service psql -v ON_ERROR_STOP=1 -U orbita_app -d $name -f /opt/migrations/001_core.sql
        if ($LASTEXITCODE -ne 0) { throw 'Migration failed' }
    }
    docker compose run --rm --no-deps -e "DB_NAME=$name" -e "MEDIA_DB_NAME=$name" -e "BACKUP_SHA256=$hash" api node server/restore.mjs --restore-empty "/backups/$([IO.Path]::GetFileName($resolved))"
    if ($LASTEXITCODE -ne 0) { throw 'Restore verification failed' }
} finally {
    foreach ($service in @('db','media-db')) { docker compose exec -T $service dropdb -U orbita_owner --if-exists $name }
    Pop-Location
}
