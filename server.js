/**
 * server.js — JobMatch AI  (Render.com, Node.js 18+)
 *
 * Routes
 *   GET  /api/stats       — live activeUsers + matchesToday from Airtable
 *   GET  /feedback        — save emoji rating from daily digest email
 *   GET  /unsubscribe     — mark Inactive in Airtable + blacklist in Brevo
 *   GET  /resubscribe     — re-activate + remove from Brevo blacklist
 *   GET  /dashboard       — show last match batch for this user
 *   GET  /profile         — render profile-edit form
 *   POST /profile         — persist profile edits to Airtable
 *   GET  /health          — uptime probe for Render
 *
 * Environment variables (set in Render dashboard)
 *   AIRTABLE_TOKEN
 *   AIRTABLE_BASE_ID
 *   BREVO_API_KEY
 *   UNSUBSCRIBE_SECRET    (same value used in Apify actor)
 *   PORT                  (Render sets this automatically)
 */

import express from 'express';
import path    from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── ES-module __dirname (not available by default in ESM) ─────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Config ────────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT          || 3000;
const AT_TOKEN      = process.env.AIRTABLE_TOKEN      || '';
const AT_BASE       = process.env.AIRTABLE_BASE_ID    || '';
const BREVO_API_KEY = process.env.BREVO_API_KEY       || '';
const UNSUB_SECRET  = process.env.UNSUBSCRIBE_SECRET  || 'jobmatch-secret-2026';

const TABLE     = 'tblJtDvebLwnXvV9i';
const AT_API    = `https://api.airtable.com/v0/${AT_BASE}/${TABLE}`;

// ── Token helpers ─────────────────────────────────────────────────────────────
function makeToken(email) {
  let hash = 0;
  const str = email.toLowerCase() + UNSUB_SECRET;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0') + str.length.toString(16);
}
const validToken = (email, token) => !!token && token === makeToken(email);

// ── Airtable helpers ──────────────────────────────────────────────────────────
const atHeaders = () => ({
  'Authorization': `Bearer ${AT_TOKEN}`,
  'Content-Type':  'application/json',
});

async function findUser(email) {
  const qs = `filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}&maxRecords=1`;
  const r   = await fetch(`${AT_API}?${qs}`, { headers: atHeaders() });
  const d   = await r.json();
  return d.records?.[0] ?? null;
}

async function patchUser(id, fields) {
  // Remove undefined values before sending to Airtable
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined && v !== '')
  );
  const r = await fetch(`${AT_API}/${id}`, {
    method:  'PATCH',
    headers: atHeaders(),
    body:    JSON.stringify({ fields: clean }),
  });
  return r.json();
}

// ═════════════════════════════════════════════════════════════════════════════
// STATIC + ROOT — serve landing page from public/index.html
// THIS IS THE FIX for "Cannot GET /"
// ═════════════════════════════════════════════════════════════════════════════
// Use process.cwd() = repo root on Render, so path always resolves correctly
const publicDir = path.resolve(process.cwd(), 'public');
app.use(express.static(publicDir));

app.get('/', (_req, res) => {
  const indexPath = path.join(publicDir, 'index.html');
  console.log('[root] serving:', indexPath);
  res.sendFile(indexPath, err => {
    if (err) {
      console.error('[root] MISSING:', indexPath);
      res.status(500).send('<h2 style="font-family:sans-serif;padding:40px">'
        + 'Missing: <code>public/index.html</code><br>'
        + 'Commit it to your repo root and redeploy.</h2>');
    }
  });
});

// ── CORS (landing page fetches /api/stats from browser) ───────────────────────
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  next();
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/stats
// Returns real active-user count + total matches delivered today from Airtable.
// Cached 5 min to avoid hammering Airtable on every page load.
// ═════════════════════════════════════════════════════════════════════════════
let _cache   = null;
let _cacheAt = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchStats() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL) return _cache;

  const h = atHeaders();

  // 1. Count Status="Active" records (= real registered users)
  const ur = await fetch(
    `${AT_API}?filterByFormula={Status}%3D%22Active%22&fields%5B%5D=Email&maxRecords=1000`,
    { headers: h }
  );
  const ud = await ur.json();
  const activeUsers = (ud.records || []).length;

  // 2. Sum matches delivered today across all active users
  //    LastRun is an ISO timestamp; we compare the date portion.
  //    LastMatches is a JSON array of compact job objects.
  const todayISO = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const mr = await fetch(
    `${AT_API}?filterByFormula=AND({Status}%3D%22Active%22%2CNOT({LastRun}%3D%22%22))&fields%5B%5D=LastMatches&fields%5B%5D=LastRun&maxRecords=1000`,
    { headers: h }
  );
  const md = await mr.json();

  let matchesToday = 0;
  for (const rec of md.records || []) {
    const lastRun = rec.fields?.LastRun || '';
    if (!lastRun.startsWith(todayISO)) continue;
    try {
      const arr = JSON.parse(rec.fields?.LastMatches || '[]');
      if (Array.isArray(arr)) matchesToday += arr.length;
    } catch { /* malformed JSON — skip */ }
  }

  _cache   = { activeUsers, matchesToday, asOf: new Date().toISOString() };
  _cacheAt = now;
  return _cache;
}

app.get('/api/stats', async (req, res) => {
  // Public endpoint — allow CDN caching for 5 min too
  res.set('Cache-Control', 'public, max-age=300');
  try {
    const stats = await fetchStats();
    res.json({ ok: true, ...stats });
  } catch (err) {
    console.error('[stats]', err.message);
    // Return a safe fallback so the landing page degrades gracefully
    res.status(500).json({ ok: false, error: 'Stats temporarily unavailable' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /feedback?email=...&rating=1-5&token=...
// Called when user taps emoji in the daily digest.
// Writes LastRating + LastRatingDate to Airtable.
// ═════════════════════════════════════════════════════════════════════════════
app.get('/feedback', async (req, res) => {
  const { email, rating, token } = req.query;
  const r = parseInt(rating, 10);

  if (!email || !validToken(email, token)) {
    return res.status(400).send(shell('Invalid link',
      `<div class="card"><p>This link is invalid or has expired.</p></div>`));
  }
  if (!r || r < 1 || r > 5) {
    return res.status(400).send(shell('Bad rating',
      `<div class="card"><p>Rating must be 1–5.</p></div>`));
  }

  const EMOJIS  = ['', '😞', '😐', '🙂', '😊', '🤩'];
  const LABELS  = ['', 'Poor', 'Okay', 'Good', 'Great', 'Excellent'];

  try {
    const user = await findUser(email);
    if (user) {
      await patchUser(user.id, {
        'LastRating':      r,
        'LastRatingDate':  new Date().toISOString().slice(0, 10),
        'LastRatingLabel': `${EMOJIS[r]} ${LABELS[r]}`,
      });
    }

    res.send(shell('Thanks!', `
      <div class="card">
        <div class="big-emoji">${EMOJIS[r]}</div>
        <h2>Thanks${user?.fields?.Name ? ', ' + user.fields.Name : ''}!</h2>
        <p>You rated today's matches <strong>${LABELS[r]}</strong>.</p>
        <p class="muted">We use this to improve tomorrow's results.</p>
      </div>`));
  } catch (err) {
    console.error('[feedback]', err.message);
    res.status(500).send(shell('Error', `<div class="card"><p>Something went wrong. Please try again.</p></div>`));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /unsubscribe?email=...&token=...
// Sets Status=Inactive in Airtable and blacklists in Brevo.
// ═════════════════════════════════════════════════════════════════════════════
app.get('/unsubscribe', async (req, res) => {
  const { email, token } = req.query;

  if (!email || !validToken(email, token)) {
    return res.status(400).send(shell('Invalid link',
      `<div class="card"><p>This unsubscribe link is invalid.</p></div>`));
  }

  try {
    const user = await findUser(email);
    if (user) {
      await patchUser(user.id, {
        Status: 'Inactive',
        Notes:  'Unsubscribed via email link ' + new Date().toISOString().slice(0, 10),
      });
    }

    // Brevo — blacklist contact
    if (BREVO_API_KEY) {
      await fetch(`https://api.brevo.com/v3/contacts`, {
        method:  'POST',
        headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, emailBlacklisted: true }),
      }).catch(() => {});
    }

    const resubUrl = `/resubscribe?email=${encodeURIComponent(email)}&token=${token}`;
    res.send(shell('Unsubscribed', `
      <div class="card">
        <div class="big-emoji">👋</div>
        <h2>You've been unsubscribed</h2>
        <p>No more daily digests. We hope we helped.</p>
        <p class="muted" style="margin-top:16px">Changed your mind?</p>
        <a href="${resubUrl}" class="btn">Resume my matches →</a>
      </div>`));
  } catch (err) {
    console.error('[unsubscribe]', err.message);
    res.status(500).send(shell('Error', `<div class="card"><p>Something went wrong.</p></div>`));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /resubscribe?email=...&token=...
// Re-activates account and removes Brevo blacklist.
// ═════════════════════════════════════════════════════════════════════════════
app.get('/resubscribe', async (req, res) => {
  const { email, token } = req.query;

  if (!email || !validToken(email, token)) {
    return res.status(400).send(shell('Invalid link',
      `<div class="card"><p>This link is invalid.</p></div>`));
  }

  try {
    const user = await findUser(email);
    if (user) {
      await patchUser(user.id, {
        Status: 'Active',
        Notes:  'Resubscribed ' + new Date().toISOString().slice(0, 10),
      });
    }

    if (BREVO_API_KEY) {
      await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
        method:  'PUT',
        headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ emailBlacklisted: false }),
      }).catch(() => {});
    }

    res.send(shell('Welcome back!', `
      <div class="card">
        <div class="big-emoji">🎉</div>
        <h2>You're back on!</h2>
        <p>Daily matches resume from tomorrow morning at 7AM.</p>
      </div>`));
  } catch (err) {
    console.error('[resubscribe]', err.message);
    res.status(500).send(shell('Error', `<div class="card"><p>Something went wrong.</p></div>`));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /dashboard?email=...&token=...
// Renders last match batch from Airtable LastMatches field.
// ═════════════════════════════════════════════════════════════════════════════
app.get('/dashboard', async (req, res) => {
  const { email, token } = req.query;

  if (!email || !validToken(email, token)) {
    return res.status(400).send(shell('Invalid link',
      `<div class="card"><p>This dashboard link is invalid.</p></div>`));
  }

  try {
    const user = await findUser(email);
    if (!user) {
      return res.status(404).send(shell('Not found',
        `<div class="card"><p>No account found for this email.</p></div>`));
    }

    const f       = user.fields || {};
    const name    = f.Name || email.split('@')[0];
    const lastRun = f.LastRun
      ? new Date(f.LastRun).toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long' })
      : null;

    let jobs = [];
    try { jobs = JSON.parse(f.LastMatches || '[]'); } catch {}

    // Score colour helpers
    const sc = s => s >= 85 ? '#059669' : s >= 70 ? '#4F46E5' : '#8888A0';
    const sl = s => s >= 85 ? 'Strong Match' : s >= 70 ? 'Good Match' : 'Possible Match';

    const cards = jobs.length === 0
      ? `<div style="text-align:center;padding:48px 0;color:#8888A0">
           <div style="font-size:32px;margin-bottom:12px">📭</div>
           <p style="font-size:15px">No matches yet — check back after your next morning digest.</p>
         </div>`
      : jobs.map(j => `
          <div style="background:#fff;border:1px solid #E6E6E2;border-radius:14px;padding:18px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,0.05)">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px">
              <div style="flex:1;min-width:0">
                <div style="font-size:15px;font-weight:700;color:#0C0C10;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${j.t || '—'}</div>
                <div style="font-size:12px;color:#8888A0">${[j.c, j.src].filter(Boolean).join(' · ')}</div>
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-size:22px;font-weight:800;color:${sc(j.s)};line-height:1">${j.s}%</div>
                <div style="font-size:10px;color:#8888A0;margin-top:2px">${sl(j.s)}</div>
              </div>
            </div>
            ${j.v ? `<div style="font-size:13px;color:#3D3D47;line-height:1.6;background:#F8F8F6;padding:10px 12px;border-radius:8px;margin-bottom:10px;border-left:3px solid ${sc(j.s)}">${j.v}</div>` : ''}
            ${j.sal || j.exp ? `<div style="font-size:12px;color:#059669;font-weight:600;margin-bottom:10px">${[j.sal, j.exp].filter(Boolean).join(' · ')}</div>` : ''}
            ${j.ap ? `<div style="font-size:11px;color:#8888A0;margin-bottom:10px">${j.ap} applicants</div>` : ''}
            ${j.u  ? `<a href="${j.u}" target="_blank" rel="noopener" style="display:inline-block;padding:7px 18px;background:#0C0C10;color:#fff;border-radius:999px;font-size:12px;font-weight:700;text-decoration:none">Apply →</a>` : ''}
          </div>`).join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your matches — JobMatch AI</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'DM Sans',sans-serif;background:#F8F8F6;color:#0C0C10;-webkit-font-smoothing:antialiased}
  .topbar{background:#fff;border-bottom:1px solid #E6E6E2;padding:0 20px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
  .logo{font-size:16px;font-weight:700;color:#0C0C10}.logo span{color:#4F46E5}
  .em{font-size:12px;color:#8888A0}
  .inner{max-width:640px;margin:0 auto;padding:32px 20px 80px}
  .hdr{margin-bottom:24px}
  .hdr h1{font-size:22px;font-weight:700;letter-spacing:-0.5px;margin-bottom:5px}
  .hdr p{font-size:13px;color:#8888A0}
  .unsublink{display:inline-block;margin-top:32px;font-size:12px;color:#C4C4C4;text-decoration:none}
  .unsublink:hover{color:#8888A0}
</style>
</head>
<body>
  <div class="topbar">
    <div class="logo">Job<span>Match</span> AI</div>
    <div class="em">${email}</div>
  </div>
  <div class="inner">
    <div class="hdr">
      <h1>Your matches, ${name}</h1>
      <p>${lastRun ? `Last run: ${lastRun} · ` : ''}${jobs.length} job${jobs.length !== 1 ? 's' : ''} in this digest</p>
    </div>
    ${cards}
    <a href="/unsubscribe?email=${encodeURIComponent(email)}&token=${token}" class="unsublink">Unsubscribe from daily digests</a>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error('[dashboard]', err.message);
    res.status(500).send(shell('Error', `<div class="card"><p>Something went wrong loading your dashboard.</p></div>`));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET  /profile?email=...&token=...   — render editable profile form
// POST /profile                       — persist changes to Airtable
// ═════════════════════════════════════════════════════════════════════════════
app.get('/profile', async (req, res) => {
  const { email, token } = req.query;

  if (!email || !validToken(email, token)) {
    return res.status(400).send(shell('Invalid link',
      `<div class="card"><p>This profile link is invalid.</p></div>`));
  }

  try {
    const user = await findUser(email);
    if (!user) {
      return res.status(404).send(shell('Not found',
        `<div class="card"><p>No account found for this email.</p></div>`));
    }

    const f = user.fields || {};
    const seniorities = ['Fresher','Junior','Mid-level','Senior','Lead','Head','Director','VP','C-suite'];
    const opt = (val) => seniorities
      .map(s => `<option value="${s.toLowerCase()}"${(f.Seniority||'').toLowerCase()===s.toLowerCase()?' selected':''}>${s}</option>`)
      .join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Update profile — JobMatch AI</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'DM Sans',sans-serif;background:#F8F8F6;color:#0C0C10;-webkit-font-smoothing:antialiased}
  .topbar{background:#fff;border-bottom:1px solid #E6E6E2;padding:0 20px;height:56px;display:flex;align-items:center;position:sticky;top:0;z-index:10}
  .logo{font-size:16px;font-weight:700;color:#0C0C10}.logo span{color:#4F46E5}
  .inner{max-width:520px;margin:0 auto;padding:32px 20px 80px}
  h1{font-size:22px;font-weight:700;letter-spacing:-0.5px;margin-bottom:6px}
  .sub{font-size:14px;color:#8888A0;margin-bottom:28px}
  .field{margin-bottom:18px}
  label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#8888A0;margin-bottom:6px}
  input,select,textarea{width:100%;padding:10px 14px;background:#fff;border:1px solid #E6E6E2;border-radius:10px;font-family:'DM Sans',sans-serif;font-size:14px;color:#0C0C10;outline:none;transition:border-color 0.2s;-webkit-appearance:none}
  input:focus,select:focus,textarea:focus{border-color:#4F46E5;box-shadow:0 0 0 3px rgba(79,70,229,0.08)}
  textarea{resize:vertical;min-height:72px}
  .save-btn{width:100%;padding:13px;border-radius:999px;background:#4F46E5;color:#fff;font-family:'DM Sans',sans-serif;font-size:15px;font-weight:700;border:none;cursor:pointer;margin-top:8px;transition:background 0.2s;-webkit-appearance:none}
  .save-btn:hover{background:#3730A3}
  .save-btn:disabled{opacity:0.6;cursor:not-allowed}
  .success{display:none;background:#ECFDF5;border:1px solid rgba(5,150,105,0.25);border-radius:10px;padding:14px;text-align:center;font-size:14px;color:#059669;font-weight:600;margin-bottom:18px}
  .hint{font-size:11px;color:#B0B0BC;margin-top:5px}
</style>
</head>
<body>
  <div class="topbar">
    <div class="logo">Job<span>Match</span> AI</div>
  </div>
  <div class="inner">
    <h1>Update your profile</h1>
    <p class="sub">Changes apply from your next morning digest.</p>
    <div class="success" id="ok">✓ Profile saved — your next digest will use these settings.</div>
    <form id="pf">
      <input type="hidden" name="email" value="${email}">
      <input type="hidden" name="token" value="${token}">

      <div class="field">
        <label>Target role</label>
        <input name="targetRole" value="${f['Target role']||''}" placeholder="e.g. Head of Partnerships">
      </div>
      <div class="field">
        <label>Current role</label>
        <input name="currentRole" value="${f['Current role']||''}" placeholder="e.g. Senior Manager, Alliances">
      </div>
      <div class="field">
        <label>Seniority</label>
        <select name="seniority">${opt()}</select>
      </div>
      <div class="field">
        <label>Total experience</label>
        <input name="experience" value="${f['Experience']||''}" placeholder="e.g. 7 years">
      </div>
      <div class="field">
        <label>Domain / Industry</label>
        <input name="domain" value="${f['Domain']||''}" placeholder="e.g. Fintech / NBFC / Digital Lending">
      </div>
      <div class="field">
        <label>Key skills</label>
        <textarea name="skills">${f['Skills']||''}</textarea>
        <p class="hint">Comma-separated, up to 10 skills</p>
      </div>
      <div class="field">
        <label>Preferred location</label>
        <input name="location" value="${f['Location']||''}" placeholder="e.g. Bengaluru">
      </div>
      <div class="field">
        <label>Cities to search</label>
        <input name="cities" value="${f['Cities']||''}" placeholder="e.g. Bengaluru, Mumbai, Hyderabad">
        <p class="hint">Comma-separated</p>
      </div>
      <div class="field">
        <label>Company type preference</label>
        <input name="companyType" value="${f['Company type']||''}" placeholder="e.g. Startup, NBFC, MNC">
      </div>

      <button type="submit" class="save-btn" id="sb">Save changes</button>
    </form>
  </div>
  <script>
    document.getElementById('pf').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = document.getElementById('sb');
      btn.textContent = 'Saving…'; btn.disabled = true;
      try {
        const res = await fetch('/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(new FormData(e.target)).toString(),
        });
        if (res.ok) {
          document.getElementById('ok').style.display = 'block';
          btn.textContent = '✓ Saved';
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          throw new Error('Server error');
        }
      } catch {
        btn.textContent = 'Error — please try again';
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`);
  } catch (err) {
    console.error('[profile GET]', err.message);
    res.status(500).send(shell('Error', `<div class="card"><p>Could not load your profile.</p></div>`));
  }
});

app.post('/profile', async (req, res) => {
  const { email, token, targetRole, currentRole, experience, domain, skills, location, cities, seniority, companyType } = req.body;

  if (!email || !validToken(email, token)) {
    return res.status(403).json({ ok: false, error: 'Invalid token' });
  }

  try {
    const user = await findUser(email);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    await patchUser(user.id, {
      'Target role':   targetRole   || undefined,
      'Current role':  currentRole  || undefined,
      'Experience':    experience   || undefined,
      'Domain':        domain       || undefined,
      'Skills':        skills       || undefined,
      'Location':      location     || undefined,
      'Cities':        cities       || undefined,
      'Seniority':     seniority    || undefined,
      'Company type':  companyType  || undefined,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[profile POST]', err.message);
    res.status(500).json({ ok: false, error: 'Update failed' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /health  — Render uptime probe
// ═════════════════════════════════════════════════════════════════════════════
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), ts: new Date().toISOString() });
});

// ── Shared HTML shell for simple one-card pages ───────────────────────────────
function shell(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — JobMatch AI</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'DM Sans',sans-serif;background:#F8F8F6;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;-webkit-font-smoothing:antialiased}
  .card{background:#fff;border:1px solid #E6E6E2;border-radius:18px;padding:40px 36px;max-width:400px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.06)}
  .big-emoji{font-size:48px;margin-bottom:16px;line-height:1}
  h2{font-size:22px;font-weight:700;letter-spacing:-0.5px;color:#0C0C10;margin-bottom:10px}
  p{font-size:15px;color:#3D3D47;line-height:1.65;margin-bottom:6px}
  strong{color:#0C0C10}
  .muted{font-size:13px;color:#8888A0;margin-top:12px}
  .btn{display:inline-block;margin-top:20px;padding:11px 24px;background:#4F46E5;color:#fff;border-radius:999px;font-weight:700;font-size:14px;text-decoration:none;transition:background 0.2s}
  .btn:hover{background:#3730A3}
</style>
</head>
<body>${body}</body>
</html>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`JobMatch AI server on :${PORT}`);
  console.log(`  Airtable base : ${AT_BASE || '(missing)'}`);
  console.log(`  Brevo enabled : ${!!BREVO_API_KEY}`);
});
