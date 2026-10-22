import { AccessToken, RoomServiceClient, TrackSource, TokenVerifier } from 'livekit-server-sdk';

export const MAX_PARTICIPANTS = 10;

export function createMedia(env, dependencies = {}) {
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET || env.LIVEKIT_SECRET;
  const publicUrl = env.LIVEKIT_PUBLIC_URL;
  const configured = Boolean(apiKey && apiSecret && publicUrl);
  if (!configured) return { configured: false };
  const publicProtocol = new URL(publicUrl).protocol;
  if (!['ws:', 'wss:'].includes(publicProtocol)) throw new Error('LIVEKIT_PUBLIC_URL должен начинаться с ws:// или wss://');
  if (env.NODE_ENV === 'production' && publicProtocol !== 'wss:') throw new Error('В production требуется LIVEKIT_PUBLIC_URL с wss://');
  const rooms = dependencies.rooms || new RoomServiceClient(env.LIVEKIT_URL || 'http://127.0.0.1:7880', apiKey, apiSecret, { requestTimeout: 5 });
  const Token = dependencies.AccessToken || AccessToken;
  const verifier = dependencies.TokenVerifier || new TokenVerifier(apiKey, apiSecret);
  const publishSources = [TrackSource.CAMERA, TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];
  return {
    configured: true,
    async verifyAccessToken(token) { return verifier.verify(token, 0); },
    async join(channel, user) {
      const capacity = channel.kind === 'direct' ? 2 : MAX_PARTICIPANTS;
      // The SFU enforces this capacity even when several clients join at once.
      await rooms.createRoom({ name: channel.id, maxParticipants: capacity, emptyTimeout: 300, departureTimeout: 30 });
      const participants = await rooms.listParticipants(channel.id);
      if (participants.length >= capacity && !participants.some((p) => p.identity === user.id)) {
        const error = new Error(`Канал заполнен: максимум ${capacity} ${capacity === 2 ? 'участника' : 'участников'}.`);
        error.status = 409;
        throw error;
      }
      const token = new Token(apiKey, apiSecret, {
        identity: user.id, name: user.username || 'Участник', metadata: JSON.stringify({ username: user.username || 'Участник', encryptionEpoch: channel.encryptionEpoch }), ttl: '5m',
      });
      token.addGrant({
        roomJoin: true, room: channel.id,
        canPublish: !channel.muted, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false,
        // Non-empty source grants override canPublish in LiveKit. Muted grants
        // must clear that list as well as disabling canPublish.
        canPublishSources: channel.muted ? [] : publishSources,
      });
      return { url: publicUrl, token: await token.toJwt() };
    },
    async status(channels) {
      const activeRooms = await rooms.listRooms(channels.map((c) => c.id));
      return Promise.all(activeRooms.map(async (room) => ({
        id: room.name,
        // Public labels are resolved from the account database by the API. Old
        // connected clients may still have a real name stored in SFU metadata.
        participants: (await rooms.listParticipants(room.name)).map((p) => ({ id: p.identity })),
      })));
    },
    async syncUsernames(accounts, channelIds) {
      if (!channelIds.length || !accounts.length) return;
      const usernames = new Map(accounts.map((account) => [account.id, account.username]));
      const allowedRooms = new Set(channelIds);
      const activeRooms = (await rooms.listRooms(channelIds)).filter((room) => allowedRooms.has(room.name));
      const outcomes = await Promise.allSettled(activeRooms.map(async (room) => {
        const updates = await Promise.allSettled((await rooms.listParticipants(room.name)).map(async (participant) => {
          const username = usernames.get(participant.identity);
          if (!username) return;
          // Epoch binds a grant to its membership generation; it is not a key.
          let epoch;
          try { epoch = JSON.parse(participant.metadata || '{}').encryptionEpoch; } catch { /* Legacy token. */ }
          const metadata = JSON.stringify({ username, ...(typeof epoch === 'string' ? { encryptionEpoch: epoch } : {}) });
          if (participant.name !== username || participant.metadata !== metadata) {
            await rooms.updateParticipant(room.name, participant.identity, { name: username, metadata });
          }
        }));
        if (updates.some((update) => update.status === 'rejected')) throw new Error('Не все подписи участников комнаты обновлены.');
      }));
      if (outcomes.some((outcome) => outcome.status === 'rejected')) throw new Error('Не все подписи участников обновлены.');
    },
    async evict(channelId, userId) {
      try { await rooms.removeParticipant(channelId, userId); }
      catch (error) { if (error.code !== 'not_found') throw error; }
    },
    async setMuted(channelId, userId, muted) {
      try {
        await rooms.updateParticipant(channelId, userId, { permission: {
          canSubscribe: true, canPublish: !muted, canPublishData: false,
          canPublishSources: muted ? [] : publishSources, canUpdateMetadata: false,
        } });
      } catch (error) { if (error.code !== 'not_found') throw error; }
    },
    async deleteChannel(channelId) {
      try { await rooms.deleteRoom(channelId); }
      catch (error) { if (error.code !== 'not_found') throw error; }
    },
  };
}
