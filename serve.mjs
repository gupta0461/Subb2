// Static file server + reservation/feedback capture for local preview.
// Usage: node serve.mjs   ->   http://localhost:3000  (serves project root)
//
// Storage:
//   - Always appends to local CSVs (reservations.csv / feedback.csv) as a backup.
//   - If a Google Sheet web-app URL is configured, it ALSO forwards there and uses
//     the Sheet as the source of truth for the live count + username uniqueness.
//     Set it via env var:  SUBB2_SHEET_URL="https://script.google.com/macros/s/XXXX/exec" node serve.mjs
//     (or paste the URL into SHEET_URL below). See google-apps-script.gs for the script.
//
// Endpoints:
//   GET  /api/reserve            -> { count }
//   GET  /api/check?handle=x     -> { available, normalized }
//   POST /api/reserve  {name,email,handle,social,phone,platform,size,about} -> { ok, count } | 409 taken
//   POST /api/feedback {name,email,rating,message} -> { ok }
import { createServer } from 'node:http';
import { readFile, appendFile, readFile as read } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const ROOT = process.cwd();
const PORT = 3000;
// Google Sheet backend (Apps Script web app). Env var overrides this default.
const SHEET_URL = process.env.SUBB2_SHEET_URL || 'https://script.google.com/macros/s/AKfycbzgrXO95AJjuzLcc7Fj1a5SB7eYQNYJYfA8EfQcuYewEmnNz8WbvjS5TxYkckGu5UfiTA/exec';
const BASE_RESERVED = 57;

const CSV = join(ROOT, 'reservations.csv');
const CSV_HEADER = 'timestamp,name,email,handle,social,phone,platform,community_size,about\n';
const FB = join(ROOT, 'feedback.csv');
const FB_HEADER = 'timestamp,name,email,rating,message\n';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8',
};

const csv = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ').trim()}"`;
const normHandle = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim());

// ---- local CSV helpers ----
async function csvHandles() {
  if (!existsSync(CSV)) return new Set();
  try {
    const txt = await read(CSV, 'utf8');
    const lines = txt.split('\n').slice(1).filter((l) => l.trim());
    return new Set(lines.map((l) => {
      const m = l.match(/^(?:"[^"]*",){3}"([^"]*)"/); // 4th quoted field = handle
      return m ? m[1].toLowerCase() : '';
    }).filter(Boolean));
  } catch { return new Set(); }
}
async function csvEmails() {
  if (!existsSync(CSV)) return new Set();
  try {
    const txt = await read(CSV, 'utf8');
    const lines = txt.split('\n').slice(1).filter((l) => l.trim());
    return new Set(lines.map((l) => {
      const m = l.match(/^(?:"[^"]*",){2}"([^"]*)"/); // 3rd quoted field = email
      return m ? m[1].toLowerCase() : '';
    }).filter(Boolean));
  } catch { return new Set(); }
}
async function csvCount() {
  if (!existsSync(CSV)) return BASE_RESERVED;
  try {
    const txt = await read(CSV, 'utf8');
    return BASE_RESERVED + Math.max(0, txt.split('\n').filter((l) => l.trim()).length - 1);
  } catch { return BASE_RESERVED; }
}

// ---- remote Google Sheet helpers ----
async function sheetGet(params) {
  const u = new URL(SHEET_URL); Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { redirect: 'follow' });
  return r.json();
}
async function sheetPost(payload) {
  const r = await fetch(SHEET_URL, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return r.json();
}

async function getCount() {
  if (SHEET_URL) { try { const d = await sheetGet({ action: 'count' }); if (typeof d.count === 'number') return d.count; } catch {} }
  return csvCount();
}
async function isTaken(handle) {
  const h = normHandle(handle); if (!h) return false;
  if (SHEET_URL) { try { const d = await sheetGet({ action: 'check', handle: h }); if (typeof d.available === 'boolean') return !d.available; } catch {} }
  return (await csvHandles()).has(h);
}
async function isEmailTaken(email) {
  const e = String(email || '').trim().toLowerCase(); if (!e) return false;
  if (SHEET_URL) { try { const d = await sheetGet({ action: 'check', email: e }); if (typeof d.emailAvailable === 'boolean') return !d.emailAvailable; } catch {} }
  return (await csvEmails()).has(e);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''; req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, `http://localhost:${PORT}`);

  // ---- username availability ----
  if (pathname === '/api/check' && req.method === 'GET') {
    const h = normHandle(searchParams.get('handle'));
    if (!h || h.length < 3) return json(res, 200, { available: false, normalized: h, error: 'too-short' });
    return json(res, 200, { available: !(await isTaken(h)), normalized: h });
  }

  // ---- reservations ----
  if (pathname === '/api/reserve') {
    if (req.method === 'GET') return json(res, 200, { count: await getCount() });
    if (req.method === 'POST') {
      try {
        const b = JSON.parse((await readBody(req)) || '{}');
        const name = (b.name || '').trim(), email = (b.email || '').trim(), handle = normHandle(b.handle);
        if (!name) return json(res, 400, { ok: false, error: 'Please add your name.' });
        if (!validEmail(email)) return json(res, 400, { ok: false, error: 'Please enter a valid email.' });
        if (handle && handle.length < 3) return json(res, 400, { ok: false, code: 'short', error: 'Username needs at least 3 characters.' });
        if (await isEmailTaken(email)) return json(res, 409, { ok: false, code: 'email', error: 'That email is already on the list.' });
        if (handle && await isTaken(handle)) return json(res, 409, { ok: false, code: 'taken', error: 'That username is already taken.' });

        if (!existsSync(CSV)) await appendFile(CSV, CSV_HEADER);
        await appendFile(CSV, [new Date().toISOString(), name, email, handle, b.social, b.phone, b.platform, b.size, b.about].map(csv).join(',') + '\n');
        if (SHEET_URL) { try { await sheetPost({ action: 'reserve', name, email, handle, social: b.social, phone: b.phone, platform: b.platform, size: b.size, about: b.about }); } catch {} }
        return json(res, 200, { ok: true, count: await getCount() });
      } catch { return json(res, 400, { ok: false, error: 'Bad request.' }); }
    }
    res.writeHead(405); return res.end('Method not allowed');
  }

  // ---- feedback ----
  if (pathname === '/api/feedback' && req.method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req)) || '{}');
      const message = (b.message || '').trim();
      if (!message) return json(res, 400, { ok: false, error: 'Please write a little feedback first.' });
      if (!existsSync(FB)) await appendFile(FB, FB_HEADER);
      await appendFile(FB, [new Date().toISOString(), b.name, b.email, b.rating, message].map(csv).join(',') + '\n');
      if (SHEET_URL) { try { await sheetPost({ action: 'feedback', name: b.name, email: b.email, rating: b.rating, message }); } catch {} }
      return json(res, 200, { ok: true });
    } catch { return json(res, 400, { ok: false, error: 'Bad request.' }); }
  }

  // ---- static files ----
  try {
    let urlPath = decodeURIComponent(pathname);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  }
}).listen(PORT, () => console.log(`Serving ${ROOT} at http://localhost:${PORT}` + (SHEET_URL ? ' (Google Sheet connected)' : ' (local CSV)')));
