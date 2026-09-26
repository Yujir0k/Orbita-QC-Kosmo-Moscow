#!/bin/sh
set -eu
app_password=$(cat /run/secrets/db-app-password)
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v app_password="$app_password" <<'SQL'
CREATE ROLE orbita_app LOGIN PASSWORD :'app_password';
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /opt/migrations/001_core.sql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
GRANT CONNECT ON DATABASE orbita TO orbita_app;
GRANT USAGE ON SCHEMA public TO orbita_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO orbita_app;
GRANT UPDATE ON documents, stream_heads, sessions, rate_limits, outbox TO orbita_app;
GRANT DELETE ON sessions, rate_limits TO orbita_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO orbita_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
