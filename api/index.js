import express from 'express';
import fetch from 'node-fetch';

const app = express();

const GDRIVE_API_KEY = process.env.GDRIVE_API_KEY;
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

// Helper untuk mengambil file JSON dari Google Drive dengan aman
async function fetchJsonFromDrive(fileId) {
    try {
        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${GDRIVE_API_KEY}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const text = await res.text();
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

// Fungsi utama untuk memindai folder Google Drive (Struktur: Main Folder -> Team Folders -> Show Folders -> Files)
async function scanLibrary() {
    if (!GDRIVE_API_KEY || !GDRIVE_FOLDER_ID) {
        return { teams: [] };
    }

    try {
        // 1. Ambil daftar folder Team di dalam Root Folder utama
        const teamsUrl = `https://www.googleapis.com/drive/v3/files?q='${GDRIVE_FOLDER_ID}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&key=${GDRIVE_API_KEY}&fields=files(id,name)`;
        const teamsRes = await fetch(teamsUrl);
        const teamsData = await teamsRes.json();
        const teamFolders = teamsData.files || [];

        let teams = [];

        for (const team of teamFolders) {
            // 2. Ambil daftar folder Show di dalam setiap Team Folder
            const showsUrl = `https://www.googleapis.com/drive/v3/files?q='${team.id}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&key=${GDRIVE_API_KEY}&fields=files(id,name)`;
            const showsRes = await fetch(showsUrl);
            const showsData = await showsRes.json();
            const showFolders = showsData.files || [];

            let shows = [];

            for (const showFolder of showFolders) {
                // 3. Ambil daftar file di dalam Show Folder
                const filesUrl = `https://www.googleapis.com/drive/v3/files?q='${showFolder.id}'+in+parents+and+trashed=false&key=${GDRIVE_API_KEY}&fields=files(id,name,mimeType,webContentLink)`;
                const filesRes = await fetch(filesUrl);
                const filesData = await filesRes.json();
                const files = filesData.files || [];

                // Cari file info.json jika ada
                let showInfo = {
                    title: showFolder.name.replace(/\s*\([^)]*\)/g, '').trim(),
                    description: "Koleksi video Move On Dance Pro.",
                    poster: "",
                    background: "",
                    logo: "",
                    releaseInfo: "2026",
                    trailerUrl: ""
                };

                const infoFile = files.find(f => f.name === 'info.json');
                if (infoFile) {
                    const parsedInfo = await fetchJsonFromDrive(infoFile.id);
                    if (parsedInfo) {
                        showInfo = { ...showInfo, ...parsedInfo };
                    }
                }

                // Cari file trailer (trailer.mp4) di dalam folder show
                const trailerFile = files.find(f => f.name.toLowerCase() === 'trailer.mp4' || f.name.toLowerCase() === 'trailer.mov');
                if (trailerFile) {
                    showInfo.trailerUrl = `https://www.googleapis.com/drive/v3/files/${trailerFile.id}?alt=media&key=${GDRIVE_API_KEY}`;
                }

                // Filter file video utama (abaikan info.json dan trailer)
                const videoFiles = files.filter(f => 
                    f.mimeType && f.mimeType.startsWith('video/') && 
                    f.name.toLowerCase() !== 'trailer.mp4' && 
                    f.name.toLowerCase() !== 'trailer.mov'
                );

                let videos = videoFiles.map((file, index) => {
                    // Bersihkan judul video dari teks di dalam kurung (misal: "Show 1 (Rehearsal)")
                    const cleanTitle = file.name.replace(/\.[^/.]+$/, "").replace(/\s*\([^)]*\)/g, '').trim();
                    
                    return {
                        id: `${showFolder.id}:${file.id}`,
                        title: cleanTitle || `Video ${index + 1}`,
                        season: 1, // Disatukan ke Season 1 utama
                        episode: index + 1,
                        thumbnail: showInfo.poster || undefined,
                        released: new Date().toISOString(),
                        streams: [
                            {
                                title: "Google Drive Stream",
                                url: `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&key=${GDRIVE_API_KEY}`
                            }
                        ]
                    };
                });

                if (videos.length > 0) {
                    shows.push({
                        id: showFolder.id,
                        title: showInfo.title,
                        poster: showInfo.poster,
                        background: showInfo.background,
                        logo: showInfo.logo,
                        releaseInfo: showInfo.releaseInfo,
                        description: showInfo.description,
                        trailerUrl: showInfo.trailerUrl,
                        videos: videos
                    });
                }
            }

            if (shows.length > 0) {
                teams.push({
                    id: team.id,
                    name: team.name,
                    shows: shows
                });
            }
        }

        return { teams };
    } catch (err) {
        console.error("Error scanning library:", err);
        return { teams: [] };
    }
}

// Manifest Add-on Stremio
const manifest = {
    id: 'org.moveondancepro.library',
    version: '1.1.3',
    name: 'Dance Library - Move On Dance Pro',
    description: 'Katalog eksklusif video performance dan rehearsal Move On Dance Pro dari Google Drive (All-in-One Season 1 & Trailer Support).',
    types: ['series', 'movie'],
    catalogs: [
        {
            type: 'series',
            id: 'dance_shows',
            name: 'Move On Dance Pro',
            extra: [{ name: 'genre', isRequired: false }]
        }
    ],
    resources: ['catalog', 'meta', 'stream'],
    idPrefixes: ['gdrive_']
};

app.get('/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.json(manifest);
});

// Catalog Handler
app.get('/catalog/:type/:id.json', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    try {
        const libData = await scanLibrary();
        let metas = [];

        libData.teams.forEach(team => {
            team.shows.forEach(show => {
                metas.push({
                    id: show.id,
                    type: 'series',
                    name: `${team.name} - ${show.title}`,
                    poster: show.poster,
                    posterShape: 'poster',
                    background: show.background,
                    logo: show.logo,
                    description: show.description,
                    genres: [team.name, 'Dance']
                });
            });
        });

        res.json({ metas });
    } catch (e) {
        res.json({ metas: [] });
    }
});

// Meta Handler (Dilengkapi Trailer Streams)
app.get('/meta/:type/:id.json', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const requestedId = req.params.id;

    try {
        const libData = await scanLibrary();
        let foundShow = null;

        for (const team of libData.teams) {
            const show = team.shows.find(s => s.id === requestedId);
            if (show) {
                foundShow = show;
                break;
            }
        }

        if (!foundShow) {
            return res.json({ meta: { id: requestedId, type: 'series', name: 'Show Not Found' } });
        }

        res.json({
            meta: {
                id: foundShow.id,
                type: 'series',
                name: foundShow.title,
                poster: foundShow.poster,
                posterShape: 'poster',
                background: foundShow.background,
                logo: foundShow.logo,
                releaseInfo: foundShow.releaseInfo,
                description: foundShow.description,
                // Otomatis aktif jika file trailer.mp4 tersedia di folder Google Drive
                trailerStreams: foundShow.trailerUrl ? [{
                    title: `${foundShow.title} - Official Trailer`,
                    url: foundShow.trailerUrl
                }] : [],
                videos: foundShow.videos.map(v => ({
                    id: v.id,
                    title: v.title,
                    season: v.season,
                    episode: v.episode,
                    thumbnail: v.thumbnail,
                    released: v.released
                }))
            }
        });
    } catch (e) {
        res.json({ meta: { id: requestedId, type: 'series', name: 'Error Loading Meta' } });
    }
});

// Stream Handler
app.get('/stream/:type/:id.json', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const parts = req.params.id.split(':');
    const showId = parts[0];
    const fileId = parts[1];

    try {
        const libData = await scanLibrary();
        let targetStream = null;

        for (const team of libData.teams) {
            const show = team.shows.find(s => s.id === showId);
            if (show) {
                const video = show.videos.find(v => v.id === req.params.id);
                if (video) {
                    targetStream = video.streams;
                    break;
                }
            }
        }

        res.json({ streams: targetStream || [] });
    } catch (e) {
        res.json({ streams: [] });
    }
});

// Endpoint Debug opsional
app.get('/debug', async (req, res) => {
    const data = await scanLibrary();
    res.json(data);
});

export default app;
