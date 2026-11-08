import {
  AudioPlayerStatus, NoSubscriberBehavior, VoiceConnectionStatus, createAudioPlayer,
  createAudioResource, entersState, getVoiceConnection, joinVoiceChannel, StreamType
} from '@discordjs/voice';
import ytdlp from './ytdlp.cjs';

const sessions = new Map();
function getSession(guildId) {
  if (!sessions.has(guildId)) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const state = { player, connection: null, current: null, queue: [], channelId: null, stream: null };
    player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
    player.on('error', (error) => { console.error('[Música]', error.message); playNext(guildId); });
    sessions.set(guildId, state);
  }
  return sessions.get(guildId);
}

export async function connect(guild, voiceChannel) {
  const state = getSession(guild.id);
  if (state.connection?.joinConfig.channelId === voiceChannel.id) return state;
  state.connection?.destroy();
  const other = getVoiceConnection(guild.id); if (other && other !== state.connection) other.destroy();
  state.connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true, selfMute: false });
  state.connection.subscribe(state.player);
  state.channelId = voiceChannel.id;
  await entersState(state.connection, VoiceConnectionStatus.Ready, 20_000);
  return state;
}

async function playNext(guildId) {
  const state = getSession(guildId);
  state.stream?.kill(); state.stream = null;
  state.current = state.queue.shift() || null;
  if (!state.current) return;
  try {
    const source = await ytdlp.openStream(state.current.url);
    if (!sessions.has(guildId) || !state.current) { source.kill(); return; }
    state.stream = source;
    state.player.play(createAudioResource(source.stream, { inputType: StreamType.OggOpus }));
  } catch (error) { console.error('[Música]', error.message); setImmediate(() => playNext(guildId)); }
}

export async function enqueue(guild, voiceChannel, url, requestedBy) {
  if (!ytdlp.isYouTubeUrl(url)) throw new Error('Usa un enlace válido de YouTube.');
  const existing = sessions.get(guild.id);
  if (existing?.connection && existing.channelId !== voiceChannel.id) throw new Error('Ya estoy en otro canal de voz. Únete a mi canal para poner música.');
  const info = await ytdlp.resolveYouTubeUrl(url);
  const state = await connect(guild, voiceChannel);
  const track = { url, title: info.title.slice(0, 200), requestedBy };
  state.queue.push(track);
  if (!state.current) await playNext(guild.id);
  return track;
}

export function status(guildId) { const state = sessions.get(guildId); return state ? { current: state.current, queue: [...state.queue], channelId: state.channelId } : null; }
export function skip(guildId) { const state = sessions.get(guildId); return Boolean(state?.current && state.player.stop()); }
export function stop(guildId) { const state = sessions.get(guildId); if (!state) return false; state.queue = []; state.current = null; state.player.stop(true); return true; }
export function disconnect(guildId) { const state = sessions.get(guildId); if (!state) return false; state.stream?.kill(); state.connection?.destroy(); sessions.delete(guildId); return true; }
