-- Singleton Decodo configuration; the token is never returned by the API.
CREATE TABLE IF NOT EXISTS decodo_settings (
  id text PRIMARY KEY CHECK (id = 'decodo'),
  token text,
  api_mode text NOT NULL DEFAULT 'web_data' CHECK (api_mode IN ('web_data', 'scraping_v2')),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
