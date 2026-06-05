#!/usr/bin/env node
/**
 * tcof publisher
 * Usage: node publish.mjs
 *
 * Compresses photos locally → uploads to Cloudinary → updates config.js → deploys.
 */

import { createInterface } from 'readline';
import { readdirSync, statSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, basename, resolve } from 'path';
import { execSync, spawnSync } from 'child_process';
import { tmpdir, homedir } from 'os';
import { createRequire } from 'module';

// ── Cloudinary (local install) ──────────────────────────────────────────────
const require = createRequire(import.meta.url);
let cloudinary;
try {
  cloudinary = require('cloudinary').v2;
} catch {
  console.log('installing cloudinary...');
  execSync('npm install cloudinary', { cwd: new URL('.', import.meta.url).pathname, stdio: 'inherit' });
  cloudinary = require('cloudinary').v2;
}

cloudinary.config({
  cloud_name: 'dttbzi3he',
  api_key:    '167147487562595',
  api_secret: 'UkM39bfDbknbKh2FJpoOuPWN9NI',
});

const ROOT       = new URL('.', import.meta.url).pathname;
const CONFIG     = join(ROOT, 'config.js');
const MAX_BYTES  = 9.5 * 1024 * 1024;
const IMG_EXT    = /\.(jpe?g|png|tiff?)$/i;

// ── Helpers ─────────────────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, fallback = '') => new Promise(res =>
  rl.question(fallback ? `${q} [${fallback}]: ` : `${q}: `, a => res(a.trim() || fallback))
);
const hr  = () => console.log('\n' + '─'.repeat(52));
const log = (icon, msg) => console.log(`  ${icon}  ${msg}`);

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── Read current config.js ───────────────────────────────────────────────────
function readConfig() {
  const src = readFileSync(CONFIG, 'utf8');
  // Extract CLOUDINARY_BASE and series array as text blocks
  const baseMatch = src.match(/const CLOUDINARY_BASE\s*=\s*"([^"]+)"/);
  const base = baseMatch ? baseMatch[1] : '';
  // Eval the series array safely by isolating it
  const seriesMatch = src.match(/const series\s*=\s*(\[[\s\S]*?\]);/);
  let series = [];
  if (seriesMatch) {
    try { series = eval(seriesMatch[1]); } catch {}
  }
  return { base, series, src };
}

// ── Write updated config.js ──────────────────────────────────────────────────
function writeConfig(series) {
  const lines = ['const CLOUDINARY_BASE = "https://res.cloudinary.com/dttbzi3he/image/upload";', ''];
  lines.push('const series = [');
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
  lines.push('];');
  lines.push('');
  writeFileSync(CONFIG, lines.join('\n'), 'utf8');
}

// ── Compress one photo ────────────────────────────────────────────────────────
function compress(src, destDir) {
  const dest = join(destDir, basename(src));
  if (existsSync(dest)) return dest;
  execSync(
    `sips --resampleWidth 3000 --setProperty formatOptions 82 "${src}" --out "${dest}"`,
    { stdio: 'pipe' }
  );
  return dest;
}

// ── Upload one photo ─────────────────────────────────────────────────────────
async function uploadPhoto(filePath, folder, publicId) {
  try {
    await cloudinary.uploader.upload(filePath, {
      folder,
      public_id: publicId,
      overwrite: false,
      resource_type: 'image',
    });
    return 'uploaded';
  } catch (e) {
    if (e.message?.includes('already exists')) return 'exists';
    throw e;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.clear();
  console.log('\n  ✦  tcof publisher\n');

  const { series } = readConfig();

  // ── What to do? ──
  hr();
  console.log('  what would you like to do?\n');
  console.log('  1  add a new series');
  console.log('  2  update an existing series (add/replace photos)');
  const action = await ask('\n  choice', '1');

  let targetSeries;
  let isNew = false;

  if (action === '2') {
    hr();
    console.log('  existing series:\n');
    series.forEach((s, i) => console.log(`  ${i + 1}  ${s.title} (${s.photos.length} photos)`));
    const pick = parseInt(await ask('\n  number')) - 1;
    targetSeries = { ...series[pick] };
  } else {
    isNew = true;
    hr();
    console.log('  new series details:\n');
    const title       = await ask('  title (e.g. South Korea)');
    const slugDefault = slugify(title);
    const slug        = await ask('  slug', slugDefault);
    const meta        = await ask('  meta (e.g. Asia · 35mm)');
    const description = await ask('  description (optional, press enter to skip)');
    targetSeries = {
      slug,
      title,
      meta,
      ...(description ? { description } : {}),
      folder: `chronicles/${slug}`,
      photos: [],
    };
  }

  // ── Photo folder ──
  hr();
  console.log('  photos\n');
  const folderPath = resolve((await ask('  folder path')).replace(/^~/, homedir()));
  if (!existsSync(folderPath)) { console.error('\n  ✗  folder not found'); process.exit(1); }

  const allFiles = readdirSync(folderPath).filter(f => IMG_EXT.test(f)).sort();
  if (!allFiles.length) { console.error('\n  ✗  no images found'); process.exit(1); }

  log('✓', `found ${allFiles.length} photos`);

  // ── Hero photo ──
  console.log('\n  which photo should be the hero (cover)?\n');
  allFiles.slice(0, 10).forEach((f, i) => console.log(`  ${i + 1}  ${f}`));
  if (allFiles.length > 10) console.log(`  ... and ${allFiles.length - 10} more`);
  const heroInput = await ask('\n  filename or number', '1');
  let heroFile = isNaN(heroInput)
    ? allFiles.find(f => f.toLowerCase().includes(heroInput.toLowerCase())) || allFiles[0]
    : allFiles[parseInt(heroInput) - 1] || allFiles[0];

  // Put hero first
  const ordered = [heroFile, ...allFiles.filter(f => f !== heroFile)];
  log('✓', `hero → ${heroFile}`);

  // ── Compress ──
  hr();
  console.log('  compressing photos...\n');
  const tmpDir = join(tmpdir(), `tcof-${targetSeries.slug}`);
  mkdirSync(tmpDir, { recursive: true });

  const compressed = [];
  for (let i = 0; i < ordered.length; i++) {
    const f = ordered[i];
    process.stdout.write(`\r  [${i + 1}/${ordered.length}] ${f}                    `);
    const dest = compress(join(folderPath, f), tmpDir);
    const sizeMB = (statSync(dest).size / 1024 / 1024).toFixed(1);
    compressed.push({ file: f, dest, sizeMB });
  }
  console.log('\n');
  log('✓', 'compression done');

  // ── Upload ──
  hr();
  console.log('  uploading to cloudinary...\n');
  const uploaded = [];
  const BATCH = 4;

  for (let i = 0; i < compressed.length; i += BATCH) {
    const batch = compressed.slice(i, i + BATCH);
    await Promise.all(batch.map(async ({ file, dest }) => {
      const publicId = file.replace(/\.[^.]+$/, '').toUpperCase();
      const status = await uploadPhoto(dest, targetSeries.folder, publicId);
      uploaded.push(publicId + '.jpg');
      const idx = uploaded.length;
      process.stdout.write(`\r  [${idx}/${compressed.length}] ${file} (${status})`);
    }));
  }
  console.log('\n');
  log('✓', `${uploaded.length} photos ready on cloudinary`);

  // ── Update config.js ──
  hr();
  console.log('  updating config.js...\n');

  if (isNew) {
    targetSeries.photos = uploaded;
    series.push(targetSeries);
  } else {
    const idx = series.findIndex(s => s.slug === targetSeries.slug);
    // Merge: keep existing photos not in this upload, add new ones
    const existing = series[idx].photos;
    const newPhotos = uploaded.filter(p => !existing.includes(p));
    series[idx].photos = [...new Set([...uploaded, ...existing])];
    // Re-order so hero is first
    const heroPublicId = heroFile.replace(/\.[^.]+$/, '').toUpperCase() + '.jpg';
    series[idx].photos = [
      heroPublicId,
      ...series[idx].photos.filter(p => p !== heroPublicId)
    ];
    if (targetSeries.description && !series[idx].description) {
      series[idx].description = targetSeries.description;
    }
  }

  writeConfig(series);
  log('✓', 'config.js updated');

  // ── Deploy ──
  hr();
  const deploy = await ask('\n  deploy now? (git commit + push)', 'y');
  if (deploy.toLowerCase() !== 'n') {
    console.log('');
    const seriesObj = series.find(s => s.slug === targetSeries.slug);
    const msg = isNew
      ? `Add ${seriesObj.title} series — ${uploaded.length} photos`
      : `Update ${seriesObj.title} series — ${uploaded.length} photos`;

    try {
      execSync(`git -C "${ROOT}" add config.js`, { stdio: 'pipe' });
      execSync(`git -C "${ROOT}" commit -m "${msg}"`, { stdio: 'pipe' });
      execSync(`git -C "${ROOT}" push`, { stdio: 'pipe' });
      log('✓', 'pushed — vercel is deploying');
      log('→', `https://www.thechroniclesofafilm.com/series.html?s=${targetSeries.slug}`);
    } catch (e) {
      log('✗', 'git error: ' + e.message);
    }
  }

  hr();
  console.log('\n  all done.\n');
  rl.close();
}

main().catch(e => { console.error(e); process.exit(1); });
