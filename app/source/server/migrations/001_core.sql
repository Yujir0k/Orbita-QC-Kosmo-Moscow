CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS documents (
  namespace text NOT NULL, id text NOT NULL, revision bigint NOT NULL DEFAULT 1,
  payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(namespace,id)
);
CREATE TABLE IF NOT EXISTS stream_heads (stream text PRIMARY KEY, seq bigint NOT NULL, mac text NOT NULL);
CREATE TABLE IF NOT EXISTS journal (
  stream text NOT NULL, seq bigint NOT NULL, id text NOT NULL UNIQUE, prev text NOT NULL,
  payload jsonb NOT NULL, mac text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(stream,seq)
);
CREATE TABLE IF NOT EXISTS events (
  event_id text PRIMARY KEY, item_id text NOT NULL, line_id text NOT NULL, event_type text NOT NULL,
  occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  fingerprint text NOT NULL, journal_id text NOT NULL REFERENCES journal(id), payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS events_item_time ON events(item_id,occurred_at,event_id);
CREATE INDEX IF NOT EXISTS events_line_time ON events(line_id,received_at,event_id);
CREATE TABLE IF NOT EXISTS ingest_receipts (
  id bigserial PRIMARY KEY, delivery_id text NOT NULL, event_id text, outcome text NOT NULL,
  payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receipts_time ON ingest_receipts(received_at);
CREATE TABLE IF NOT EXISTS commands (
  id text PRIMARY KEY, actor text NOT NULL, fingerprint text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY, user_id text NOT NULL, payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL, idle_until timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS rate_limits (id text PRIMARY KEY, count integer NOT NULL, resets_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  id text PRIMARY KEY, item_id text NOT NULL, destination text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','accepted','retry_wait','failed')),
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz, lease_id text, last_error text, receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status,available_at);
CREATE TABLE IF NOT EXISTS media (
  id text PRIMARY KEY, item_id text NOT NULL, line_id text NOT NULL, filename text NOT NULL UNIQUE,
  content_type text NOT NULL, sha256 text NOT NULL, bytes integer NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION prevent_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable history: append a correction instead' USING ERRCODE='42501'; END;
$$;
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['journal','events','ingest_receipts','commands','media'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = target || '_immutable') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION prevent_history_mutation()', target || '_immutable', target);
    END IF;
  END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
