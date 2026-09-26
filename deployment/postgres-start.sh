#!/bin/sh
set -eu
cp /run/secrets/db.key /var/lib/postgresql/server.key
cp /run/secrets/db.crt /var/lib/postgresql/server.crt
chown postgres:postgres /var/lib/postgresql/server.key /var/lib/postgresql/server.crt
chmod 600 /var/lib/postgresql/server.key
exec docker-entrypoint.sh postgres -c hba_file=/opt/pg_hba.conf -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key -c shared_buffers=256MB -c max_connections=160 -c log_min_duration_statement=1000 -c password_encryption=scram-sha-256
