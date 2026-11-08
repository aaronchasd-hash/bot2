const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Transform, PassThrough } = require('stream');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

const PREBUFFER_BYTES = 256 * 1024;      // colchón inicial (~32 s a 64 kbps)
const PREBUFFER_TIMEOUT_MS = 10_000;
const YOUTUBE_PREBUFFER_TIMEOUT_MS = 20_000;
const DEFAULT_BITRATE = 64;

const YOUTUBE_URL = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?|shorts\/|embed\/|live\/)|youtu\.be\/)/i;
const YOUTUBE_CLIENTS = process.env.YOUTUBE_CLIENTS || 'mweb,web_embedded,android';
const YTDLP_PLUGIN_DIR = process.env.YTDLP_PLUGIN_DIR || '/opt/yt-dlp-plugins';
const POT_PLUGIN_ZIP = path.join(YTDLP_PLUGIN_DIR, 'bgutil-ytdlp-pot-provider.zip');
const HAS_POT_PLUGIN = fs.existsSync(POT_PLUGIN_ZIP);
const POT_PROVIDER_URL = process.env.YTDLP_POT_PROVIDER_URL || '';

const USER_AGENT = process.env.YTDLP_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function resolveYtDlp() {
    if (process.env.YTDLP_PATH && fs.existsSync(process.env.YTDLP_PATH)) {
        return process.env.YTDLP_PATH;
    }

    const local = path.join(BIN_DIR, BIN_NAME);
    if (fs.existsSync(local)) return local;

    return process.env.YTDLP_PATH || 'yt-dlp';
}

const YTDLP = resolveYtDlp();

function resolveFfmpeg() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;

    // En Linux (Railway/Docker) conviene el ffmpeg del sistema: el binario
    // empaquetado por @ffmpeg-installer es de 2018 y puede fallar con streams
    // modernos. En Windows se usa el instalador si no hay ffmpeg.
    try {
        const probe = spawnSync('ffmpeg', ['-version'], {
            windowsHide: true,
            timeout: 3000,
            stdio: 'ignore'
        });
        if (probe.status === 0) return 'ffmpeg';
    } catch {
        // ffmpeg no está en PATH: seguimos con el instalador.
    }

    try {
        return require('@ffmpeg-installer/ffmpeg').path;
    } catch {
        return 'ffmpeg';
    }
}

const FFMPEG = resolveFfmpeg();

function clampBitrate(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_BITRATE;
    return Math.min(Math.max(Math.round(numeric), 32), 128);
}

function isUrl(text) {
    return /^https?:\/\//i.test(text);
}

function isYouTubeUrl(value) {
    return YOUTUBE_URL.test(String(value || '').trim());
}

/**
 * yt-dlp necesita el plugin de PO Token y un runtime de JavaScript para
 * obtener formatos de YouTube desde una IP de datacenter. Sin el plugin,
 * YouTube se intenta igualmente y el manager cae a SoundCloud si falla.
 */
function youtubeArgs() {
    const args = [];

    if (!HAS_POT_PLUGIN) return args;

    args.push(
        '--plugin-dirs', YTDLP_PLUGIN_DIR,
        '--js-runtimes', process.env.YTDLP_JS_RUNTIME || 'node'
    );

    if (POT_PROVIDER_URL) {
        args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${POT_PROVIDER_URL}`);
    }

    args.push('--extractor-args', `youtube:player_client=${YOUTUBE_CLIENTS}`);
    return args;
}

function classifyError(error) {
    const message = error?.message || '';

    if (/DRM protected|DRM/i.test(message)) {
        error.code = 'DRM';
    } else if (/Sign in to confirm|not a bot|HTTP Error 429|Too Many Requests/i.test(message)) {
        error.code = 'YOUTUBE_BLOCKED';
    } else if (/403|Forbidden/i.test(message)) {
        error.code = 'FORBIDDEN';
    }

    return error;
}

function run(args, { timeout = 60_000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(YTDLP, args, { windowsHide: true });

        let stdout = '';
        let stderr = '';
        let finished = false;

        const timer = setTimeout(() => {
            if (finished) return;
            finished = true;
            child.kill('SIGKILL');
            reject(new Error('yt-dlp tardó demasiado en responder'));
        }, timeout);

        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });

        child.on('error', (err) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            reject(
                err.code === 'ENOENT'
                    ? new Error('yt-dlp no está instalado. Coloca yt-dlp en bin/ o define YTDLP_PATH.')
                    : err
            );
        });

        child.on('close', (code) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);

            if (code !== 0) {
                return reject(classifyError(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `yt-dlp salió con código ${code}`)));
            }

            resolve(stdout);
        });
    });
}

function normalize(entry) {
    const url = entry.webpage_url || entry.original_url || entry.url || null;

    return {
        id: entry.id || url,
        title: entry.title || entry.track || 'Desconocido',
        url,
        duration: Number.isFinite(entry.duration) ? entry.duration : null,
        thumbnail: entry.thumbnail || entry.thumbnails?.at(-1)?.url || null,
        uploader: entry.uploader || entry.channel || entry.artist || entry.artists?.join(', ') || 'Desconocido',
        isLive: entry.is_live === true || entry.live_status === 'is_live'
    };
}

function normalizeSoundCloud(entry) {
    const track = normalize(entry);
    return {
        ...track,
        id: `sc:${entry.id || track.url}`,
        url: track.url,
        source: 'soundcloud'
    };
}

function normalizeYouTube(entry) {
    const track = normalize(entry);
    const id = entry.id || null;
    const url = entry.webpage_url
        || entry.original_url
        || (id ? `https://www.youtube.com/watch?v=${id}` : track.url);

    return {
        ...track,
        id: `yt:${id || url}`,
        url,
        source: 'youtube'
    };
}

function youtubeScore(track, expected = {}) {
    const title = normalizeForMatch(track.title);
    const uploader = normalizeForMatch(track.uploader);
    const combined = `${title} ${uploader}`;
    const wantedTitle = normalizeForMatch(expected.title);
    const wantedArtist = normalizeForMatch(expected.artist);
    let score = 0;

    if (wantedTitle) {
        if (title === wantedTitle) score += 8;
        else if (title.includes(wantedTitle) || wantedTitle.includes(title)) score += 5;
        else score -= 2;
    }

    if (wantedArtist) {
        if (uploader === wantedArtist) score += 4;
        else if (uploader.includes(wantedArtist) || wantedArtist.includes(uploader)) score += 3;
        else if (combined.includes(wantedArtist)) score += 2;
    }

    if (/\b(official|oficial|topic)\b/.test(combined)) score += 1;
    if (/\b(cover|karaoke|remix|nightcore|sped up|slowed|instrumental|tutorial|reaction)\b/.test(title)) score -= 6;
    if (/\b(en vivo|live)\b/.test(title)) score -= 4;

    if (expected.duration && track.duration) {
        const difference = Math.abs(track.duration - expected.duration);
        if (difference <= 3) score += 3;
        else if (difference <= 10) score += 1;
        else if (difference > 60) score -= 1;
    }

    if (track.isLive) score -= 10;
    return score;
}

/**
 * Busca videos en YouTube. La búsqueda no necesita PO Token; el token se
 * pide al abrir el audio. Se ordenan los resultados para preferir la versión
 * oficial y descartar covers, directos y versiones aceleradas.
 */
async function searchYouTube(query, {
    limit = 10,
    minDuration = 20,
    expectedTitle = null,
    expectedArtist = null,
    expectedDuration = null
} = {}) {
    const target = `ytsearch${Math.min(Math.max(Math.round(limit), 1), 20)}:${query}`;
    const raw = await run([
        '-J',
        ...youtubeArgs(),
        '--no-warnings',
        '--no-progress',
        '--no-playlist',
        '--flat-playlist',
        target
    ], { timeout: 90_000 });

    const json = JSON.parse(raw);
    const entries = (json.entries || [json]).filter(Boolean);
    const expected = {
        title: expectedTitle,
        artist: expectedArtist,
        duration: expectedDuration
    };

    const candidates = entries
        .map(normalizeYouTube)
        .filter((track) => track.url && (!track.duration || track.duration >= minDuration))
        .filter((track) => !track.isLive)
        .map((track) => ({ track, score: youtubeScore(track, expected) }))
        .sort((left, right) => right.score - left.score)
        .map(({ track }) => track);

    if (!candidates.length) {
        throw noPlayableError('No encontré una versión reproducible en YouTube.');
    }

    return candidates;
}

async function resolveYouTubeUrl(url) {
    const raw = await run([
        '-J',
        ...youtubeArgs(),
        '--no-warnings',
        '--no-progress',
        '--no-playlist',
        url
    ], { timeout: 90_000 });

    const json = JSON.parse(raw);
    const entry = (json.entries || [json]).filter(Boolean)[0];

    if (!entry) {
        throw noPlayableError('No pude leer ese video de YouTube.');
    }

    return normalizeYouTube(entry);
}

function isDrmError(error) {
    return error?.code === 'DRM' || /DRM protected/i.test(error?.message || '');
}

function normalizeForMatch(text) {
    return String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function titleMatches(candidate, expected) {
    const left = normalizeForMatch(candidate);
    const right = normalizeForMatch(expected);
    if (!left || !right) return true;
    return left.includes(right) || right.includes(left);
}

function noPlayableError(message) {
    const error = new Error(message);
    error.code = 'NO_PLAYABLE';
    return error;
}

/**
 * Busca en SoundCloud y devuelve la primera versión que yt-dlp puede abrir.
 * Se prueba cada resultado porque las pistas oficiales suelen tener DRM.
 */
async function searchSoundCloud(query, { limit = 10, probe = true, minDuration = 20, probeTimeout = 20_000, expectedTitle = null } = {}) {
    const target = `scsearch${Math.min(Math.max(Math.round(limit), 1), 30)}:${query}`;
    const raw = await run([
        '-J',
        '--no-warnings',
        '--no-progress',
        '--no-playlist',
        '--flat-playlist',
        target
    ]);

    const json = JSON.parse(raw);
    const entries = (json.entries || [json]).filter(Boolean);
    const candidates = entries
        .map(normalizeSoundCloud)
        .filter((track) => track.url && (!track.duration || track.duration >= minDuration))
        .filter((track) => !expectedTitle || titleMatches(track.title, expectedTitle));

    if (!candidates.length) {
        throw noPlayableError('No encontré una versión que coincida en SoundCloud.');
    }

    if (!probe) return candidates;

    let nonDrmCandidate = null;

    for (const track of candidates) {
        if (!track.url) continue;

        try {
            track.directUrl = await extractDirectUrl(track.url, { timeout: probeTimeout });
            return [track];
        } catch (error) {
            if (process.env.MUSIC_DEBUG) {
                console.error(`[SoundCloud] ${track.title}: ${error.message}`);
            }

            // Un fallo de red no significa que la pista sea inútil. Si no
            // aparece ninguna versión válida, se intentará abrir esta después.
            if (!isDrmError(error) && !nonDrmCandidate) nonDrmCandidate = track;
        }
    }

    if (nonDrmCandidate) return [nonDrmCandidate];

    throw noPlayableError('Las versiones encontradas en SoundCloud tienen DRM. Prueba con otro nombre o enlace.');
}

async function resolveSoundCloudUrl(url) {
    const raw = await run([
        '-J',
        '--no-warnings',
        '--no-progress',
        '--no-playlist',
        url
    ]);

    const json = JSON.parse(raw);
    const entry = (json.entries || [json]).filter(Boolean)[0];

    if (!entry) {
        throw noPlayableError('No pude leer esa canción de SoundCloud.');
    }

    const track = normalizeSoundCloud(entry);
    track.url = track.url || url;

    try {
        track.directUrl = await extractDirectUrl(url, { timeout: 30_000 });
    } catch (error) {
        if (isDrmError(error)) {
            throw noPlayableError('Esa versión de SoundCloud tiene DRM. Prueba con otro enlace.');
        }
        throw error;
    }

    return track;
}

/**
 * Obtiene la URL directa del audio de una pista de SoundCloud.
 */
async function extractDirectUrl(url, { timeout = 45_000 } = {}) {
    const raw = await run([
        '-g',
        '-f', 'bestaudio/best',
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        url
    ], { timeout });

    const candidate = raw
        .split('\n')
        .map((line) => line.trim())
        .find((line) => /^https?:\/\//i.test(line));

    if (!candidate) {
        throw new Error('yt-dlp no devolvió una URL de audio válida');
    }

    return candidate;
}

async function getDirectUrl(url, options = {}) {
    return extractDirectUrl(url, options);
}

function startTranscoder(directUrl, { seek = 0, bitrateKbps = DEFAULT_BITRATE, volume = 1 } = {}) {
    return new Promise((resolve, reject) => {
        const bitrate = clampBitrate(bitrateKbps);
        const gain = Math.min(Math.max(Number(volume) || 0, 0), 2);
        const referer = /soundcloud\.(?:com|cloud)|sndcdn\.com/i.test(directUrl)
            ? 'https://soundcloud.com/'
            : null;

        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            '-nostdin',
            '-user_agent', USER_AGENT,
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-rw_timeout', '15000000',
            '-analyzeduration', '1000000',
            '-probesize', '1048576'
        ];

        if (referer) args.push('-referer', referer);

        if (seek > 0) args.push('-ss', String(seek));

        args.push('-i', directUrl);

        if (gain !== 1) args.push('-af', `volume=${gain.toFixed(3)}`);

        args.push(
            '-vn', '-sn', '-dn',
            '-c:a', 'libopus',
            '-b:a', `${bitrate}k`,
            '-ar', '48000',
            '-ac', '2',
            '-application', 'audio',
            '-frame_duration', '20',
            '-compression_level', '10',
            '-f', 'ogg',
            'pipe:1'
        );

        const transcoder = spawn(FFMPEG, args, { windowsHide: true });

        let stderr = '';
        let received = 0;
        let settled = false;

        const buffer = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });

        const counter = new Transform({
            transform(chunk, _encoding, callback) {
                received += chunk.length;
                if (!settled && received >= PREBUFFER_BYTES) start();
                callback(null, chunk);
            }
        });

        const cleanup = () => {
            clearTimeout(prebufferTimer);
            transcoder.removeListener('close', onClose);
            transcoder.removeListener('error', onError);
        };

        const start = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({
                stream: buffer,
                bitrate,
                directUrl,
                kill: () => {
                    try { transcoder.kill('SIGKILL'); } catch {}
                    try { buffer.destroy(); } catch {}
                }
            });
        };

        const fail = (message) => {
            if (settled) return;
            settled = true;
            cleanup();
            try { transcoder.kill('SIGKILL'); } catch {}
            try { buffer.destroy(); } catch {}
            reject(new Error(message));
        };

        const onClose = (code) => {
            if (settled) return;

            // Si ya llegó audio, dejamos que el recurso lo consuma hasta el final.
            if (received > 0) return start();

            fail(code === 0
                ? 'El audio terminó antes de empezar'
                : `ffmpeg falló (${code}): ${stderr.trim().split('\n').slice(-2).join(' ')}`);
        };

        const onError = (error) => {
            fail(
                error.code === 'ENOENT'
                    ? 'No encontré ffmpeg. Define FFMPEG_PATH.'
                    : error.message
            );
        };

        const prebufferTimer = setTimeout(() => {
            if (received > 0) return start();
            fail('No se pudo iniciar el audio a tiempo');
        }, PREBUFFER_TIMEOUT_MS);

        transcoder.stderr.on('data', (d) => { stderr += d.toString(); });
        transcoder.on('close', onClose);
        transcoder.on('error', onError);
        transcoder.stdout.on('error', () => {});

        transcoder.stdout.pipe(counter).pipe(buffer);
    });
}

/**
 * YouTube devuelve cabeceras y cookies de sesión que FFmpeg no replica.
 * Por eso yt-dlp descarga el audio y lo entrega por stdout a FFmpeg, que
 * sigue haciendo la conversión a Ogg/Opus de 64 kbps.
 */
function startYouTubeTranscoder(url, { seek = 0, bitrateKbps = DEFAULT_BITRATE, volume = 1 } = {}) {
    return new Promise((resolve, reject) => {
        const bitrate = clampBitrate(bitrateKbps);
        const gain = Math.min(Math.max(Number(volume) || 0, 0), 2);
        const startSeconds = Math.max(0, Math.floor(Number(seek) || 0));

        const ytArgs = [
            ...youtubeArgs(),
            '-f', 'bestaudio[acodec=opus]/bestaudio/best',
            '--no-playlist',
            '--no-warnings',
            '--no-progress',
            ...(startSeconds > 0 ? ['--download-sections', `*${startSeconds}-`] : []),
            '-o', '-',
            url
        ];

        const ffmpegArgs = [
            '-hide_banner',
            '-loglevel', 'error',
            '-nostdin',
            '-analyzeduration', '1000000',
            '-probesize', '1048576',
            '-i', 'pipe:0'
        ];

        if (gain !== 1) ffmpegArgs.push('-af', `volume=${gain.toFixed(3)}`);

        ffmpegArgs.push(
            '-vn', '-sn', '-dn',
            '-c:a', 'libopus',
            '-b:a', `${bitrate}k`,
            '-ar', '48000',
            '-ac', '2',
            '-application', 'audio',
            '-frame_duration', '20',
            '-compression_level', '10',
            '-f', 'ogg',
            'pipe:1'
        );

        const downloader = spawn(YTDLP, ytArgs, { windowsHide: true });
        const transcoder = spawn(FFMPEG, ffmpegArgs, { windowsHide: true });

        let ffmpegError = '';
        let downloaderError = '';
        let received = 0;
        let settled = false;
        let killed = false;

        const buffer = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });

        const counter = new Transform({
            transform(chunk, _encoding, callback) {
                received += chunk.length;
                if (!settled && received >= PREBUFFER_BYTES) start();
                callback(null, chunk);
            }
        });

        const cleanup = () => {
            clearTimeout(prebufferTimer);
            transcoder.removeListener('close', onTranscoderClose);
            transcoder.removeListener('error', onTranscoderError);
            downloader.removeListener('close', onDownloaderClose);
            downloader.removeListener('error', onDownloaderError);
        };

        const start = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({
                stream: buffer,
                bitrate,
                directUrl: null,
                kill: () => {
                    killed = true;
                    try { downloader.kill('SIGKILL'); } catch {}
                    try { transcoder.kill('SIGKILL'); } catch {}
                    try { buffer.destroy(); } catch {}
                }
            });
        };

        const fail = (message) => {
            if (settled) return;
            settled = true;
            cleanup();
            try { downloader.kill('SIGKILL'); } catch {}
            try { transcoder.kill('SIGKILL'); } catch {}
            try { buffer.destroy(); } catch {}
            reject(new Error(message));
        };

        const onTranscoderClose = (code) => {
            if (settled) return;
            if (received > 0) return start();
            fail(code === 0
                ? 'El audio de YouTube terminó antes de empezar'
                : `ffmpeg falló (${code}): ${ffmpegError.trim().split('\n').slice(-2).join(' ')}`);
        };

        const onDownloaderClose = (code) => {
            if (settled || killed) return;
            if (received > 0) return;
            if (code === 0) return fail('YouTube no entregó audio');
            fail(`yt-dlp falló (${code}): ${downloaderError.trim().split('\n').slice(-3).join(' ') || 'sin detalles'}`);
        };

        const onTranscoderError = (error) => {
            fail(error.code === 'ENOENT'
                ? 'No encontré ffmpeg. Define FFMPEG_PATH.'
                : error.message);
        };

        const onDownloaderError = (error) => {
            fail(error.code === 'ENOENT'
                ? 'No encontré yt-dlp. Coloca yt-dlp en bin/ o define YTDLP_PATH.'
                : error.message);
        };

        const prebufferTimer = setTimeout(() => {
            if (received > 0) return start();
            fail('No se pudo iniciar el audio de YouTube a tiempo');
        }, YOUTUBE_PREBUFFER_TIMEOUT_MS);

        transcoder.stderr.on('data', (d) => { ffmpegError += d.toString(); });
        downloader.stderr.on('data', (d) => { downloaderError += d.toString(); });
        transcoder.on('close', onTranscoderClose);
        transcoder.on('error', onTranscoderError);
        downloader.on('close', onDownloaderClose);
        downloader.on('error', onDownloaderError);
        transcoder.stdout.on('error', () => {});
        transcoder.stdin.on('error', () => {});
        downloader.stdout.on('error', () => {});

        downloader.stdout.pipe(transcoder.stdin);
        transcoder.stdout.pipe(counter).pipe(buffer);
    });
}

/**
 * Abre el audio y entrega un stream Ogg/Opus con prebuffer.
 * Reintenta una vez con una URL fresca si la CDN devuelve 403 o expira.
 */
async function openStream(url, { seek = 0, bitrateKbps = DEFAULT_BITRATE, volume = 1, directUrl = null } = {}) {
    if (isYouTubeUrl(url)) {
        return startYouTubeTranscoder(url, { seek, bitrateKbps, volume });
    }

    let lastError;
    let cachedUrl = directUrl;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const direct = cachedUrl || await getDirectUrl(url, { timeout: 30_000 });
            return await startTranscoder(direct, { seek, bitrateKbps, volume });
        } catch (error) {
            lastError = error;
            cachedUrl = null;
            if (process.env.MUSIC_DEBUG) {
                console.error(`[yt-dlp] intento ${attempt + 1} falló: ${error.message}`);
            }
        }
    }

    throw classifyError(lastError);
}

module.exports = {
    YTDLP,
    searchSoundCloud,
    resolveSoundCloudUrl,
    searchYouTube,
    resolveYouTubeUrl,
    openStream,
    getDirectUrl,
    isUrl,
    isYouTubeUrl,
    scoreYouTubeCandidate: youtubeScore,
    normalizeForMatch,
    titleMatches,
    clampBitrate
};
