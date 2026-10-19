import { randomUUID } from 'node:crypto';

export function installModerationRoutes(app, context) {
  const { db, clock, media, HttpError, requireAuth, sessionUser, getChannel, listMembers, broadcastChannels, broadcastInvitations, broadcastPresence, notifyModeration } = context;
  const running = new Map();
  let closed = false;
  const listBans = (channelId) => db.prepare('SELECT users.id, users.username FROM channel_bans JOIN users ON users.id = channel_bans.user_id WHERE channel_bans.channel_id = ? ORDER BY users.username COLLATE NOCASE').all(channelId);
  const requireManager = (channel) => { if (!['owner', 'admin'].includes(channel.role)) throw new HttpError(403, 'Нужны права администратора канала.'); };
  function transaction(callback) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function enqueue(channelId, userId, action) {
    db.prepare(`INSERT INTO media_moderation_jobs (id, channel_id, user_id, action, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (channel_id, user_id) DO UPDATE SET id = excluded.id, action = excluded.action, created_at = excluded.created_at`).run(randomUUID(), channelId, userId, action, clock());
  }
  async function applyJob(channelId, userId) {
    const key = `${channelId}:${userId}`;
    if (running.has(key)) { await running.get(key); return closed ? false : applyJob(channelId, userId); }
    const job = db.prepare('SELECT * FROM media_moderation_jobs WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
    if (!job) return true;
    const operation = (async () => {
      try {
        const membership = db.prepare('SELECT muted FROM memberships WHERE channel_id = ? AND user_id = ?').get(job.channel_id, job.user_id);
        const banned = db.prepare('SELECT 1 FROM channel_bans WHERE channel_id = ? AND user_id = ?').get(job.channel_id, job.user_id);
        const obsolete = (job.action === 'evict' && membership && !banned)
          || (['mute', 'unmute'].includes(job.action) && (!membership || banned || Boolean(membership.muted) !== (job.action === 'mute')));
        if (obsolete) { db.prepare('DELETE FROM media_moderation_jobs WHERE id = ?').run(job.id); return true; }
        if (media.configured) {
          const method = job.action === 'delete' ? 'deleteChannel' : job.action === 'evict' ? 'evict' : 'setMuted';
          if (typeof media[method] !== 'function') throw new Error('Media moderation unavailable');
          if (method === 'deleteChannel') await media.deleteChannel(job.channel_id);
          else if (method === 'evict') await media.evict(job.channel_id, job.user_id);
          else await media.setMuted(job.channel_id, job.user_id, job.action === 'mute');
        }
        db.prepare('DELETE FROM media_moderation_jobs WHERE id = ?').run(job.id);
        return true;
      } catch { return false; }
    })();
    running.set(key, operation);
    let applied;
    try { applied = await operation; } finally { running.delete(key); }
    if (!closed) {
      const newest = db.prepare('SELECT id FROM media_moderation_jobs WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
      if (newest && newest.id !== job.id) return applyJob(channelId, userId);
    }
    return applied;
  }
  async function drainJobs() {
    if (closed) return;
    const jobs = db.prepare('SELECT channel_id, user_id FROM media_moderation_jobs ORDER BY created_at LIMIT 100').all();
    await Promise.allSettled(jobs.map((job) => applyJob(job.channel_id, job.user_id)));
  }
  const retryTimer = setInterval(() => { void drainJobs().catch(() => {}); }, 5000);
  retryTimer.unref();
  void drainJobs().catch(() => {});

  app.get('/api/channels/:id/bans', requireAuth, (req, res) => {
    const channel = getChannel(req.params.id, req.auth.user.id);
    requireManager(channel);
    res.json({ bans: listBans(channel.id) });
  });
  app.post('/api/channels/:id/settings', requireAuth, (req, res) => {
    const channel = getChannel(req.params.id, req.auth.user.id);
    requireManager(channel);
    const name = req.body?.name === undefined ? channel.name : req.body.name;
    const description = req.body?.description === undefined ? channel.description : req.body.description;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 40 || typeof description !== 'string' || description.trim().length > 180) throw new HttpError(400, 'Название: 1–40 символов, описание: до 180 символов.');
    if (db.prepare('SELECT 1 FROM channels WHERE name = ? AND id <> ?').get(name.trim(), channel.id)) throw new HttpError(409, 'Канал с таким названием уже существует.');
    db.prepare('UPDATE channels SET name = ?, description = ? WHERE id = ?').run(name.trim(), description.trim(), channel.id);
    broadcastChannels();
    res.json({ channel: getChannel(channel.id, req.auth.user.id) });
  });
  app.post('/api/channels/:id/members/:userId', requireAuth, async (req, res) => {
    const channel = getChannel(req.params.id, req.auth.user.id);
    requireManager(channel);
    const { action } = req.body || {};
    if (!['promote', 'demote', 'kick', 'ban', 'unban', 'mute', 'unmute'].includes(action)) throw new HttpError(400, 'Неизвестное действие администратора.');
    const userId = req.params.userId;
    if (userId === channel.ownerId) throw new HttpError(403, 'Владелец канала защищён от модерации.');
    if (userId === req.auth.user.id) throw new HttpError(400, 'Для выхода из канала используйте «Покинуть канал».');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw new HttpError(404, 'Пользователь не найден.');
    const targetMembership = db.prepare('SELECT role FROM memberships WHERE channel_id = ? AND user_id = ?').get(channel.id, userId);
    const target = targetMembership || db.prepare('SELECT target_role AS role FROM channel_bans WHERE channel_id = ? AND user_id = ?').get(channel.id, userId);
    if (channel.role !== 'owner' && target?.role === 'admin') throw new HttpError(403, 'Администратор может модерировать только участников.');
    if (['promote', 'demote'].includes(action) && channel.role !== 'owner') throw new HttpError(403, 'Назначать и снимать администраторов может владелец канала.');
    if (['promote', 'demote', 'mute', 'unmute'].includes(action) && !targetMembership) throw new HttpError(404, 'Участник канала не найден.');
    transaction(() => {
      if (action === 'promote' || action === 'demote') db.prepare('UPDATE memberships SET role = ? WHERE channel_id = ? AND user_id = ?').run(action === 'promote' ? 'admin' : 'member', channel.id, userId);
      if (action === 'ban') db.prepare('INSERT OR IGNORE INTO channel_bans (channel_id, user_id, banned_by, target_role, created_at) VALUES (?, ?, ?, ?, ?)').run(channel.id, userId, req.auth.user.id, target?.role || 'member', clock());
      if (action === 'unban') db.prepare('DELETE FROM channel_bans WHERE channel_id = ? AND user_id = ?').run(channel.id, userId);
      if (action === 'kick' || action === 'ban') {
        db.prepare('DELETE FROM memberships WHERE channel_id = ? AND user_id = ?').run(channel.id, userId);
        db.prepare("UPDATE channel_invitations SET status = 'expired' WHERE channel_id = ? AND recipient_id = ? AND status = 'pending'").run(channel.id, userId);
        enqueue(channel.id, userId, 'evict');
      }
      if (action === 'mute' || action === 'unmute') {
        db.prepare('UPDATE memberships SET muted = ? WHERE channel_id = ? AND user_id = ?').run(action === 'mute' ? 1 : 0, channel.id, userId);
        enqueue(channel.id, userId, action);
      }
    });
    notifyModeration(channel.id, action, userId);
    broadcastChannels();
    broadcastInvitations(userId);
    broadcastPresence();
    const needsMedia = ['kick', 'ban', 'mute', 'unmute'].includes(action);
    if (needsMedia && !await applyJob(channel.id, userId)) throw new HttpError(503, 'Права сохранены. Медиасервер временно недоступен; действие будет применено автоматически.');
    if (!sessionUser(req)) throw new HttpError(401, 'Сессия завершена. Войдите снова.');
    requireManager(getChannel(channel.id, req.auth.user.id));
    res.json({ ok: true, members: listMembers(channel.id), bans: listBans(channel.id) });
  });
  app.post('/api/channels/:id/leave', requireAuth, async (req, res) => {
    const channel = getChannel(req.params.id, req.auth.user.id);
    if (channel.role === 'owner') throw new HttpError(403, 'Владелец может удалить канал; выйти из него нельзя.');
    transaction(() => {
      db.prepare('DELETE FROM memberships WHERE channel_id = ? AND user_id = ?').run(channel.id, req.auth.user.id);
      enqueue(channel.id, req.auth.user.id, 'evict');
    });
    notifyModeration(channel.id, 'leave', req.auth.user.id);
    broadcastChannels();
    broadcastPresence();
    if (!await applyJob(channel.id, req.auth.user.id)) throw new HttpError(503, 'Вы покинули канал. Отключение от медиасервера будет повторено автоматически.');
    res.json({ ok: true });
  });
  app.post('/api/channels/:id/delete', requireAuth, async (req, res) => {
    const channel = getChannel(req.params.id, req.auth.user.id);
    if (channel.role !== 'owner') throw new HttpError(403, 'Удалить канал может владелец.');
    const recipients = db.prepare('SELECT user_id AS id FROM memberships WHERE channel_id = ? UNION SELECT recipient_id AS id FROM channel_invitations WHERE channel_id = ?').all(channel.id, channel.id).map((row) => row.id);
    transaction(() => {
      db.prepare('DELETE FROM media_moderation_jobs WHERE channel_id = ?').run(channel.id);
      enqueue(channel.id, '', 'delete');
      db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);
    });
    notifyModeration(channel.id, 'delete', req.auth.user.id, recipients);
    broadcastChannels();
    for (const userId of recipients) broadcastInvitations(userId);
    broadcastPresence();
    if (!await applyJob(channel.id, '')) throw new HttpError(503, 'Канал удалён. Закрытие медиакомнаты будет повторено автоматически.');
    res.json({ ok: true });
  });
  return {
    async close() { closed = true; clearInterval(retryTimer); await Promise.allSettled([...running.values()]); },
  };
}
