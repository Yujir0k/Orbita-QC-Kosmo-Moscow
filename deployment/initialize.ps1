param([string]$OpenSsl = 'openssl')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$secretRoot = Join-Path $projectRoot '.secrets'
New-Item -ItemType Directory -Force -Path $secretRoot, (Join-Path $projectRoot '.runtime/backups') | Out-Null
if (Test-Path -LiteralPath (Join-Path $secretRoot 'initialized')) { Write-Output 'Secrets already initialized'; exit 0 }
function WriteSecret([string]$name, [string]$value) {
    [IO.File]::WriteAllText((Join-Path $secretRoot $name), $value, [Text.UTF8Encoding]::new($false))
}
function RandomSecret { return [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant() }
foreach ($name in @('db-owner-password','db-app-password','media-owner-password','media-app-password','emulator-token')) { WriteSecret $name (RandomSecret) }
WriteSecret 'keyring.json' (@{active='data-v1';keys=@{'data-v1'=(RandomSecret)}} | ConvertTo-Json -Depth 4)
$users = foreach ($role in @('controller','master','technologist','leader','administrator')) { @{id="$role-01";role=$role;password=(RandomSecret)} }
WriteSecret 'users.json' (ConvertTo-Json -InputObject @($users) -Depth 4)
WriteSecret 'openssl.cnf' "[req]`ndistinguished_name=dn`n[dn]`n"
$env:OPENSSL_CONF = Join-Path $secretRoot 'openssl.cnf'
Push-Location $secretRoot
try {
    & $OpenSsl req -x509 -newkey rsa:3072 -nodes -keyout ca.key -out ca.crt -days 365 -subj '/CN=ORBITA Local Development CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'CA generation failed' }
    foreach ($service in @('api','db','emulator','web')) {
        $san = switch ($service) { 'db' {'DNS:db,DNS:media-db'} 'web' {'DNS:localhost,IP:127.0.0.1'} default {"DNS:$service"} }
        WriteSecret "$service.ext" "subjectAltName=$san`nextendedKeyUsage=serverAuth"
        & $OpenSsl req -newkey rsa:3072 -nodes -keyout "$service.key" -out "$service.csr" -subj "/CN=$service" 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Certificate request failed' }
        & $OpenSsl x509 -req -in "$service.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -out "$service.crt" -days 365 -extfile "$service.ext" 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Certificate generation failed' }
    }
    & $OpenSsl ecparam -name prime256v1 -genkey -noout -out signing.key
    if ($LASTEXITCODE -ne 0) { throw 'Signing key generation failed' }
    WriteSecret 'initialized' ([DateTime]::UtcNow.ToString('O'))
} finally { Pop-Location }
Write-Output 'Secrets created in .secrets. Credentials are in users.json; do not commit this directory.'
