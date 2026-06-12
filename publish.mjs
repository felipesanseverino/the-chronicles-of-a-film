#!/usr/bin/env node
/**
 * tcof publisher
 * Usage: node publish.mjs
 */

import { createInterface } from 'readline';
import { readdirSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { tmpdir, homedir } from 'os';
import { createRequire } from 'module';

// ── Cloudinary ───────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
const ROOT = new URL('.', import.meta.url).pathname;

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

loadLocalEnv(join(ROOT, '.env'));

let cloudinary;
try {
  cloudinary = require('cloudinary').v2;
} catch (e) {
  console.error('Missing dependency: run `npm install` before publishing.');
  process.exit(1);
}

const CLOUDINARY_CONFIG = {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dttbzi3he',
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
};
const missingCloudinary = Object.entries(CLOUDINARY_CONFIG)
  .filter(([, value]) => !value)
  .map(([key]) => key);
if (missingCloudinary.length) {
  console.error(`Missing Cloudinary environment values: ${missingCloudinary.join(', ')}`);
  console.error('Use .env.example as a guide, then export those values before publishing.');
  process.exit(1);
}
cloudinary.config(CLOUDINARY_CONFIG);

// ── ANSI ─────────────────────────────────────────────────────────────────────
const A = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  // colours
  gold:   '\x1b[38;2;189;135;53m',
  white:  '\x1b[38;2;229;210;182m',
  muted:  '\x1b[38;2;90;86;80m',
  green:  '\x1b[38;2;130;190;130m',
  red:    '\x1b[38;2;220;100;100m',
  bg:     '\x1b[48;2;14;14;14m',
};
const c  = (color, str) => `${A[color]}${str}${A.reset}`;
const W  = process.stdout.columns || 72;

// ── ASCII logo ────────────────────────────────────────────────────────────────
const LOGO = `
${c('gold','  ████████╗ ██████╗ ██████╗ ███████╗')}
${c('gold','     ██╔══╝██╔════╝██╔═══██╗██╔════╝')}
${c('gold','     ██║   ██║     ██║   ██║█████╗  ')}
${c('gold','     ██║   ██║     ██║   ██║██╔══╝  ')}
${c('gold','     ██║   ╚██████╗╚██████╔╝██║     ')}
${c('muted','     ╚═╝    ╚═════╝ ╚═════╝ ╚═╝     ')}
${c('muted','  the chronicles of a film  ·  publisher')}
`;

// ── UI helpers ────────────────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (label, fallback = '') => new Promise(res => {
  const hint = fallback ? c('muted', ` [${fallback}]`) : '';
  rl.question(`  ${c('muted','›')} ${c('white', label)}${hint}${c('muted',': ')}`, a => {
    res(a.trim() || fallback);
  });
});

function divider(label = '') {
  const line = '─'.repeat(W - 4);
  if (!label) return console.log(c('muted', `  ${line}`));
  const pad = Math.max(0, W - 4 - label.length - 2);
  console.log(c('muted', `  ─── `) + c('gold', label) + c('muted', ' ' + '─'.repeat(pad)));
}

function ok(msg)   { console.log(`  ${c('green','✓')}  ${c('white', msg)}`); }
function info(msg) { console.log(`  ${c('muted','·')}  ${c('muted', msg)}`); }
function err(msg)  { console.log(`  ${c('red','✗')}  ${c('red', msg)}`); }
function link(msg) { console.log(`  ${c('gold','→')}  ${c('gold', msg)}`); }

function progress(done, total, label = '') {
  const BAR = 28;
  const filled = Math.round((done / total) * BAR);
  const bar = c('gold', '█'.repeat(filled)) + c('muted', '░'.repeat(BAR - filled));
  const pct = String(Math.round((done / total) * 100)).padStart(3);
  process.stdout.write(
    `\r  ${c('muted','[')}${bar}${c('muted',']')} ${c('white', pct + '%')}  ${c('muted', label.slice(0,28).padEnd(28))}`
  );
}

function menuItem(n, label, sub = '') {
  console.log(`  ${c('gold', String(n))}  ${c('white', label)}${sub ? '  ' + c('muted', sub) : ''}`);
}

// ── Config helpers ────────────────────────────────────────────────────────────
const CONFIG = join(ROOT, 'config.js');
const IMG_EXT = /\.(jpe?g|png|tiff?)$/i;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || `${command} failed`).trim();
    throw new Error(msg);
  }
  return result.stdout || '';
}

function readConfig() {
  const src = readFileSync(CONFIG, 'utf8');
  const seriesMatch = src.match(/const series\s*=\s*(\[[\s\S]*?\]);/);
  let series = [];
  if (seriesMatch) { try { series = eval(seriesMatch[1]); } catch {} }
  return { series };
}

function writeConfig(series) {
  const lines = [
    'const CLOUDINARY_BASE = "https://res.cloudinary.com/dttbzi3he/image/upload";',
    '',
    'const series = [',
  ];
  series.forEach((s, i) => {
    lines.push('  {');
    lines.push(`    slug: ${JSON.stringify(s.slug)},`);
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

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── Compress ──────────────────────────────────────────────────────────────────
function compress(src, destDir) {
  const dest = join(destDir, src.split('/').pop());
  if (!existsSync(dest)) {
    run('sips', ['--resampleWidth', '3000', '--setProperty', 'formatOptions', '82', src, '--out', dest]);
  }
  return dest;
}

// ── Upload ────────────────────────────────────────────────────────────────────
async function uploadPhoto(filePath, folder, publicId) {
  try {
    await cloudinary.uploader.upload(filePath, { folder, public_id: publicId, overwrite: false, resource_type: 'image' });
    return 'uploaded';
  } catch (e) {
    if (e.message?.includes('already exists')) return 'exists';
    throw e;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.clear();
  console.log(LOGO);

  const { series } = readConfig();

  // ── action ──
  divider('what would you like to do?');
  console.log('');
  menuItem(1, 'add a new series');
  menuItem(2, 'update an existing series', '(add photos / edit intro)');
  console.log('');
  const action = await ask('choice', '1');

  let targetSeries;
  let isNew = false;

  if (action === '2') {
    console.log('');
    divider('existing series');
    console.log('');
    series.forEach((s, i) =>
      menuItem(i + 1, s.title, `${s.photos.length} photos · ${s.meta}`)
    );
    console.log('');
    const pick = parseInt(await ask('number')) - 1;
    targetSeries = { ...series[pick] };

    // description
    console.log('');
    divider('series intro');
    console.log('');
    if (targetSeries.description) {
      info(`current: "${targetSeries.description.substring(0, 70)}…"`);
      console.log('');
    }
    const desc = await ask(
      targetSeries.description ? 'update intro (enter to keep)' : 'intro text (optional)'
    );
    if (desc) targetSeries.description = desc;

  } else {
    isNew = true;
    console.log('');
    divider('new series');
    console.log('');
    const title       = await ask('title (e.g. South Korea)');
    const slug        = await ask('slug', slugify(title));
    const meta        = await ask('meta (e.g. Asia · 35mm)');
    console.log('');
    divider('series intro');
    console.log('');
    const description = await ask('intro text (optional)');
    targetSeries = {
      slug, title, meta,
      ...(description ? { description } : {}),
      folder: `chronicles/${slug}`,
      photos: [],
    };
  }

  // ── folder ──
  console.log('');
  divider('photos');
  console.log('');
  const rawPath    = await ask('folder path');
  const folderPath = resolve(rawPath.replace(/^~/, homedir()));
  if (!existsSync(folderPath)) { err('folder not found'); process.exit(1); }

  const allFiles = readdirSync(folderPath).filter(f => IMG_EXT.test(f)).sort();
  if (!allFiles.length) { err('no images found in that folder'); process.exit(1); }

  console.log('');
  ok(`found ${c('gold', String(allFiles.length))} photos`);

  // ── hero ──
  console.log('');
  divider('cover photo');
  console.log('');
  const preview = allFiles.slice(0, 12);
  preview.forEach((f, i) => info(`${String(i + 1).padStart(2)}  ${f}`));
  if (allFiles.length > 12) info(`    … and ${allFiles.length - 12} more`);
  console.log('');
  const heroInput = await ask('filename or number', '1');
  const heroFile  = isNaN(heroInput)
    ? allFiles.find(f => f.toLowerCase().includes(heroInput.toLowerCase())) || allFiles[0]
    : allFiles[parseInt(heroInput) - 1] || allFiles[0];
  const ordered   = [heroFile, ...allFiles.filter(f => f !== heroFile)];
  console.log('');
  ok(`cover → ${c('gold', heroFile)}`);

  // ── compress ──
  console.log('');
  divider('compressing');
  console.log('');
  const tmpDir = join(tmpdir(), `tcof-${targetSeries.slug}`);
  mkdirSync(tmpDir, { recursive: true });
  const compressed = [];

  for (let i = 0; i < ordered.length; i++) {
    progress(i, ordered.length, ordered[i]);
    const dest = compress(join(folderPath, ordered[i]), tmpDir);
    compressed.push({ file: ordered[i], dest });
  }
  progress(ordered.length, ordered.length, 'done');
  console.log('\n');
  ok(`compressed ${c('gold', String(compressed.length))} photos`);

  // ── upload ──
  console.log('');
  divider('uploading to cloudinary');
  console.log('');
  const uploaded = [];
  const BATCH    = 4;

  for (let i = 0; i < compressed.length; i += BATCH) {
    const batch = compressed.slice(i, i + BATCH);
    await Promise.all(batch.map(async ({ file, dest }) => {
      const publicId = file.replace(/\.[^.]+$/, '').toUpperCase();
      await uploadPhoto(dest, targetSeries.folder, publicId);
      uploaded.push(publicId + '.jpg');
      progress(uploaded.length, compressed.length, file);
    }));
  }
  progress(compressed.length, compressed.length, 'done');
  console.log('\n');
  ok(`${c('gold', String(uploaded.length))} photos on cloudinary`);

  // ── config ──
  console.log('');
  divider('updating config');
  console.log('');

  if (isNew) {
    targetSeries.photos = uploaded;
    series.push(targetSeries);
  } else {
    const idx = series.findIndex(s => s.slug === targetSeries.slug);
    const heroId = heroFile.replace(/\.[^.]+$/, '').toUpperCase() + '.jpg';
    const merged = [...new Set([...uploaded, ...series[idx].photos])];
    series[idx].photos = [heroId, ...merged.filter(p => p !== heroId)];
    if (targetSeries.description) series[idx].description = targetSeries.description;
  }

  writeConfig(series);
  ok('config.js saved');

  // ── deploy ──
  console.log('');
  divider('deploy');
  console.log('');
  const deploy = await ask('push to github + deploy? (y/n)', 'y');
  if (deploy.toLowerCase() !== 'n') {
    console.log('');
    const seriesObj = series.find(s => s.slug === targetSeries.slug);
    const msg = isNew
      ? `Add ${seriesObj.title} series — ${uploaded.length} photos`
      : `Update ${seriesObj.title} series — ${uploaded.length} photos`;
    try {
      run('git', ['-C', ROOT, 'add', 'config.js']);
      const diff = run('git', ['-C', ROOT, 'diff', '--cached', '--stat']).trim();
      if (diff) run('git', ['-C', ROOT, 'commit', '-m', msg]);
      run('git', ['-C', ROOT, 'push']);
      ok('pushed to github');
      ok('vercel is deploying…');
      console.log('');
      link(`https://www.thechroniclesofafilm.com/series.html?s=${targetSeries.slug}`);
    } catch (e) {
      err('git error: ' + e.message);
    }
  }

  console.log('');
  divider();
  console.log(`\n  ${c('gold','✦')}  ${c('white','all done.')}\n`);
  rl.close();
}

main().catch(e => { err(e.message); process.exit(1); });
