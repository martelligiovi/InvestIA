CREATE TABLE IF NOT EXISTS evidence_normalization_jobs (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN (
    'AI_NOT_CONFIGURED',
    'AI_PROVIDER_UNAUTHORIZED',
    'AI_PROVIDER_RATE_LIMITED',
    'AI_PROVIDER_REJECTED',
    'AI_PROVIDER_TIMEOUT',
    'AI_PROVIDER_TRUNCATED',
    'AI_PROVIDER_UNAVAILABLE',
    'AI_PROVIDER_INVALID_RESPONSE',
    'EVIDENCE_UNAVAILABLE',
    'JOB_INTERRUPTED',
    'INTERNAL_ERROR'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS evidence_normalization_jobs_investigation_idx
  ON evidence_normalization_jobs (investigation_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS evidence_normalization_jobs_queued_idx
  ON evidence_normalization_jobs (created_at ASC, id ASC) WHERE status = 'queued';

CREATE UNIQUE INDEX IF NOT EXISTS evidence_normalization_jobs_active_idx
  ON evidence_normalization_jobs (investigation_id, evidence_id) WHERE status IN ('queued', 'running');
