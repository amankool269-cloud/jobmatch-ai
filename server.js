/**
 * server.js — JobMatch AI  (Render.com, Node 18+, ESM)
 *
 * ── PHASE 0 FIXES (2026-05) ────────────────────────────────────────────────
 *  1. Resume parser: dead model string `claude-haiku-20240307` → current Haiku,
 *     pulled from env so the next model retirement is a config change, not a
 *     redeploy. DOCX now parsed via mammoth (was reading zip bytes as text).
 *  2. Email-link tokens: homemade hash → HMAC-SHA256, and the secret now
 *     FAILS LOUD if unset (was silently defaulting to two different strings
 *     across server.js / main.js, which broke every email link when they
 *     didn't match). MUST be identical on Render and Apify.
 *  3. Security: CORS locked to known origins; rate limiting on the two routes
 *     that cost money per call (signup → actor run, parse-resume → Claude).
 *     Admin route moved off the signing secret and out of the query string.
 *  4. DPDP: consent is now captured with version + timestamp + scope, and the
 *     `plan` field is actually persisted (was silently dropped).
 *
 * ── PHASE 1 MONETIZATION (2026-05) ─────────────────────────────────────────
 *  5. Plan model: Free = instant signup digest + weekly (Sunday). Pro (₹99) = daily.
 *     - inlineProfile now carries seniority/education/companyType (were dropped,
 *       which forced every new user's FIRST digest — the conversion pitch — into
 *       low_confidence and killed CA/CFA anchoring).
 *     - Razorpay one-time Payment Link (/api/create-payment-link) + signature-
 *       verified webhook (/api/razorpay-webhook) that flips Plan=Pro, PlanExpiry
 *       =+30d, idempotent on LastPaymentId.
 *     - /upgrade page is the user-facing entry that mints the link and redirects.
 *
 * Required env vars (Render → Environment):
 *   AIRTABLE_TOKEN, AIRTABLE_BASE_ID, BREVO_API_KEY
 *   UNSUBSCRIBE_SECRET   ← MUST match Apify actor exactly
 *   ANTHROPIC_API_KEY
 *   ADMIN_SECRET         ← separate from UNSUBSCRIBE_SECRET, for /api/insights
 *   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET  ← NEW (Phase 1)
 * Optional:
 *   PARSE_MODEL (default claude-haiku-4-5-20251001), APIFY_TOKEN, APIFY_ACTOR_ID,
 *   ALLOWED_ORIGINS (comma-separated)
 *
 * Airtable columns required for Phase 1: Plan (singleSelect Basic/Pro),
 *   PlanExpiry (date as YYYY-MM-DD text/date), LastPaymentId (text).
 */

import express   from 'express';
import path      from 'path';
import fs        from 'fs';
import crypto    from 'crypto';
import { fileURLToPath } from 'url';
import multer    from 'multer';
import pdfParse  from 'pdf-parse/lib/pdf-parse.js';
import mammoth   from 'mammoth';                    // proper DOCX extraction
import rateLimit from 'express-rate-limit';         // abuse protection

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);                          // Render sits behind a proxy; needed for rate-limit IPs

// IMPORTANT: the Razorpay webhook needs the RAW body for signature verification.
// We register that route's raw parser BEFORE express.json() so the global JSON
// parser never consumes the webhook body. All other routes still get JSON.
app.use('/api/razorpay-webhook', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Config ────────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT                || 3000;
const AT_TOKEN      = process.env.AIRTABLE_TOKEN      || '';
const AT_BASE       = process.env.AIRTABLE_BASE_ID    || '';
const BREVO_KEY     = process.env.BREVO_API_KEY       || '';
const APIFY_TOKEN   = process.env.APIFY_TOKEN          || '';
const ACTOR_ID      = process.env.APIFY_ACTOR_ID       || '';
const PARSE_MODEL   = process.env.PARSE_MODEL          || 'claude-haiku-4-5-20251001';
const TABLE         = 'tblJtDvebLwnXvV9i';
const AT_API        = `https://api.airtable.com/v0/${AT_BASE}/${TABLE}`;

// FIX #2: fail loud instead of silently using a default that won't match the actor.
const UNSUB_SECRET = process.env.UNSUBSCRIBE_SECRET;
if (!UNSUB_SECRET) {
  console.error('FATAL: UNSUBSCRIBE_SECRET is not set. Email links will not validate. Refusing to start.');
  process.exit(1);
}
// FIX #3: admin auth is its own secret, never the token-signing secret.
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

// Phase 1: Razorpay. Routes degrade gracefully (return "unavailable") if unset,
// so the server still boots in environments without payment configured.
const RAZORPAY_KEY_ID         = process.env.RAZORPAY_KEY_ID         || '';
const RAZORPAY_KEY_SECRET     = process.env.RAZORPAY_KEY_SECRET     || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const PRO_PRICE_PAISE = 9900;          // ₹99
const PRO_DAYS        = 30;            // one-time link grants 30 days of Pro
const SERVER_URL      = process.env.SERVER_URL || 'https://jobmatch-ai-z19k.onrender.com';

// Current consent text version — bump this string whenever the consent wording changes.
// Stored per user so you can prove WHAT they agreed to and WHEN (DPDP requirement).
const CONSENT_VERSION = '2026-05-v1';

// ── CORS (FIX #3: locked to known origins, not '*') ───────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://jobmatch-ai-z19k.onrender.com,https://jobmatchai.co.in,https://www.jobmatchai.co.in')
  .split(',').map(s => s.trim()).filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  // No origin header = same-origin request (the page Express itself serves) → always fine.
}

// ── Rate limiters (FIX #3: protect the money-spending routes) ─────────────────
const signupLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 5,                     // 5 signups/min/IP (v8: `limit` replaces `max`)
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please wait a minute and try again.' },
});
const parseLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 8,                     // 8 resume parses/min/IP
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many uploads. Please wait a minute.' },
});
const payLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 6,                     // 6 link-creations/min/IP
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please wait a minute.' },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const atH = () => ({ Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' });

// FIX #2: HMAC-SHA256 token. Same function MUST exist in main.js with the same secret.
function makeToken(email) {
  return crypto.createHmac('sha256', UNSUB_SECRET)
    .update(email.toLowerCase())
    .digest('hex')
    .slice(0, 16);
}
// Constant-time compare to avoid timing leaks on token guessing.
function validToken(email, token) {
  if (!token) return false;
  const expected = makeToken(email);
  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Airtable with one retry on 429 (shared 5 req/s limit with the actor).
async function atFetch(url, opts = {}, retries = 2) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, opts);
    if (r.status !== 429 || i >= retries) return r;
    await new Promise(res => setTimeout(res, 1000 * (i + 1)));
  }
}
async function findUser(email) {
  const r = await atFetch(`${AT_API}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}&maxRecords=1`, { headers: atH() });
  return (await r.json()).records?.[0] ?? null;
}
async function patchUser(id, fields) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null && v !== ''));
  // typecast: let Airtable coerce values to the field's type and auto-create
  // a missing singleSelect option (e.g. Plan "Basic"). Without this, ONE bad
  // field 422s the WHOLE atomic PATCH and silently drops every other field too.
  const r = await atFetch(`${AT_API}/${id}`, { method: 'PATCH', headers: atH(), body: JSON.stringify({ fields: clean, typecast: true }) });
  if (!r.ok) {
    // No longer swallow the error — surface it so the caller can react/log.
    const err = await r.json().catch(() => ({}));
    throw new Error(`Airtable PATCH ${r.status}: ${JSON.stringify(err)}`);
  }
  return r;
}

// ── Multer (memory storage, 5 MB cap) ────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── Static assets ─────────────────────────────────────────────────────────────
app.use(express.static(__dirname));
app.use(express.static(process.cwd()));
console.log('[boot] static root =', __dirname);

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/ping', (req, res) => {
  applyCors(req, res);
  res.json({ ok: true, ts: new Date().toISOString(), airtable: !!(AT_TOKEN && AT_BASE), node: process.version });
});

// ── GET /api/stats ────────────────────────────────────────────────────────────
let _cache = null, _cacheAt = 0;
app.get('/api/stats', async (req, res) => {
  applyCors(req, res);
  try {
    const now = Date.now();
    if (!_cache || now - _cacheAt > 5 * 60 * 1000) {
      const [ur, mr] = await Promise.all([
        atFetch(`${AT_API}?fields%5B%5D=Email&maxRecords=1000`, { headers: atH() }),
        atFetch(`${AT_API}?filterByFormula=${encodeURIComponent('AND({Status}="Active",NOT({LastRun}=""))')}&fields%5B%5D=LastRun&fields%5B%5D=LastMatches&maxRecords=1000`, { headers: atH() }),
      ]);
      const [ud, md] = await Promise.all([ur.json(), mr.json()]);
      if (ud.error) throw new Error(`Airtable: ${ud.error.type || ud.error.message || JSON.stringify(ud.error)}`);
      const today = new Date().toISOString().slice(0, 10);
      let matchesToday = 0;
      for (const r of md.records || []) {
        if (!(r.fields?.LastRun || '').startsWith(today)) continue;
        try { const a = JSON.parse(r.fields?.LastMatches || '[]'); if (Array.isArray(a)) matchesToday += a.length; } catch {}
      }
      _cache = { activeUsers: (ud.records || []).length, matchesToday, asOf: new Date().toISOString() };
      _cacheAt = now;
    }
    res.json({ ok: true, ..._cache });
  } catch (e) {
    console.error('[stats] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/parse-resume (FIX #1: working model + real DOCX) ────────────────
app.post('/api/parse-resume', parseLimiter, upload.single('resume'), async (req, res) => {
  applyCors(req, res);
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file received' });

  try {
    let text = '';
    const mime = req.file.mimetype || '';

    if (mime === 'application/pdf') {
      text = (await pdfParse(req.file.buffer)).text || '';
    } else if (
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      req.file.originalname?.toLowerCase().endsWith('.docx')
    ) {
      // FIX #1: a .docx is a zip archive — reading it as utf8 produced garbage.
      // mammoth extracts the actual document text.
      text = (await mammoth.extractRawText({ buffer: req.file.buffer })).value || '';
    } else {
      // Legacy .doc or unknown — best-effort ASCII scrape.
      text = req.file.buffer.toString('utf8').replace(/[^\x20-\x7E\n]/g, ' ');
    }

    // ── Regex fallbacks (used if Claude unavailable) ──────────────────────────
    const emailMatch = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6}/);
    const email = emailMatch ? emailMatch[0].toLowerCase() : '';
    const phoneMatch = text.match(/(?:\+91[\s\-]?|0)?[6-9]\d{9}/);
    const phone = phoneMatch ? phoneMatch[0].replace(/\s/g, '') : '';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let firstName = '', lastName = '';
    for (const line of lines.slice(0, 15)) {
      if (/\d/.test(line) || line.includes('@') || line.includes('http')) continue;
      if (line.length < 3 || line.length > 50) continue;
      if (!/^[A-Za-z\s.\-]+$/.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) { firstName = parts[0]; lastName = parts.slice(1).join(' '); break; }
    }

    // ── Claude extraction (FIX #1: valid, env-configurable model) ─────────────
    // Phase 1 note: also asks for seniority + education so the signup form can
    // forward them to inlineProfile. Falls back gracefully if absent.
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
    if (ANTHROPIC_KEY && text.length > 100) {
      try {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: PARSE_MODEL,
            max_tokens: 512,
            messages: [{
              role: 'user',
              content: `Extract info from this resume. Reply ONLY with a single JSON object, no markdown, no explanation:
{"firstName":"","lastName":"","email":"","phone":"","currentRole":"","targetRole":"","skills":[],"yearsExp":0,"location":"","seniority":"","education":""}

Rules:
- targetRole: what they want next (infer from profile summary / objective if present)
- currentRole: their most recent job title
- skills: top 8 skills as short strings
- yearsExp: total years of work experience as a number
- location: city they are based in (Indian city preferred)
- seniority: one of fresher/junior/mid-level/senior/lead/head/director/vp/c-suite
- education: highest qualification, include CA/CFA/MBA/PGDM if present
- phone: Indian mobile number if present

Resume (first 3000 chars):
${text.slice(0, 3000)}`,
            }],
          }),
        });
        if (aiRes.ok) {
          const aiData = await aiRes.json();
          const block = (aiData.content || []).find(b => b.type === 'text');   // don't assume content[0]
          const raw = block?.text?.trim() || '';
          const jsonStr = raw.match(/\{[\s\S]*\}/)?.[0] || '{}';
          const ex = JSON.parse(jsonStr);
          console.log(`[parse-resume] Claude (${PARSE_MODEL}) extracted: ${ex.firstName} ${ex.lastName} / ${ex.currentRole}`);
          return res.json({
            ok: true,
            firstName:   ex.firstName   || firstName,
            lastName:    ex.lastName    || lastName,
            email:       ex.email       || email,
            phone:       ex.phone       || phone,
            currentRole: ex.currentRole || '',
            targetRole:  ex.targetRole  || '',
            skills:      Array.isArray(ex.skills) ? ex.skills : [],
            yearsExp:    ex.yearsExp    || 0,
            location:    ex.location    || '',
            seniority:   ex.seniority   || '',
            education:   ex.education   || '',
            source: 'claude',
          });
        } else {
          const errBody = await aiRes.text().catch(() => '');
          console.error(`[parse-resume] Claude HTTP ${aiRes.status} — model="${PARSE_MODEL}". Body: ${errBody.slice(0, 300)}`);
        }
      } catch (aiErr) {
        console.log('[parse-resume] Claude failed, using regex fallback:', aiErr.message);
      }
    }

    console.log(`[parse-resume] regex: name="${firstName} ${lastName}" email=${email} phone=${phone}`);
    res.json({ ok: true, firstName, lastName, email, phone, source: 'regex' });
  } catch (err) {
    console.error('[parse-resume] error:', err.message);
    res.status(500).json({ ok: false, error: 'Could not parse resume' });
  }
});

// ── GET /feedback ─────────────────────────────────────────────────────────────
app.get('/feedback', async (req, res) => {
  const { email, rating, token } = req.query;
  const r = parseInt(rating, 10);
  if (!email || !validToken(email, token) || !r || r < 1 || r > 5)
    return res.status(400).send(page('Error', '<p>Invalid link.</p>'));
  try {
    const u = await findUser(email);
    if (u) await patchUser(u.id, { LastRating: r, LastRatingDate: new Date().toISOString().slice(0, 10) });
    const E = ['', '😞', '😐', '🙂', '😊', '🤩'], L = ['', 'Poor', 'Okay', 'Good', 'Great', 'Excellent'];
    res.send(page('Thanks!', `<div class="big-emoji">${E[r]}</div><h2>Thanks!</h2><p>You rated today's matches <strong>${L[r]}</strong>.</p>`));
  } catch (e) { res.status(500).send(page('Error', '<p>Something went wrong.</p>')); }
});

// ── GET /unsubscribe ──────────────────────────────────────────────────────────
app.get('/unsubscribe', async (req, res) => {
  const { email, token } = req.query;
  if (!email || !validToken(email, token)) return res.status(400).send(page('Invalid', '<p>Invalid link.</p>'));
  try {
    const u = await findUser(email);
    if (u) await patchUser(u.id, { Status: 'Inactive', Notes: 'Unsubscribed ' + new Date().toISOString().slice(0, 10) });
    if (BREVO_KEY) await fetch('https://api.brevo.com/v3/contacts', { method: 'POST', headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, emailBlacklisted: true }) }).catch(() => {});
    res.send(page('Unsubscribed', `<div class="big-emoji">👋</div><h2>Done.</h2><p>No more digests.<br><a href="/resubscribe?email=${encodeURIComponent(email)}&token=${token}" class="btn">Undo →</a></p>`));
  } catch (e) { res.status(500).send(page('Error', '<p>Something went wrong.</p>')); }
});

// ── GET /resubscribe ──────────────────────────────────────────────────────────
app.get('/resubscribe', async (req, res) => {
  const { email, token } = req.query;
  if (!email || !validToken(email, token)) return res.status(400).send(page('Invalid', '<p>Invalid link.</p>'));
  try {
    const u = await findUser(email);
    if (u) await patchUser(u.id, { Status: 'Active', Notes: 'Resubscribed ' + new Date().toISOString().slice(0, 10) });
    if (BREVO_KEY) await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, { method: 'PUT', headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ emailBlacklisted: false }) }).catch(() => {});
    res.send(page('Welcome back!', '<div class="big-emoji">🎉</div><h2>You\'re back on.</h2><p>Matches resume on your next scheduled digest.</p>'));
  } catch (e) { res.status(500).send(page('Error', '<p>Something went wrong.</p>')); }
});

// ── GET /dashboard ────────────────────────────────────────────────────────────
app.get('/dashboard', async (req, res) => {
  const { email, token } = req.query;
  if (!email || !validToken(email, token)) return res.status(400).send(page('Invalid', '<p>Invalid link.</p>'));
  try {
    const u = await findUser(email);
    if (!u) return res.status(404).send(page('Not found', '<p>No account found.</p>'));
    const f = u.fields || {};
    let jobs = []; try { jobs = JSON.parse(f.LastMatches || '[]'); } catch {}
    const planNow = (f.Plan || 'Basic');
    const isPro = planNow.toLowerCase() === 'pro' &&
      f.PlanExpiry && String(f.PlanExpiry).slice(0, 10) >= new Date().toISOString().slice(0, 10);
    const sc = s => s >= 85 ? '#059669' : s >= 70 ? '#4F46E5' : '#888';
    const cards = jobs.length
      ? jobs.map(j => `<div style="border:1px solid #E6E6E2;border-radius:12px;padding:16px;margin-bottom:10px;background:#fff">
          <div style="display:flex;justify-content:space-between;margin-bottom:8px">
            <div><strong style="color:#0C0C10">${j.t || '—'}</strong><br><span style="font-size:12px;color:#888">${[j.c, j.src].filter(Boolean).join(' · ')}</span></div>
            <strong style="font-size:24px;color:${sc(j.s)}">${j.s}%</strong>
          </div>
          ${j.v ? `<p style="font-size:13px;color:#555;line-height:1.6;background:#f8f8f6;padding:10px;border-radius:8px;border-left:3px solid ${sc(j.s)}">${j.v}</p>` : ''}
          ${j.u ? `<a href="${j.u}" target="_blank" style="display:inline-block;margin-top:10px;padding:6px 16px;background:#0C0C10;color:#fff;border-radius:999px;font-size:12px;font-weight:700;text-decoration:none">Apply →</a>` : ''}
        </div>`).join('')
      : '<p style="color:#888;padding:32px 0;text-align:center">No matches yet — check back after your next digest.</p>';
    const upsell = isPro
      ? `<div style="background:#ecfdf5;border:1px solid rgba(5,150,105,.25);border-radius:12px;padding:14px 16px;margin-bottom:18px;font-size:13px;color:#065f46;font-weight:600">★ Pro — daily digests active until ${String(f.PlanExpiry).slice(0,10)}.</div>`
      : `<div style="background:linear-gradient(135deg,#4F46E5,#0055FF);border-radius:12px;padding:16px 18px;margin-bottom:18px;text-align:center">
           <div style="font-size:14px;font-weight:800;color:#fff;margin-bottom:4px">Get matches every morning</div>
           <div style="font-size:12px;color:rgba(255,255,255,.85);margin-bottom:12px">You're on the free weekly digest. Pro members get daily matches.</div>
           <a href="/upgrade?email=${encodeURIComponent(email)}&token=${token}" style="display:inline-block;background:#fff;color:#4F46E5;padding:9px 20px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:800">Upgrade to Pro — ₹99</a>
         </div>`;
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your matches</title>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
      <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:#f8f8f6;padding:0 0 60px}
      .top{background:#fff;border-bottom:1px solid #E6E6E2;padding:0 20px;height:52px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0}
      .inner{max-width:600px;margin:0 auto;padding:28px 20px}h1{font-size:20px;font-weight:700;margin-bottom:4px}p.sub{font-size:13px;color:#888;margin-bottom:20px}</style></head>
      <body><div class="top"><strong>JobMatch AI</strong><span style="font-size:12px;color:#888">${email}</span></div>
      <div class="inner"><h1>Your matches</h1><p class="sub">${jobs.length} job${jobs.length !== 1 ? 's' : ''} in this digest · <a href="/unsubscribe?email=${encodeURIComponent(email)}&token=${token}" style="color:#888">Unsubscribe</a></p>
      ${upsell}
      ${cards}</div></body></html>`);
  } catch (e) { res.status(500).send(page('Error', '<p>Something went wrong.</p>')); }
});

// ── GET + POST /profile ───────────────────────────────────────────────────────
app.get('/profile', async (req, res) => {
  const { email, token } = req.query;
  if (!email || !validToken(email, token)) return res.status(400).send(page('Invalid', '<p>Invalid link.</p>'));
  try {
    const u = await findUser(email);
    if (!u) return res.status(404).send(page('Not found', '<p>No account found.</p>'));
    const f = u.fields || {};
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Update profile</title>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
      <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:#f8f8f6;padding:40px 20px}
      .wrap{max-width:480px;margin:0 auto}h1{font-size:20px;font-weight:700;margin-bottom:6px}p.sub{font-size:13px;color:#888;margin-bottom:24px}
      label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#888;margin-bottom:5px;margin-top:14px}
      input{width:100%;padding:9px 12px;border:1px solid #E6E6E2;border-radius:8px;font-family:inherit;font-size:14px;outline:none}
      input:focus{border-color:#4F46E5}
      button{width:100%;margin-top:20px;padding:12px;background:#0C0C10;color:#fff;border:none;border-radius:999px;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer}
      #ok{display:none;background:#ecfdf5;color:#059669;border:1px solid rgba(5,150,105,.2);border-radius:8px;padding:12px;text-align:center;margin-bottom:16px;font-weight:600}</style></head>
      <body><div class="wrap"><h1>Update your profile</h1><p class="sub">Changes apply from your next digest.</p>
      <div id="ok">✓ Profile saved.</div>
      <form id="pf"><input type="hidden" name="email" value="${email}"><input type="hidden" name="token" value="${token}">
      <label>Target role</label><input name="targetRole" value="${f['Target role'] || ''}">
      <label>Current role</label><input name="currentRole" value="${f['Current role'] || ''}">
      <label>Domain / Industry</label><input name="domain" value="${f['Domain'] || ''}">
      <label>Location</label><input name="location" value="${f['Location'] || ''}">
      <label>Key skills</label><input name="skills" value="${f['Skills'] || ''}">
      <label>Cities to search</label><input name="cities" value="${f['Cities'] || ''}">
      <button type="submit">Save changes</button></form></div>
      <script>document.getElementById('pf').addEventListener('submit',async e=>{e.preventDefault();
      const r=await fetch('/profile',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(e.target)).toString()});
      if(r.ok){document.getElementById('ok').style.display='block';window.scrollTo({top:0,behavior:'smooth'});}});</script>
      </body></html>`);
  } catch (e) { res.status(500).send(page('Error', '<p>Something went wrong.</p>')); }
});

app.post('/profile', async (req, res) => {
  const { email, token, targetRole, currentRole, domain, location, skills, cities } = req.body;
  if (!email || !validToken(email, token)) return res.status(403).json({ ok: false });
  try {
    const u = await findUser(email);
    if (!u) return res.status(404).json({ ok: false });
    await patchUser(u.id, { 'Target role': targetRole, 'Current role': currentRole, Domain: domain, Location: location, Skills: skills, Cities: cities });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── POST /api/signup ──────────────────────────────────────────────────────────
app.options('/api/signup', (req, res) => {
  applyCors(req, res);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.post('/api/signup', signupLimiter, async (req, res) => {
  applyCors(req, res);
  // FIX #4: `plan` and `consent` are read and persisted.
  // Phase 1: also read seniority/education/companyType so the FIRST digest
  // (the conversion pitch) isn't forced into low_confidence by missing fields.
  const { name, email, industry, location, targetRole, currentRole, skills, yearsExp, plan, consent, seniority, education, companyType } = req.body || {};

  if (!name || !email) return res.status(400).json({ ok: false, error: 'Name and email are required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Invalid email address.' });
  // DPDP: consent must be explicit. No consent → no account.
  if (consent !== true) return res.status(400).json({ ok: false, error: 'Consent is required to create an account.' });
  if (!AT_TOKEN || !AT_BASE) {
    console.error('[signup] Airtable not configured');
    return res.status(503).json({ ok: false, error: 'Service temporarily unavailable.' });
  }

  try {
    const existing = await findUser(email);
    const nowIso = new Date().toISOString();

    const fields = {
      'Name':     name.trim(),
      'Email':    email.trim().toLowerCase(),
      'Domain':   (industry || '').trim(),
      'Location': (location || 'Bengaluru').trim(),
      'Cities':   (location || 'Bengaluru').trim(),
      'Status':   'Active',
      // FIX #4: persist the chosen plan (default Basic). New signups are free
      // by default — Pro is granted only by the Razorpay webhook after payment.
      'Plan':     (plan || 'Basic').trim(),
      // DPDP consent record — what + when + which version.
      'Consent':         true,
      'ConsentVersion':  CONSENT_VERSION,
      'ConsentAt':       nowIso,
      ...(targetRole  ? { 'Target role':  targetRole.trim()  } : {}),
      ...(currentRole ? { 'Current role': currentRole.trim() } : {}),
      ...(Array.isArray(skills) && skills.length ? { 'Skills': skills.slice(0, 8).join(', ') } : {}),
      ...(yearsExp    ? { 'Experience':   String(yearsExp)    } : {}),
      ...(seniority   ? { 'Seniority':    String(seniority).trim()   } : {}),
      ...(education   ? { 'Education':     String(education).trim()    } : {}),
      ...(companyType ? { 'Company type': String(companyType).trim()  } : {}),
    };

    if (existing) {
      await patchUser(existing.id, { ...fields, 'Notes': 'Re-signup ' + nowIso.slice(0, 10) });
      console.log('[signup] updated existing user:', email);
    } else {
      const r = await atFetch(AT_API, { method: 'POST', headers: atH(), body: JSON.stringify({ fields, typecast: true }) });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        console.error('[signup] Airtable create error:', JSON.stringify(err));
        return res.status(502).json({ ok: false, error: 'Could not save your profile. Try again.' });
      }
      console.log('[signup] created new user:', email, '| plan:', plan || 'Basic');
    }

    if (BREVO_KEY && !existing) {
      fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender:  { name: 'JobMatch AI', email: 'hello@jobmatchai.co.in' },
          to:      [{ email, name }],
          // Phase 1 copy fix: no fixed "7AM" promise — the daily schedule is the
          // dependency. "Shortly" matches the instant signup-triggered digest;
          // ongoing cadence is described honestly as weekly (free) below.
          subject: `Welcome to JobMatch AI — your first matches are on the way`,
          htmlContent: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
            <div style="background:#F97316;border-radius:14px;padding:20px 24px;margin-bottom:24px">
              <div style="font-size:18px;font-weight:800;color:#fff">JobMatch AI</div>
              <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:4px">You're in.</div>
            </div>
            <h2 style="font-size:20px;font-weight:700;color:#111827;margin-bottom:10px">Hi ${name}! 🎉</h2>
            <p style="font-size:14px;color:#6B7280;line-height:1.7;margin-bottom:14px">
              Your profile is live and we're matching your first set of jobs right now — they'll land in your inbox <strong style="color:#111827">shortly</strong>.
            </p>
            <p style="font-size:14px;color:#6B7280;line-height:1.7;margin-bottom:14px">
              We search top job platforms — LinkedIn, Naukri, Google Jobs, Adzuna and more — and send only the roles that actually match your profile, with a score and a plain-English reason. On the free plan you'll get a fresh digest <strong style="color:#111827">every week</strong>; upgrade to Pro for daily matches.
            </p>
            <div style="background:#FFF7ED;border:1px solid rgba(249,115,22,0.2);border-radius:10px;padding:14px 16px;margin-bottom:20px">
              <strong style="font-size:13px;color:#92400E">Your search profile</strong><br>
              <span style="font-size:13px;color:#6B7280">Domain: ${industry || 'not set'} · City: ${location || 'not set'}</span>
            </div>
            <p style="font-size:12px;color:#9CA3AF">JobMatch AI · <a href="mailto:hello@jobmatchai.co.in" style="color:#F97316">hello@jobmatchai.co.in</a></p>
          </div>`,
        }),
      }).catch(e => console.error('[signup] welcome email error:', e.message));
    }

    _cache = null;

    if (!existing && APIFY_TOKEN && ACTOR_ID) {
      fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(ACTOR_ID)}/runs?token=${APIFY_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filterEmail: email, inlineProfile: {
          name, email,
          targetRole:  targetRole  || currentRole || '',
          currentRole: currentRole || targetRole  || '',
          domain:      industry || '',
          skills:      Array.isArray(skills) ? skills.join(', ') : (skills || ''),
          experience:  yearsExp ? String(yearsExp) : '',
          seniority:   seniority   || '',     // was dropped → forced low_confidence on first run
          education:   education   || '',     // was dropped → killed CA/CFA anchoring
          companyType: companyType || '',     // was dropped
          location,
          cities:      [location],
          plan:        (plan || 'Basic'),      // signup run sends regardless, but keep consistent
          planExpiry:  '',
        } }),
      }).then(() => console.log('[signup] actor triggered for:', email))
        .catch(e => console.error('[signup] actor trigger failed:', e.message));
    }

    res.json({ ok: true, message: existing ? 'Profile updated! Changes apply from your next digest.' : 'You\'re all set! Your first matches are on the way.' });
  } catch (e) {
    console.error('[signup] error:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

// ── GET /api/matches ───────────────────────────────────────────────────────────
app.get('/api/matches', async (req, res) => {
  applyCors(req, res);
  const { email } = req.query;
  if (!email) return res.status(400).json({ ok: false, error: 'email required' });
  try {
    const u = await findUser(email);
    if (!u) return res.json({ ok: true, matches: [], ready: false, message: 'Profile not found' });
    let matches = []; try { matches = JSON.parse(u.fields?.LastMatches || '[]'); } catch {}
    const today = new Date().toISOString().slice(0, 10);
    const fresh = (u.fields?.LastRun || '').slice(0, 10) === today;
    res.json({ ok: true, matches, fresh, count: matches.length, lastRun: (u.fields?.LastRun || '').slice(0, 10) });
  } catch (e) {
    console.error('[matches] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/signal ───────────────────────────────────────────────────────────
// NOTE: read-modify-write of the Signals blob is a known lost-update risk under
// concurrency. Acceptable short-term; fixed properly by the Postgres migration
// (Phase 2) where signals become append-only rows.
app.post('/api/signal', async (req, res) => {
  applyCors(req, res);
  const { email, jobTitle, jobScore, action } = req.body || {};
  if (!email || !action) return res.status(400).json({ ok: false, error: 'email and action required' });
  try {
    const user = await findUser(email);
    if (!user) return res.json({ ok: false, error: 'User not found' });
    const signals = (() => { try { return JSON.parse(user.fields?.Signals || '[]'); } catch { return []; } })();
    signals.push({ t: jobTitle || '', s: jobScore || 0, a: action, ts: Date.now() });
    if (signals.length > 200) signals.splice(0, signals.length - 200);
    await patchUser(user.id, { Signals: JSON.stringify(signals) });
    res.json({ ok: true });
  } catch (e) {
    console.error('[signal] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1 — MONETIZATION ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /upgrade — user-facing entry. Mints a Razorpay link and redirects. ─────
// Token-gated so only the real user (via their email link) can start checkout.
app.get('/upgrade', payLimiter, async (req, res) => {
  const { email, token } = req.query;
  if (!email || !validToken(email, token)) return res.status(400).send(page('Invalid', '<p>Invalid link.</p>'));
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return res.send(page('Coming soon', '<div class="big-emoji">⏳</div><h2>Pro is almost ready</h2><p>Daily matching is being switched on. We\'ll email you the moment you can upgrade.</p>'));
  }
  try {
    const u = await findUser(email);
    if (!u) return res.status(404).send(page('Not found', '<p>No account found.</p>'));

    // Already Pro and not expired → don't double-charge; send to dashboard.
    const f = u.fields || {};
    const isPro = (f.Plan || '').toLowerCase() === 'pro' &&
      f.PlanExpiry && String(f.PlanExpiry).slice(0, 10) >= new Date().toISOString().slice(0, 10);
    if (isPro) {
      return res.send(page('Already Pro', `<div class="big-emoji">★</div><h2>You're already Pro</h2><p>Daily matches are active until ${String(f.PlanExpiry).slice(0,10)}.</p><a href="/dashboard?email=${encodeURIComponent(email)}&token=${token}" class="btn">View matches →</a>`));
    }

    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: PRO_PRICE_PAISE, currency: 'INR',
        description: 'JobMatch AI Pro — daily digest, 30 days',
        customer: { email },
        notify: { email: false, sms: false },
        notes: { email: email.toLowerCase() },               // ← webhook maps payment→user from this
        reminder_enable: false,
        callback_url: `${SERVER_URL}/dashboard?email=${encodeURIComponent(email)}&token=${token}`,
        callback_method: 'get',
      }),
    });
    const data = await r.json();
    if (!r.ok || !data.short_url) {
      console.error('[upgrade] razorpay link create failed:', JSON.stringify(data).slice(0, 300));
      return res.status(502).send(page('Error', '<p>Could not start checkout. Please try again in a minute.</p>'));
    }
    // Redirect the user straight to Razorpay's hosted payment page.
    res.redirect(302, data.short_url);
  } catch (e) {
    console.error('[upgrade] error:', e.message);
    res.status(500).send(page('Error', '<p>Something went wrong. Please try again.</p>'));
  }
});

// ── POST /api/create-payment-link — JSON variant (for in-page / dashboard JS) ──
app.post('/api/create-payment-link', payLimiter, async (req, res) => {
  applyCors(req, res);
  const { email } = req.body || {};
  if (!email || !RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) return res.status(400).json({ ok: false, error: 'Unavailable' });
  try {
    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: PRO_PRICE_PAISE, currency: 'INR',
        description: 'JobMatch AI Pro — daily digest, 30 days',
        customer: { email },
        notify: { email: false, sms: false },
        notes: { email: email.toLowerCase() },
        reminder_enable: false,
        callback_url: `${SERVER_URL}/dashboard`,
        callback_method: 'get',
      }),
    });
    const data = await r.json();
    if (!r.ok || !data.short_url) { console.error('[create-payment-link]', JSON.stringify(data).slice(0, 300)); return res.status(502).json({ ok: false }); }
    res.json({ ok: true, url: data.short_url });
  } catch (e) { console.error('[create-payment-link] error:', e.message); res.status(500).json({ ok: false }); }
});

// ── POST /api/razorpay-webhook — flip user to Pro on payment ───────────────────
// Uses RAW body (registered at top, before express.json) for signature verify.
// Idempotent: Razorpay retries on non-2xx, so we skip already-processed payments.
app.post('/api/razorpay-webhook', async (req, res) => {
  try {
    if (!RAZORPAY_WEBHOOK_SECRET) { console.error('[webhook] no secret configured'); return res.status(503).json({ ok: false }); }
    // req.body is a Buffer here because of express.raw registered above.
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const sig = String(req.headers['x-razorpay-signature'] || '');
    const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      console.error('[webhook] bad signature');
      return res.status(400).json({ ok: false });
    }

    const event = JSON.parse(rawBody.toString());
    // Accept the payment-link-paid event. (Order.paid / payment.captured could be
    // added later; for one-time links, payment_link.paid is the authoritative one.)
    if (event.event !== 'payment_link.paid') return res.json({ ok: true, ignored: event.event });

    const linkEntity = event.payload?.payment_link?.entity || {};
    const payEntity  = event.payload?.payment?.entity || {};
    const email = (linkEntity.notes?.email || '').toLowerCase();
    const paymentId = payEntity.id || linkEntity.id;
    if (!email) { console.error('[webhook] no email in notes'); return res.json({ ok: true }); }

    const u = await findUser(email);
    if (!u) { console.error('[webhook] user not found:', email); return res.json({ ok: true }); }

    // Idempotency — skip if we already recorded this payment.
    if (u.fields?.LastPaymentId && u.fields.LastPaymentId === paymentId) {
      console.log('[webhook] duplicate payment, skipping:', paymentId);
      return res.json({ ok: true, duplicate: true });
    }

    const expiry = new Date(Date.now() + PRO_DAYS * 86400 * 1000).toISOString().slice(0, 10);
    await patchUser(u.id, { Plan: 'Pro', PlanExpiry: expiry, LastPaymentId: paymentId, Status: 'Active' });
    console.log(`[webhook] ${email} → Pro until ${expiry} (payment ${paymentId})`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook] error:', e.message);
    res.status(500).json({ ok: false });
  }
});

// ── GET /api/insights (FIX #3: admin secret in header, not query string) ──────
app.get('/api/insights', async (req, res) => {
  applyCors(req, res);
  if (!ADMIN_SECRET || req.headers['x-admin-key'] !== ADMIN_SECRET) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  try {
    const r = await atFetch(`${AT_API}?fields%5B%5D=Email&fields%5B%5D=Signals&fields%5B%5D=LastRating&fields%5B%5D=Domain&fields%5B%5D=Status&fields%5B%5D=Plan&fields%5B%5D=PlanExpiry&maxRecords=1000`, { headers: atH() });
    const d = await r.json();
    if (d.error) throw new Error(JSON.stringify(d.error));
    let totalSignals = 0, clicks = 0, applies = 0, dismisses = 0, ratingSum = 0, ratingCount = 0;
    const scoreHistogram = {}, domainEngagement = {}, planCounts = {};
    const today = new Date().toISOString().slice(0, 10);
    let activePro = 0;
    for (const rec of d.records || []) {
      const sigs = (() => { try { return JSON.parse(rec.fields?.Signals || '[]'); } catch { return []; } })();
      const domain = rec.fields?.Domain || 'unknown';
      const plan = rec.fields?.Plan || 'Basic';
      planCounts[plan] = (planCounts[plan] || 0) + 1;
      if (plan.toLowerCase() === 'pro' && rec.fields?.PlanExpiry && String(rec.fields.PlanExpiry).slice(0,10) >= today) activePro++;
      totalSignals += sigs.length;
      clicks    += sigs.filter(s => s.a === 'click').length;
      applies   += sigs.filter(s => s.a === 'apply').length;
      dismisses += sigs.filter(s => s.a === 'dismiss').length;
      for (const s of sigs.filter(s => s.a === 'click' || s.a === 'apply')) {
        const bucket = String(Math.floor((s.s || 0) / 10) * 10);
        scoreHistogram[bucket] = (scoreHistogram[bucket] || 0) + 1;
      }
      if (sigs.length) domainEngagement[domain] = (domainEngagement[domain] || 0) + sigs.filter(s => s.a === 'click' || s.a === 'apply').length;
      const rating = parseFloat(rec.fields?.LastRating || '');
      if (!isNaN(rating) && rating > 0) { ratingSum += rating; ratingCount++; }
    }
    const activeUsers = (d.records || []).filter(r => r.fields?.Status === 'Active').length;
    res.json({
      ok: true,
      totalUsers: (d.records || []).length, activeUsers,
      usersWithSignals: (d.records || []).filter(r => r.fields?.Signals).length,
      planBreakdown: planCounts,
      activeProUsers: activePro,
      signals: { total: totalSignals, clicks, applies, dismisses },
      engagementRate: (clicks + applies + dismisses) > 0 ? ((clicks + applies) / (clicks + applies + dismisses) * 100).toFixed(1) + '%' : '—',
      rating: ratingCount ? { avg: (ratingSum / ratingCount).toFixed(2), count: ratingCount } : null,
      clicksByScore: scoreHistogram, clicksByDomain: domainEngagement,
      asOf: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[insights] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

// ── GET / ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  const p1 = path.join(__dirname, 'index.html');
  const p2 = path.join(process.cwd(), 'index.html');
  const p = fs.existsSync(p1) ? p1 : fs.existsSync(p2) ? p2 : null;
  if (!p) return res.status(500).send('<h2>index.html not found — make sure it is in the same folder as server.js</h2>');
  res.sendFile(p);
});

// ── Shared mini page shell ────────────────────────────────────────────────────
function page(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — JobMatch AI</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:#f8f8f6;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border:1px solid #E6E6E2;border-radius:16px;padding:36px;max-width:380px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.06)}
  .big-emoji{font-size:44px;margin-bottom:14px}h2{font-size:20px;font-weight:700;margin-bottom:10px}p{font-size:14px;color:#555;line-height:1.65}
  a{color:#4F46E5}.btn{display:inline-block;margin-top:16px;padding:9px 22px;background:#0C0C10;color:#fff;border-radius:999px;font-weight:700;font-size:13px;text-decoration:none}</style>
  </head><body><div class="card">${body}</div></body></html>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n  JobMatch AI server running on port', PORT);
  console.log('  ----------------------------------------');
  console.log('  Parser model  :', PARSE_MODEL);
  console.log('  Allowed origins:', ALLOWED_ORIGINS.join(', '));
  console.log('  Airtable base :', AT_BASE  || '✗ MISSING');
  console.log('  Airtable token:', AT_TOKEN ? AT_TOKEN.slice(0, 12) + '...' : '✗ MISSING');
  console.log('  Unsub secret  :', UNSUB_SECRET ? '✓ set' : '✗ MISSING');
  console.log('  Admin secret  :', ADMIN_SECRET ? '✓ set' : '— not set (/api/insights disabled)');
  console.log('  Razorpay      :', RAZORPAY_KEY_ID ? '✓ keys set' : '— not set (/upgrade shows "coming soon")');
  console.log('  RZP webhook   :', RAZORPAY_WEBHOOK_SECRET ? '✓ secret set' : '— not set (webhook will 503)');
  console.log('  Claude key    :', process.env.ANTHROPIC_API_KEY ? '✓ set' : '— not set (regex fallback)');
  console.log('');
});
