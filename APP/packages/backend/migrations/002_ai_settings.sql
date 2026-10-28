-- Single-row NVIDIA Build configuration. The API key is a local operator secret and is never returned by the API.
CREATE TABLE IF NOT EXISTS ai_settings (
  id text PRIMARY KEY CHECK (id = 'nvidia-build'),
  api_key text,
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz NOT NULL
);
