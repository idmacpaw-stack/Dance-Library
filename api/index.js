const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '1wxqFA4Tz6swiZApr0tugxb-vIPZpPQWu';
const GDRIVE_API_KEY = process.env.GDRIVE_API_KEY || '';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PREFIX = 'modp_';

const CACHE = {
    data: null,
    timestamp: 0,
    ttl: 10 * 60 * 1000 // 10 menit
};

const http = axios.create({
    timeout: 8000,
    headers: { 'User-Agent': UA }
});

// Fungsi pencarian file/folder menggunakan Google Drive API v3 (Wajib pakai GDRIVE_API_KEY di environment variables Vercel agar lancar)
async function listDriveFolder(folderId) {
    if (!GDRIVE_API_KEY) {
        // Fallback jika API Key belum dipasang: kembalikan struktur data statis/aman agar tidak error 500
        return [];
    }
    try {
        const files = [];
        let pageToken = null;
        do {
            const { data } = await http.get('https://www.googleapis.com/drive/v3/files', {
                params: {
                    q: `'${folderId}' in parents and trashed = false`,
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
        console.error('Drive API Error:', e.message);
        return [];
    }
}

function guessMime(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['mp4', 'm4v', 'mov', 'mkv'].includes(ext)) return 'video/mp4';
    if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'image/jpeg';
    if (ext === 'json') return 'application/json';
    return 'application/octet-stream';
}

function isVideo(file) {
    return (file.mimeType && file.mimeType.startsWith('video/')) || /\.(mp4|mov|mkv|m4v|avi)$/i.test(file.name);
}

function isImage(file) {
    return (file.mimeType && file.mimeType.startsWith('image/')) || /\.(jpg|jpeg|png|webp)$/i.test(file.name);
}

function stripExt(filename) {
    return filename.replace(/\.[^/.]+$/, '');
}

function driveImageUrl(fileId, width = 1000) {
    return `https://lh3.googleusercontent.com/d/${fileId}=w${width}`;
}

async function fetchJsonFile(fileId) {
    if (!GDRIVE_API_KEY) return null;
    try {
        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${GDRIVE_API_KEY}`;
        const { data } = await http.get(url, { responseType: 'json', timeout: 5000 });
        return data && typeof data === 'object' ? data : null;
    } catch (e) {
        return null;
    }
}

async function scanLibrary(force = false) {
    const now = Date.now();
    if (!force && CACHE.data && (now - CACHE.timestamp < CACHE.ttl)) {
        return CACHE.data;
    }

    const rootItems = await listDriveFolder(GDRIVE_FOLDER_ID);
    const teamFolders = rootItems
        .filter(f => f.mimeType === 'application/vnd.google-apps.folder')
        .sort((a, b) => a.name.localeCompare(b.name));

    const teams = [];

    for (const tf of teamFolders) {
        const displayName = tf.name.replace(/^\d+\s+/, '').trim();
        const catalogId = 'team_' + tf.id;
        const teamChildren = await listDriveFolder(tf.id);

        const logoFile = teamChildren.find(f => isImage(f) && stripExt(f.name).toLowerCase() === 'logo');
        const teamLogoUrl = logoFile ? driveImageUrl(logoFile.id, 1000) : undefined;

        const showFolders = teamChildren
            .filter(f => f.mimeType === 'application/vnd.google-apps.folder')
            .sort((a, b) => b.name.localeCompare(a.name));

        const shows = [];

        for (const sf of showFolders) {
            const files = await listDriveFolder(sf.id);

            const dateMatch = sf.name.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
            const folderDate = dateMatch ? dateMatch[1] : '';
            const folderTitle = dateMatch ? dateMatch[2].trim() : sf.name;

            const infoFile = files.find(f => f.name.toLowerCase() === 'info.json');
            const infoData = infoFile ? await fetchJsonFile(infoFile.id) : null;

            const title = (infoData && infoData.title) || folderTitle;
            const date = (infoData && infoData.date) || folderDate;
            const description = (infoData && infoData.description) || `Dokumentasi penampilan ${displayName} - ${title}`;

            const posterFile = files.find(f => isImage(f) && stripExt(f.name).toLowerCase() === 'poster');
            const bgFile = files.find(f => isImage(f) && stripExt(f.name).toLowerCase() === 'background');
            const showLogoFile = files.find(f => isImage(f) && stripExt(f.name).toLowerCase() === 'logo');

            const videoFiles = files.filter(isVideo).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
            const imageFiles = files.filter(isImage);

            const episodes = [];
            let s1Ep = 1, s2Ep = 1, s3Ep = 1;

            for (const vf of videoFiles) {
                const baseName = stripExt(vf.name);
                const lowerBase = baseName.toLowerCase();

                let season = 3;
                let episode = 1;

                if (/^show/i.test(lowerBase)) {
                    season = 1;
                    episode = s1Ep++;
                } else if (/^rehearsal/i.test(lowerBase)) {
                    season = 2;
                    episode = s2Ep++;
                } else {
                    season = 3;
                    episode = s3Ep++;
                }

                const matchedThumb = imageFiles.find(img => stripExt(img.name).toLowerCase() === lowerBase);
                const thumbUrl = matchedThumb
                    ? driveImageUrl(matchedThumb.id, 1280)
                    : (vf.thumbnailLink ? vf.thumbnailLink.replace(/=s\d+/, '=s1280') : driveImageUrl(vf.id, 1280));

                const seasonName = season === 1 ? `Show ${episode}` : (season === 2 ? `Rehearsal ${episode}` : `Extra ${episode}`);

                episodes.push({
                    id: `${PREFIX}${sf.id}:${vf.id}`,
                    fileId: vf.id,
                    title: `${baseName} (${seasonName})`,
                    fullTitle: `${title} – ${baseName}`,
                    season: season,
                    episode: episode,
                    thumbnail: thumbUrl,
                    released: date ? `${date}T00:00:00.000Z` : undefined,
                    overview: `${baseName} • ${title} (${displayName})`
                });
            }

            const firstThumb = episodes.length > 0 ? episodes[0].thumbnail : undefined;
            const posterUrl = posterFile ? driveImageUrl(posterFile.id, 1000) : firstThumb;
            const bgUrl = bgFile ? driveImageUrl(bgFile.id, 1920) : (posterUrl || firstThumb);
            const logoUrl = showLogoFile ? driveImageUrl(showLogoFile.id, 1000) : teamLogoUrl;

            shows.push({
                id: `${PREFIX}${sf.id}`,
                folderId: sf.id,
                teamName: displayName,
                catalogId,
                title,
                date,
                releaseInfo: date ? date.slice(0, 4) : undefined,
                description,
                poster: posterUrl,
                background: bgUrl,
                logo: logoUrl,
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
        version: '1.0.4',
        name: 'Dance Library - Move On Dance Pro',
        description: 'Katalog resmi video dokumentasi show dan rehearsal Move On Dance Pro',
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
                            videos: show.videos.map(v => ({
                                id: v.id,
                                title: v.title,
                                season: v.season,
                                episode: v.episode,
                                thumbnail: v.thumbnail,
                                released: v.released
