-- migrations/003_gemini_task_queue.sql
--
-- Comprehensive schema for the Gemini task queue, adapted from:
--   1. iHildy/jules-task-queue Prisma schema (JulesTask, WebhookLog, GitHubInstallation, etc.)
--   2. Existing orchestrator schema (workflow_templates, workflow_instances, etc.)
--
-- This migration is additive — it does NOT modify existing tables.

-- Ensure UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────
-- GitHub App Installations (from jules-task-queue)
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS github_installations (
  id                        INTEGER PRIMARY KEY,
  account_id                BIGINT NOT NULL,
  account_login             VARCHAR(255) NOT NULL,
  account_type              VARCHAR(50) NOT NULL,   -- 'User' or 'Organization'
  target_type               VARCHAR(50) NOT NULL,   -- 'User' or 'Organization'
  permissions               JSONB NOT NULL DEFAULT '{}',
  events                    JSONB NOT NULL DEFAULT '[]',
  single_file_name          VARCHAR(255),
  repository_selection      VARCHAR(50) NOT NULL,   -- 'all' or 'selected'
  suspended_at              TIMESTAMP,
  suspended_by              VARCHAR(255),

  -- OAuth tokens
  user_access_token         TEXT,
  refresh_token             TEXT,
  token_expires_at          TIMESTAMP,
  refresh_token_expires_at  TIMESTAMP,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gh_install_account_id ON github_installations(account_id);
CREATE INDEX IF NOT EXISTS idx_gh_install_account_login ON github_installations(account_login);
CREATE INDEX IF NOT EXISTS idx_gh_install_suspended ON github_installations(suspended_at);

-- ─────────────────────────────────────────────────────────
-- Installation Repositories (from jules-task-queue)
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS installation_repositories (
  id              SERIAL PRIMARY KEY,
  installation_id INTEGER NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  repository_id   BIGINT NOT NULL,
  name            VARCHAR(255) NOT NULL,
  full_name       VARCHAR(512) NOT NULL,
  owner           VARCHAR(255) NOT NULL,
  private         BOOLEAN DEFAULT false,
  html_url        TEXT,
  description     TEXT,

  added_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  removed_at      TIMESTAMP,

  UNIQUE (installation_id, repository_id)
);

CREATE INDEX IF NOT EXISTS idx_install_repo_install ON installation_repositories(installation_id);
CREATE INDEX IF NOT EXISTS idx_install_repo_repo_id ON installation_repositories(repository_id);
CREATE INDEX IF NOT EXISTS idx_install_repo_owner_name ON installation_repositories(owner, name);
CREATE INDEX IF NOT EXISTS idx_install_repo_removed ON installation_repositories(removed_at);

-- ─────────────────────────────────────────────────────────
-- Gemini Tasks (adapted from jules-task-queue JulesTask)
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gemini_tasks (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  github_repo_id    BIGINT,
  github_issue_id   BIGINT UNIQUE,
  owner             VARCHAR(255) NOT NULL,
  repo              VARCHAR(255) NOT NULL,
  issue_number      INTEGER NOT NULL,
  issue_title       TEXT,
  issue_body        TEXT,
  issue_labels      JSONB DEFAULT '[]',

  -- GitHub App integration (optional)
  installation_id   INTEGER REFERENCES github_installations(id),

  -- Processing status
  status            VARCHAR(50) NOT NULL DEFAULT 'pending',
  flagged_for_retry BOOLEAN DEFAULT false,
  retry_count       INTEGER DEFAULT 0,
  last_retry_at     TIMESTAMP,

  -- Session tracking
  session_id        VARCHAR(255),
  error             TEXT,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT valid_gemini_task_status CHECK (status IN (
    'pending', 'processing', 'queued', 'completed', 'failed'
  ))
);

CREATE INDEX IF NOT EXISTS idx_gemini_tasks_status ON gemini_tasks(status);
CREATE INDEX IF NOT EXISTS idx_gemini_tasks_retry ON gemini_tasks(flagged_for_retry) WHERE flagged_for_retry = true;
CREATE INDEX IF NOT EXISTS idx_gemini_tasks_issue ON gemini_tasks(owner, repo, issue_number);
CREATE INDEX IF NOT EXISTS idx_gemini_tasks_created ON gemini_tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gemini_tasks_install ON gemini_tasks(installation_id);
CREATE INDEX IF NOT EXISTS idx_gemini_tasks_retry_created ON gemini_tasks(flagged_for_retry, created_at);

-- ─────────────────────────────────────────────────────────
-- Webhook Logs (from jules-task-queue WebhookLog)
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS webhook_logs (
  id         SERIAL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  payload    JSONB NOT NULL,
  success    BOOLEAN DEFAULT true,
  error      TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_event ON webhook_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_success ON webhook_logs(success);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created ON webhook_logs(created_at DESC);

-- ─────────────────────────────────────────────────────────
-- Label Preferences (from jules-task-queue)
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS label_preferences (
  id              SERIAL PRIMARY KEY,
  installation_id INTEGER NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  setup_type      VARCHAR(50) NOT NULL,  -- 'all', 'selected', 'manual'

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (installation_id)
);

CREATE INDEX IF NOT EXISTS idx_label_prefs_install ON label_preferences(installation_id);
CREATE INDEX IF NOT EXISTS idx_label_prefs_setup ON label_preferences(setup_type);

CREATE TABLE IF NOT EXISTS label_preference_repositories (
  id                  SERIAL PRIMARY KEY,
  label_preference_id INTEGER NOT NULL REFERENCES label_preferences(id) ON DELETE CASCADE,
  repository_id       BIGINT NOT NULL,
  name                VARCHAR(255) NOT NULL,
  full_name           VARCHAR(512) NOT NULL,
  owner               VARCHAR(255) NOT NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (label_preference_id, repository_id)
);

CREATE INDEX IF NOT EXISTS idx_label_pref_repo_pref ON label_preference_repositories(label_preference_id);
CREATE INDEX IF NOT EXISTS idx_label_pref_repo_id ON label_preference_repositories(repository_id);
CREATE INDEX IF NOT EXISTS idx_label_pref_repo_owner ON label_preference_repositories(owner, name);

-- ─────────────────────────────────────────────────────────
-- Rate Limiting (from jules-task-queue)
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rate_limits (
  id           SERIAL PRIMARY KEY,
  identifier   VARCHAR(255) NOT NULL,  -- IP address or user identifier
  endpoint     VARCHAR(255) NOT NULL,  -- API endpoint
  requests     INTEGER DEFAULT 1,
  window_start TIMESTAMP NOT NULL,
  expires_at   TIMESTAMP NOT NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (identifier, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_identifier ON rate_limits(identifier);
CREATE INDEX IF NOT EXISTS idx_rate_limits_endpoint ON rate_limits(endpoint);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);

-- ─────────────────────────────────────────────────────────
-- Auto-update triggers (reuse existing function if available)
-- ─────────────────────────────────────────────────────────

-- Create the function if it doesn't exist (safe for fresh installs)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_gemini_tasks_updated_at') THEN
    CREATE TRIGGER update_gemini_tasks_updated_at BEFORE UPDATE ON gemini_tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_github_installations_updated_at') THEN
    CREATE TRIGGER update_github_installations_updated_at BEFORE UPDATE ON github_installations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_label_preferences_updated_at') THEN
    CREATE TRIGGER update_label_preferences_updated_at BEFORE UPDATE ON label_preferences
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_rate_limits_updated_at') THEN
    CREATE TRIGGER update_rate_limits_updated_at BEFORE UPDATE ON rate_limits
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
