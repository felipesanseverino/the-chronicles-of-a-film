#!/usr/bin/env node
/**
 * tcof visual publisher
 * Usage: node publisher.mjs
 * Opens a local web UI in your browser.
 */

import http from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'fs';
import { join, resolve, extname } from 'path';
import { execSync } from 'child_process';
import { tmpdir, homedir } from 'os';
import { createRequire } from 'module';

const PORT   = 4242;
const ROOT   = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const CONFIG = join(ROOT, 'config.js');
const CACHE  = new Map(); // thumb cache
const IMG_EXT = /\.(jpe?g|png|tiff?)$/i;

// ── Cloudinary ────────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
let cloudinary;
try { cloudinary = require('cloudinary').v2; }
catch {
  execSync('npm install cloudinary', { cwd: ROOT, stdio: 'inherit' });
  cloudinary = require('cloudinary').v2;
}
cloudinary.config({ cloud_name: 'dttbzi3he', api_key: '167147487562595', api_secret: 'UkM39bfDbknbKh2FJpoOuPWN9NI' });

// ── Config helpers ────────────────────────────────────────────────────────────
function readConfig() {
  const src = readFileSync(CONFIG, 'utf8');
  const m = src.match(/const series\s*=\s*(\[[\s\S]*?\]);/);
  let series = [];
  if (m) { try { series = eval(m[1]); } catch {} }
  return series;
}

function writeConfig(series) {
  const lines = ['const CLOUDINARY_BASE = "https://res.cloudinary.com/dttbzi3he/image/upload";', '', 'const series = ['];
  series.forEach((s, i) => {
    lines.push('  {');
    lines.push(`    slug: ${JSON.stringify(s.slug)},`);
    lines.push(`    title: ${JSON.stringify(s.title)},`);
    lines.push(`    meta: ${JSON.stringify(s.meta)},`);
    if (s.description) lines.push(`    description: ${JSON.stringify(s.description)},`);
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
  const dest = join(tmpdir(), 'tcof-thumb-' + Buffer.from(srcPath).toString('base64').slice(0,16) + '.jpg');
  if (!existsSync(dest)) {
    execSync(`sips --resampleWidth 400 --setProperty formatOptions 70 "${srcPath}" --out "${dest}"`, { stdio: 'pipe' });
  }
  const buf = readFileSync(dest);
  CACHE.set(srcPath, buf);
  return buf;
}

function compress(src, destDir) {
  const dest = join(destDir, src.split('/').pop());
  if (!existsSync(dest)) {
    execSync(`sips --resampleWidth 3000 --setProperty formatOptions 82 "${src}" --out "${dest}"`, { stdio: 'pipe' });
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
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
      return res.end(buf);
    } catch { res.writeHead(500); return res.end(); }
  }

  // Series list
  if (m === 'GET' && path === '/api/series') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(readConfig()));
  }

  // Remove a photo from a series
  if (m === 'POST' && path === '/api/remove-photo') {
    const { slug, filename } = await body(req);
    const series = readConfig();
    const idx = series.findIndex(s => s.slug === slug);
    if (idx === -1) { res.writeHead(404); return res.end(JSON.stringify({ error: 'series not found' })); }
    series[idx].photos = series[idx].photos.filter(p => p !== filename);
    writeConfig(series);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, remaining: series[idx].photos.length }));
  }

  // Save metadata only (no upload)
  if (m === 'POST' && path === '/api/save') {
    const { slug, title, meta, description } = await body(req);
    const series = readConfig();
    const idx = series.findIndex(s => s.slug === slug);
    if (idx === -1) { res.writeHead(404); return res.end(JSON.stringify({ error: 'not found' })); }
    if (title) series[idx].title = title;
    if (meta)  series[idx].meta  = meta;
    series[idx].description = description || '';
    if (!series[idx].description) delete series[idx].description;
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
      execSync(`git -C "${ROOT}" add config.js`, { stdio: 'pipe' });

      // Check if there's anything staged to commit
      const diff = execSync(`git -C "${ROOT}" diff --cached --stat`, { stdio: 'pipe' }).toString().trim();
      if (diff) {
        const photoPart = count > 0 ? ` — ${count} photos` : '';
        const msg = isNew ? `Add ${title} series${photoPart}` : `Update ${title} series${photoPart}`;
        execSync(`git -C "${ROOT}" commit -m "${msg}"`, { stdio: 'pipe' });
      }

      execSync(`git -C "${ROOT}" push`, { stdio: 'pipe' });
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
async function runPublish({ jobId, slug, title, meta, description, folder, hero, isNew }) {
  const send = e => sendSSE(jobId, e);
  const dir  = resolve(folder.replace(/^~/, homedir()));
  const allFiles = readdirSync(dir).filter(f => IMG_EXT.test(f)).sort();
  const heroFile = allFiles.find(f => f === hero) || allFiles[0];
  const ordered  = [heroFile, ...allFiles.filter(f => f !== heroFile)];
  const tmpDir   = join(tmpdir(), `tcof-${slug}`);
  mkdirSync(tmpDir, { recursive: true });
  const total = ordered.length;

  // Compress
  send({ type: 'phase', phase: 'compress', total });
  const compressed = [];
  for (let i = 0; i < ordered.length; i++) {
    send({ type: 'progress', phase: 'compress', done: i, total, file: ordered[i] });
    const dest = compress(join(dir, ordered[i]), tmpDir);
    compressed.push({ file: ordered[i], dest });
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

  // Config
  const series = readConfig();
  if (isNew) {
    series.push({ slug, title, meta, ...(description ? { description } : {}), folder: cloudFolder, photos: uploaded });
  } else {
    const idx = series.findIndex(s => s.slug === slug);
    const heroId = heroFile.replace(/\.[^.]+$/, '').toUpperCase() + '.jpg';
    const merged = [...new Set([...uploaded, ...series[idx].photos])];
    series[idx].photos = [heroId, ...merged.filter(p => p !== heroId)];
    if (description) series[idx].description = description;
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

.header-site {
  margin-left: auto;
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

<header>
  <span class="logo">tcof</span>
  <span class="logo-sep">·</span>
  <span class="logo-sub">publisher</span>
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
  hero: '',
  uploaded: 0,
};

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  const data = await fetch('/api/series').then(r => r.json());
  state.series = data;
  renderSidebar();
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function renderSidebar() {
  const el = document.getElementById('series-list');
  el.innerHTML = state.series.map(s => {
    const thumb = s.photos.length
      ? \`<img class="series-thumb" src="https://res.cloudinary.com/dttbzi3he/image/upload/f_auto,q_auto,w_88,h_60,c_fill/\${s.folder}/\${s.photos[0]}" onerror="this.style.display='none'">\`
      : '<div class="series-thumb-empty"></div>';
    return \`<div class="series-row \${state.active === s.slug ? 'active' : ''}" onclick="selectSeries('\${s.slug}')">
      \${thumb}
      <div class="series-info">
        <div class="series-name">\${s.title}</div>
        <div class="series-count">\${s.photos.length} photos · \${s.meta}</div>
      </div>
    </div>\`;
  }).join('');
}

// ── Select / New ──────────────────────────────────────────────────────────────
function selectSeries(slug) {
  const s = state.series.find(x => x.slug === slug);
  if (!s) return;
  state.active = slug;
  state.isNew  = false;
  state.scanned = [];
  state.hero    = s.photos[0] || '';
  renderSidebar();
  renderForm(s);
}

function newSeries() {
  state.active = '__new__';
  state.isNew  = true;
  state.scanned = [];
  state.hero    = '';
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
      <span class="section-label">series details</span>
      <div class="form-grid">
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
          <textarea id="f-desc" placeholder="write something about this series…">\${s && s.description ? s.description : ''}</textarea>
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
  area.innerHTML = \`
    <p class="photo-count">\${files.length} photos — click to set cover</p>
    <div class="photo-grid" id="photo-grid">
      \${files.map(f => \`
        <div class="photo-cell \${state.hero === f ? 'hero' : ''}" onclick="setHero('\${f}')" title="\${f}">
          <img src="/api/thumb?path=\${encodeURIComponent(dir + '/' + f)}" loading="lazy" alt="\${f}">
          <div class="hero-badge">cover</div>
        </div>
      \`).join('')}
    </div>
  \`;
}

function setHero(f) {
  state.hero = f;
  document.querySelectorAll('.photo-cell').forEach(el => {
    el.classList.toggle('hero', el.title === f);
  });
}

// ── Upload ────────────────────────────────────────────────────────────────────
async function startUpload() {
  const title  = document.getElementById('f-title')?.value.trim();
  const slug   = document.getElementById('f-slug')?.value.trim();
  const meta   = document.getElementById('f-meta')?.value.trim();
  const desc   = document.getElementById('f-desc')?.value.trim();
  const folder = document.getElementById('f-folder')?.value.trim();

  if (!slug || !folder) { setStatus('error', 'fill in slug and folder path'); return; }
  if (!state.scanned.length) { setStatus('error', 'scan a folder first'); return; }

  const jobId = Date.now().toString();
  const pw    = document.getElementById('progress-wrap');
  pw.classList.add('active');
  document.getElementById('btn-upload').disabled = true;
  resetStages();
  setStage('scan', 'done', state.scanned.length + ' files');
  setBar(10); setFile('starting…');

  // SSE
  const evs = new EventSource(\`/api/progress?id=\${jobId}\`);
  evs.onmessage = e => {
    const msg = JSON.parse(e.data);
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
        setBar(pct); setFile(msg.file);
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
      setStage('upload', 'error');
      document.getElementById('btn-upload').disabled = false;
    }
  };

  // Start job
  await fetch('/api/publish', {
    method: 'POST',
    body: JSON.stringify({ jobId, slug, title, meta, description: desc, folder, hero: state.hero, isNew: state.isNew }),
  });
}

// ── Deploy ────────────────────────────────────────────────────────────────────
async function deployNow() {
  const slug  = document.getElementById('f-slug')?.value.trim();
  const title = document.getElementById('f-title')?.value.trim();
  const meta  = document.getElementById('f-meta')?.value.trim();
  const desc  = document.getElementById('f-desc')?.value.trim();
  document.getElementById('btn-deploy').disabled = true;

  setStage('deploy', 'active'); setBar(92); setFile('saving changes…');

  // Save metadata first (works even without uploading new photos)
  if (!state.isNew) {
    const saved = await fetch('/api/save', {
      method: 'POST',
      body: JSON.stringify({ slug, title, meta, description: desc }),
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

boot();
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
  // Auto-open browser
  try { execSync(`open "${url}"`); } catch {}
});
