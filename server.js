// ClipForge — serveur public
// - sert le site (dossier public/)
// - importe les vidéos YouTube / Twitch avec yt-dlp (jobs + progression)
// - appelle Claude (API Anthropic) pour choisir les moments, écrire les titres, vérifier les sous-titres
import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 3000;
const TMP = process.env.TMP_DIR || path.join(__dirname, 'tmp');
const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const MAX_MINUTES = +process.env.MAX_MINUTES || 180;          // durée max d'une vidéo importée
const MAX_HEIGHT = +process.env.MAX_HEIGHT || 1080;
const JOB_TTL_MS = (+process.env.JOB_TTL_MIN || 60) * 60e3;    // fichiers supprimés après 1 h
const MAX_PARALLEL = +process.env.MAX_PARALLEL || 2;           // téléchargements simultanés
const DL_PER_HOUR = +process.env.DL_PER_HOUR || 6;             // imports par visiteur et par heure
const AI_PER_HOUR = +process.env.AI_PER_HOUR || 60;            // appels Claude par visiteur et par heure
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || 'youtube.com,www.youtube.com,m.youtube.com,music.youtube.com,youtu.be,twitch.tv,www.twitch.tv,m.twitch.tv,clips.twitch.tv')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const PROXY = process.env.YTDLP_PROXY || '';                     // facultatif : proxy si YouTube bloque l'IP du serveur
const COOKIES = process.env.YTDLP_COOKIES_FILE || '';            // facultatif : fichier cookies.txt

fs.mkdirSync(TMP, { recursive: true });
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// Isolation cross-origin => transcription multi-thread (bien plus rapide) dans le navigateur
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});

/* ---------- limitation simple par IP ---------- */
const buckets = new Map();
function allow(ip, kind, perHour) {
  const k = kind + '|' + ip, now = Date.now();
  const arr = (buckets.get(k) || []).filter(t => now - t < 3600e3);
  if (arr.length >= perHour) { buckets.set(k, arr); return false; }
  arr.push(now); buckets.set(k, arr); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of buckets) if (!a.some(t => now - t < 3600e3)) buckets.delete(k); }, 600e3).unref();

/* ---------- santé ---------- */
app.get('/api/health', (req, res) => res.json({ clipforge: true, ok: true, claude: !!ANTHROPIC_KEY, download: true, maxMinutes: MAX_MINUTES }));

/* ---------- import de vidéo ---------- */
const jobs = new Map();
let running = 0; const queue = [];

function checkUrl(u) {
  let url; try { url = new URL(u); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const h = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.some(a => h === a || h.endsWith('.' + a))) return null;
  return url.toString();
}
function baseArgs() {
  const a = ['--no-playlist', '--no-warnings', '--newline', '--restrict-filenames'];
  if (PROXY) a.push('--proxy', PROXY);
  if (COOKIES) a.push('--cookies', COOKIES);
  return a;
}
function run(args, onLine) {
  return new Promise((resolve) => {
    const p = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; if (onLine) String(d).split('\n').forEach(onLine); });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
    p.on('error', e => resolve({ code: -1, out, err: String(e) }));
  });
}
function friendlyError(err) {
  if (/sign in to confirm|not a bot/i.test(err)) return 'YouTube bloque temporairement le serveur (anti-robot). Réessaie plus tard ou importe le fichier vidéo directement.';
  if (/private video|members-only|login required/i.test(err)) return 'Vidéo privée ou réservée aux membres : impossible de l\'importer.';
  if (/unavailable|not available|does not exist|404/i.test(err)) return 'Vidéo introuvable ou indisponible.';
  if (/live event|is live|premieres in/i.test(err)) return 'Les lives en cours ne peuvent pas être importés (attends la rediffusion).';
  return 'Import impossible (' + (err.split('\n').filter(Boolean).pop() || 'erreur inconnue').slice(0, 160) + ')';
}
async function processJob(job) {
  job.status = 'info';
  const info = await run([...baseArgs(), '-J', '--', job.url]);
  if (info.code !== 0) { job.status = 'error'; job.error = friendlyError(info.err); return; }
  let meta; try { meta = JSON.parse(info.out); } catch { job.status = 'error'; job.error = 'Réponse illisible.'; return; }
  job.title = meta.title || 'video';
  if (meta.is_live) { job.status = 'error'; job.error = 'Les lives en cours ne peuvent pas être importés.'; return; }
  if (meta.duration && meta.duration > MAX_MINUTES * 60) { job.status = 'error'; job.error = `Vidéo trop longue (max ${MAX_MINUTES} min).`; return; }
  job.status = 'downloading';
  const outTpl = path.join(TMP, job.id + '.%(ext)s');
  const H = MAX_HEIGHT;
  const fmt = `bv*[height<=${H}][vcodec^=avc1]+ba[ext=m4a]/b[height<=${H}][ext=mp4]/bv*[height<=${H}]+ba/b[height<=${H}]/b`;
  const nParts = Array.isArray(meta.requested_formats) && meta.requested_formats.length ? meta.requested_formats.length : 1;
  let media = -1; // index du fichier média en cours (vidéo puis audio)
  const r = await run([...baseArgs(), '-f', fmt, '--merge-output-format', 'mp4', '--max-filesize', '4G',
    '--write-subs', '--write-auto-subs', '--sub-langs', 'fr,fr-FR,fr-orig,en,en-orig', '--sub-format', 'vtt', '--ignore-errors',
    '-o', outTpl, '--', job.url], line => {
      const d = line.match(/\[download\] Destination: (.+)$/);
      if (d) { job._sub = /\.vtt\s*$/.test(d[1]); if (!job._sub) media++; }
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m && !job._sub && media >= 0) job.progress = Math.min(0.99, (Math.min(media, nParts - 1) + (+m[1] / 100)) / nParts);
      if (/\[Merger\]/.test(line)) job.progress = 0.99;
    });
  const files = fs.readdirSync(TMP).filter(f => f.startsWith(job.id + '.'));
  const mp4 = files.find(f => f.endsWith('.mp4')) || files.find(f => /\.(mkv|webm|mov)$/.test(f));
  const subsPref = ['fr', 'fr-FR', 'fr-orig', 'en', 'en-orig'];
  const vtts = files.filter(f => f.endsWith('.vtt'));
  const vtt = subsPref.map(l => vtts.find(f => f.endsWith(`.${l}.vtt`))).find(Boolean) || vtts[0];
  if (!mp4) { job.status = 'error'; job.error = friendlyError(r.err); return; }
  job.file = path.join(TMP, mp4); job.subs = vtt ? path.join(TMP, vtt) : null;
  job.progress = 1; job.status = 'done';
}
function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift(); running++;
    processJob(job).catch(e => { job.status = 'error'; job.error = String(e.message || e); }).finally(() => { running--; pump(); });
  }
}
app.post('/api/jobs', (req, res) => {
  const url = checkUrl(String((req.body && req.body.url) || '').trim());
  if (!url) return res.status(400).json({ error: 'Lien non accepté : colle un lien YouTube ou Twitch.' });
  if (!allow(req.ip, 'dl', DL_PER_HOUR)) return res.status(429).json({ error: `Limite atteinte (${DL_PER_HOUR} imports par heure). Réessaie plus tard.` });
  const id = crypto.randomBytes(9).toString('hex');
  const job = { id, url, status: 'queued', progress: 0, _last: 0, created: Date.now() };
  jobs.set(id, job); queue.push(job); pump();
  res.json({ id });
});
app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id); if (!j) return res.status(404).json({ error: 'Import introuvable ou expiré.' });
  res.json({ status: j.status, progress: j.progress, title: j.title, error: j.error, subs: !!j.subs, queued: j.status === 'queued' ? queue.indexOf(j) + 1 : 0 });
});
app.get('/api/jobs/:id/file', (req, res) => {
  const j = jobs.get(req.params.id); if (!j || j.status !== 'done' || !fs.existsSync(j.file)) return res.status(404).json({ error: 'Fichier indisponible.' });
  res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Content-Length', fs.statSync(j.file).size);
  fs.createReadStream(j.file).pipe(res);
});
app.get('/api/jobs/:id/subs', (req, res) => {
  const j = jobs.get(req.params.id); if (!j || !j.subs || !fs.existsSync(j.subs)) return res.status(404).end();
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8'); fs.createReadStream(j.subs).pipe(res);
});
// ménage
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.created > JOB_TTL_MS && j.status !== 'downloading') { jobs.delete(id); }
  for (const f of fs.readdirSync(TMP)) { const p = path.join(TMP, f); try { if (now - fs.statSync(p).mtimeMs > JOB_TTL_MS) fs.rmSync(p, { force: true }); } catch { } }
}, 5 * 60e3).unref();

/* ---------- Claude ---------- */
function extractJSON(t) {
  t = String(t || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { } }
  return null;
}
app.post('/api/claude', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'Claude non configuré sur ce serveur.', code: 'unavailable' });
  const prompt = String((req.body && req.body.prompt) || '');
  if (!prompt || prompt.length > 160000) return res.status(400).json({ error: 'Requête invalide.' });
  if (!allow(req.ip, 'ai', AI_PER_HOUR)) return res.status(429).json({ error: 'Trop de demandes, réessaie dans un moment.', code: 'rate_limited' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 8000, messages: [{ role: 'user', content: prompt + '\n\nRéponds uniquement avec le JSON demandé, sans texte autour.' }] }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || 'Erreur Claude', code: 'upstream' });
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const result = extractJSON(text);
    if (!result) return res.status(502).json({ error: 'Réponse de Claude illisible.', code: 'bad_json' });
    res.json({ result });
  } catch (e) { res.status(502).json({ error: 'Claude injoignable.', code: 'upstream' }); }
});

/* ---------- site ---------- */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', setHeaders: (res, p) => { if (p.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache'); } }));

app.listen(PORT, () => console.log(`ClipForge en ligne sur le port ${PORT} — Claude ${ANTHROPIC_KEY ? 'activé' : 'désactivé'}`));
