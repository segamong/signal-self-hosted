const REACTIONS = new Set(['👍', '❤️', '😂', '🎉', '😮', '😢', '🔥', '👀']);
const SELECT_MESSAGE = 'SELECT messages.*, users.username, users.role FROM messages JOIN users ON users.id = messages.user_id';

function migrateMessageTools(db, now) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get('message-tools-v1')) {
      const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(column => column.name));
      if (!columns.has('edited_at')) db.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER');
      if (!columns.has('pinned')) db.exec('ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))');
      if (!columns.has('deleted_at')) db.exec('ALTER TABLE messages ADD COLUMN deleted_at INTEGER');
      db.exec(`
        CREATE TABLE IF NOT EXISTS message_reactions (
          message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          emoji TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (message_id, user_id, emoji)
        );
        CREATE INDEX IF NOT EXISTS message_reactions_user ON message_reactions(user_id, message_id);
        CREATE INDEX IF NOT EXISTS messages_pins ON messages(channel_id, id DESC) WHERE pinned = 1 AND deleted_at IS NULL;
      `);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run('message-tools-v1', now);
    }
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get('message-tools-v2')) {
      if (!db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'revision')) {
        db.exec('ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
      }
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run('message-tools-v2', now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function messageExtras(db, messageId) {
  const message = db.prepare('SELECT edited_at, pinned, revision FROM messages WHERE id = ?').get(messageId);
  const reactions = new Map();
  for (const row of db.prepare('SELECT emoji, user_id FROM message_reactions WHERE message_id = ? ORDER BY emoji, user_id').all(messageId)) {
    if (!reactions.has(row.emoji)) reactions.set(row.emoji, { emoji: row.emoji, count: 0, userIds: [] });
    const reaction = reactions.get(row.emoji);
    reaction.count += 1;
    reaction.userIds.push(row.user_id);
  }
  return {
    editedAt: message?.edited_at == null ? null : new Date(Number(message.edited_at)).toISOString(),
    pinned: Boolean(message?.pinned),
    revision: Number(message?.revision || 0),
    reactions: [...reactions.values()],
  };
}

export function installMessageTools({ app, db, requireAuth, getChannel, clock = Date.now, broadcastToChannel, HttpError }) {
  migrateMessageTools(db, clock());
  const messageDto = row => ({
    id: Number(row.id),
    channelId: row.channel_id,
    content: row.content,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    user: { id: row.user_id, username: row.username, displayName: row.username, role: row.role },
    ...messageExtras(db, row.id),
  });
  const messageById = (channelId, messageId) => db.prepare(`${SELECT_MESSAGE} WHERE messages.channel_id = ? AND messages.id = ? AND messages.deleted_at IS NULL`).get(channelId, messageId);

  app.get('/api/channels/:id/pins', requireAuth, (req, res) => {
    getChannel(req.params.id, req.auth.user.id);
    const rows = db.prepare(`${SELECT_MESSAGE} WHERE messages.channel_id = ? AND messages.pinned = 1 AND messages.deleted_at IS NULL ORDER BY messages.id DESC`).all(req.params.id);
    res.json({ messages: rows.map(messageDto) });
  });

  app.post('/api/channels/:id/messages/:messageId/action', requireAuth, (req, res) => {
    const userId = req.auth.user.id;
    const channel = getChannel(req.params.id, userId);
    if (!/^[1-9]\d{0,14}$/.test(req.params.messageId)) throw new HttpError(404, 'Сообщение не найдено.');
    const messageId = Number(req.params.messageId);
    const row = messageById(channel.id, messageId);
    if (!row) throw new HttpError(404, 'Сообщение не найдено.');
    const { action, content, emoji } = req.body || {};
    const canModerate = channel.role === 'owner' || channel.role === 'admin';
    if (!['edit', 'delete', 'pin', 'unpin', 'react'].includes(action)) throw new HttpError(400, 'Неизвестное действие с сообщением.');
    if (action === 'edit' && row.user_id !== userId) throw new HttpError(403, 'Редактировать можно только свои сообщения.');
    if (action === 'delete' && row.user_id !== userId && !canModerate) throw new HttpError(403, 'Нет прав для удаления этого сообщения.');
    if ((action === 'pin' || action === 'unpin') && !canModerate) throw new HttpError(403, 'Закреплять сообщения может администратор канала.');
    if (action === 'edit' && (typeof content !== 'string' || !content.trim() || content.trim().length > 4000)) throw new HttpError(400, 'Сообщение должно содержать от 1 до 4000 символов.');
    if (action === 'react' && !REACTIONS.has(emoji)) throw new HttpError(400, 'Выберите реакцию из списка.');

    db.exec('BEGIN IMMEDIATE');
    try {
      if (action === 'edit' && content.trim() !== row.content) db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content.trim(), clock(), messageId);
      if (action === 'delete') {
        db.prepare('UPDATE messages SET content = ?, deleted_at = ?, pinned = 0 WHERE id = ?').run('', clock(), messageId);
        db.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(messageId);
      }
      if (action === 'pin' || action === 'unpin') db.prepare('UPDATE messages SET pinned = ? WHERE id = ?').run(action === 'pin' ? 1 : 0, messageId);
      if (action === 'react') {
        const existing = db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(messageId, userId, emoji);
        if (existing) db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, userId, emoji);
        else db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(messageId, userId, emoji, clock());
      }
      db.prepare('UPDATE messages SET revision = revision + 1 WHERE id = ?').run(messageId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    if (action === 'delete') {
      const revision = Number(db.prepare('SELECT revision FROM messages WHERE id = ?').get(messageId).revision);
      broadcastToChannel(channel.id, { type: 'message-deleted', channelId: channel.id, messageId, revision });
      res.json({ deleted: true, messageId, channelId: channel.id, revision });
      return;
    }
    const message = messageDto(messageById(channel.id, messageId));
    broadcastToChannel(channel.id, { type: 'message-updated', message });
    res.json({ message });
  });
}
