import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'signal.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_channel_id ON messages(channel_id, id DESC);
    CREATE TABLE IF NOT EXISTS invites (
      code_hash TEXT PRIMARY KEY,
      created_by TEXT NOT NULL REFERENCES users(id),
      max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
      uses INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL
    );
  `);
  const migrationsExist = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const membershipMigrationApplied = migrationsExist && db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get('channel-memberships-v1');
  if (!membershipMigrationApplied) {
    const insert = db.prepare('INSERT OR IGNORE INTO channels (id, name, description, created_at) VALUES (?, ?, ?, ?)');
    const now = Date.now();
    insert.run('general', 'Общий', 'Общаемся, встречаемся и обсуждаем всё на свете', now);
    insert.run('gaming', 'Игровая', 'Собираем команду и играем вместе', now + 1);
    insert.run('lounge', 'Гостиная', 'Неспешные разговоры и совместные просмотры', now + 2);
  }
  return db;
}

export function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, displayName: row.username, role: row.role };
}

// Run after the bootstrap account exists. Existing accounts keep access to their
// old conversations exactly once; later registrations start with no memberships.
export function migrateChannelMemberships(db, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get('channel-memberships-v1')) {
      if (!db.prepare('PRAGMA table_info(channels)').all().some((column) => column.name === 'owner_id')) {
        db.exec('ALTER TABLE channels ADD COLUMN owner_id TEXT REFERENCES users(id)');
      }
      if (!db.prepare('PRAGMA table_info(invites)').all().some((column) => column.name === 'channel_id')) {
        db.exec('ALTER TABLE invites ADD COLUMN channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE');
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS memberships (
          channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
          joined_at INTEGER NOT NULL,
          PRIMARY KEY (channel_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id, channel_id);
        CREATE INDEX IF NOT EXISTS invites_channel ON invites(channel_id);
      `);
      const owner = db.prepare("SELECT id FROM users ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, created_at, id LIMIT 1").get();
      if (!owner) throw new Error('Для переноса каналов нужен существующий аккаунт.');
      db.prepare('UPDATE channels SET owner_id = ? WHERE owner_id IS NULL').run(owner.id);
      db.prepare(`INSERT OR IGNORE INTO memberships (channel_id, user_id, role, joined_at)
        SELECT channels.id, users.id, CASE WHEN channels.owner_id = users.id THEN 'owner' ELSE 'member' END, ? FROM channels CROSS JOIN users`).run(now);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run('channel-memberships-v1', now);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function migrateDirectInvitations(db, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get('direct-channel-invitations-v1')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_invitations (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          responded_at INTEGER,
          CHECK (created_by <> recipient_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS channel_invitations_pending ON channel_invitations(channel_id, recipient_id) WHERE status = 'pending';
        CREATE INDEX IF NOT EXISTS channel_invitations_recipient ON channel_invitations(recipient_id, status, expires_at);
      `);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run('direct-channel-invitations-v1', now);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function migrateChannelModeration(db, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get('username-only-v1')) {
      db.exec('UPDATE users SET display_name = username');
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run('username-only-v1', now);
    }
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get('channel-moderation-v1')) {
      const hasMuted = db.prepare('PRAGMA table_info(memberships)').all().some((column) => column.name === 'muted');
      db.exec(`CREATE TABLE memberships_v2 (
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
        muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, user_id)
      )`);
      db.exec(`INSERT INTO memberships_v2 (channel_id, user_id, role, muted, joined_at) SELECT channel_id, user_id, role, ${hasMuted ? 'muted' : '0'}, joined_at FROM memberships`);
      db.exec(`
        DROP TABLE memberships;
        ALTER TABLE memberships_v2 RENAME TO memberships;
        CREATE INDEX memberships_user ON memberships(user_id, channel_id);
        CREATE TABLE channel_bans (
          channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          banned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          target_role TEXT NOT NULL DEFAULT 'member' CHECK (target_role IN ('admin', 'member')),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (channel_id, user_id)
        );
        CREATE INDEX channel_bans_user ON channel_bans(user_id, channel_id);
        CREATE TABLE media_moderation_jobs (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('evict', 'mute', 'unmute', 'delete')),
          created_at INTEGER NOT NULL,
          UNIQUE (channel_id, user_id)
        );
      `);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run('channel-moderation-v1', now);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

// Private conversations keep an immutable account pair. Their membership cannot
// be expanded through a link, a channel invitation or an administrator action.
export function migratePrivateCalls(db, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get('private-calls-e2ee-v1')) {
      if (!db.prepare('PRAGMA table_info(channels)').all().some((column) => column.name === 'kind')) {
        db.exec("ALTER TABLE channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'channel' CHECK (kind IN ('channel', 'direct'))");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS direct_conversations (
          channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
          first_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          second_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          CHECK (first_user_id < second_user_id),
          UNIQUE (first_user_id, second_user_id)
        );
        CREATE TABLE IF NOT EXISTS channel_media_keys (
          channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch > 0),
          reset_pending INTEGER NOT NULL DEFAULT 0 CHECK (reset_pending IN (0, 1))
        );
      `);
      // Existing plaintext calls must end before an encrypted participant joins.
      const seed = db.prepare('INSERT OR IGNORE INTO channel_media_keys (channel_id, key, epoch, reset_pending) VALUES (?, ?, 1, 1)');
      for (const channel of db.prepare('SELECT id FROM channels').all()) seed.run(channel.id, randomBytes(32).toString('base64url'));
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run('private-calls-e2ee-v1', now);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

// Every legacy conversation becomes its own workspace. Membership is copied
// from that conversation only, so unrelated private groups never become peers.
export function migrateCommunities(db, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get('workspaces-friends-v1')) {
      db.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          owner_id TEXT NOT NULL REFERENCES users(id),
          created_at INTEGER NOT NULL
        );
        CREATE TABLE workspace_memberships (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
          joined_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, user_id)
        );
        CREATE TABLE workspace_bans (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          banned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          target_role TEXT NOT NULL DEFAULT 'member' CHECK (target_role IN ('admin', 'member')),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, user_id)
        );
        ALTER TABLE channels ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
        ALTER TABLE channels ADD COLUMN channel_type TEXT NOT NULL DEFAULT 'text' CHECK (channel_type IN ('text', 'voice'));
        ALTER TABLE channels ADD COLUMN label TEXT;
        ALTER TABLE channels ADD COLUMN legacy_voice_compatible INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX channels_workspace ON channels(workspace_id, created_at);
        CREATE INDEX workspace_memberships_user ON workspace_memberships(user_id, workspace_id);
        CREATE TABLE friend_requests (
          id TEXT PRIMARY KEY,
          sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
          created_at INTEGER NOT NULL,
          responded_at INTEGER,
          CHECK (sender_id <> recipient_id)
        );
        CREATE UNIQUE INDEX friend_requests_pending_pair ON friend_requests(
          CASE WHEN sender_id < recipient_id THEN sender_id ELSE recipient_id END,
          CASE WHEN sender_id < recipient_id THEN recipient_id ELSE sender_id END
        ) WHERE status = 'pending';
        CREATE TABLE friendships (
          first_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          second_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (first_user_id, second_user_id),
          CHECK (first_user_id < second_user_id)
        );
        CREATE TABLE direct_calls (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          caller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'ended', 'expired')),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          responded_at INTEGER,
          CHECK (caller_id <> recipient_id)
        );
        CREATE INDEX direct_calls_recipient ON direct_calls(recipient_id, status, expires_at);
        CREATE INDEX friend_requests_recipient ON friend_requests(recipient_id, status);
        CREATE INDEX friend_requests_sender ON friend_requests(sender_id, status);
      `);
      for (const channel of db.prepare("SELECT * FROM channels WHERE kind = 'channel'").all()) {
        db.prepare('INSERT INTO workspaces (id, name, description, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').run(channel.id, channel.name, channel.description, channel.owner_id, channel.created_at);
        db.prepare('INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at) SELECT ?, user_id, role, joined_at FROM memberships WHERE channel_id = ?').run(channel.id, channel.id);
        db.prepare('INSERT INTO workspace_bans (workspace_id, user_id, banned_by, target_role, created_at) SELECT ?, user_id, banned_by, target_role, created_at FROM channel_bans WHERE channel_id = ?').run(channel.id, channel.id);
        db.prepare("UPDATE channels SET workspace_id = ?, label = name, legacy_voice_compatible = 1 WHERE id = ?").run(channel.id, channel.id);
        const voiceId = randomUUID();
        db.prepare("INSERT INTO channels (id, name, label, description, owner_id, kind, workspace_id, channel_type, created_at) VALUES (?, ?, ?, ?, ?, 'channel', ?, 'voice', ?)").run(voiceId, `channel:${voiceId}`, 'Общий', channel.description, channel.owner_id, channel.id, Number(channel.created_at) + 1);
        db.prepare('INSERT INTO memberships (channel_id, user_id, role, muted, joined_at) SELECT ?, user_id, role, muted, joined_at FROM memberships WHERE channel_id = ?').run(voiceId, channel.id);
        db.prepare('INSERT INTO channel_bans (channel_id, user_id, banned_by, target_role, created_at) SELECT ?, user_id, banned_by, target_role, created_at FROM channel_bans WHERE channel_id = ?').run(voiceId, channel.id);
        db.prepare('INSERT INTO channel_media_keys (channel_id, key, epoch, reset_pending) VALUES (?, ?, 1, 0)').run(voiceId, randomBytes(32).toString('base64url'));
      }
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run('workspaces-friends-v1', now);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
