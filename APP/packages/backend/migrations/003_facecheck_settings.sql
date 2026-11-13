-- Singleton FaceCheck configuration; the token is never returned by the API.
CREATE TABLE IF NOT EXISTS facecheck_settings (
  id text PRIMARY KEY CHECK (id = 'facecheck'),
  token text,
  testing_mode boolean NOT NULL DEFAULT true
);
