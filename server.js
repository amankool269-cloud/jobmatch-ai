/**
 * server.js — JobMatch AI  (Render.com, Node 18+, ESM)
 *
 * Deploy structure:
 *   your-repo/
 *   ├── server.js          ← this file
 *   ├── package.json
 *   └── public/
 *       └── index.html     ← landing page
 *
 * Environment variables (Render → Environment):
 *   AIRTABLE_TOKEN
 *   AIRTABLE_BASE_ID
 *   BREVO_API_KEY
 *   UNSUBSCRIBE_SECRET
 */

import express   from 'express';
import path      from 'path';
import fs        from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Config ────────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT                || 3000;
const AT_TOKEN      = process.env.AIRTABLE_TOKEN      || '';
const AT_BASE       = process.env.AIRTABLE_BASE_ID    || '';
const BREVO_KEY     = process.env.BREVO_API_KEY       || '';
const UNSUB_SECRET  = process.env.UNSUBSCRIBE_SECRET  || 'jobmatch-2026';
const APIFY_TOKEN   = process.env.APIFY_TOKEN          || '';
const ACTOR_ID      = process.env.APIFY_ACTOR_ID       || '';  // e.g. "youruser~jobmatch-actor"
const TABLE         = 'tblJtDvebLwnXvV9i';
const AT_API        = `https://api.airtable.com/v0/${AT_BASE}/${TABLE}`;

// ── Helpers ───────────────────────────────────────────────────────────────────
const atH = () => ({ Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' });
const cors = res => res.set('Access-Control-Allow-Origin', '*');

function makeToken(email) {
  let h = 0;
  for (const c of email.toLowerCase() + UNSUB_SECRET) { h = ((h << 5) - h) + c.charCodeAt(0); h |= 0; }
  return Math.abs(h).toString(16).padStart(8, '0') + (email.length + UNSUB_SECRET.length).toString(16);
}
const validToken = (e, t) => !!t && t === makeToken(e);

async function findUser(email) {
  const r = await fetch(`${AT_API}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}&maxRecords=1`, { headers: atH() });
  return (await r.json()).records?.[0] ?? null;
}
async function patchUser(id, fields) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([,v]) => v != null && v !== ''));
  await fetch(`${AT_API}/${id}`, { method: 'PATCH', headers: atH(), body: JSON.stringify({ fields: clean }) });
}

// ── Serve static assets from same folder as server.js ────────────────────────
// index.html lives in the repo root alongside server.js — no public/ needed
app.use(express.static(__dirname));
app.use(express.static(process.cwd()));
console.log('[boot] static root =', __dirname);

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/ping — deployment check ─────────────────────────────────────────
app.get('/api/ping', (_req, res) => {
  cors(res);
  console.log('[ping] ok');
  res.json({ ok: true, ts: new Date().toISOString(), airtable: !!(AT_TOKEN && AT_BASE), node: process.version });
});

// ── GET /api/stats ────────────────────────────────────────────────────────────
let _cache = null, _cacheAt = 0;

app.get('/api/stats', async (_req, res) => {
  cors(res);
  console.log('[stats] request');
  try {
    const now = Date.now();
    if (!_cache || now - _cacheAt > 5 * 60 * 1000) {
      const [ur, mr] = await Promise.all([
        fetch(`${AT_API}?filterByFormula=${encodeURIComponent('{Status}="Active"')}&fields[]=Email&maxRecords=1000`, { headers: atH() }),
        fetch(`${AT_API}?filterByFormula=${encodeURIComponent('AND({Status}="Active",NOT({LastRun}=""))')}&fields[]=LastRun&fields[]=LastMatches&maxRecords=1000`, { headers: atH() }),
      ]);
      const [ud, md] = await Promise.all([ur.json(), mr.json()]);
      const today = new Date().toISOString().slice(0, 10);
      let matchesToday = 0;
      for (const r of md.records || []) {
        if (!(r.fields?.LastRun || '').startsWith(today)) continue;
        try { const a = JSON.parse(r.fields?.LastMatches || '[]'); if (Array.isArray(a)) matchesToday += a.length; } catch {}
      }
      _cache = { activeUsers: (ud.records || []).length, matchesToday, asOf: new Date().toISOString() };
      _cacheAt = now;
      console.log('[stats]', _cache.activeUsers, 'users,', _cache.matchesToday, 'matches today');
    }
    res.json({ ok: true, ..._cache });
  } catch (e) {
    console.error('[stats] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
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
    if (u) await patchUser(u.id, { LastRating: r, LastRatingDate: new Date().toISOString().slice(0,10) });
    const E = ['','😞','😐','🙂','😊','🤩'], L = ['','Poor','Okay','Good','Great','Excellent'];
    res.send(page('Thanks!', `<div class="big-emoji">${E[r]}</div><h2>Thanks!</h2><p>You rated today's matches <strong>${L[r]}</strong>.</p>`));
  } catch (e) { res.status(500).send(page('Error', '<p>Something went wrong.</p>')); }
});

// ── GET /unsubscribe ──────────────────────────────────────────────────────────
app.get('/unsubscribe', async (req, res) => {
  const { email, token } = req.query;
  if (!email || !validToken(email, token)) return res.status(400).send(page('Invalid', '<p>Invalid link.</p>'));
  try {
    const u = await findUser(email);
    if (u) await patchUser(u.id, { Status: 'Inactive', Notes: 'Unsubscribed ' + new Date().toISOString().slice(0,10) });
    if (BREVO_KEY) await fetch('https://api.brevo.com/v3/contacts', { method:'POST', headers:{'api-key':BREVO_KEY,'Content-Type':'application/json'}, body: JSON.stringify({ email, emailBlacklisted: true }) }).catch(()=>{});
    res.send(page('Unsubscribed', `<div class="big-emoji">👋</div><h2>Done.</h2><p>No more digests.<br><a href="/resubscribe?email=${encodeURIComponent(email)}&token=${token}" class="btn">Undo →</a></p>`));
  } catch (e) { res.status(500).send(page('Error', '<p>Something went wrong.</p>')); }
});

// ── GET /resubscribe ──────────────────────────────────────────────────────────
app.get('/resubscribe', async (req, res) => {
  const { email, token } = req.query;
  if (!email || !validToken(email, token)) return res.status(400).send(page('Invalid', '<p>Invalid link.</p>'));
  try {
    const u = await findUser(email);
    if (u) await patchUser(u.id, { Status: 'Active', Notes: 'Resubscribed ' + new Date().toISOString().slice(0,10) });
    if (BREVO_KEY) await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, { method:'PUT', headers:{'api-key':BREVO_KEY,'Content-Type':'application/json'}, body: JSON.stringify({ emailBlacklisted: false }) }).catch(()=>{});
    res.send(page('Welcome back!', '<div class="big-emoji">🎉</div><h2>You\'re back on.</h2><p>Matches resume tomorrow morning.</p>'));
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
    const sc = s => s>=85?'#059669':s>=70?'#4F46E5':'#888';
    const cards = jobs.length
      ? jobs.map(j=>`<div style="border:1px solid #E6E6E2;border-radius:12px;padding:16px;margin-bottom:10px;background:#fff">
          <div style="display:flex;justify-content:space-between;margin-bottom:8px">
            <div><strong style="color:#0C0C10">${j.t||'—'}</strong><br><span style="font-size:12px;color:#888">${[j.c,j.src].filter(Boolean).join(' · ')}</span></div>
            <strong style="font-size:24px;color:${sc(j.s)}">${j.s}%</strong>
          </div>
          ${j.v?`<p style="font-size:13px;color:#555;line-height:1.6;background:#f8f8f6;padding:10px;border-radius:8px;border-left:3px solid ${sc(j.s)}">${j.v}</p>`:''}
          ${j.u?`<a href="${j.u}" target="_blank" style="display:inline-block;margin-top:10px;padding:6px 16px;background:#0C0C10;color:#fff;border-radius:999px;font-size:12px;font-weight:700;text-decoration:none">Apply →</a>`:''}
        </div>`).join('')
      : '<p style="color:#888;padding:32px 0;text-align:center">No matches yet — check back after your next morning digest.</p>';
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your matches</title>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
      <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:#f8f8f6;padding:0 0 60px}
      .top{background:#fff;border-bottom:1px solid #E6E6E2;padding:0 20px;height:52px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0}
      .inner{max-width:600px;margin:0 auto;padding:28px 20px}h1{font-size:20px;font-weight:700;margin-bottom:4px}p.sub{font-size:13px;color:#888;margin-bottom:20px}</style></head>
      <body><div class="top"><strong>JobMatch AI</strong><span style="font-size:12px;color:#888">${email}</span></div>
      <div class="inner"><h1>Your matches</h1><p class="sub">${jobs.length} job${jobs.length!==1?'s':''} in this digest · <a href="/unsubscribe?email=${encodeURIComponent(email)}&token=${token}" style="color:#888">Unsubscribe</a></p>
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
      <body><div class="wrap"><h1>Update your profile</h1><p class="sub">Changes apply from your next morning digest.</p>
      <div id="ok">✓ Profile saved.</div>
      <form id="pf"><input type="hidden" name="email" value="${email}"><input type="hidden" name="token" value="${token}">
      <label>Target role</label><input name="targetRole" value="${f['Target role']||''}">
      <label>Current role</label><input name="currentRole" value="${f['Current role']||''}">
      <label>Domain / Industry</label><input name="domain" value="${f['Domain']||''}">
      <label>Location</label><input name="location" value="${f['Location']||''}">
      <label>Key skills</label><input name="skills" value="${f['Skills']||''}">
      <label>Cities to search</label><input name="cities" value="${f['Cities']||''}">
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

// ── POST /api/signup — create / update Airtable record ───────────────────────
app.options('/api/signup', (req, res) => {
  cors(res);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.post('/api/signup', async (req, res) => {
  cors(res);
  const { name, email, industry, location } = req.body || {};

  // Basic validation
  if (!name || !email) {
    return res.status(400).json({ ok: false, error: 'Name and email are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Invalid email address.' });
  }
  if (!AT_TOKEN || !AT_BASE) {
    console.error('[signup] Airtable not configured');
    return res.status(503).json({ ok: false, error: 'Service temporarily unavailable.' });
  }

  try {
    const existing = await findUser(email);

    const fields = {
      'Name':         name.trim(),
      'Email':        email.trim().toLowerCase(),
      'Domain':       (industry || '').trim(),
      'Location':     (location || 'Bengaluru').trim(),
      'Cities':       (location || 'Bengaluru').trim(),
      'Status':       'Active',
      'Signup Date':  new Date().toISOString().slice(0, 10),
    };

    if (existing) {
      // Update existing record — re-activate if they signed up again
      await patchUser(existing.id, { ...fields, 'Notes': 'Re-signup ' + fields['Signup Date'] });
      console.log('[signup] updated existing user:', email);
    } else {
      // Create new record
      const r = await fetch(AT_API, {
        method: 'POST',
        headers: atH(),
        body: JSON.stringify({ fields }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        console.error('[signup] Airtable create error:', JSON.stringify(err));
        return res.status(502).json({ ok: false, error: 'Could not save your profile. Try again.' });
      }
      console.log('[signup] created new user:', email);
    }

    // Welcome email via Brevo (fire-and-forget — don't block response)
    if (BREVO_KEY && !existing) {
      fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender:      { name: 'JobMatch AI', email: 'hello@jobmatchai.co.in' },
          to:          [{ email, name }],
          subject:     `Welcome to JobMatch AI — first digest tomorrow at 7AM`,
          htmlContent: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
            <div style="background:#F97316;border-radius:14px;padding:20px 24px;margin-bottom:24px">
              <div style="font-size:18px;font-weight:800;color:#fff;font-family:'Syne',sans-serif">JobMatch AI</div>
              <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:4px">You're in.</div>
            </div>
            <h2 style="font-size:20px;font-weight:700;color:#111827;margin-bottom:10px">Hi ${name}! 🎉</h2>
            <p style="font-size:14px;color:#6B7280;line-height:1.7;margin-bottom:14px">
              Your profile is live. Your first job digest will arrive <strong style="color:#111827">tomorrow morning at 7AM</strong>.
            </p>
            <p style="font-size:14px;color:#6B7280;line-height:1.7;margin-bottom:14px">
              Every morning we search LinkedIn, Naukri, Google Jobs, Adzuna and more — and send you only the roles that actually match your profile, with a score and a plain-English reason.
            </p>
            <div style="background:#FFF7ED;border:1px solid rgba(249,115,22,0.2);border-radius:10px;padding:14px 16px;margin-bottom:20px">
              <strong style="font-size:13px;color:#92400E">Your search profile</strong><br>
              <span style="font-size:13px;color:#6B7280">Domain: ${industry || 'not set'} · City: ${location || 'not set'}</span>
            </div>
            <p style="font-size:12px;color:#9CA3AF">
              JobMatch AI · <a href="mailto:hello@jobmatchai.co.in" style="color:#F97316">hello@jobmatchai.co.in</a>
            </p>
          </div>`,
        }),
      }).catch(e => console.error('[signup] welcome email error:', e.message));
    }

    // Invalidate stats cache so counter updates
    _cache = null;

    // Trigger actor immediately for new users → first digest in ~2 min
    // Existing users are already in the next scheduled run, so skip
    if (!existing && APIFY_TOKEN && ACTOR_ID) {
      fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(ACTOR_ID)}/runs?token=${APIFY_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filterEmail:   email,
          inlineProfile: { name, email, domain: industry, location, cities: [location] },
        }),
      })
      .then(() => console.log('[signup] actor triggered for:', email))
      .catch(e  => console.error('[signup] actor trigger failed:', e.message));
      // fire-and-forget — don't await, don't block the response
    }

    const msg = existing
      ? 'Profile updated! Changes apply from your next morning digest.'
      : 'You\'re all set! First digest on its way shortly.';
    res.json({ ok: true, message: msg });
  } catch (e) {
    console.error('[signup] error:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

// ── GET / — serve index.html from repo root ──────────────────────────────────
app.get('/', (_req, res) => {
  const p1 = path.join(__dirname,     'index.html');
  const p2 = path.join(process.cwd(), 'index.html');
  const p  = fs.existsSync(p1) ? p1 : fs.existsSync(p2) ? p2 : null;
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
  console.log('');
  console.log('  JobMatch AI server running on port', PORT);
  console.log('  ----------------------------------------');
  console.log('  GET  /              → index.html from repo root');
  console.log('  GET  /api/ping      → always 200 (deployment test)');
  console.log('  GET  /api/stats     → Airtable live counter');
  console.log('  POST /api/signup    → create / update user in Airtable + welcome email');
  console.log('  GET  /feedback      → email rating handler');
  console.log('  GET  /unsubscribe   → unsubscribe handler');
  console.log('  GET  /dashboard     → user match dashboard');
  console.log('  GET  /profile       → profile edit form');
  console.log('  ----------------------------------------');
  console.log('  Airtable base :', AT_BASE  || '✗ MISSING — set AIRTABLE_BASE_ID');
  console.log('  Airtable token:', AT_TOKEN ? AT_TOKEN.slice(0,12)+'...' : '✗ MISSING — set AIRTABLE_TOKEN');
  console.log('');
});
