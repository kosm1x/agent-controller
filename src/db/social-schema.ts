/**
 * Social Publishing Schema (v6.3 D2)
 *
 * Tables for multi-platform social media publishing:
 * - social_accounts: OAuth credentials + platform config per client
 * - publish_records: publishing history + status tracking
 *
 * Auto-created on first use (same pattern as task_mutations).
 */

import { getDatabase } from "./index.js";

let initialized = false;

export function ensureSocialTables(): void {
  if (initialized) return;
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_accounts (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      platform TEXT NOT NULL CHECK(platform IN ('facebook','instagram','tiktok','youtube','twitter','linkedin')),
      account_name TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      token_expires_at INTEGER,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_social_accounts_platform ON social_accounts(platform);
    CREATE INDEX IF NOT EXISTS idx_social_accounts_project ON social_accounts(project_id);

    CREATE TABLE IF NOT EXISTS publish_records (
      id TEXT PRIMARY KEY,
      social_account_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','queued','publishing','published','failed')),
      content_type TEXT DEFAULT 'text' CHECK(content_type IN ('text','image','video','carousel')),
      title TEXT,
      description TEXT,
      media_urls TEXT DEFAULT '[]',
      topics TEXT DEFAULT '[]',
      platform_post_id TEXT,
      platform_post_url TEXT,
      scheduled_at INTEGER,
      published_at INTEGER,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_publish_records_account ON publish_records(social_account_id);
    CREATE INDEX IF NOT EXISTS idx_publish_records_status ON publish_records(status);
    CREATE INDEX IF NOT EXISTS idx_publish_records_platform ON publish_records(platform);
    CREATE INDEX IF NOT EXISTS idx_publish_records_scheduled ON publish_records(scheduled_at);
  `);
  initialized = true;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export interface SocialAccount {
  id: string;
  project_id: string | null;
  platform: string;
  account_name: string;
  metadata: string;
  created_at: string;
}

export function listSocialAccounts(platform?: string): SocialAccount[] {
  ensureSocialTables();
  const db = getDatabase();
  if (platform) {
    return db
      .prepare(
        "SELECT id, project_id, platform, account_name, metadata, created_at FROM social_accounts WHERE platform = ? ORDER BY account_name",
      )
      .all(platform) as SocialAccount[];
  }
  return db
    .prepare(
      "SELECT id, project_id, platform, account_name, metadata, created_at FROM social_accounts ORDER BY platform, account_name",
    )
    .all() as SocialAccount[];
}

export interface PublishRecord {
  id: string;
  platform: string;
  status: string;
  content_type: string;
  title: string | null;
  platform_post_url: string | null;
  published_at: number | null;
  error: string | null;
  created_at: string;
}

export function getPublishRecord(recordId: string): PublishRecord | null {
  ensureSocialTables();
  const db = getDatabase();
  return (
    (db
      .prepare(
        "SELECT id, platform, status, content_type, title, platform_post_url, published_at, error, created_at FROM publish_records WHERE id = ?",
      )
      .get(recordId) as PublishRecord | undefined) ?? null
  );
}

export function listPublishRecords(opts?: {
  platform?: string;
  status?: string;
  limit?: number;
}): PublishRecord[] {
  ensureSocialTables();
  const db = getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.platform) {
    conditions.push("platform = ?");
    params.push(opts.platform);
  }
  if (opts?.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts?.limit ?? 50;

  return db
    .prepare(
      `SELECT id, platform, status, content_type, title, platform_post_url, published_at, error, created_at FROM publish_records ${where} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as PublishRecord[];
}
