-- Per-evidence optional Layer 2 AI normalizations bound to raw Decodo content hashes.
CREATE TABLE IF NOT EXISTS evidence_ai_normalizations (
  investigation_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  model TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  source_content_hash TEXT NOT NULL,
  normalized_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (investigation_id, evidence_id)
);
