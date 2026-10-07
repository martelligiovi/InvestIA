CREATE TABLE IF NOT EXISTS backend_schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS investigations (
  id text PRIMARY KEY,
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  revision bigint NOT NULL CHECK (revision >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  CHECK (jsonb_typeof(document) = 'object'),
  CHECK (document ? 'id' AND document ? 'revision'),
  CONSTRAINT investigations_document_id_type_check CHECK (
    jsonb_typeof(document -> 'id') IS NOT NULL AND jsonb_typeof(document -> 'id') = 'string'
  ),
  CONSTRAINT investigations_document_revision_type_check CHECK (
    jsonb_typeof(document -> 'revision') IS NOT NULL AND jsonb_typeof(document -> 'revision') = 'number'
  ),
  CHECK (document ->> 'id' = id),
  CHECK ((document ->> 'revision')::bigint = revision)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'investigations'::regclass AND conname = 'investigations_document_id_type_check'
  ) THEN
    ALTER TABLE investigations ADD CONSTRAINT investigations_document_id_type_check CHECK (
      jsonb_typeof(document -> 'id') IS NOT NULL AND jsonb_typeof(document -> 'id') = 'string'
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'investigations'::regclass AND conname = 'investigations_document_revision_type_check'
  ) THEN
    ALTER TABLE investigations ADD CONSTRAINT investigations_document_revision_type_check CHECK (
      jsonb_typeof(document -> 'revision') IS NOT NULL AND jsonb_typeof(document -> 'revision') = 'number'
    );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS investigations_created_at_idx ON investigations (created_at, id);
