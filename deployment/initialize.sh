#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p .secrets .runtime/backups
if test -f .secrets/initialized; then echo 'Secrets already initialized'; exit 0; fi
command -v openssl >/dev/null
for name in db-owner-password db-app-password media-owner-password media-app-password emulator-token; do
  openssl rand -hex 32 > ".secrets/$name"
done
printf '{"active":"data-v1","keys":{"data-v1":"%s"}}\n' "$(openssl rand -hex 32)" > .secrets/keyring.json
printf '[' > .secrets/users.json
separator=''
for role in controller master technologist leader administrator; do
  printf '%s{"id":"%s-01","role":"%s","password":"%s"}' "$separator" "$role" "$role" "$(openssl rand -hex 32)" >> .secrets/users.json
  separator=','
done
printf ']\n' >> .secrets/users.json
cd .secrets
openssl req -x509 -newkey rsa:3072 -nodes -keyout ca.key -out ca.crt -days 365 -subj '/CN=ORBITA Local Development CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign'
for service in api db emulator web; do
  case "$service" in
    db) san='DNS:db,DNS:media-db';;
    web) san='DNS:localhost,IP:127.0.0.1';;
    *) san="DNS:$service";;
  esac
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$san" > "$service.ext"
  openssl req -newkey rsa:3072 -nodes -keyout "$service.key" -out "$service.csr" -subj "/CN=$service"
  openssl x509 -req -in "$service.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -out "$service.crt" -days 365 -extfile "$service.ext"
done
openssl ecparam -name prime256v1 -genkey -noout -out signing.key
# The application runs as an unprivileged container user. Public read is limited
# by the 0700 host directory; mount only specific secrets into each service.
chmod 644 ca.crt api.key api.crt db.key db.crt emulator.key emulator.crt web.key web.crt keyring.json signing.key users.json *-password emulator-token
date -u +%FT%TZ > initialized
echo 'Secrets initialized. Keep .secrets outside version control.'
