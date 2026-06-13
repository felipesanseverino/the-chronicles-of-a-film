#!/usr/bin/env node
/**
 * tcof visual publisher
 * Usage: node publisher.mjs
 * Opens a local web UI in your browser.
 */

import http from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { tmpdir, homedir } from 'os';
import { createRequire } from 'module';
import { createHash } from 'crypto';

const PORT   = 4242;
const ROOT   = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const CONFIG = join(ROOT, 'config.js');
const CACHE  = new Map(); // thumb cache
const IMG_EXT = /\.(jpe?g|png|tiff?)$/i;

function loadLocalEnv(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

// ── Cloudinary ────────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
loadLocalEnv(join(ROOT, '.env'));

let cloudinary;

function getCloudinary() {
  if (cloudinary) return cloudinary;
  let sdk;
  try { sdk = require('cloudinary').v2; }
  catch {
    throw new Error('Missing dependency: run `npm install` before publishing.');
  }

  const config = {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dttbzi3he',
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  };
  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`Missing Cloudinary environment values: ${missing.join(', ')}. Fill in .env, then try publishing again.`);
  }

  sdk.config(config);
  cloudinary = sdk;
  return cloudinary;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, ...options });
  if (result.error) {
    throw new Error(result.error.code === 'ETIMEDOUT'
      ? `${command} timed out`
      : result.error.message);
  }
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || `${command} failed`).trim();
    throw new Error(msg);
  }
  return result.stdout || '';
}

// ── Config helpers ────────────────────────────────────────────────────────────
function readConfig() {
  const src = readFileSync(CONFIG, 'utf8');
  const m = src.match(/const series\s*=\s*(\[[\s\S]*?\]);/);
  let series = [];
  if (m) { try { series = eval(m[1]); } catch {} }
  return series;
}

function readRemoteConfig() {
  try {
    run('git', ['-C', ROOT, 'fetch', 'origin', 'main']);
    const src = run('git', ['-C', ROOT, 'show', 'origin/main:config.js']);
    const m = src.match(/const series\s*=\s*(\[[\s\S]*?\]);/);
    if (m) { try { return eval(m[1]); } catch {} }
  } catch {}
  // Fall back to local if remote is unreachable
  return readConfig();
}

function writeConfig(series) {
  const lines = ['const CLOUDINARY_BASE = "https://res.cloudinary.com/dttbzi3he/image/upload";', '', 'const series = ['];
  series.forEach((s, i) => {
    lines.push('  {');
    lines.push(`    slug: ${JSON.stringify(s.slug)},`);
    if (s.type && s.type !== 'archive') lines.push(`    type: ${JSON.stringify(s.type)},`);
    lines.push(`    title: ${JSON.stringify(s.title)},`);
    lines.push(`    meta: ${JSON.stringify(s.meta)},`);
    if (s.description) lines.push(`    description: ${JSON.stringify(s.description)},`);
    if (s.essayNote) lines.push(`    essayNote: ${JSON.stringify(s.essayNote)},`);
    if (s.closingText) lines.push(`    closingText: ${JSON.stringify(s.closingText)},`);
    if (Array.isArray(s.selectedPhotos) && s.selectedPhotos.length) {
      lines.push(`    selectedPhotos: ${JSON.stringify(s.selectedPhotos)},`);
    }
    if (Array.isArray(s.contactSheetPhotos) && s.contactSheetPhotos.length) {
      lines.push(`    contactSheetPhotos: ${JSON.stringify(s.contactSheetPhotos)},`);
    }
    if (Array.isArray(s.captions) && s.captions.length) {
      lines.push(`    captions: ${JSON.stringify(s.captions)},`);
    }
    lines.push(`    folder: ${JSON.stringify(s.folder)},`);
    lines.push(`    photos: [`);
    s.photos.forEach(p => lines.push(`      ${JSON.stringify(p)},`));
    lines.push(`    ]`);
    lines.push(i < series.length - 1 ? '  },' : '  }');
  });
  lines.push('];', '');
  writeFileSync(CONFIG, lines.join('\n'), 'utf8');
}

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

// ── Image helpers ─────────────────────────────────────────────────────────────
function getThumb(srcPath) {
  if (CACHE.has(srcPath)) return CACHE.get(srcPath);
  const dest = join(tmpdir(), 'tcof-thumb-' + createHash('sha1').update(srcPath).digest('hex') + '.jpg');
  if (!existsSync(dest)) {
    run('sips', ['--resampleWidth', '400', '--setProperty', 'formatOptions', '70', srcPath, '--out', dest]);
  }
  const buf = readFileSync(dest);
  CACHE.set(srcPath, buf);
  return buf;
}

function compress(src, destDir) {
  const dest = join(destDir, src.split('/').pop());
  if (!existsSync(dest)) {
    run('sips', ['--resampleWidth', '3000', '--setProperty', 'formatOptions', '82', src, '--out', dest], { timeout: 180000 });
  }
  return dest;
}

// ── Body parser ───────────────────────────────────────────────────────────────
function body(req) {
  return new Promise((res, rej) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { res(JSON.parse(d)); } catch { res({}); } });
    req.on('error', rej);
  });
}

// ── Active SSE clients ────────────────────────────────────────────────────────
const sseClients = new Map();

function sendSSE(id, event) {
  const client = sseClients.get(id);
  if (client) client.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ── Routes ────────────────────────────────────────────────────────────────────
async function route(req, res) {
  const url  = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const m    = req.method;

  // HTML
  if (m === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }

  // Thumbnail
  if (m === 'GET' && path === '/api/thumb') {
    const p = url.searchParams.get('path');
    if (!p || !existsSync(p)) { res.writeHead(404); return res.end(); }
    try {
      const buf = getThumb(p);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      return res.end(buf);
    } catch { res.writeHead(500); return res.end(); }
  }

  // Series list
  if (m === 'GET' && path === '/api/series') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(readConfig()));
  }

  // Cloudinary usage
  if (m === 'GET' && path === '/api/usage') {
    try {
      const cld = getCloudinary();
      const data = await cld.api.usage();
      const { credits, storage } = data;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        storageMB: Math.round(storage.usage / 1024 / 1024),
        credits:   credits.usage,
        limit:     credits.limit,
        pct:       credits.used_percent,
        plan:      data.plan,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Delete an entire series (config + Cloudinary folder)
  if (m === 'POST' && path === '/api/delete-series') {
    const { slug } = await body(req);
    const series = readRemoteConfig();
    const idx = series.findIndex(s => s.slug === slug);
    if (idx === -1) { res.writeHead(404); return res.end(JSON.stringify({ error: 'series not found' })); }
    const { folder } = series[idx];
    // Delete from Cloudinary
    try {
      const cld = getCloudinary();
      await cld.api.delete_resources_by_prefix(folder + '/');
      await cld.api.delete_folder(folder);
    } catch (e) {
      // Non-fatal: folder may already be empty or not exist
    }
    // Remove from config
    series.splice(idx, 1);
    writeConfig(series);
    // Commit + push
    try {
      run('git', ['-C', ROOT, 'fetch', 'origin', 'main']);
      run('git', ['-C', ROOT, 'reset', '--mixed', 'origin/main']);
      run('git', ['-C', ROOT, 'add', 'config.js']);
      const diff = run('git', ['-C', ROOT, 'diff', '--cached', '--stat']).trim();
      if (diff) run('git', ['-C', ROOT, 'commit', '-m', `Remove ${slug} series`]);
      run('git', ['-C', ROOT, 'push']);
    } catch (e) {
      // Return ok even if git fails — config is already updated
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Remove a photo from a series
  if (m === 'POST' && path === '/api/remove-photo') {
    const { slug, filename } = await body(req);
    const series = readRemoteConfig();
    const idx = series.findIndex(s => s.slug === slug);
    if (idx === -1) { res.writeHead(404); return res.end(JSON.stringify({ error: 'series not found' })); }
    series[idx].photos = series[idx].photos.filter(p => p !== filename);
    writeConfig(series);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, remaining: series[idx].photos.length }));
  }

  // Save metadata only (no upload)
  if (m === 'POST' && path === '/api/save') {
    const { slug, type, title, meta, description, essayNote, closingText, selectedPhotos, contactSheetPhotos, captions } = await body(req);
    const series = readRemoteConfig();
    const idx = series.findIndex(s => s.slug === slug);
    if (idx === -1) { res.writeHead(404); return res.end(JSON.stringify({ error: 'not found' })); }
    if (title) series[idx].title = title;
    series[idx].type = type === 'chapter' ? 'chapter' : 'archive';
    if (series[idx].type === 'archive') delete series[idx].type;
    if (meta)  series[idx].meta  = meta;
    series[idx].description = description || '';
    if (!series[idx].description) delete series[idx].description;
    series[idx].essayNote = essayNote || '';
    if (!series[idx].essayNote) delete series[idx].essayNote;
    series[idx].closingText = closingText || '';
    if (!series[idx].closingText) delete series[idx].closingText;
    series[idx].selectedPhotos = Array.isArray(selectedPhotos) ? selectedPhotos.filter(Boolean) : [];
    if (!series[idx].selectedPhotos.length) delete series[idx].selectedPhotos;
    series[idx].contactSheetPhotos = Array.isArray(contactSheetPhotos) ? contactSheetPhotos.filter(Boolean) : [];
    if (!series[idx].contactSheetPhotos.length) delete series[idx].contactSheetPhotos;
    series[idx].captions = Array.isArray(captions) ? captions.filter(Boolean) : [];
    if (!series[idx].captions.length) delete series[idx].captions;
    writeConfig(series);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Scan folder
  if (m === 'POST' && path === '/api/scan') {
    const { folder } = await body(req);
    const dir = resolve((folder || '').replace(/^~/, homedir()));
    if (!existsSync(dir)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Folder not found' }));
    }
    const files = readdirSync(dir).filter(f => IMG_EXT.test(f)).sort();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ files, dir }));
  }

  // SSE progress stream
  if (m === 'GET' && path === '/api/progress') {
    const id = url.searchParams.get('id');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    sseClients.set(id, res);
    req.on('close', () => sseClients.delete(id));
    return;
  }

  // Publish
  if (m === 'POST' && path === '/api/publish') {
    const payload = await body(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    // Run async
    runPublish(payload).catch(e => sendSSE(payload.jobId, { type: 'error', message: e.message }));
    return;
  }

  // Deploy
  if (m === 'POST' && path === '/api/deploy') {
    const { slug, count, isNew, title } = await body(req);
    try {
      // Fetch remote, then move HEAD to origin/main without touching the
      // working tree (--mixed) so our already-written config.js is preserved.
      run('git', ['-C', ROOT, 'fetch', 'origin', 'main']);
      run('git', ['-C', ROOT, 'reset', '--mixed', 'origin/main']);

      run('git', ['-C', ROOT, 'add', 'config.js']);

      // Check if there's anything staged to commit
      const diff = run('git', ['-C', ROOT, 'diff', '--cached', '--stat']).trim();
      if (diff) {
        const photoPart = count > 0 ? ` — ${count} photos` : '';
        const msg = isNew ? `Add ${title} series${photoPart}` : `Update ${title} series${photoPart}`;
        run('git', ['-C', ROOT, 'commit', '-m', msg]);
      }

      run('git', ['-C', ROOT, 'push']);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: `https://www.thechroniclesofafilm.com/series.html?s=${slug}` }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('not found');
}

// ── Publish job ───────────────────────────────────────────────────────────────
async function runPublish({ jobId, slug, type, title, meta, description, essayNote, closingText, selectedPhotos, contactSheetPhotos, captions, folder, hero, isNew, files }) {
  const cloudinary = getCloudinary();
  const send = e => sendSSE(jobId, e);
  const dir  = resolve(folder.replace(/^~/, homedir()));
  if (!existsSync(dir)) throw new Error(`Folder not found: ${dir}`);
  const allFiles = (Array.isArray(files) && files.length)
    ? files.filter(f => IMG_EXT.test(f))
    : readdirSync(dir).filter(f => IMG_EXT.test(f)).sort();
  if (!allFiles.length) throw new Error(`No supported image files found in: ${dir}`);
  const heroFile = allFiles.find(f => f === hero) || allFiles[0];
  const ordered  = [heroFile, ...allFiles.filter(f => f !== heroFile)];
  const tmpDir   = join(tmpdir(), `tcof-${slug}`);
  mkdirSync(tmpDir, { recursive: true });
  const total = ordered.length;

  // Compress
  send({ type: 'phase', phase: 'compress', total });
  const compressed = [];
  for (let i = 0; i < ordered.length; i++) {
    const file = ordered[i];
    send({ type: 'progress', phase: 'compress', done: i, total, file, status: 'working' });
    let dest;
    try {
      dest = compress(join(dir, file), tmpDir);
    } catch (e) {
      throw new Error(`Could not compress ${file}: ${e.message}`);
    }
    compressed.push({ file: ordered[i], dest });
    send({ type: 'progress', phase: 'compress', done: i + 1, total, file, status: 'done' });
  }

  // Upload
  send({ type: 'phase', phase: 'upload', total });
  const cloudFolder = `chronicles/${slug}`;
  const uploaded = [];
  const BATCH = 4;
  for (let i = 0; i < compressed.length; i += BATCH) {
    const batch = compressed.slice(i, i + BATCH);
    await Promise.all(batch.map(async ({ file, dest }) => {
      const publicId = file.replace(/\.[^.]+$/, '').toUpperCase();
      try {
        await cloudinary.uploader.upload(dest, { folder: cloudFolder, public_id: publicId, overwrite: false, resource_type: 'image' });
      } catch (e) { if (!e.message?.includes('already exists')) throw e; }
      uploaded.push(publicId + '.jpg');
      send({ type: 'progress', phase: 'upload', done: uploaded.length, total, file });
    }));
  }

  // Config — always base off the remote version so local can never be stale
  const series = readRemoteConfig();
  const contentFields = {
    ...(description ? { description } : {}),
    ...(essayNote ? { essayNote } : {}),
    ...(closingText ? { closingText } : {}),
    ...(Array.isArray(selectedPhotos) && selectedPhotos.length ? { selectedPhotos: selectedPhotos.filter(Boolean) } : {}),
    ...(Array.isArray(contactSheetPhotos) && contactSheetPhotos.length ? { contactSheetPhotos: contactSheetPhotos.filter(Boolean) } : {}),
    ...(Array.isArray(captions) && captions.length ? { captions: captions.filter(Boolean) } : {}),
  };
  if (isNew) {
    series.push({ slug, ...(type === 'chapter' ? { type: 'chapter' } : {}), title, meta, ...contentFields, folder: cloudFolder, photos: uploaded });
  } else {
    const idx = series.findIndex(s => s.slug === slug);
    const heroId = heroFile.replace(/\.[^.]+$/, '').toUpperCase() + '.jpg';
    const merged = [...new Set([...uploaded, ...series[idx].photos])];
    series[idx].photos = [heroId, ...merged.filter(p => p !== heroId)];
    series[idx].type = type === 'chapter' ? 'chapter' : 'archive';
    if (series[idx].type === 'archive') delete series[idx].type;
    series[idx].description = description || '';
    if (!series[idx].description) delete series[idx].description;
    series[idx].essayNote = essayNote || '';
    if (!series[idx].essayNote) delete series[idx].essayNote;
    series[idx].closingText = closingText || '';
    if (!series[idx].closingText) delete series[idx].closingText;
    series[idx].selectedPhotos = Array.isArray(selectedPhotos) ? selectedPhotos.filter(Boolean) : [];
    if (!series[idx].selectedPhotos.length) delete series[idx].selectedPhotos;
    series[idx].contactSheetPhotos = Array.isArray(contactSheetPhotos) ? contactSheetPhotos.filter(Boolean) : [];
    if (!series[idx].contactSheetPhotos.length) delete series[idx].contactSheetPhotos;
    series[idx].captions = Array.isArray(captions) ? captions.filter(Boolean) : [];
    if (!series[idx].captions.length) delete series[idx].captions;
    if (meta)  series[idx].meta  = meta;
    if (title) series[idx].title = title;
  }
  writeConfig(series);

  send({ type: 'done', slug, count: uploaded.length });
}

// ── HTML ──────────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>tcof publisher</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;1,400;1,500&family=Overpass+Mono:wght@300;400&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg:      #0e0e0e;
  --surface: #141414;
  --surface2:#1a1a1a;
  --border:  #272727;
  --text:    #d4cfc8;
  --muted:   #5a5650;
  --accent:  #bd8735;
  --white:   #e5d2b6;
  --green:   #82be82;
  --red:     #dc6464;
  --serif:   'EB Garamond', Georgia, serif;
  --mono:    'Overpass Mono', monospace;
}

html, body { height: 100%; overflow: hidden; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--serif);
  font-size: 15px;
  display: flex;
  flex-direction: column;
}

/* noise */
body::before {
  content: '';
  position: fixed; inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
  pointer-events: none; z-index: 1000; opacity: 0.5;
}

/* ── HEADER ── */
header {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 0 2rem;
  height: 52px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.logo {
  font-family: var(--mono);
  font-size: 0.62rem;
  letter-spacing: 0.2em;
  color: var(--accent);
}

.logo-sep { color: var(--border); }

.logo-sub {
  font-family: var(--mono);
  font-size: 0.55rem;
  letter-spacing: 0.15em;
  color: var(--muted);
}

.storage-pill {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-family: var(--mono);
  font-size: 0.5rem;
  letter-spacing: 0.1em;
  color: var(--muted);
}

.storage-bar-track {
  width: 60px;
  height: 3px;
  background: var(--border);
  border-radius: 2px;
  overflow: hidden;
}

.storage-bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.4s ease;
}
.storage-bar-fill.warn  { background: #c97b2a; }
.storage-bar-fill.alert { background: var(--red); }

.header-site {
  margin-left: 1.2rem;
  font-family: var(--mono);
  font-size: 0.55rem;
  letter-spacing: 0.12em;
  color: var(--muted);
  text-decoration: none;
  transition: color 0.2s;
}
.header-site:hover { color: var(--accent); }

/* ── LAYOUT ── */
.app {
  display: grid;
  grid-template-columns: 260px 1fr;
  flex: 1;
  overflow: hidden;
}

/* ── SIDEBAR ── */
.sidebar {
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-header {
  padding: 1.2rem 1.5rem 1rem;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sidebar-label {
  font-family: var(--mono);
  font-size: 0.55rem;
  letter-spacing: 0.2em;
  color: var(--muted);
}

.btn-new {
  font-family: var(--mono);
  font-size: 0.55rem;
  letter-spacing: 0.12em;
  color: var(--accent);
  background: none;
  border: 1px solid var(--accent);
  padding: 0.3rem 0.7rem;
  cursor: pointer;
  transition: background 0.2s, color 0.2s;
}
.btn-new:hover { background: var(--accent); color: var(--bg); }

.series-list {
  overflow-y: auto;
  flex: 1;
}

.series-list::-webkit-scrollbar { width: 4px; }
.series-list::-webkit-scrollbar-track { background: transparent; }
.series-list::-webkit-scrollbar-thumb { background: var(--border); }

.series-row {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.9rem 1.5rem;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  transition: background 0.15s;
  position: relative;
}
.series-row:hover { background: var(--surface); }
.series-row.active { background: var(--surface2); }
.series-row.active::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 2px;
  background: var(--accent);
}

.btn-delete-series {
  display: none;
  background: none;
  border: none;
  color: var(--red);
  font-size: 0.75rem;
  cursor: pointer;
  padding: 2px 4px;
  line-height: 1;
  opacity: 0.6;
  flex-shrink: 0;
}
.btn-delete-series:hover { opacity: 1; }
.series-row:hover .btn-delete-series { display: block; }

.series-thumb {
  width: 44px;
  height: 30px;
  object-fit: cover;
  flex-shrink: 0;
  filter: grayscale(30%);
}
.series-thumb-empty {
  width: 44px;
  height: 30px;
  background: var(--border);
  flex-shrink: 0;
}

.series-info { flex: 1; min-width: 0; }

.series-name {
  font-family: var(--serif);
  font-size: 0.95rem;
  color: var(--white);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-transform: lowercase;
}

.series-count {
  font-family: var(--mono);
  font-size: 0.5rem;
  letter-spacing: 0.1em;
  color: var(--muted);
  margin-top: 2px;
}

/* ── MAIN ── */
.main {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.main-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 2rem 2.5rem;
}
.main-scroll::-webkit-scrollbar { width: 4px; }
.main-scroll::-webkit-scrollbar-thumb { background: var(--border); }

/* ── FORM ── */
.form-section { margin-bottom: 2rem; }

.section-label {
  font-family: var(--mono);
  font-size: 0.55rem;
  letter-spacing: 0.2em;
  color: var(--muted);
  text-transform: lowercase;
  margin-bottom: 1rem;
  display: block;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.field { display: flex; flex-direction: column; gap: 0.4rem; }
.field.full { grid-column: 1 / -1; }

.field label {
  font-family: var(--mono);
  font-size: 0.5rem;
  letter-spacing: 0.15em;
  color: var(--muted);
}

.field input,
.field textarea {
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--white);
  font-family: var(--serif);
  font-size: 0.95rem;
  padding: 0.55rem 0.8rem;
  outline: none;
  transition: border-color 0.2s;
  width: 100%;
}
.field input:focus,
.field textarea:focus { border-color: var(--accent); }
.field textarea { resize: vertical; min-height: 80px; line-height: 1.6; }

/* ── DROP ZONE ── */
.drop-overlay {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 999;
  background: rgba(14,14,14,0.85);
  border: 2px dashed var(--accent);
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 0.75rem;
  pointer-events: none;
}
.drop-overlay.active {
  display: flex;
  pointer-events: all;
}
.drop-overlay-icon {
  font-size: 2.5rem;
  opacity: 0.6;
}
.drop-overlay-label {
  font-family: var(--mono);
  font-size: 0.65rem;
  letter-spacing: 0.14em;
  color: var(--accent);
}

/* ── FOLDER ── */
.folder-row {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}

.folder-input {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--white);
  font-family: var(--mono);
  font-size: 0.65rem;
  padding: 0.55rem 0.8rem;
  outline: none;
  transition: border-color 0.2s;
}
.folder-input:focus { border-color: var(--accent); }
.folder-input::placeholder { color: var(--muted); }

.btn {
  font-family: var(--mono);
  font-size: 0.55rem;
  letter-spacing: 0.12em;
  padding: 0.55rem 1.1rem;
  cursor: pointer;
  border: 1px solid var(--border);
  background: none;
  color: var(--muted);
  transition: all 0.2s;
  white-space: nowrap;
}
.btn:hover { border-color: var(--white); color: var(--white); }
.btn.primary { border-color: var(--accent); color: var(--accent); }
.btn.primary:hover { background: var(--accent); color: var(--bg); }
.btn.success { border-color: var(--green); color: var(--green); }
.btn.success:hover { background: var(--green); color: var(--bg); }
.btn:disabled { opacity: 0.35; cursor: not-allowed; }
.btn:disabled:hover { background: none; color: var(--muted); border-color: var(--border); }

/* ── PHOTO GRID ── */
.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 0.5rem;
  margin-top: 1rem;
}

.photo-cell {
  position: relative;
  cursor: pointer;
  overflow: hidden;
  border: 2px solid transparent;
  transition: border-color 0.2s;
}
.photo-cell:hover { border-color: var(--muted); }
.photo-cell.hero  { border-color: var(--accent); }
.photo-cell.deselected { opacity: 0.25; }
.photo-cell.deselected:hover { opacity: 0.5; border-color: var(--muted); }

.photo-cell img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  display: block;
  filter: grayscale(20%);
  transition: filter 0.3s;
}
.photo-cell:hover img,
.photo-cell.hero  img { filter: grayscale(0%); }

.hero-badge {
  display: none;
  position: absolute;
  bottom: 0; left: 0; right: 0;
  background: var(--accent);
  color: var(--bg);
  font-family: var(--mono);
  font-size: 0.45rem;
  letter-spacing: 0.12em;
  text-align: center;
  padding: 2px 0;
}
.photo-cell.hero .hero-badge { display: block; }

.photo-grid-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 1rem;
}
.photo-grid-header .photo-count {
  margin: 0;
}
.select-all-btns {
  display: flex;
  gap: 0.4rem;
  flex-shrink: 0;
}

.photo-overlay {
  position: absolute;
  inset: 0;
  background: rgba(8,8,8,0.7);
  opacity: 0;
  transition: opacity 0.2s;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px;
}
.photo-cell:hover .photo-overlay { opacity: 1; }

.photo-filename {
  font-family: var(--mono);
  font-size: 0.42rem;
  letter-spacing: 0.05em;
  color: rgba(229,210,182,0.7);
  text-align: center;
  word-break: break-all;
  line-height: 1.4;
}

.btn-remove {
  font-family: var(--mono);
  font-size: 0.48rem;
  letter-spacing: 0.1em;
  color: var(--red);
  background: none;
  border: 1px solid var(--red);
  padding: 3px 8px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
}
.btn-remove:hover { background: var(--red); color: var(--bg); }

.photo-count {
  font-family: var(--mono);
  font-size: 0.55rem;
  color: var(--muted);
  margin-top: 0.75rem;
}

/* ── PROGRESS ── */
.progress-wrap {
  margin-top: 1.5rem;
  display: none;
}
.progress-wrap.active { display: block; }

.progress-phase {
  font-family: var(--mono);
  font-size: 0.55rem;
  letter-spacing: 0.15em;
  color: var(--muted);
  margin-bottom: 0.5rem;
}

.progress-bar {
  height: 2px;
  background: var(--border);
  position: relative;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--accent);
  width: 0%;
  transition: width 0.3s ease;
}

.progress-file {
  font-family: var(--mono);
  font-size: 0.5rem;
  color: var(--muted);
  margin-top: 0.4rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── STATUS BAR ── */
/* ── BOTTOM BAR ── */
.bottom-bar {
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  background: var(--surface);
}

.bottom-progress {
  height: 2px;
  background: var(--border);
  position: relative;
}
.bottom-progress-fill {
  height: 100%;
  width: 0%;
  background: var(--accent);
  transition: width 0.25s ease;
}
.bottom-progress-fill.green { background: var(--green); }
.bottom-progress-fill.red   { background: var(--red); }

.bottom-inner {
  display: flex;
  align-items: center;
  padding: 0 2rem;
  height: 44px;
  gap: 0;
}

/* stages */
.stages {
  display: flex;
  align-items: center;
  gap: 0;
  flex: 1;
}

.stage {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0 1.2rem 0 0;
  position: relative;
}

.stage:not(:last-child)::after {
  content: '›';
  color: var(--border);
  font-size: 0.7rem;
  margin-right: 1.2rem;
}

.stage-dot {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: var(--border);
  flex-shrink: 0;
  transition: background 0.3s;
}
.stage.done   .stage-dot { background: var(--green); }
.stage.active .stage-dot { background: var(--accent); animation: pulse 1s ease-in-out infinite; }
.stage.error  .stage-dot { background: var(--red); }

.stage-label {
  font-family: var(--mono);
  font-size: 0.5rem;
  letter-spacing: 0.15em;
  color: var(--muted);
  transition: color 0.3s;
}
.stage.done   .stage-label { color: var(--green); }
.stage.active .stage-label { color: var(--white); }
.stage.error  .stage-label { color: var(--red); }

.stage-count {
  font-family: var(--mono);
  font-size: 0.48rem;
  color: var(--muted);
  min-width: 3rem;
  transition: color 0.3s;
}
.stage.active .stage-count { color: var(--accent); }
.stage.done   .stage-count { color: var(--green); }

/* file label */
.status-file {
  font-family: var(--mono);
  font-size: 0.48rem;
  letter-spacing: 0.05em;
  color: var(--muted);
  max-width: 260px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-left: auto;
  padding-left: 1rem;
}

.status-link {
  font-family: var(--mono);
  font-size: 0.5rem;
  letter-spacing: 0.1em;
  color: var(--accent);
  text-decoration: none;
  margin-left: 1.5rem;
  white-space: nowrap;
}
.status-link:hover { text-decoration: underline; }

@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

/* ── EMPTY STATE ── */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 1rem;
  color: var(--muted);
}
.empty-state-icon { font-size: 2rem; opacity: 0.3; }
.empty-state-text { font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.15em; }

/* ── ACTION ROW ── */
.action-row {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  padding: 1.25rem 2.5rem;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
</style>
</head>
<body>

<div class="drop-overlay" id="drop-overlay">
  <div class="drop-overlay-icon">⬇</div>
  <div class="drop-overlay-label">drop photos or a folder to scan</div>
</div>

<header>
  <span class="logo">tcof</span>
  <span class="logo-sep">·</span>
  <span class="logo-sub">publisher</span>
  <div class="storage-pill" id="storage-pill" title="Cloudinary storage usage"></div>
  <a href="https://www.thechroniclesofafilm.com" target="_blank" class="header-site">↗ thechroniclesofafilm.com</a>
</header>

<div class="app">

  <!-- SIDEBAR -->
  <aside class="sidebar">
    <div class="sidebar-header">
      <span class="sidebar-label">series</span>
      <button class="btn-new" onclick="newSeries()">+ new</button>
    </div>
    <div class="series-list" id="series-list"></div>
  </aside>

  <!-- MAIN -->
  <div class="main">
    <div class="main-scroll" id="main-content">
      <div class="empty-state">
        <div class="empty-state-icon">✦</div>
        <div class="empty-state-text">select a series or create a new one</div>
      </div>
    </div>
    <div class="action-row" id="action-row" style="display:none">
      <button class="btn primary" id="btn-upload" onclick="startUpload()" disabled>upload photos</button>
      <button class="btn success" id="btn-deploy" onclick="deployNow()" disabled>deploy to vercel</button>
      <span id="deploy-hint" style="font-family:var(--mono);font-size:0.5rem;color:var(--muted);margin-left:0.5rem"></span>
    </div>
  </div>
</div>

<div class="bottom-bar">
  <div class="bottom-progress">
    <div class="bottom-progress-fill" id="bar-fill"></div>
  </div>
  <div class="bottom-inner">
    <div class="stages">
      <div class="stage" id="stage-scan">
        <div class="stage-dot"></div>
        <span class="stage-label">scan</span>
        <span class="stage-count" id="count-scan"></span>
      </div>
      <div class="stage" id="stage-compress">
        <div class="stage-dot"></div>
        <span class="stage-label">compress</span>
        <span class="stage-count" id="count-compress"></span>
      </div>
      <div class="stage" id="stage-upload">
        <div class="stage-dot"></div>
        <span class="stage-label">upload</span>
        <span class="stage-count" id="count-upload"></span>
      </div>
      <div class="stage" id="stage-deploy">
        <div class="stage-dot"></div>
        <span class="stage-label">deploy</span>
        <span class="stage-count" id="count-deploy"></span>
      </div>
    </div>
    <span class="status-file" id="status-file">ready</span>
    <a class="status-link" id="status-link" href="#" target="_blank" style="display:none">↗ view live</a>
  </div>
</div>

<script>
let state = {
  series: [],
  active: null,   // slug
  isNew: false,
  scanned: [],    // filenames from scan
  scannedDir: '',
  selected: new Set(), // filenames chosen for upload
  hero: '',
  uploaded: 0,
};

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  const data = await fetch('/api/series').then(r => r.json());
  state.series = data;
  renderSidebar();
  loadUsage();
}

async function loadUsage() {
  const pill = document.getElementById('storage-pill');
  try {
    const d = await fetch('/api/usage').then(r => r.json());
    if (d.error) return;
    const pct = Math.min(100, Math.round(d.pct * 10) / 10);
    const colorClass = pct >= 90 ? 'alert' : pct >= 70 ? 'warn' : '';
    pill.innerHTML = \`
      <div class="storage-bar-track">
        <div class="storage-bar-fill \${colorClass}" style="width:\${pct}%"></div>
      </div>
      <span>\${d.storageMB} MB · \${d.credits.toFixed(2)}/\${d.limit} credits · \${pct}%</span>
    \`;
    pill.title = \`Cloudinary \${d.plan} plan — \${pct}% of monthly credits used\`;
  } catch {}
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function renderSidebar() {
  const el = document.getElementById('series-list');
  el.innerHTML = state.series.map(s => {
    const thumb = s.photos.length
      ? \`<img class="series-thumb" src="https://res.cloudinary.com/dttbzi3he/image/upload/f_auto,q_auto,w_88,h_60,c_fill/\${s.folder}/\${s.photos[0]}" onerror="this.style.display='none'">\`
      : '<div class="series-thumb-empty"></div>';
    return \`<div class="series-row \${state.active === s.slug ? 'active' : ''}" data-slug="\${s.slug}" onclick="selectSeries('\${s.slug}')">
      \${thumb}
      <div class="series-info">
        <div class="series-name">\${s.title}</div>
        <div class="series-count">\${s.photos.length} photos · \${s.meta}</div>
      </div>
      <button class="btn-delete-series" title="delete series" data-slug="\${s.slug}" data-title="\${s.title.replace(/"/g,'&quot;')}">×</button>
    </div>\`;
  }).join('');

  el.querySelectorAll('.btn-delete-series').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteSeries(btn.dataset.slug, btn.dataset.title);
    });
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function listToText(value) {
  return Array.isArray(value) ? value.join('\\n') : '';
}

function listFromText(value) {
  return String(value || '')
    .split(/\\r?\\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

// ── Select / New ──────────────────────────────────────────────────────────────
function selectSeries(slug) {
  const s = state.series.find(x => x.slug === slug);
  if (!s) return;
  state.active   = slug;
  state.isNew    = false;
  state.scanned  = [];
  state.selected = new Set();
  state.hero     = s.photos[0] || '';
  renderSidebar();
  renderForm(s);
}

function newSeries() {
  state.active   = '__new__';
  state.isNew    = true;
  state.scanned  = [];
  state.selected = new Set();
  state.hero     = '';
  renderSidebar();
  renderForm(null);
}

// ── Form ──────────────────────────────────────────────────────────────────────
function renderForm(s) {
  const mc = document.getElementById('main-content');
  const ar = document.getElementById('action-row');
  ar.style.display = 'flex';

  // Existing series: deploy is available immediately only if photos look real (not img_001 placeholders)
  const hasRealPhotos = s && s.photos.length > 0 && !s.photos[0].startsWith('img_');
  const canDeployNow = !state.isNew && hasRealPhotos;
  document.getElementById('btn-deploy').disabled = !canDeployNow;
  document.getElementById('deploy-hint').textContent = canDeployNow ? '' : 'upload photos first';

  mc.innerHTML = \`
    <div class="form-section">
      <span class="section-label">archive / chapter details</span>
      <div class="form-grid">
        <div class="field">
          <label>type</label>
          <select id="f-type">
            <option value="archive" \${!s || s.type !== 'chapter' ? 'selected' : ''}>archive / place</option>
            <option value="chapter" \${s && s.type === 'chapter' ? 'selected' : ''}>chapter / idea</option>
          </select>
        </div>
        <div class="field">
          <label>title</label>
          <input id="f-title" type="text" value="\${s ? s.title : ''}" placeholder="Japan" oninput="autoSlug()">
        </div>
        <div class="field">
          <label>slug</label>
          <input id="f-slug" type="text" value="\${s ? s.slug : ''}" placeholder="japan" \${!state.isNew ? 'readonly style="opacity:0.5"' : ''}>
        </div>
        <div class="field">
          <label>meta</label>
          <input id="f-meta" type="text" value="\${s ? s.meta : ''}" placeholder="Asia · 35mm">
        </div>
        <div class="field full">
          <label>intro text</label>
          <textarea id="f-desc" placeholder="write something about this series…">\${escapeHtml(s && s.description ? s.description : '')}</textarea>
        </div>
        <div class="field full">
          <label>essay note</label>
          <textarea id="f-essay-note" placeholder="shown on the paper interlude…">\${escapeHtml(s && s.essayNote ? s.essayNote : '')}</textarea>
        </div>
        <div class="field full">
          <label>closing text</label>
          <textarea id="f-closing-text" placeholder="shown near the chapter colophon…">\${escapeHtml(s && s.closingText ? s.closingText : '')}</textarea>
        </div>
        <div class="field full">
          <label>selected frames</label>
          <textarea id="f-selected-photos" placeholder="one filename per line">\${escapeHtml(listToText(s && s.selectedPhotos))}</textarea>
        </div>
        <div class="field full">
          <label>contact sheet frames</label>
          <textarea id="f-contact-sheet-photos" placeholder="one filename per line">\${escapeHtml(listToText(s && s.contactSheetPhotos))}</textarea>
        </div>
        <div class="field full">
          <label>captions</label>
          <textarea id="f-captions" placeholder="one caption per selected frame">\${escapeHtml(listToText(s && s.captions))}</textarea>
        </div>
      </div>
    </div>

    <div class="form-section">
      <span class="section-label">\${canDeployNow ? 'current photos' : 'photos'}</span>
      \${canDeployNow
        ? \`<div id="photo-area"></div>
           <div style="margin-top:1.2rem">
             <span class="section-label" style="display:block;margin-bottom:0.5rem">add more photos</span>
             <div class="folder-row">
               <input class="folder-input" id="f-folder" type="text" placeholder="~/Documents/Photos/Japan/… (optional)" value="\${state.scannedDir}">
               <button class="btn" onclick="scanFolder()">scan folder</button>
             </div>
             <div id="new-photo-area"></div>
           </div>\`
        : \`<div class="folder-row">
             <input class="folder-input" id="f-folder" type="text" placeholder="~/Documents/Photos/Japan/…" value="\${state.scannedDir}">
             <button class="btn" onclick="scanFolder()">scan folder</button>
           </div>
           <div id="photo-area"></div>\`
      }
    </div>

    <div class="progress-wrap" id="progress-wrap">
      <div class="progress-phase" id="progress-phase">compressing…</div>
      <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
      <div class="progress-file" id="progress-file"></div>
    </div>
  \`;

  // Show existing Cloudinary photos
  if (canDeployNow && s.photos.length) renderCloudinaryPhotos(s);
  if (state.scanned.length) renderPhotoGrid(state.scanned, state.scannedDir);
}

// ── Current Cloudinary photos ─────────────────────────────────────────────────
function renderCloudinaryPhotos(s) {
  const area = document.getElementById('photo-area');
  if (!area) return;
  const BASE = 'https://res.cloudinary.com/dttbzi3he/image/upload/f_auto,q_auto,w_220,h_220,c_fill';
  area.innerHTML = \`
    <p class="photo-count" id="cloud-count">\${s.photos.length} photos on cloudinary — hover to remove</p>
    <div class="photo-grid" id="cloud-grid">
      \${s.photos.map(p => cloudPhotoCell(p, s.folder, BASE)).join('')}
    </div>
  \`;
}

function cloudPhotoCell(p, folder, BASE) {
  BASE = BASE || 'https://res.cloudinary.com/dttbzi3he/image/upload/f_auto,q_auto,w_220,h_220,c_fill';
  const s = state.series.find(x => x.slug === state.active);
  const f = (s && s.folder) ? s.folder : folder;
  return \`<div class="photo-cell \${state.hero === p ? 'hero' : ''}" id="cell-\${p}" title="\${p}" onclick="setCloudHero('\${p}')">
    <img src="\${BASE}/\${f}/\${p}" loading="lazy" alt="\${p}"
      onerror="document.getElementById('cell-\${p}').style.display='none'; updateCloudCount()">
    <div class="photo-overlay">
      <div class="photo-filename">\${p}</div>
      <button class="btn-remove" onclick="event.stopPropagation(); removePhoto('\${p}')">× remove</button>
    </div>
    <div class="hero-badge">cover</div>
  </div>\`;
}

function updateCloudCount() {
  const visible = document.querySelectorAll('#cloud-grid .photo-cell[style!="display: none;"]').length;
  const all     = document.querySelectorAll('#cloud-grid .photo-cell').length;
  const hidden  = all - visible;
  const real    = all - hidden;
  const el = document.getElementById('cloud-count');
  if (!el) return;
  if (real === 0) {
    el.textContent = 'no photos uploaded yet — scan a folder below to add some';
    document.getElementById('cloud-grid').style.display = 'none';
  } else {
    el.textContent = \`\${real} photos on cloudinary — hover to remove\`;
  }
}

function setCloudHero(filename) {
  state.hero = filename;
  document.querySelectorAll('#cloud-grid .photo-cell').forEach(el => {
    el.classList.toggle('hero', el.title === filename);
  });
}

async function removePhoto(filename) {
  const slug = document.getElementById('f-slug')?.value.trim();
  if (!confirm(\`Remove \${filename} from this series?\`)) return;
  const res = await fetch('/api/remove-photo', {
    method: 'POST',
    body: JSON.stringify({ slug, filename }),
  }).then(r => r.json());
  if (res.error) { setStatus('error', res.error); return; }
  // Remove from DOM
  document.getElementById('cell-' + filename)?.remove();
  document.getElementById('cloud-count').textContent = \`\${res.remaining} photos on cloudinary — hover to remove\`;
  // Update local state
  const s = state.series.find(x => x.slug === slug);
  if (s) s.photos = s.photos.filter(p => p !== filename);
  renderSidebar();
  setStatus('ok', \`\${filename} removed — deploy to go live\`);
}

function autoSlug() {
  if (!state.isNew) return;
  const t = document.getElementById('f-title').value;
  document.getElementById('f-slug').value = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── Scan folder ───────────────────────────────────────────────────────────────
async function scanFolder() {
  const folder = document.getElementById('f-folder').value.trim();
  if (!folder) return;
  setStage('scan', 'active'); setFile('scanning folder…');
  const res = await fetch('/api/scan', { method: 'POST', body: JSON.stringify({ folder }) }).then(r => r.json());
  if (res.error) { setStage('scan', 'error'); setStatus('error', res.error); return; }
  state.scanned    = res.files;
  state.scannedDir = res.dir;
  state.selected   = new Set(res.files);
  if (!state.hero && res.files.length) state.hero = res.files[0];
  // For existing series, new photos go in the secondary area
  const area = document.getElementById('new-photo-area') || document.getElementById('photo-area');
  renderPhotoGrid(res.files, res.dir, area);
  // Unlock upload button
  document.getElementById('btn-upload').disabled = false;
  setStage('scan', 'done', res.files.length + ' files');
  setBar(10); setFile(\`\${res.files.length} photos found\`);
}

// ── Photo grid ────────────────────────────────────────────────────────────────
function renderPhotoGrid(files, dir, area) {
  area = area || document.getElementById('photo-area');
  if (!area) return;
  const selCount = files.filter(f => state.selected.has(f)).length;
  area.innerHTML = \`
    <div class="photo-grid-header">
      <p class="photo-count" id="photo-count-label">\${selCount} of \${files.length} selected — click to toggle · right-click to set cover</p>
      <div class="select-all-btns">
        <button class="btn" onclick="selectAllPhotos()">select all</button>
        <button class="btn" onclick="deselectAllPhotos()">deselect all</button>
      </div>
    </div>
    <div class="photo-grid" id="photo-grid">
      \${files.map(f => \`
        <div class="photo-cell \${state.hero === f ? 'hero' : ''} \${state.selected.has(f) ? '' : 'deselected'}"
             onclick="togglePhoto('\${f}')"
             oncontextmenu="setHero('\${f}');return false;"
             title="\${f}">
          <img src="/api/thumb?path=\${encodeURIComponent(dir + '/' + f)}&v=\${(() => { try { return statSync(dir + '/' + f).mtimeMs | 0; } catch { return 0; } })()}" loading="lazy" alt="\${f}">
          <div class="hero-badge">cover</div>
        </div>
      \`).join('')}
    </div>
  \`;
}

function selectAllPhotos() {
  state.scanned.forEach(f => state.selected.add(f));
  document.querySelectorAll('#photo-grid .photo-cell').forEach(el => el.classList.remove('deselected'));
  const label = document.getElementById('photo-count-label');
  if (label) label.textContent = \`\${state.scanned.length} of \${state.scanned.length} selected — click to toggle · right-click to set cover\`;
  const btn = document.getElementById('btn-upload');
  if (btn) btn.disabled = false;
}

function deselectAllPhotos() {
  state.selected.clear();
  if (state.hero) state.hero = '';
  document.querySelectorAll('#photo-grid .photo-cell').forEach(el => {
    el.classList.add('deselected');
    el.classList.remove('hero');
  });
  const label = document.getElementById('photo-count-label');
  if (label) label.textContent = \`0 of \${state.scanned.length} selected — click to toggle · right-click to set cover\`;
  const btn = document.getElementById('btn-upload');
  if (btn) btn.disabled = true;
}

function togglePhoto(f) {
  if (state.selected.has(f)) {
    state.selected.delete(f);
    if (state.hero === f) {
      // assign hero to next selected photo
      const next = state.scanned.find(x => x !== f && state.selected.has(x));
      state.hero = next || '';
    }
  } else {
    state.selected.add(f);
  }
  const el = document.querySelector(\`.photo-cell[title="\${f}"]\`);
  if (el) el.classList.toggle('deselected', !state.selected.has(f));
  const label = document.getElementById('photo-count-label');
  if (label) {
    const sel = state.scanned.filter(x => state.selected.has(x)).length;
    label.textContent = \`\${sel} of \${state.scanned.length} selected — click to toggle · right-click to set cover\`;
  }
  // sync upload button
  const btn = document.getElementById('btn-upload');
  if (btn) btn.disabled = state.selected.size === 0;
}

function setHero(f) {
  if (!state.selected.has(f)) state.selected.add(f);
  state.hero = f;
  document.querySelectorAll('.photo-cell').forEach(el => {
    el.classList.toggle('hero', el.title === f);
    el.classList.toggle('deselected', !state.selected.has(el.title));
  });
}

// ── Upload ────────────────────────────────────────────────────────────────────
async function startUpload() {
  const title  = document.getElementById('f-title')?.value.trim();
  const type   = document.getElementById('f-type')?.value === 'chapter' ? 'chapter' : 'archive';
  const slug   = document.getElementById('f-slug')?.value.trim();
  const meta   = document.getElementById('f-meta')?.value.trim();
  const desc   = document.getElementById('f-desc')?.value.trim();
  const essayNote = document.getElementById('f-essay-note')?.value.trim();
  const closingText = document.getElementById('f-closing-text')?.value.trim();
  const selectedPhotos = listFromText(document.getElementById('f-selected-photos')?.value);
  const contactSheetPhotos = listFromText(document.getElementById('f-contact-sheet-photos')?.value);
  const captions = listFromText(document.getElementById('f-captions')?.value);
  const folder = document.getElementById('f-folder')?.value.trim();

  if (!slug || !folder) { setStatus('error', 'fill in slug and folder path'); return; }
  if (!state.scanned.length) { setStatus('error', 'scan a folder first'); return; }
  if (!state.selected.size)  { setStatus('error', 'no photos selected'); return; }

  const jobId = Date.now().toString();
  const pw    = document.getElementById('progress-wrap');
  pw.classList.add('active');
  document.getElementById('btn-upload').disabled = true;
  resetStages();
  setStage('scan', 'done', state.selected.size + ' files');
  setBar(10); setFile('starting…');

  // SSE
  const evs = new EventSource(\`/api/progress?id=\${jobId}\`);
  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Could not connect to progress stream. Try upload again.')), 5000);
    evs.addEventListener('message', e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'connected') {
          clearTimeout(timer);
          resolve();
        }
      } catch {}
    }, { once: true });
    evs.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Progress stream disconnected. Try upload again.'));
    };
  });
  evs.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'connected') return;
    if (msg.type === 'phase') {
      if (msg.phase === 'compress') {
        setStage('compress', 'active');
        setBar(15); setFile('compressing photos…');
      } else {
        setStage('compress', 'done', msg.total + ' files');
        setStage('upload', 'active');
        setBar(50); setFile('uploading to cloudinary…');
      }
    }
    if (msg.type === 'progress') {
      if (msg.phase === 'compress') {
        const pct = 15 + Math.round((msg.done / msg.total) * 35);
        const verb = msg.status === 'done' ? 'compressed' : 'compressing';
        setBar(pct); setFile(verb + ' ' + msg.done + '/' + msg.total + ': ' + msg.file);
        setStage('compress', 'active', \`\${msg.done}/\${msg.total}\`);
      } else {
        const pct = 50 + Math.round((msg.done / msg.total) * 40);
        setBar(pct); setFile(msg.file);
        setStage('upload', 'active', \`\${msg.done}/\${msg.total}\`);
      }
      document.getElementById('progress-fill').style.width =
        Math.round((msg.done / msg.total) * 100) + '%';
    }
    if (msg.type === 'done') {
      evs.close();
      state.uploaded = msg.count;
      state.isNew = false; // series now exists — deploy always available
      setStage('compress', 'done'); setStage('upload', 'done', msg.count + ' photos');
      setBar(90); setFile(\`\${msg.count} photos ready on cloudinary\`);
      document.getElementById('progress-fill').style.width = '100%';
      document.getElementById('progress-phase').textContent = 'done ✓';
      document.getElementById('btn-upload').disabled = false;
      document.getElementById('btn-deploy').disabled = false;
      document.getElementById('deploy-hint').textContent = '';
      boot();
    }
    if (msg.type === 'error') {
      evs.close();
      setStatus('error', msg.message);
      setStage('compress', 'error');
      setStage('upload', '');
      document.getElementById('btn-upload').disabled = false;
    }
  };

  // Start job
  try {
    await connected;
    const started = await fetch('/api/publish', {
      method: 'POST',
      body: JSON.stringify({
        jobId,
        slug,
        type,
        title,
        meta,
        description: desc,
        essayNote,
        closingText,
        selectedPhotos,
        contactSheetPhotos,
        captions,
        folder,
        hero: state.hero,
        isNew: state.isNew,
        files: [...state.selected],
      }),
    }).then(r => r.json());
    if (started.error) {
      evs.close();
      setStage('compress', 'error');
      setStatus('error', started.error);
      document.getElementById('btn-upload').disabled = false;
    }
  } catch (e) {
    evs.close();
    setStage('compress', 'error');
    setStatus('error', e.message);
    document.getElementById('btn-upload').disabled = false;
  }
}

// ── Deploy ────────────────────────────────────────────────────────────────────
async function deployNow() {
  const slug  = document.getElementById('f-slug')?.value.trim();
  const type  = document.getElementById('f-type')?.value === 'chapter' ? 'chapter' : 'archive';
  const title = document.getElementById('f-title')?.value.trim();
  const meta  = document.getElementById('f-meta')?.value.trim();
  const desc  = document.getElementById('f-desc')?.value.trim();
  const essayNote = document.getElementById('f-essay-note')?.value.trim();
  const closingText = document.getElementById('f-closing-text')?.value.trim();
  const selectedPhotos = listFromText(document.getElementById('f-selected-photos')?.value);
  const contactSheetPhotos = listFromText(document.getElementById('f-contact-sheet-photos')?.value);
  const captions = listFromText(document.getElementById('f-captions')?.value);
  document.getElementById('btn-deploy').disabled = true;

  setStage('deploy', 'active'); setBar(92); setFile('saving changes…');

  // Save metadata first (works even without uploading new photos)
  if (!state.isNew) {
    const saved = await fetch('/api/save', {
      method: 'POST',
      body: JSON.stringify({
        slug,
        type,
        title,
        meta,
        description: desc,
        essayNote,
        closingText,
        selectedPhotos,
        contactSheetPhotos,
        captions,
      }),
    }).then(r => r.json());
    if (saved.error) { setStage('deploy','error'); setStatus('error', saved.error); document.getElementById('btn-deploy').disabled = false; return; }
  }

  setBar(96); setFile('pushing to github…');
  const res = await fetch('/api/deploy', {
    method: 'POST',
    body: JSON.stringify({ slug, title, count: state.uploaded, isNew: state.isNew }),
  }).then(r => r.json());
  if (res.error) { setStage('deploy','error'); setStatus('error', res.error); document.getElementById('btn-deploy').disabled = false; return; }

  setStage('deploy', 'done'); setBar(100, 'green'); setFile('deployed — vercel is building');
  const sl = document.getElementById('status-link');
  sl.href = res.url; sl.style.display = 'block';
  document.getElementById('btn-deploy').disabled = false;
}

// ── Stage / progress helpers ──────────────────────────────────────────────────
function setStage(name, state, count = '') {
  const el = document.getElementById('stage-' + name);
  if (!el) return;
  el.className = 'stage ' + state;
  const c = document.getElementById('count-' + name);
  if (c) c.textContent = count;
}

function setBar(pct, color = '') {
  const fill = document.getElementById('bar-fill');
  fill.style.width = pct + '%';
  fill.className = 'bottom-progress-fill' + (color ? ' ' + color : '');
}

function setFile(msg) {
  document.getElementById('status-file').textContent = msg;
}

function resetStages() {
  ['scan','compress','upload','deploy'].forEach(s => setStage(s, ''));
  setBar(0);
  document.getElementById('status-link').style.display = 'none';
}

// kept for backward compat but now drives the richer bar too
function setStatus(type, msg) {
  setFile(msg);
  if (type === 'error') setBar(100, 'red');
}

// ── Delete series ─────────────────────────────────────────────────────────────
function deleteSeries(slug, title) {
  const el = document.querySelector(\`.series-row[data-slug="\${slug}"]\`);
  if (document.getElementById('confirm-delete-' + slug)) return;
  const box = document.createElement('div');
  box.id = 'confirm-delete-' + slug;
  box.style.cssText = 'position:absolute;right:0;top:0;bottom:0;display:flex;align-items:center;gap:6px;padding:0 10px;background:var(--surface2);z-index:10;border-left:1px solid var(--border)';
  box.innerHTML = \`
    <span style="font-family:var(--mono);font-size:0.48rem;color:var(--red);letter-spacing:0.08em">delete?</span>
    <button id="confirm-yes-\${slug}" style="font-family:var(--mono);font-size:0.48rem;letter-spacing:0.1em;color:var(--red);background:none;border:1px solid var(--red);padding:2px 7px;cursor:pointer">yes</button>
    <button id="confirm-no-\${slug}"  style="font-family:var(--mono);font-size:0.48rem;letter-spacing:0.1em;color:var(--text);background:none;border:1px solid var(--muted);padding:2px 7px;cursor:pointer">no</button>
  \`;
  el.appendChild(box);
  document.getElementById('confirm-no-'  + slug).onclick = e => { e.stopPropagation(); box.remove(); };
  document.getElementById('confirm-yes-' + slug).onclick = e => { e.stopPropagation(); box.remove(); doDeleteSeries(slug, title); };
}

async function doDeleteSeries(slug, title) {
  setFile('deleting series…'); setBar(30);
  const res = await fetch('/api/delete-series', {
    method: 'POST',
    body: JSON.stringify({ slug }),
  }).then(r => r.json());
  if (res.error) { setStatus('error', res.error); return; }
  state.series = state.series.filter(s => s.slug !== slug);
  if (state.active === slug) {
    state.active = null;
    state.isNew  = false;
    document.getElementById('main-content').innerHTML = \`
      <div class="empty-state">
        <div class="empty-state-icon">✦</div>
        <div class="empty-state-text">select a series or create a new one</div>
      </div>\`;
    document.getElementById('action-row').style.display = 'none';
  }
  renderSidebar();
  setBar(100, 'green'); setFile(\`"\${title}" deleted and deployed\`);
}

boot();

// ── Drag & drop (paths come from native Swift handler) ────────────────────────
window.handleNativeDrop = async function(paths) {
  const overlay = document.getElementById('drop-overlay');
  overlay.classList.remove('active');

  const IMG = /\.(jpe?g|png|tiff?)$/i;
  const imagePaths = paths.filter(p => IMG.test(p));
  if (!imagePaths.length) return;

  // If a single folder was dropped, use it directly; otherwise use parent of first file
  const isFolder = !IMG.test(paths[0]);
  const folder   = isFolder ? paths[0] : paths[0].split('/').slice(0, -1).join('/');
  const droppedNames = new Set(imagePaths.map(p => p.split('/').pop()));

  const folderInput = document.getElementById('f-folder');
  if (!folderInput) { setStatus('error', 'select a series first'); return; }
  folderInput.value = folder;

  setStage('scan', 'active'); setFile('scanning…');
  const res = await fetch('/api/scan', { method: 'POST', body: JSON.stringify({ folder }) }).then(r => r.json());
  if (res.error) { setStage('scan', 'error'); setStatus('error', res.error); return; }

  state.scanned    = res.files;
  state.scannedDir = res.dir;
  state.selected   = new Set(res.files.filter(f => droppedNames.has(f)));
  if (!state.selected.size) state.selected = new Set(res.files);
  if (!state.hero) state.hero = [...state.selected][0] || '';

  const area = document.getElementById('new-photo-area') || document.getElementById('photo-area');
  renderPhotoGrid(res.files, res.dir, area);

  document.getElementById('btn-upload').disabled = state.selected.size === 0;
  setStage('scan', 'done', res.files.length + ' files');
  setFile(\`\${state.selected.size} of \${res.files.length} photos selected\`);
};

// Show overlay while dragging over the window (visual feedback only)
(function () {
  const overlay = document.getElementById('drop-overlay');
  let dragDepth = 0;
  document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; overlay.classList.add('active'); });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; overlay.classList.remove('active'); } });
  document.addEventListener('dragover',  e => e.preventDefault());
  document.addEventListener('drop',      e => { e.preventDefault(); dragDepth = 0; overlay.classList.remove('active'); });
})();
</script>
</body>
</html>`;

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  route(req, res).catch(e => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  ✦  tcof publisher\n`);
  console.log(`  \x1b[38;2;189;135;53mopen\x1b[0m  ${url}\n`);
  if (process.env.TCOF_NO_AUTO_OPEN !== '1') {
    try { spawnSync('open', [url]); } catch {}
  }
});
