const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '1wxqFA4Tz6swiZApr0tugxb-vIPZpPQWu';
const GDRIVE_API_KEY = (process.env.GDRIVE_API_KEY || '').trim();

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PREFIX = 'modp_';

const CACHE = {
    data: null,
    timestamp: 0,
    ttl: 10 * 60 * 1000 // 10 menit
};

const http = axios.create({
    timeout: 10000,
    headers: { 'User-Agent': UA }
});

async function listDriveFolder(folderId) {
    if (!GDRIVE_API_KEY) {
        throw new Error('GDRIVE_API_KEY belum terbaca di Environment Variables Vercel.');
    }
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
    try {
        const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
        const { data } = await http.get(url, { responseType: 'text', timeout: 5000 });
        if (!data || typeof data !== 'string' || data.includes('<!DOCTYPE html>')) return null;

        const cleaned = data
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/[\u2018\u2019]/g, "'")
            .trim();

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
            let epNum = 1;

            for (const vf of videoFiles) {
                const baseName = stripExt(vf.name);
                const lowerBase = baseName.toLowerCase();

                let categoryLabel = 'Performance';
                if (/^rehearsal/i.test(lowerBase)) {
                    categoryLabel = 'Rehearsal';
                }

                const matchedThumb = imageFiles.find(img => stripExt(img.name).toLowerCase() === lowerBase);
                const thumbUrl = matchedThumb
                    ? driveImageUrl(matchedThumb.id, 1280)
                    : (vf.thumbnailLink ? vf.thumbnailLink.replace(/=s\d+/, '=s1280') : driveImageUrl(vf.id, 1280));

                episodes.push({
                    id: `${PREFIX}${sf.id}:${vf.id}`,
                    fileId: vf.id,
                    title: baseName, // Bersih sesuai nama file
                    fullTitle: `${title} – ${baseName}`,
                    season: 1, // Semua disatukan dalam 1 tab utama
                    episode: epNum++,
                    thumbnail: thumbUrl,
                    released: date ? `${date}T00:00:00.000Z` : undefined,
                    overview: `${categoryLabel} • ${title} (${displayName})`
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
            id:
