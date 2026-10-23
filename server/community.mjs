import { randomBytes, randomUUID } from 'node:crypto';

const USERNAME = /^[a-zA-Z0-9_-]{3,32}$/;
const FRIEND_REQUEST_MS = 30 * 24 * 60 * 60 * 1000;
const RING_MS = 45_000;

export function createCommunityService(context) {
  const { app, db, clock, HttpError, requireAuth, enforceRate, sockets, sendClient, getChannel, listChannels, broadcastChannels, broadcastPresence, broadcastInvitations, rotateMediaKey, resetMediaRoom } = context;
  const transaction = (callback) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const account = (id) => db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
  const pair = (a, b) => [a, b].sort();
  const areFriends = (a, b) => Boolean(db.prepare('SELECT 1 FROM friendships WHERE first_user_id = ? AND second_user_id = ?').get(...pair(a, b)));
  const online = (id) => [...sockets.values()].some((client) => client.user.id === id && client.expiresAt > clock());
  const listWorkspaces = (userId) => db.prepare(`SELECT workspaces.id, workspaces.name, workspaces.description, workspaces.owner_id AS ownerId, workspace_memberships.role
    FROM workspaces JOIN workspace_memberships ON workspace_memberships.workspace_id = workspaces.id WHERE workspace_memberships.user_id = ?
      AND NOT EXISTS (SELECT 1 FROM workspace_bans WHERE workspace_bans.workspace_id = workspaces.id AND workspace_bans.user_id = workspace_memberships.user_id)
      ORDER BY workspaces.created_at, workspaces.id`).all(userId);
  const getWorkspace = (id, userId) => {
    const workspace = listWorkspaces(userId).find((item) => item.id === id);
    if (!workspace) throw new HttpError(404, 'Сервер не найден.');
    return workspace;
  };
  const scopedChannelIds = (channel) => channel.workspaceId
    ? db.prepare('SELECT id FROM channels WHERE workspace_id = ?').all(channel.workspaceId).map((row) => row.id) : [channel.id];
  function grantMembership(channelId, userId) {
    const channel = db.prepare('SELECT workspace_id FROM channels WHERE id = ?').get(channelId);
    const ids = channel?.workspace_id ? db.prepare('SELECT id FROM channels WHERE workspace_id = ?').all(channel.workspace_id).map((row) => row.id) : [channelId];
    if (channel?.workspace_id && db.prepare('SELECT 1 FROM workspace_bans WHERE workspace_id = ? AND user_id = ?').get(channel.workspace_id, userId) || ids.some((id) => db.prepare('SELECT 1 FROM channel_bans WHERE channel_id = ? AND user_id = ?').get(id, userId))) throw new HttpError(403, 'Доступ на этот сервер заблокирован.');
    if (channel?.workspace_id) db.prepare("INSERT OR IGNORE INTO workspace_memberships (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(channel.workspace_id, userId, clock());
    let changed = false;
    for (const id of ids) {
      if (db.prepare("INSERT OR IGNORE INTO memberships (channel_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(id, userId, clock()).changes) { rotateMediaKey(id); changed = true; }
    }
    if (channel?.workspace_id) db.prepare("UPDATE channel_invitations SET status = 'accepted', responded_at = ? WHERE recipient_id = ? AND status = 'pending' AND channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)").run(clock(), userId, channel.workspace_id);
    return changed;
  }
  const resetMembershipRooms = (channelId) => {
    const row = db.prepare('SELECT workspace_id AS workspaceId FROM channels WHERE id = ?').get(channelId);
    return Promise.allSettled(scopedChannelIds({ id: channelId, workspaceId: row?.workspaceId }).map(resetMediaRoom));
  };
  function broadcastWorkspaces(userId) {
    for (const [ws, client] of sockets) if (!userId || client.user.id === userId) sendClient(ws, client, { type: 'workspaces', workspaces: listWorkspaces(client.user.id) });
  }
  const friendRequestDto = (row, userId) => ({ id: row.id, user: account(row.sender_id === userId ? row.recipient_id : row.sender_id), createdAt: new Date(Number(row.created_at)).toISOString() });
  function listFriends(userId) {
    const friends = db.prepare(`SELECT users.id, users.username FROM friendships JOIN users ON users.id = CASE WHEN first_user_id = ? THEN second_user_id ELSE first_user_id END
      WHERE first_user_id = ? OR second_user_id = ? ORDER BY users.username COLLATE NOCASE`).all(userId, userId, userId).map((user) => ({ ...user, online: online(user.id) }));
    const pending = db.prepare("SELECT * FROM friend_requests WHERE status = 'pending' AND created_at > ? AND (sender_id = ? OR recipient_id = ?) ORDER BY created_at DESC, id").all(clock() - FRIEND_REQUEST_MS, userId, userId);
    return { friends, incoming: pending.filter((row) => row.recipient_id === userId).map((row) => friendRequestDto(row, userId)), outgoing: pending.filter((row) => row.sender_id === userId).map((row) => friendRequestDto(row, userId)) };
  }
  function broadcastFriends(userIds) {
    for (const [ws, client] of sockets) if (!userIds || userIds.includes(client.user.id)) sendClient(ws, client, { type: 'friends', ...listFriends(client.user.id) });
  }
  function ensureFriendConversation(userId, otherId) {
    if (!areFriends(userId, otherId)) throw new HttpError(403, 'Сначала добавьте пользователя в друзья и дождитесь принятия запроса.');
    const [first, second] = pair(userId, otherId);
    let row = db.prepare('SELECT channel_id FROM direct_conversations WHERE first_user_id = ? AND second_user_id = ?').get(first, second);
    let created = false;
    if (!row) {
      const id = randomUUID();
      db.prepare("INSERT INTO channels (id, name, description, created_at, kind) VALUES (?, ?, '', ?, 'direct')").run(id, `direct:${id}`, clock());
      db.prepare('INSERT INTO direct_conversations (channel_id, first_user_id, second_user_id) VALUES (?, ?, ?)').run(id, first, second);
      row = { channel_id: id }; created = true;
    }
    let changed = false;
    for (const id of [userId, otherId]) changed = Boolean(db.prepare("INSERT OR IGNORE INTO memberships (channel_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(row.channel_id, id, clock()).changes) || changed;
    db.prepare("UPDATE channel_invitations SET status = 'accepted', responded_at = ? WHERE channel_id = ? AND status = 'pending'").run(clock(), row.channel_id);
    if (changed && !created) rotateMediaKey(row.channel_id);
    return { channelId: row.channel_id, changed: changed && !created };
  }
  function callDto(row) {
    return { id: row.id, channelId: row.channel_id, caller: account(row.caller_id), recipient: account(row.recipient_id), status: row.status, createdAt: new Date(Number(row.created_at)).toISOString(), expiresAt: new Date(Number(row.expires_at)).toISOString() };
  }
  function broadcastCall(row) {
    for (const [ws, client] of sockets) if ([row.caller_id, row.recipient_id].includes(client.user.id)) {
      let channel;
      try { channel = getChannel(row.channel_id, client.user.id); } catch { /* Removed membership carries no channel data. */ }
      sendClient(ws, client, { type: 'direct-call', call: callDto(row), channel });
    }
  }
  function expireCalls() {
    for (const row of db.prepare("SELECT * FROM direct_calls WHERE status = 'pending' AND expires_at <= ?").all(clock())) {
      db.prepare("UPDATE direct_calls SET status = 'expired', responded_at = ? WHERE id = ? AND status = 'pending'").run(clock(), row.id);
      broadcastCall({ ...row, status: 'expired' });
    }
  }
  const listCalls = (userId) => db.prepare("SELECT * FROM direct_calls WHERE (caller_id = ? OR recipient_id = ?) AND ((status = 'pending' AND expires_at > ?) OR status = 'accepted') ORDER BY created_at DESC").all(userId, userId, clock()).map(callDto);
  function validateChannelInput(body) {
    const { name, description = '' } = body || {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 40 || typeof description !== 'string' || description.trim().length > 180) throw new HttpError(400, 'Название: 1–40 символов, описание: до 180 символов.');
    return { name: name.trim(), description: description.trim() };
  }
  function addChannel(workspace, data, type) {
    const id = randomUUID();
    if (db.prepare('SELECT 1 FROM channels WHERE workspace_id = ? AND label = ? AND channel_type = ?').get(workspace.id, data.name, type)) throw new HttpError(409, 'Такой канал уже есть на сервере.');
    db.prepare("INSERT INTO channels (id, name, label, description, owner_id, kind, workspace_id, channel_type, created_at) VALUES (?, ?, ?, ?, ?, 'channel', ?, ?, ?)").run(id, `channel:${id}`, data.name, data.description, workspace.ownerId, workspace.id, type, clock());
    db.prepare('INSERT INTO memberships (channel_id, user_id, role, joined_at) SELECT ?, user_id, role, joined_at FROM workspace_memberships WHERE workspace_id = ?').run(id, workspace.id);
    db.prepare('INSERT INTO channel_media_keys (channel_id, key, epoch, reset_pending) VALUES (?, ?, 1, 0)').run(id, randomBytes(32).toString('base64url'));
    // Bans are mirrored to every child, including children added afterwards.
    db.prepare(`INSERT OR IGNORE INTO channel_bans (channel_id, user_id, banned_by, target_role, created_at)
      SELECT ?, user_id, banned_by, target_role, created_at FROM workspace_bans WHERE workspace_id = ?`).run(id, workspace.id);
    return id;
  }
  function createWorkspace(userId, body) {
    const data = validateChannelInput(body);
    const workspace = { id: randomUUID(), ...data, ownerId: userId, role: 'owner' };
    transaction(() => {
      db.prepare('INSERT INTO workspaces (id, name, description, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').run(workspace.id, workspace.name, workspace.description, userId, clock());
      db.prepare("INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(workspace.id, userId, clock());
      addChannel(workspace, { name: 'общий', description: workspace.description }, 'text');
      addChannel(workspace, { name: 'Общий', description: workspace.description }, 'voice');
    });
    broadcastChannels(userId); broadcastPresence();
    return { workspace, channels: listChannels(userId).filter((channel) => channel.workspaceId === workspace.id) };
  }
  function installRoutes() {
    app.get('/api/workspaces', requireAuth, (req, res) => res.json({ workspaces: listWorkspaces(req.auth.user.id) }));
    app.post('/api/workspaces', requireAuth, (req, res) => { enforceRate(`workspaces:${req.auth.user.id}`, 10, 60_000); res.status(201).json(createWorkspace(req.auth.user.id, req.body)); });
    app.post('/api/workspaces/:id/channels', requireAuth, (req, res) => {
      enforceRate(`channels:${req.auth.user.id}`, 20, 60_000);
      const workspace = getWorkspace(req.params.id, req.auth.user.id);
      if (!['owner', 'admin'].includes(workspace.role)) throw new HttpError(403, 'Создавать каналы может администратор сервера.');
      const type = req.body?.type;
      if (!['text', 'voice'].includes(type)) throw new HttpError(400, 'Выберите текстовый или голосовой канал.');
      const id = transaction(() => addChannel(workspace, validateChannelInput(req.body), type));
      broadcastChannels(); res.status(201).json({ channel: getChannel(id, req.auth.user.id) });
    });
    app.get('/api/friends', requireAuth, (req, res) => res.json(listFriends(req.auth.user.id)));
    app.post('/api/friend-requests', requireAuth, (req, res) => {
      enforceRate(`friend-requests:${req.auth.user.id}`, 20, 60_000);
      const username = typeof req.body?.username === 'string' ? req.body.username.trim().replace(/^@/, '').toLowerCase() : '';
      if (!USERNAME.test(username)) throw new HttpError(400, 'Введите никнейм пользователя.');
      const recipient = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
      const senderId = req.auth.user.id;
      if (!recipient) throw new HttpError(404, 'Пользователь не найден.');
      if (recipient.id === senderId) throw new HttpError(400, 'Нельзя добавить в друзья себя.');
      if (areFriends(senderId, recipient.id)) throw new HttpError(409, 'Вы уже друзья.');
      db.prepare("UPDATE friend_requests SET status = 'cancelled', responded_at = ? WHERE status = 'pending' AND created_at <= ?").run(clock(), clock() - FRIEND_REQUEST_MS);
      const pending = db.prepare("SELECT * FROM friend_requests WHERE status = 'pending' AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))").get(senderId, recipient.id, recipient.id, senderId);
      if (pending) {
        broadcastFriends([senderId, recipient.id]);
        return res.json({ request: friendRequestDto(pending, senderId), requiresAcceptance: pending.recipient_id === senderId, ...listFriends(senderId) });
      }
      const id = randomUUID();
      db.prepare("INSERT INTO friend_requests (id, sender_id, recipient_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(id, senderId, recipient.id, clock());
      broadcastFriends([senderId, recipient.id]);
      res.status(201).json({ request: friendRequestDto(db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(id), senderId), ...listFriends(senderId) });
    });
    app.post('/api/friend-requests/:id/respond', requireAuth, (req, res) => {
      const action = req.body?.action, userId = req.auth.user.id;
      if (!['accept', 'decline', 'cancel'].includes(action)) throw new HttpError(400, 'Неизвестное действие.');
      const row = db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(req.params.id);
      if (!row || (action === 'cancel' ? row.sender_id !== userId : row.recipient_id !== userId)) throw new HttpError(404, 'Запрос не найден.');
      const status = { accept: 'accepted', decline: 'declined', cancel: 'cancelled' }[action];
      if (row.status !== 'pending' && row.status !== status) throw new HttpError(409, 'На запрос уже дан ответ.');
      if (row.status === 'pending' && Number(row.created_at) <= clock() - FRIEND_REQUEST_MS) throw new HttpError(409, 'Срок запроса истёк. Отправьте новый.');
      transaction(() => {
        if (row.status === 'pending') db.prepare('UPDATE friend_requests SET status = ?, responded_at = ? WHERE id = ?').run(status, clock(), row.id);
        if (row.status === 'pending' && status === 'accepted') db.prepare('INSERT OR IGNORE INTO friendships (first_user_id, second_user_id, created_at) VALUES (?, ?, ?)').run(...pair(row.sender_id, row.recipient_id), clock());
      });
      broadcastFriends([row.sender_id, row.recipient_id]); broadcastPresence();
      res.json({ ok: true, ...listFriends(userId) });
    });
    app.post('/api/friends/:userId/remove', requireAuth, (req, res) => {
      const ownId = req.auth.user.id, otherId = req.params.userId;
      const calls = transaction(() => {
        db.prepare('DELETE FROM friendships WHERE first_user_id = ? AND second_user_id = ?').run(...pair(ownId, otherId));
        const active = db.prepare("SELECT * FROM direct_calls WHERE status IN ('pending', 'accepted') AND ((caller_id = ? AND recipient_id = ?) OR (caller_id = ? AND recipient_id = ?))").all(ownId, otherId, otherId, ownId);
        for (const call of active) db.prepare("UPDATE direct_calls SET status = 'ended', responded_at = ? WHERE id = ?").run(clock(), call.id);
        return active;
      });
      for (const call of calls) broadcastCall({ ...call, status: 'ended' });
      broadcastFriends([ownId, otherId]); broadcastPresence(); res.json({ ok: true, ...listFriends(ownId) });
    });
    app.get('/api/direct-calls', requireAuth, (req, res) => { expireCalls(); res.json({ calls: listCalls(req.auth.user.id) }); });
    app.post('/api/direct-calls', requireAuth, async (req, res) => {
      enforceRate(`direct-calls:${req.auth.user.id}`, 15, 60_000); expireCalls();
      const ownId = req.auth.user.id, otherId = req.body?.userId;
      if (typeof otherId !== 'string' || ownId === otherId || !account(otherId)) throw new HttpError(404, 'Друг не найден.');
      if (!areFriends(ownId, otherId)) throw new HttpError(403, 'Сначала добавьте пользователя в друзья и дождитесь принятия запроса.');
      const existing = db.prepare("SELECT * FROM direct_calls WHERE status = 'pending' AND ((caller_id = ? AND recipient_id = ?) OR (caller_id = ? AND recipient_id = ?))").get(ownId, otherId, otherId, ownId);
      if (existing) return res.json({ call: callDto(existing), channel: getChannel(existing.channel_id, ownId) });
      let conversation, row;
      transaction(() => {
        conversation = ensureFriendConversation(ownId, otherId);
        // A completed UI call must not leave accepted ringing state forever.
        db.prepare("UPDATE direct_calls SET status = 'ended', responded_at = ? WHERE channel_id = ? AND status = 'accepted'").run(clock(), conversation.channelId);
        const id = randomUUID(), now = clock();
        db.prepare("INSERT INTO direct_calls (id, channel_id, caller_id, recipient_id, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(id, conversation.channelId, ownId, otherId, now, now + RING_MS);
        row = db.prepare('SELECT * FROM direct_calls WHERE id = ?').get(id);
      });
      broadcastChannels(ownId); broadcastChannels(otherId); broadcastInvitations(ownId); broadcastInvitations(otherId); broadcastPresence();
      if (conversation.changed && !await resetMediaRoom(conversation.channelId)) {
        db.prepare("UPDATE direct_calls SET status = 'ended', responded_at = ? WHERE id = ? AND status = 'pending'").run(clock(), row.id);
        broadcastCall(db.prepare('SELECT * FROM direct_calls WHERE id = ?').get(row.id));
        throw new HttpError(503, 'Не удалось обновить защищённую комнату. Повторите звонок.');
      }
      // Reset awaits network I/O: a cancellation, acceptance or removal may have
      // happened while it ran. Never resurrect an earlier pending notification.
      row = db.prepare('SELECT * FROM direct_calls WHERE id = ?').get(row.id);
      broadcastCall(row); res.status(201).json({ call: callDto(row), channel: getChannel(row.channel_id, ownId) });
    });
    app.post('/api/direct-calls/:id/respond', requireAuth, (req, res) => {
      expireCalls(); const action = req.body?.action, ownId = req.auth.user.id;
      if (!['accept', 'decline', 'cancel', 'end'].includes(action)) throw new HttpError(400, 'Неизвестное действие со звонком.');
      const row = db.prepare('SELECT * FROM direct_calls WHERE id = ?').get(req.params.id);
      if (!row || ![row.caller_id, row.recipient_id].includes(ownId)) throw new HttpError(404, 'Звонок не найден.');
      if (['accept', 'decline'].includes(action) && row.recipient_id !== ownId || action === 'cancel' && row.caller_id !== ownId) throw new HttpError(403, 'Это действие недоступно.');
      const status = { accept: 'accepted', decline: 'declined', cancel: 'cancelled', end: 'ended' }[action];
      if (row.status !== status && (action === 'end' ? !['pending', 'accepted'].includes(row.status) : row.status !== 'pending')) throw new HttpError(409, 'Звонок уже завершён или на него уже ответили.');
      if (action === 'accept') {
        if (!areFriends(row.caller_id, row.recipient_id)) throw new HttpError(403, 'Пользователь больше не в друзьях.');
        getChannel(row.channel_id, ownId); getChannel(row.channel_id, row.caller_id);
      }
      db.prepare('UPDATE direct_calls SET status = ?, responded_at = ? WHERE id = ?').run(status, clock(), row.id);
      const updated = { ...row, status }; broadcastCall(updated);
      let channel;
      try { channel = getChannel(row.channel_id, ownId); } catch { /* Ending a removed conversation still succeeds. */ }
      res.json({ call: callDto(updated), channel });
    });
  }
  const callTimer = setInterval(expireCalls, 5000); callTimer.unref();
  return { installRoutes, areFriends, listFriends, broadcastFriends, listWorkspaces, broadcastWorkspaces, listCalls, createWorkspace, scopedChannelIds, grantMembership, resetMembershipRooms, ensureFriendConversation,
    close() { clearInterval(callTimer); } };
}
