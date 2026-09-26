#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
sh deployment/initialize.sh
# Give the unprivileged application ownership of its backup directory.
docker run --rm -v "$PWD/.runtime/backups:/backups" alpine:3.21 chown 1000:1000 /backups
docker build --target api -t orbita-qc-api:local .
docker build --target web -t orbita-qc-web:local .
docker compose up -d --no-build --scale api="${API_REPLICAS:-2}" --wait --wait-timeout 180
echo 'Open https://localhost:8443'
