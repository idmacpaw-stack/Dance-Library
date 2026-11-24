const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const GDRIVE_API_KEY = process.env.GDRIVE_API_KEY;
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;
const PREFIX = 'modp_';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const CACHE = {
    data: null,
    timestamp: 0,
    ttl: 15 * 60 * 1000 // Cache 15 menit
};

const http = axios.create({
    timeout: 8000,
    headers: { 'User-Agent': UA }
});

async function listDriveFolder(folderId) {
    if (!GDRIVE_API_KEY) {
        throw new Error('GDRIVE_API_KEY belum terbaca di Environment Variables Vercel.');
    }
    try {
        const files = [];
        let pageToken = null;
        do {
            const { data } = await http.get('https://www.googleapis.com/drive/v3/files', {
                params: {
                    q: `'${folderId.trim()}' in parents and trashed = false`,
                    fields: 'nextPageToken, files(id, name, mimeType, size, thumbnailLink)',
                    pageSize: 100,
                    pageToken: pageToken || undefined,
                    key: GDRIVE_API_KEY
                }
            });
            if (data && Array.isArray(data.files)) files.push(...data.files);
            pageToken = data.nextPageToken;
        } while (pageToken);
        return files;
    } catch (e) {
        console.error('Error listDriveFolder:', e.message);
        return [];
    }
}

function isVideo(file) {
    return file.mimeType && file.mimeType.startsWith('video/');
}

function isImage(file) {
    return file.mimeType && file.mimeType.startsWith('image/');
}

function stripExt(filename) {
    return filename.replace(/\.[^/.]+$/, '').replace(/\s*\([^)]*\)/g, '').trim();
}

function driveImageUrl(fileId, width = 1000) {
    return `https://lh3.googleusercontent.com/d/${fileId}=w${width}`;
}

async function fetchJsonFile(fileId) {
    try {
        const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
        const { data } = await http.get(url, { responseType: 'text', timeout: 4000 });
        if (!data || typeof data !== 'string' || data.includes('<!DOCTYPE html>')) return null;

        const cleaned = data
            .replace(/^\uFEFF/, '')
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/[\u2018\u2019]/g, "'");

        return JSON.parse(cleaned);
    } catch (e) {
        console.error('Gagal baca info.json:', e.message);
        return null;
    }
}

async function scanLibrary(force = false) {
    const now = Date.now();
    if (!force && CACHE.data && (now - CACHE.timestamp < CACHE.ttl)) {
        return CACHE.data;
    }

    if (!GDRIVE_FOLDER_ID) {
        throw new Error('GDRIVE_FOLDER_ID belum terbaca di Environment Variables Vercel.');
    }

    const rootItems = await listDriveFolder(GDRIVE_FOLDER_ID);
    const teamFolders = rootItems.filter(f => f.mimeType === 'application/vnd.google-apps.folder');

    const teams = [];

    for (const tf of teamFolders) {
        const displayName = tf.name.replace(/\s*\([^)]*\)/g, '').trim();
        const catalogId = `team_${tf.id}`;
        const teamItems = await listDriveFolder(tf.id);

        const teamLogoFile = teamItems.find(f => isImage(f) && /^logo/i.test(f.name));
        const teamLogoUrl = teamLogoFile ? driveImageUrl(teamLogoFile.id, 800) : undefined;

        const showFolders = teamItems.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
        const shows = [];

        for (const sf of showFolders) {
            const showItems = await listDriveFolder(sf.id);
            const imageFiles = showItems.filter(isImage);
            const allVideos = showItems.filter(isVideo);

            // Pisahkan file trailer (trailer.mp4 / trailer.mov) agar tidak masuk ke daftar episode
            const trailerFile = allVideos.find(f => /^trailer\./i.test(f.name));
            const videoFiles = allVideos.filter(f => !/^trailer\./i.test(f.name));

            if (videoFiles.length === 0) continue;

            // Baca info.json jika ada
            let metaInfo = {};
            const jsonFile = showItems.find(f => f.name.toLowerCase() === 'info.json');
            if (jsonFile) {
                const parsed = await fetchJsonFile(jsonFile.id);
                if (parsed) metaInfo = parsed;
            }

            const posterFile = imageFiles.find(f => /^poster/i.test(f.name)) || imageFiles[0];
            const bgFile = imageFiles.find(f => /^background/i.test(f.name)) || posterFile;
            const logoFile = imageFiles.find(f => /^logo/i.test(f.name));

            const title = metaInfo.title || sf.name.replace(/\s*\([^)]*\)/g, '').trim();
            const description = metaInfo.description || `Dokumentasi resmi ${title} oleh ${displayName}.`;
            const releaseInfo = metaInfo.releaseInfo || metaInfo.year || '2026';
            const date = metaInfo.date || '';

            // Link stream langsung untuk trailer jika file trailer ditemukan
            const trailerUrl = trailerFile
                ? (GDRIVE_API_KEY
                    ? `https://www.googleapis.com/drive/v3/files/${trailerFile.id}?alt=media&key=${GDRIVE_API_KEY}`
                    : `https://drive.usercontent.google.com/download?id=${trailerFile.id}&export=download&confirm=t`)
                : null;

            // Urutkan video berdasarkan nama
            videoFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

            const episodes = [];
            let epNum = 1;

            for (const vf of videoFiles) {
                const baseName = stripExt(vf.name);
                const matchedThumb = imageFiles.find(img => stripExt(img.name).toLowerCase() === baseName.toLowerCase());
                const thumbUrl = matchedThumb
                    ? driveImageUrl(matchedThumb.id, 1280)
                    : (vf.thumbnailLink ? vf.thumbnailLink.replace(/=s\d+/, '=s1280') : driveImageUrl(vf.id, 1280));

                episodes.push({
                    id: `${PREFIX}${sf.id}:${vf.id}`,
                    fileId: vf.id,
                    title: baseName,
                    fullTitle: `${title} – ${baseName}`,
                    season: 1,
                    episode: epNum++,
                    thumbnail: thumbUrl,
                    released: date ? `${date}T00:00:00.000Z` : undefined,
                    overview: `${baseName} • ${title} (${displayName})`
                });
            }

            shows.push({
                id: `${PREFIX}${sf.id}`,
                folderId: sf.id,
                title,
                poster: metaInfo.poster || (posterFile ? driveImageUrl(posterFile.id, 1000) : undefined),
                background: metaInfo.background || (bgFile ? driveImageUrl(bgFile.id, 1920) : undefined),
                logo: metaInfo.logo || (logoFile ? driveImageUrl(logoFile.id, 800) : undefined),
                releaseInfo: String(releaseInfo),
                date,
                description,
                trailerUrl,
                videos: episodes
            });
        }

        teams.push({
            id: catalogId,
            folderId: tf.id,
            name: displayName,
            logo: teamLogoUrl,
            shows
        });
    }

    CACHE.data = { teams };
    CACHE.timestamp = now;
    return CACHE.data;
}

async function getAddonInterface() {
    const lib = await scanLibrary();
    const catalogs = lib.teams.map(t => ({
        type: 'series',
        id: t.id,
        name: t.name,
        extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
    }));

    if (catalogs.length === 0) {
        catalogs.push({
            type: 'series',
            id: 'team_default',
            name: 'Move On Dance Pro',
            extra: [{ name: 'search', isRequired: false }]
        });
    }

    const manifest = {
        id: 'org.moveondancepro.library',
        version: '1.1.3',
        name: 'Dance Library - Move On Dance Pro',
        description: 'Katalog resmi video dokumentasi Move On Dance Pro',
        resources: ['catalog', 'meta', 'stream'],
        types: ['series'],
        catalogs,
        idPrefixes: [PREFIX]
    };

    const builder = new addonBuilder(manifest);

    builder.defineCatalogHandler(async (args) => {
        try {
            const libData = await scanLibrary();
            const team = libData.teams.find(t => t.id === args.id);
            if (!team) return { metas: [] };

            let list = team.shows;
            if (args.extra && args.extra.search) {
                const q = args.extra.search.toLowerCase().trim();
                list = list.filter(s =>
                    s.title.toLowerCase().includes(q) ||
                    s.description.toLowerCase().includes(q) ||
                    (s.date && s.date.includes(q))
                );
            }

            const skip = parseInt(args.extra && args.extra.skip, 10) || 0;
            const sliced = list.slice(skip, skip + 50);

            const metas = sliced.map(s => ({
                id: s.id,
                type: 'series',
                name: s.title,
                poster: s.poster,
                posterShape: 'poster',
                background: s.background,
                logo: s.logo,
                releaseInfo: s.releaseInfo,
                description: s.description
            }));

            return { metas, cacheMaxAge: 300 };
        } catch (err) {
            return { metas: [] };
        }
    });

    builder.defineMetaHandler(async (args) => {
        try {
            const libData = await scanLibrary();
            for (const team of libData.teams) {
                const show = team.shows.find(s => s.id === args.id);
                if (show) {
                    return {
                        meta: {
                            id: show.id,
                            type: 'series',
                            name: show.title,
                            poster: show.poster,
                            posterShape: 'poster',
                            background: show.background,
                            logo: show.logo,
                            releaseInfo: show.releaseInfo,
                            description: show.description,
                            // Klip trailer otomatis muncul jika ada file trailer.mp4/mov di folder show
                            trailerStreams: show.trailerUrl ? [
                                {
                                    title: `${show.title} - Official Trailer`,
                                    url: show.trailerUrl
                                }
                            ] : [],
                            videos: show.videos.map(v => ({
                                id: v.id,
                                title: v.title,
                                season: v.season,
                                episode: v.episode,
                                thumbnail: v.thumbnail,
                                released: v.released,
                                overview: v.overview
                            }))
                        },
                        cacheMaxAge: 300
                    };
                }
            }
            return { meta: { id: args.id, type: 'series', name: 'Show Not Found' } };
        } catch (err) {
            return { meta: { id: args.id, type: 'series', name: 'Error' } };
        }
    });

    builder.defineStreamHandler(async (args) => {
        try {
            const raw = args.id.replace(PREFIX, '');
            const [folderId, fileId] = raw.split(':');
            if (!fileId) return { streams: [] };

            const libData = await scanLibrary();
            let teamName = 'Move On Dance Pro';
            let videoLabel = 'Play Video';

            for (const team of libData.teams) {
                const show = team.shows.find(s => s.folderId === folderId);
                if (show) {
                    teamName = team.name;
                    const ep = show.videos.find(v => v.fileId === fileId);
                    if (ep) videoLabel = ep.fullTitle;
                    break;
                }
            }

            const directUrl = GDRIVE_API_KEY
                ? `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${GDRIVE_API_KEY}`
                : `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;

            const streams = [
                {
                    name: teamName,
                    title: `${videoLabel}\nGoogle Drive Direct Stream`,
                    url: directUrl,
                    behaviorHints: { notWebReady: false }
                }
            ];

            return { streams, cacheMaxAge: 300 };
        } catch (err) {
            return { streams: [] };
        }
    });

    return builder.getInterface();
}

const app = express();
app.use(cors());

app.get('/', (req, res) => res.redirect('/manifest.json'));

app.get('/debug', async (req, res) => {
    try {
        const lib = await scanLibrary(req.query.refresh === '1');
        res.json({
            status: 'ok',
            usingApiKey: !!GDRIVE_API_KEY,
            teams: lib.teams.map(t => ({
                name: t.name,
                shows: t.shows.map(s => ({
                    title: s.title,
                    hasTrailer: !!s.trailerUrl,
                    description: s.description,
                    videos: s.videos.map(v => ({ title: v.title, season: v.season, episode: v.episode }))
                }))
            }))
        });
    } catch (e) {
        res.status(200).json({
            status: 'error',
            usingApiKey: !!GDRIVE_API_KEY,
            message: e.response?.data?.error?.message || e.message
        });
    }
});

app.use(async (req, res, next) => {
    try {
        const addonInterface = await getAddonInterface();
        const router = getRouter(addonInterface);
        router(req, res, next);
    } catch (err) {
        res.status(500).json({
            error: err.response?.data?.error?.message || err.message
        });
    }
});

module.exports = app;
