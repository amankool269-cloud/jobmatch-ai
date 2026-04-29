// ═══════════════════════════════════════════════════════════════════
// JobMatch AI — Render Server
// Handles: apply tracking, open pixels, feedback, unsubscribe,
//          dashboard, profile, resume upload, actor triggers
// ═══════════════════════════════════════════════════════════════════
//
// Deploy: Render web service, Node 20+
// Required env vars:
//   AIRTABLE_TOKEN, AIRTABLE_BASE_ID
//   APIFY_TOKEN, APIFY_ACTOR_ID
//   ANTHROPIC_API_KEY
//   BREVO_API_KEY
//   UNSUBSCRIBE_SECRET (must match the actor)
//   PORT (Render sets this automatically)
// ═══════════════════════════════════════════════════════════════════

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';

// ─── Global error handlers — prevent server crash on unhandled errors ─────────
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason?.message || reason);
    // Don't crash — log and continue
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message, err.stack?.split('\n')[1] || '');
    // Don't crash — log and continue
});

const app = express();
app.use(cors());
// Capture raw body for Razorpay webhook signature verification
// Must be set on express.json() before any other middleware consumes the body
app.use(express.json({
    limit: '10mb',
    verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Config ───────────────────────────────────────────────────────
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const AT_BASE  = process.env.AIRTABLE_BASE_ID;
const USERS_TABLE  = 'tblJtDvebLwnXvV9i';
const CLICKS_TABLE = 'ApplyClicks';
const FEEDBACK_TABLE = 'Feedback';
const APIFY_TOKEN  = process.env.APIFY_TOKEN;
const APIFY_ACTOR  = process.env.APIFY_ACTOR_ID || 'YOUR_USERNAME~jobmatch-ai';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const BREVO_KEY        = process.env.BREVO_API_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL || 'hello@jobmatchai.co.in';
const BREVO_FROM_NAME  = process.env.BREVO_FROM_NAME  || 'JobMatch AI';
const UNSUB_SECRET = process.env.UNSUBSCRIBE_SECRET || 'jobmatch-secret-2026';
const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || 'https://jobmatchai.co.in';
const RAZORPAY_LINK_MONTHLY = process.env.RAZORPAY_LINK_MONTHLY || '';
const RAZORPAY_LINK_ANNUAL  = process.env.RAZORPAY_LINK_ANNUAL  || '';

// Shared brand CSS — injected into every public page
const BRAND_HEAD = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#09090B;--surface:#18181B;--card:#1C1E24;--gold:#F59E0B;--gold-dim:rgba(245,158,11,0.12);--gold-border:rgba(245,158,11,0.25);--text:#FAFAF9;--muted:#71717A;--subtle:#3F3F46;--border:rgba(255,255,255,0.07);--border-hover:rgba(255,255,255,0.14);--green:#22C55E;--blue:#3B82F6;--radius:12px;--radius-lg:18px}
*{box-sizing:border-box;margin:0;padding:0}html{scroll-behavior:smooth}
body{font-family:'Manrope',sans-serif;background:var(--bg);color:var(--text);line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}input,select,textarea,button{font-family:'Manrope',sans-serif}
::selection{background:var(--gold-dim);color:var(--gold)}
</style>`;

const claude = new Anthropic({ apiKey: ANTHROPIC_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ─── Helpers ──────────────────────────────────────────────────────
function signPayload(payload) {
    return crypto.createHmac('sha256', UNSUB_SECRET)
        .update(payload).digest('hex').slice(0, 12);
}

function verifyPayload(payload, sig) {
    if (!sig) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(signPayload(payload)), Buffer.from(sig));
    } catch { return false; }
}

function makeUnsubToken(email) {
    let hash = 0;
    const str = email.toLowerCase() + UNSUB_SECRET;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8,'0') + str.length.toString(16);
}

function verifyUnsubToken(email, token) {
    return makeUnsubToken(email) === token;
}

async function findUserRecord(email) {
    const r = await fetch(
        `https://api.airtable.com/v0/${AT_BASE}/${USERS_TABLE}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}&maxRecords=1`,
        { headers: { Authorization: `Bearer ${AT_TOKEN}` } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    return data.records?.[0] || null;
}

async function patchUserField(email, fields) {
    try {
        const rec = await findUserRecord(email);
        if (!rec) return false;
        const r = await fetch(`https://api.airtable.com/v0/${AT_BASE}/${USERS_TABLE}/${rec.id}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields })
        });
        return r.ok;
    } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════
// /apply — Signed redirect with click logging (the cost-saving lever)
// ═══════════════════════════════════════════════════════════════════
app.get('/apply', async (req, res) => {
    const { e: email, t: title, c: company, s: source, sc: score, u: jobUrl, sig } = req.query;

    if (!jobUrl) return res.status(400).send('Missing job URL');

    const cleanUrl = decodeURIComponent(jobUrl);

    // Sign on email + jobUrl only (must match buildApplyUrl in actor)
    // Title/company/etc are not signed because they get truncated for URL length
    const payload = `${email}|${jobUrl}`;
    const sigValid = verifyPayload(payload, sig);

    // 302 redirect first — zero perceived delay
    res.redirect(302, cleanUrl);

    if (!sigValid) {
        console.warn(`Invalid signature for ${email} → ${title}`);
        return;
    }

    // Async logging — fire and forget
    logApplyClick({ email, title, company, source, score, jobUrl: cleanUrl })
        .catch(err => console.error('Apply log error:', err.message));
});

async function logApplyClick({ email, title, company, source, score, jobUrl }) {
    const headers = { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' };

    // 1. Append to ApplyClicks table
    await fetch(`https://api.airtable.com/v0/${AT_BASE}/${CLICKS_TABLE}`, {
        method: 'POST', headers,
        body: JSON.stringify({
            fields: {
                Email: email || '',
                JobTitle: (title || '').slice(0, 100),
                Company: (company || '').slice(0, 60),
                JobUrl: jobUrl || '',
                Source: source || '',
                MatchScore: parseInt(score) || 0,
                ClickedAt: new Date().toISOString()
            }
        })
    }).catch(() => {});

    // 2. Bump engagement on user record
    if (!email) return;
    const rec = await findUserRecord(email);
    if (!rec) return;
    const prevCount = rec.fields?.['TotalApplyClicks'] || 0;
    await fetch(`https://api.airtable.com/v0/${AT_BASE}/${USERS_TABLE}/${rec.id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({
            fields: {
                LastApplyClick: new Date().toISOString(),
                TotalApplyClicks: prevCount + 1,
                LastEngagement: new Date().toISOString()
            }
        })
    });
    console.log(`Apply: ${email} → ${title} @ ${company} (${source})`);
}

// ═══════════════════════════════════════════════════════════════════
// /open — 1x1 GIF email open tracker
// ═══════════════════════════════════════════════════════════════════
const TRANSPARENT_PIXEL = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'
);

app.get('/open', async (req, res) => {
    const { e: email } = req.query;

    res.set({
        'Content-Type': 'image/gif',
        'Content-Length': TRANSPARENT_PIXEL.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    res.send(TRANSPARENT_PIXEL);

    if (!email) return;
    try {
        const rec = await findUserRecord(email);
        if (!rec) return;
        const prevOpens = rec.fields?.['TotalEmailOpens'] || 0;
        await fetch(`https://api.airtable.com/v0/${AT_BASE}/${USERS_TABLE}/${rec.id}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields: {
                    LastEmailOpen: new Date().toISOString(),
                    TotalEmailOpens: prevOpens + 1,
                    LastEngagement: new Date().toISOString()
                }
            })
        });
    } catch (e) { /* silent — pixel must always succeed */ }
});

// ═══════════════════════════════════════════════════════════════════
// /feedback — Rating handler with engagement tracking
// ═══════════════════════════════════════════════════════════════════
app.get('/feedback', async (req, res) => {
    const { email, rating, token } = req.query;

    if (!email || !rating) return res.status(400).send('Missing parameters');
    if (!verifyUnsubToken(email, token)) return res.status(403).send('Invalid token');

    const r = parseInt(rating);
    if (isNaN(r) || r < 1 || r > 5) return res.status(400).send('Invalid rating');

    // 1. Update user record
    await patchUserField(email, {
        LastFeedbackRating: r,
        LastFeedbackAt: new Date().toISOString(),
        LastEngagement: new Date().toISOString()
    });

    // 2. Append to feedback log
    try {
        await fetch(`https://api.airtable.com/v0/${AT_BASE}/${FEEDBACK_TABLE}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields: {
                    Email: email,
                    Rating: r,
                    SubmittedAt: new Date().toISOString()
                }
            })
        });
    } catch (e) { /* silent */ }

    const emojis = ['', '😞', '😐', '🙂', '😊', '🤩'];
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thanks!</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:60px 20px;background:#f8fafc;margin:0">
<div style="max-width:420px;margin:0 auto;background:#fff;padding:40px 28px;border-radius:14px;border:1px solid #e5e7eb">
<div style="font-size:64px;margin-bottom:16px">${emojis[r]}</div>
<h2 style="font-size:22px;color:#111;margin:0 0 12px">Thanks for the feedback!</h2>
<p style="font-size:14px;color:#6b7280;margin:0 0 28px;line-height:1.6">We use your rating to improve tomorrow's matches. The more you rate, the smarter we get.</p>
<a href="${SERVER_URL}/dashboard?email=${encodeURIComponent(email)}&token=${makeUnsubToken(email)}" style="display:inline-block;background:#0055FF;color:#fff;padding:12px 24px;border-radius:9px;text-decoration:none;font-size:14px;font-weight:600">View your dashboard →</a>
</div></body></html>`);
});

// ═══════════════════════════════════════════════════════════════════
// /unsubscribe + /resubscribe
// ═══════════════════════════════════════════════════════════════════
app.get('/unsubscribe', async (req, res) => {
    const { email, token } = req.query;
    if (!email || !verifyUnsubToken(email, token)) return res.status(403).send('Invalid link');

    await patchUserField(email, { Status: 'Inactive', Notes: `Unsubscribed via email on ${new Date().toISOString().split('T')[0]}` });

    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui;text-align:center;padding:60px 20px;background:#f8fafc">
<div style="max-width:420px;margin:0 auto;background:#fff;padding:40px 28px;border-radius:14px;border:1px solid #e5e7eb">
<h2 style="font-size:22px;color:#111;margin:0 0 12px">You're unsubscribed</h2>
<p style="font-size:14px;color:#6b7280;margin:0 0 22px;line-height:1.6">No more daily emails. Sorry to see you go!</p>
<a href="${SERVER_URL}/resubscribe?email=${encodeURIComponent(email)}&token=${token}" style="font-size:13px;color:#0055FF">Changed your mind? Resubscribe</a>
</div></body></html>`);
});

app.get('/resubscribe', async (req, res) => {
    const { email, token } = req.query;
    if (!email || !verifyUnsubToken(email, token)) return res.status(403).send('Invalid link');

    await patchUserField(email, {
        Status: 'Active',
        LastEngagement: new Date().toISOString(),
        ConsecutiveSkips: 0
    });

    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui;text-align:center;padding:60px 20px;background:#f8fafc">
<div style="max-width:420px;margin:0 auto;background:#fff;padding:40px 28px;border-radius:14px;border:1px solid #e5e7eb">
<h2 style="font-size:22px;color:#111;margin:0 0 12px">Welcome back! 🎉</h2>
<p style="font-size:14px;color:#6b7280;margin:0;line-height:1.6">You'll receive your next daily digest tomorrow morning.</p>
</div></body></html>`);
});

// ═══════════════════════════════════════════════════════════════════
// /dashboard — Show user's last matches + apply history + stats
// ═══════════════════════════════════════════════════════════════════
app.get('/dashboard', async (req, res) => {
    const { email, token } = req.query;
    if (!email || !verifyUnsubToken(email, token)) return res.status(403).send(`
        <html><body style="font-family:system-ui;text-align:center;padding:80px 20px;background:#f8fafc">
        <h2 style="color:#dc2626">Invalid or expired link</h2>
        <p style="color:#6b7280;margin-top:12px">Please use the dashboard link from your latest JobMatch email.</p>
        </body></html>`);

    const rec = await findUserRecord(email);
    if (!rec) return res.status(404).send('Profile not found');

    const f = rec.fields;
    let matches = [];
    try { matches = JSON.parse(f.LastMatches || '[]'); } catch {}

    let applies = [];
    try {
        const r = await fetch(
            `https://api.airtable.com/v0/${AT_BASE}/${CLICKS_TABLE}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}&sort[0][field]=ClickedAt&sort[0][direction]=desc&maxRecords=50`,
            { headers: { Authorization: `Bearer ${AT_TOKEN}` } }
        );
        const data = await r.json();
        applies = data.records || [];
    } catch {}

    const isPro = f.PaidStatus === 'pro';
    const totalApplies = f.TotalApplyClicks || 0;
    const totalOpens = f.TotalEmailOpens || 0;
    const avgScore = matches.length ? Math.round(matches.reduce((a,m) => a + (m.s||0), 0) / matches.length) : 0;
    const paidUntil = f.PaidUntil ? new Date(f.PaidUntil).toLocaleDateString('en-IN', {day:'numeric',month:'long',year:'numeric'}) : null;
    const daysLeft = f.PaidUntil ? Math.ceil((new Date(f.PaidUntil) - new Date()) / 86400000) : null;
    const unsubUrl = `${SERVER_URL}/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;

    const scoreColor = s => s >= 85 ? '#059669' : s >= 70 ? '#0055FF' : '#d97706';
    const scoreBg    = s => s >= 85 ? '#ecfdf5' : s >= 70 ? '#eff6ff' : '#fffbeb';
    const scoreBorder= s => s >= 85 ? '#6ee7b7' : s >= 70 ? '#bfdbfe' : '#fde68a';
    const scoreLabel = s => s >= 85 ? 'Strong fit' : s >= 70 ? 'Good fit' : 'Possible fit';

    const matchCards = matches.map((m,i) => `
<div class="card match-card" style="border-left:4px solid ${scoreColor(m.s)};animation-delay:${i*0.05}s" data-score="${m.s}" data-city="${(m.c||'').toLowerCase()}" data-src="${(m.src||'').toLowerCase()}" data-industry="${(m.v||'').toLowerCase()}">
  <div style="display:flex;gap:14px;align-items:flex-start">
    <div style="flex:1;min-width:0">
      <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px;line-height:1.3">${m.t}</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span>${m.c}</span>
        ${m.src ? `<span style="width:3px;height:3px;background:#cbd5e1;border-radius:50%;display:inline-block"></span><span>${m.src}</span>` : ''}
        ${m.sal ? `<span style="width:3px;height:3px;background:#cbd5e1;border-radius:50%;display:inline-block"></span><span style="color:#059669;font-weight:600">${m.sal}</span>` : ''}
      </div>
      ${m.v ? `<div style="font-size:13px;color:var(--muted);line-height:1.6;background:rgba(255,255,255,0.03);padding:10px 12px;border-radius:8px;margin-bottom:8px">${m.v}</div>` : ''}
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-size:11px;font-weight:700;padding:4px 10px;border-radius:20px;background:${scoreBg(m.s)};color:${scoreColor(m.s)};border:1px solid ${scoreBorder(m.s)}">${scoreLabel(m.s)}</span>
        ${m.ap ? `<span style="font-size:11px;color:#94a3b8">${m.ap} applicants</span>` : ''}
      </div>
    </div>
    <div style="flex-shrink:0;text-align:center;min-width:64px">
      <div style="font-size:26px;font-weight:900;color:${scoreColor(m.s)};line-height:1;margin-bottom:2px">${m.s}%</div>
      <div style="font-size:10px;color:#94a3b8;margin-bottom:10px">match</div>
      ${m.u ? `<a href="${SERVER_URL}/apply?e=${encodeURIComponent(email)}&u=${encodeURIComponent(m.u)}&t=${encodeURIComponent(m.t)}&c=${encodeURIComponent(m.c)}&s=${encodeURIComponent(m.src||'')}&sc=${m.s}&sig=${signPayload(`${email}|${m.u}`)}" class="apply-btn">Apply →</a>` : ''}
    </div>
  </div>
</div>`).join('');

    const STATUS_CONFIG = {
        'Applied':      { bg: '#eff6ff', color: '#1d4ed8', next: 'Heard back' },
        'Heard back':   { bg: '#f0fdf4', color: '#15803d', next: 'Interviewing' },
        'Interviewing': { bg: '#faf5ff', color: '#7c3aed', next: 'Offered' },
        'Offered':      { bg: '#fefce8', color: '#a16207', next: 'Applied' },
        'Rejected':     { bg: '#fef2f2', color: '#b91c1c', next: 'Applied' },
    };

    const applyRows = applies.slice(0, 30).map(a => {
        const af = a.fields;
        const date = af.ClickedAt ? new Date(af.ClickedAt).toLocaleDateString('en-IN', {day:'numeric',month:'short'}) : '';
        const srcColors = {LinkedIn:'#0077b5',Naukri:'#ff6b35',JSearch:'#4285f4',Adzuna:'#e63946',iimjobs:'#6d28d9'};
        const srcColor = srcColors[af.Source] || '#64748b';
        const status = af.ApplyStatus || 'Applied';
        const sc = STATUS_CONFIG[status] || STATUS_CONFIG['Applied'];
        return `<div class="apply-row" id="row-${a.id}">
  <div style="flex:1;min-width:0">
    <div style="font-size:13px;font-weight:500;color:var(--color-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${af.JobTitle||'Untitled role'}</div>
    <div style="font-size:11px;color:var(--color-text-secondary);margin-top:3px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      <span>${af.Company||''}</span>
      ${af.Source ? `<span style="background:${srcColor}18;color:${srcColor};padding:1px 7px;border-radius:10px;font-weight:500;font-size:10px">${af.Source}</span>` : ''}
      <span style="color:var(--color-text-secondary)">${date}</span>
    </div>
  </div>
  <div style="flex-shrink:0;display:flex;align-items:center;gap:10px">
    ${af.MatchScore ? `<span style="font-size:12px;font-weight:500;color:${scoreColor(af.MatchScore)}">${af.MatchScore}%</span>` : ''}
    <button onclick="cycleStatus('${a.id}','${af.ApplyStatus||'Applied'}','${encodeURIComponent(email)}')"
      id="status-${a.id}"
      style="font-size:11px;font-weight:500;padding:4px 10px;border-radius:20px;border:0.5px solid ${sc.color}40;background:${sc.bg};color:${sc.color};cursor:pointer;transition:opacity .15s;white-space:nowrap">
      ${status}
    </button>
  </div>
</div>`;
    }).join('');

    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard · JobMatch AI</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{--bg:#09090B;--surface:#18181B;--card:#1C1E24;--gold:#F59E0B;--gold-dim:rgba(245,158,11,0.1);--gold-border:rgba(245,158,11,0.2);--text:#FAFAF9;--muted:#71717A;--subtle:#3F3F46;--border:rgba(255,255,255,0.07);--green:#22C55E;--blue:#3B82F6}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Manrope',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;-webkit-font-smoothing:antialiased}
  /* NAV */
  .nav{background:#09090B;padding:0 20px;position:sticky;top:0;z-index:50;border-bottom:1px solid var(--border)}
  .nav-inner{max-width:940px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;height:56px}
  .logo{font-family:'Instrument Serif',serif;font-size:18px;color:var(--text)}
  .logo i{font-style:italic;color:var(--gold)}
  .nav-right{display:flex;align-items:center;gap:14px}
  .plan-badge{font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;${isPro ? 'background:var(--gold);color:#000' : 'background:var(--surface);color:var(--muted);border:1px solid var(--border)'}}
  .nav-email{font-size:12px;color:var(--muted);display:none}
  @media(min-width:640px){.nav-email{display:block}}
  /* TABS */
  .tabs{background:var(--surface);border-bottom:1px solid var(--border);padding:0 20px;position:sticky;top:56px;z-index:40}
  .tabs-inner{max-width:940px;margin:0 auto;display:flex}
  .tab{padding:14px 18px;font-size:13px;font-weight:600;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap}
  .tab:hover{color:var(--text)}
  .tab.active{color:var(--gold);border-bottom-color:var(--gold)}
  /* CONTENT */
  .wrap{max-width:940px;margin:0 auto;padding:24px 16px}
  /* STATS */
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}
  .stat{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center}
  .stat-num{font-family:'Instrument Serif',serif;font-size:28px;line-height:1;margin-bottom:4px}
  .stat-lbl{font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
  @media(max-width:600px){.stats{grid-template-columns:repeat(2,1fr)}}
  /* CARDS */
  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:10px;animation:fu .3s ease both}
  @keyframes fu{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
  .match-card{border-left-width:3px}
  .apply-btn{display:block;background:var(--gold);color:#000;padding:7px 12px;border-radius:8px;text-decoration:none;font-size:12px;font-weight:700;text-align:center}
  /* APPLY ROWS */
  .apply-row{display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--border)}
  .apply-row:last-child{border-bottom:none}
  /* PRO CARD */
  .pro-card{background:linear-gradient(135deg,#111112 0%,#1C1810 100%);border:1px solid var(--gold-border);border-radius:14px;padding:22px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
  /* FREE UPSELL */
  .upsell{background:linear-gradient(135deg,rgba(245,158,11,0.15) 0%,rgba(245,158,11,0.05) 100%);border:1px solid var(--gold-border);border-radius:14px;padding:22px;margin-bottom:20px}
  /* SECTION HEADER */
  .section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
  .section-title{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em}
  .section-count{font-size:12px;color:var(--subtle);font-weight:600}
  /* EMPTY STATE */
  .empty{text-align:center;padding:48px 20px;color:var(--muted)}
  .empty-icon{font-size:36px;margin-bottom:12px}
  .empty-title{font-size:15px;font-weight:600;color:var(--muted);margin-bottom:6px}
  .empty-sub{font-size:13px;line-height:1.6;color:var(--subtle)}
  /* TAB PANELS */
  .panel{display:none}.panel.active{display:block}
  /* PROFILE FORM */
  .form-group{margin-bottom:16px}
  .form-label{font-size:11px;font-weight:700;color:var(--muted);display:block;margin-bottom:7px;text-transform:uppercase;letter-spacing:.07em}
  .form-input{width:100%;padding:11px 14px;border:1px solid var(--border);border-radius:9px;font-size:14px;font-family:inherit;transition:border-color .15s;background:var(--bg);color:var(--text);outline:none}
  .form-input:focus{border-color:var(--gold)}
  .save-btn{background:var(--gold);color:#000;padding:12px 24px;border:0;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;width:100%}
</style></head>
<body>

<!-- NAV -->
<nav class="nav"><div class="nav-inner">
  <div class="logo">Job<i>Match</i> AI</div>
  <div class="nav-right">
    <span class="nav-email">${f.Name || email.split('@')[0]}</span>
    <span class="plan-badge">${isPro ? '★ PRO' : 'FREE'}</span>
  </div>
</div></nav>

<!-- TABS -->
<div class="tabs"><div class="tabs-inner">
  <a class="tab active" onclick="switchTab('matches',this)">Today's Matches <span style="background:#f1f5f9;color:#64748b;padding:1px 7px;border-radius:10px;font-size:11px;margin-left:4px">${matches.length}</span></a>
  <a class="tab" onclick="switchTab('applied',this)">Applied <span style="background:#f1f5f9;color:#64748b;padding:1px 7px;border-radius:10px;font-size:11px;margin-left:4px">${totalApplies}</span></a>
  <a class="tab" onclick="switchTab('profile',this)">Profile</a>
</div></div>

<div class="wrap">

  <!-- STATS BAR -->
  <div class="stats">
    <div class="stat">
      <div class="stat-num" style="color:#0055FF">${matches.length}</div>
      <div class="stat-lbl">New matches</div>
    </div>
    <div class="stat">
      <div class="stat-num" style="color:#059669">${totalApplies}</div>
      <div class="stat-lbl">Total applied</div>
    </div>
    <div class="stat">
      <div class="stat-num" style="color:#7c3aed">${totalOpens}</div>
      <div class="stat-lbl">Emails opened</div>
    </div>
    <div class="stat">
      <div class="stat-num" style="color:#d97706">${avgScore || '—'}</div>
      <div class="stat-lbl">Avg match %</div>
    </div>
  </div>

  <!-- PLAN CARD -->
  ${isPro ? `
  <div class="pro-card">
    <div>
      <div style="font-size:11px;font-weight:700;color:var(--gold);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">★ Pro Member</div>
      <div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:4px">${f.Name || 'Welcome back'}</div>
      <div style="font-size:13px;color:var(--muted)">${paidUntil ? `Active until ${paidUntil}${daysLeft !== null && daysLeft <= 7 ? ` <span style="color:#fbbf24;font-weight:600">(${daysLeft}d left)</span>` : ''}` : 'Active'}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:11px;color:var(--subtle);margin-bottom:8px">Daily search · all 5 platforms</div>
      <a href="mailto:hello@jobmatchai.co.in" style="font-size:12px;color:var(--gold);text-decoration:none;font-weight:600">Support →</a>
    </div>
  </div>` : `
  <div class="upsell">
    <div style="font-size:15px;font-weight:700;color:var(--gold);margin-bottom:6px">Upgrade to Pro · ₹49/month</div>
    <div style="font-size:13px;color:var(--muted);margin-bottom:14px;line-height:1.6">Daily emails · Full source coverage · Dashboard · Priority support</div>
    <a href="${SERVER_URL}/pricing?email=${encodeURIComponent(email)}&token=${token}" style="display:inline-block;background:var(--gold);color:#000;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700">Become a founding member →</a>
  </div>`}

  <!-- MATCHES TAB -->
  <div id="tab-matches" class="panel active">
    <div class="section-head">
      <div class="section-title">Today's matches</div>
      <div class="section-count">${matches.length} jobs</div>
    </div>

    <!-- FILTER BAR -->
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:12px;align-items:center">
      <select id="f-industry" onchange="applyFilters()" style="flex:1;min-width:130px;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--text);font-family:inherit;cursor:pointer;outline:none">
        <option value="">All industries</option>
        <option value="fintech">Fintech / NBFC</option>
        <option value="saas">SaaS / Tech</option>
        <option value="ecommerce">E-commerce / D2C</option>
        <option value="fmcg">FMCG / Consumer</option>
        <option value="banking">Banking / BFSI</option>
        <option value="edtech">EdTech</option>
        <option value="healthtech">HealthTech</option>
        <option value="startup">Startup</option>
        <option value="mnc">MNC</option>
      </select>
      <select id="f-city" onchange="applyFilters()" style="flex:1;min-width:130px;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--text);font-family:inherit;cursor:pointer;outline:none">
        <option value="">All cities</option>
        ${[...new Set(matches.map(m=>m.c?.split('·')[1]?.trim()).filter(Boolean))].map(c=>`<option value="${c}">${c}</option>`).join('')}
        <option value="Bengaluru">Bengaluru</option>
        <option value="Mumbai">Mumbai</option>
        <option value="Delhi">Delhi NCR</option>
        <option value="Hyderabad">Hyderabad</option>
        <option value="Pune">Pune</option>
        <option value="Remote">Remote</option>
      </select>
      <select id="f-score" onchange="applyFilters()" style="flex:1;min-width:130px;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--text);font-family:inherit;cursor:pointer;outline:none">
        <option value="0">All scores</option>
        <option value="85">Strong fit only (85%+)</option>
        <option value="70">Good fit+ (70%+)</option>
        <option value="55">All relevant (55%+)</option>
      </select>
      <select id="f-src" onchange="applyFilters()" style="flex:1;min-width:130px;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--text);font-family:inherit;cursor:pointer;outline:none">
        <option value="">All sources</option>
        <option value="LinkedIn">LinkedIn</option>
        <option value="Naukri">Naukri</option>
        <option value="JSearch">JSearch</option>
        <option value="Adzuna">Adzuna</option>
        <option value="iimjobs">iimjobs</option>
      </select>
      <button onclick="clearFilters()" style="padding:8px 14px;background:transparent;border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--muted);cursor:pointer;font-family:inherit;white-space:nowrap;transition:border-color .15s" onmouseover="this.style.borderColor='rgba(255,255,255,0.2)'" onmouseout="this.style.borderColor='var(--border)'">Clear filters</button>
      <span id="filter-count" style="font-size:12px;color:var(--muted);white-space:nowrap"></span>
    </div>
    ${matches.length ? matchCards : `<div class="empty">
      <div class="empty-icon">🔍</div>
      <div class="empty-title">No matches yet today</div>
      <div class="empty-sub">Fresh matches arrive every morning at 9am IST.<br>Check back tomorrow.</div>
    </div>`}
  </div>

  <!-- APPLIED TAB -->
  <div id="tab-applied" class="panel">
    <div class="section-head">
      <div class="section-title">Apply history</div>
      <div class="section-count">${applies.length} jobs</div>
    </div>
    ${applies.length ? `<div class="card" style="padding:0 18px">${applyRows}</div>` : `<div class="empty">
      <div class="empty-icon">📋</div>
      <div class="empty-title">No applies tracked yet</div>
      <div class="empty-sub">When you click "Apply" in your daily emails,<br>we track them here automatically.</div>
    </div>`}
  </div>

  <!-- PROFILE TAB -->
  <div id="tab-profile" class="panel">
    <div class="card">
      <div class="section-title" style="margin-bottom:20px">Your profile</div>
      <form method="POST" action="${SERVER_URL}/profile/save?email=${encodeURIComponent(email)}&token=${token}">
        ${[
            ['Name', 'Name', 'text', f.Name||''],
            ['Target role', 'TargetRole', 'text', f['Target role']||''],
            ['Current role', 'CurrentRole', 'text', f['Current role']||''],
            ['Current company', 'CurrentCompany', 'text', f['Current company']||''],
            ['Experience (e.g. 5 years)', 'Experience', 'text', f.Experience||''],
            ['Domain / Industry', 'Domain', 'text', f.Domain||''],
            ['Skills (comma-separated)', 'Skills', 'text', f.Skills||''],
            ['Cities (comma-separated)', 'Cities', 'text', f.Cities||''],
            ['WhatsApp number', 'Phone', 'tel', f.Phone||''],
        ].map(([label, name, type, val]) => `
        <div class="form-group">
          <label class="form-label">${label}</label>
          <input class="form-input" name="${name}" type="${type}" value="${(val||'').toString().replace(/"/g,'&quot;')}">
        </div>`).join('')}
        <button type="submit" class="save-btn">Save changes</button>
      </form>
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid #f1f5f9;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:12px;color:#94a3b8">Joined with ${email}</span>
        <a href="${unsubUrl}" style="font-size:12px;color:#dc2626;text-decoration:none">Unsubscribe</a>
      </div>
    </div>
  </div>

</div>

<script>
function switchTab(name, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

// Filter logic for match cards
function applyFilters() {
  const city = document.getElementById('f-city')?.value.toLowerCase() || '';
  const industry = document.getElementById('f-industry')?.value.toLowerCase() || '';
  const minScore = parseInt(document.getElementById('f-score')?.value || '0');
  const src = document.getElementById('f-src')?.value.toLowerCase() || '';
  const cards = document.querySelectorAll('.match-card');
  let visible = 0;
  cards.forEach(card => {
    const cardCity = (card.dataset.city || '').toLowerCase();
    const cardScore = parseInt(card.dataset.score || '0');
    const cardSrc = (card.dataset.src || '').toLowerCase();
    const cardIndustry = (card.dataset.industry || '').toLowerCase();
    const cityOk = !city || cardCity.includes(city) || city.includes(cardCity.split(',')[0].trim());
    const industryOk = !industry || cardIndustry.includes(industry);
    const scoreOk = cardScore >= minScore;
    const srcOk = !src || cardSrc.includes(src);
    const show = cityOk && industryOk && scoreOk && srcOk;
    card.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  const fc = document.getElementById('filter-count');
  if (fc) fc.textContent = visible < cards.length ? (visible + ' of ' + cards.length + ' shown') : '';
}

function clearFilters() {
  ['f-city','f-industry','f-score','f-src'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = el.tagName === 'SELECT' ? el.options[0].value : '';
  });
  applyFilters();
}

const STATUS_CYCLE = {
  'Applied':      { next:'Heard back',   bg:'#eff6ff', color:'#1d4ed8' },
  'Heard back':   { next:'Interviewing', bg:'#f0fdf4', color:'#15803d' },
  'Interviewing': { next:'Offered',      bg:'#faf5ff', color:'#7c3aed' },
  'Offered':      { next:'Applied',      bg:'#fefce8', color:'#a16207' },
  'Rejected':     { next:'Applied',      bg:'#fef2f2', color:'#b91c1c' },
};

async function cycleStatus(recordId, currentStatus, encodedEmail) {
  const cfg = STATUS_CYCLE[currentStatus] || STATUS_CYCLE['Applied'];
  const newStatus = cfg.next;
  const btn = document.getElementById('status-' + recordId);
  if (!btn) return;
  btn.style.opacity = '0.5';
  btn.textContent = '...';
  try {
    const resp = await fetch('/apply-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordId, status: newStatus, email: decodeURIComponent(encodedEmail) })
    });
    if (!resp.ok) throw new Error('Failed');
    const newCfg = STATUS_CYCLE[newStatus] || STATUS_CYCLE['Applied'];
    btn.textContent = newStatus;
    btn.style.background = newCfg.bg;
    btn.style.color = newCfg.color;
    btn.style.borderColor = newCfg.color + '40';
    btn.style.opacity = '1';
    btn.onclick = () => cycleStatus(recordId, newStatus, encodedEmail);
  } catch (e) {
    btn.textContent = currentStatus;
    btn.style.opacity = '1';
  }
}
</script>
</body></html>`);
});

// ═══════════════════════════════════════════════════════════════════
// /profile — Edit user profile (light version — extend as needed)
// ═══════════════════════════════════════════════════════════════════
app.get('/profile', async (req, res) => {
    const { email, token, resume } = req.query;
    if (!email || !verifyUnsubToken(email, token)) return res.status(403).send('Invalid link');

    const rec = await findUserRecord(email);
    if (!rec) return res.status(404).send('Profile not found');

    // If ?resume=1, set Status back to Active (from re-engagement email)
    if (resume === '1') {
        await patchUserField(email, {
            Status: 'Active',
            LastEngagement: new Date().toISOString(),
            ConsecutiveSkips: 0
        });
    }

    const f = rec.fields;
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Edit Profile</title></head>
<body style="font-family:system-ui;background:#f8fafc;padding:24px 16px;margin:0">
<form method="POST" action="${SERVER_URL}/profile/save?email=${encodeURIComponent(email)}&token=${token}" style="max-width:520px;margin:0 auto;background:#fff;padding:28px;border-radius:14px;border:1px solid #e5e7eb">
<h2 style="font-size:20px;color:#111;margin:0 0 6px">Edit your profile</h2>
<p style="font-size:13px;color:#6b7280;margin:0 0 22px">Updating these fields improves match quality immediately.</p>
${[
    ['Name','Name','text'],
    ['Target role','TargetRole','text'],
    ['Current role','CurrentRole','text'],
    ['Current company','CurrentCompany','text'],
    ['Experience','Experience','text'],
    ['Domain','Domain','text'],
    ['Skills (comma-separated)','Skills','text'],
    ['Cities (comma-separated)','Cities','text'],
    ['WhatsApp number (with country code)','Phone','tel'],
].map(([label, key, type]) => `
<label style="display:block;font-size:12px;color:#374151;font-weight:600;margin-bottom:4px">${label}</label>
<input name="${key}" type="${type}" value="${(f[label] || f[key] || '').toString().replace(/"/g,'&quot;')}" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;margin-bottom:14px;font-size:14px;box-sizing:border-box" />`).join('')}
<button type="submit" style="background:#0055FF;color:#fff;padding:12px 22px;border:0;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer;width:100%">Save changes</button>
</form></body></html>`);
});

app.post('/profile/save', async (req, res) => {
    const { email, token } = req.query;
    if (!email || !verifyUnsubToken(email, token)) return res.status(403).send('Invalid link');

    const fieldMap = {
        Name: 'Name', TargetRole: 'Target role', CurrentRole: 'Current role',
        CurrentCompany: 'Current company', Experience: 'Experience', Domain: 'Domain',
        Skills: 'Skills', Cities: 'Cities', Phone: 'Phone'
    };
    const updates = {};
    for (const [k, airtableField] of Object.entries(fieldMap)) {
        if (req.body[k] !== undefined) updates[airtableField] = req.body[k];
    }
    updates.LastEngagement = new Date().toISOString();

    await patchUserField(email, updates);
    res.redirect(302, `${SERVER_URL}/dashboard?email=${encodeURIComponent(email)}&token=${token}&saved=1`);
});

// ═══════════════════════════════════════════════════════════════════
// /signup — Resume upload + Claude profile extraction
// ═══════════════════════════════════════════════════════════════════
app.post('/signup', upload.single('resume'), async (req, res) => {
    const { email, name, phone, cities } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!phone) return res.status(400).json({ error: 'Phone required for WhatsApp alerts' });
    if (!req.file) return res.status(400).json({ error: 'Resume required' });

    try {
        // Extract profile from resume via Claude
        const base64 = req.file.buffer.toString('base64');
        const msg = await claude.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 800,
            messages: [{
                role: 'user',
                content: [
                    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
                    { type: 'text', text: `Extract from this resume and return JSON only:
{"targetRole":"...","currentRole":"...","currentCompany":"...","experience":"X years","seniority":"junior|mid|senior|lead","domain":"...","skills":"comma,separated","education":"..."}
For seniority: 0-2yr=junior, 3-6=mid, 7-12=senior, 13+=lead. Domain examples: Fintech/NBFC, SaaS, Healthcare, FMCG.` }
                ]
            }]
        });

        let profile = {};
        try {
            const raw = msg.content[0].text.replace(/```json|```/g, '').trim();
            profile = JSON.parse(raw);
        } catch (e) {
            profile = { targetRole: '', currentRole: '', experience: '3 years', seniority: 'mid' };
        }

        // Save to Airtable
        await fetch(`https://api.airtable.com/v0/${AT_BASE}/${USERS_TABLE}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields: {
                    Email: email,
                    Name: name || email.split('@')[0],
                    Phone: phone,
                    'Target role': profile.targetRole || '',
                    'Current role': profile.currentRole || '',
                    'Current company': profile.currentCompany || '',
                    Experience: profile.experience || '3 years',
                    Seniority: profile.seniority || 'mid',
                    Domain: req.body.domain || profile.domain || '',
                    Skills: profile.skills || '',
                    Education: profile.education || '',
                    Cities: cities || 'Bengaluru',
                    Status: 'Active',
                    PaidStatus: 'free',
                    LastEngagement: new Date().toISOString()
                }
            })
        });

        // Trigger Apify actor for immediate first digest
        if (APIFY_TOKEN) {
            fetch(`https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs?token=${APIFY_TOKEN}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filterEmail: email, inlineProfile: { ...profile, email, name, cities: cities ? cities.split(',') : ['Bengaluru'] } })
            }).catch(() => {});
        }

        res.json({ success: true, profile, dashboardUrl: `${SERVER_URL}/dashboard?email=${encodeURIComponent(email)}&token=${makeUnsubToken(email)}` });
    } catch (e) {
        console.error('Signup error:', e.message);
        res.status(500).json({ error: 'Signup failed — please try again' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// /pricing — Pro tier upsell page (placeholder — wire Razorpay next)
// ═══════════════════════════════════════════════════════════════════
app.get('/pricing', async (req, res) => {
    const { email, token } = req.query;
    if (!email || !verifyUnsubToken(email, token)) return res.status(403).send('Invalid link');

    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pricing</title></head>
<body style="font-family:system-ui;background:#f8fafc;padding:32px 16px;margin:0">
<div style="max-width:520px;margin:0 auto">
<h1 style="text-align:center;font-size:24px;color:#111;margin:0 0 6px">Upgrade to JobMatch Pro</h1>
<p style="text-align:center;font-size:13px;color:#6b7280;margin:0 0 28px">More matches, faster, with WhatsApp + ATS optimiser</p>

<div style="background:#fff;border:2px solid #0055FF;border-radius:14px;padding:24px;text-align:center">
  <div style="font-size:13px;color:#0055FF;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">PRO</div>
  <div style="font-size:32px;font-weight:800;color:#111">₹299<span style="font-size:14px;color:#6b7280;font-weight:500">/month</span></div>
  <div style="font-size:12px;color:#6b7280;margin-bottom:18px">or ₹2,499/year (save 30%)</div>
  <ul style="list-style:none;padding:0;text-align:left;margin:0 0 22px;font-size:13px;color:#374151;line-height:2">
    <li>✓ Daily email digests (vs 2/week free)</li>
    <li>✓ WhatsApp alerts at 9am IST</li>
    <li>✓ Full LinkedIn + Naukri search</li>
    <li>✓ ATS resume optimiser (10/month)</li>
    <li>✓ Hiring contact reveals</li>
    <li>✓ Apply tracking + reminders</li>
  </ul>
  <a href="${SERVER_URL}/checkout?email=${encodeURIComponent(email)}&token=${token}&plan=monthly" style="display:block;background:#0055FF;color:#fff;padding:14px;border-radius:9px;text-decoration:none;font-size:14px;font-weight:700">Upgrade now →</a>
</div>

<p style="text-align:center;font-size:11px;color:#9ca3af;margin-top:18px">Cancel anytime. Secure payment via Razorpay (UPI / cards).</p>
</div></body></html>`);
});

// Placeholder — wire Razorpay in the next iteration
app.get('/checkout', (req, res) => {
    res.send('Razorpay checkout coming next — for now, email hello@jobmatchai.co.in for early Pro access at ₹199/month.');
});

// ═══════════════════════════════════════════════════════════════════
// /health — uptime check
// ═══════════════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════════
// /count — Live active user count (cached 5 min, called from landing)
// ═══════════════════════════════════════════════════════════════════
let countCache = { value: 0, expiresAt: 0 };
app.get('/count', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    if (Date.now() < countCache.expiresAt) {
        return res.json({ count: countCache.value });
    }
    try {
        let total = 0;
        let offset = '';
        // Paginate through all Active users
        do {
            const url = `https://api.airtable.com/v0/${AT_BASE}/${USERS_TABLE}?filterByFormula={Status}="Active"&fields[]=Email&pageSize=100${offset ? '&offset='+offset : ''}`;
            const r = await fetch(url, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
            const data = await r.json();
            total += (data.records || []).length;
            offset = data.offset || '';
        } while (offset);
        countCache = { value: total, expiresAt: Date.now() + 5 * 60 * 1000 };
        res.json({ count: total });
    } catch (e) {
        res.json({ count: countCache.value || 50 });
    }
});

// ═══════════════════════════════════════════════════════════════════
// /signup — Public signup form (resume + email + phone mandatory)
// ═══════════════════════════════════════════════════════════════════
app.get('/signup', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign up — JobMatch AI</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cabinet+Grotesk:wght@400;500;700;800;900&family=Satoshi:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#F8F9FC;--white:#FFFFFF;--s:#F2F4F8;--s2:#E8EBF2;--border:#E2E6EF;--border2:#CDD2E0;--ink:#0D0F1A;--ink2:#1E2235;--ink3:#6B7280;--ink4:#9CA3AF;--v:#5B21B6;--v2:#7C3AED;--v3:#8B5CF6;--v4:rgba(91,33,182,0.08);--v5:rgba(91,33,182,0.15);--b:#1D4ED8;--b2:#3B82F6;--g:#059669;--g2:rgba(5,150,105,0.1);--r:10px;--r2:16px}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;-webkit-font-smoothing:antialiased}
body{font-family:'Satoshi',system-ui,sans-serif;background:var(--bg);color:var(--ink);display:flex;min-height:100vh}
a{text-decoration:none;color:inherit}
.left{width:46%;background:var(--white);border-right:1px solid var(--border);padding:44px 52px;display:flex;flex-direction:column;position:relative;overflow:hidden;box-shadow:2px 0 20px rgba(13,15,26,0.04)}
.left::before{content:'';position:absolute;top:-100px;right:-80px;width:400px;height:400px;background:radial-gradient(circle,rgba(91,33,182,0.05) 0%,transparent 65%);pointer-events:none}
.left::after{content:'';position:absolute;bottom:-60px;left:-60px;width:300px;height:300px;background:radial-gradient(circle,rgba(29,78,216,0.04) 0%,transparent 65%);pointer-events:none}
.l-logo{display:flex;align-items:center;gap:10px;margin-bottom:56px}
.l-lm{width:32px;height:32px;background:linear-gradient(135deg,var(--v),var(--b));border-radius:9px;display:grid;place-items:center;box-shadow:0 4px 12px rgba(91,33,182,0.25)}
.l-lm svg{width:15px;height:15px;fill:white}
.l-brand{font-family:'Cabinet Grotesk',sans-serif;font-size:16px;font-weight:800;letter-spacing:-.02em;color:var(--ink)}
.l-h{font-family:'Cabinet Grotesk',sans-serif;font-size:32px;font-weight:900;line-height:1.1;letter-spacing:-.04em;margin-bottom:12px;color:var(--ink)}
.l-h-g{background:linear-gradient(135deg,var(--v),var(--b2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.l-sub{font-size:15px;color:var(--ink3);line-height:1.72;margin-bottom:40px;max-width:340px}
.feats{display:flex;flex-direction:column;gap:20px;margin-bottom:auto}
.feat{display:flex;gap:14px;align-items:flex-start}
.feat-icon{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-size:18px;flex-shrink:0;border:1px solid var(--border)}
.feat-t{font-size:14px;font-weight:700;color:var(--ink);margin-bottom:3px;letter-spacing:-.01em}
.feat-d{font-size:13px;color:var(--ink3);line-height:1.55}
.sample{background:linear-gradient(135deg,rgba(5,150,105,0.04),rgba(5,150,105,0.02));border:1px solid rgba(5,150,105,0.15);border-left:3px solid var(--g);border-radius:var(--r2);padding:16px;margin-top:36px}
.sl{font-size:10.5px;font-weight:700;color:var(--ink4);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}
.st{font-family:'Cabinet Grotesk',sans-serif;font-size:14px;font-weight:800;margin-bottom:3px;letter-spacing:-.01em;color:var(--ink)}
.sm{font-size:12px;color:var(--ink3);margin-bottom:10px}
.sf{display:flex;justify-content:space-between;align-items:center}
.sbadge{font-size:11px;font-weight:700;color:var(--g);background:var(--g2);border:1px solid rgba(5,150,105,0.2);padding:3px 10px;border-radius:10px}
.sscore{font-family:'Cabinet Grotesk',sans-serif;font-size:22px;font-weight:900;color:var(--g);letter-spacing:-.04em}
.right{flex:1;display:flex;align-items:center;justify-content:center;padding:48px 64px;background:var(--bg)}
.fbox{width:100%;max-width:460px}
.fh{font-family:'Cabinet Grotesk',sans-serif;font-size:28px;font-weight:900;letter-spacing:-.04em;margin-bottom:6px;color:var(--ink)}
.fsub{font-size:14px;color:var(--ink3);margin-bottom:32px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.fd{margin-bottom:18px}
.fd label{display:block;font-size:11px;font-weight:700;color:var(--ink3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
.fd input,.fd select{width:100%;padding:12px 15px;background:var(--white);border:1.5px solid var(--border);border-radius:var(--r);font-size:14px;color:var(--ink);font-family:inherit;transition:all .2s;outline:none;box-shadow:0 1px 3px rgba(13,15,26,0.04)}
.fd input:focus,.fd select:focus{border-color:var(--v3);box-shadow:0 0 0 3px var(--v4),0 1px 3px rgba(13,15,26,0.04)}
.fd input::placeholder{color:var(--ink4)}
.fd select{cursor:pointer;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%239CA3AF' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center}
.divider{display:flex;align-items:center;gap:10px;margin:4px 0 18px}
.divider span{font-size:11px;font-weight:700;color:var(--v);text-transform:uppercase;letter-spacing:.08em;white-space:nowrap}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}
.uzone{display:block;width:100%;border:1.5px dashed var(--border2);border-radius:var(--r2);padding:26px 20px;text-align:center;cursor:pointer;transition:all .2s;margin-bottom:18px;background:var(--white);box-shadow:0 1px 3px rgba(13,15,26,0.04)}
.uzone:hover,.uzone.active{border-color:var(--v3);background:var(--v4)}
.uzone input{display:none}
.uicon{font-size:24px;margin-bottom:8px;display:block}
.umain{font-size:14px;font-weight:700;color:var(--v);margin-bottom:3px}
.usub{font-size:12px;color:var(--ink4)}
.uname{font-size:12px;color:var(--g);font-weight:700;margin-top:7px;display:none}
.sbtn{width:100%;padding:14px;background:linear-gradient(135deg,var(--v),var(--b));color:#fff;border:none;border-radius:var(--r);font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;letter-spacing:-.01em;transition:all .2s;box-shadow:0 4px 16px rgba(91,33,182,0.25)}
.sbtn:hover{box-shadow:0 8px 28px rgba(91,33,182,0.35);transform:translateY(-1px)}
.sbtn:disabled{opacity:.5;cursor:wait;transform:none;box-shadow:none}
.fine{font-size:12px;color:var(--ink4);text-align:center;margin-top:12px;line-height:1.6}.fine a{color:var(--v);text-decoration:none}
.ebox{background:#FEF2F2;border:1px solid #FECACA;color:#DC2626;padding:12px 15px;border-radius:var(--r);font-size:13px;margin-bottom:14px;display:none}
.obox{background:#F0FDF4;border:1px solid #BBF7D0;border-radius:var(--r2);padding:36px;text-align:center;display:none}
.ot{font-family:'Cabinet Grotesk',sans-serif;font-size:22px;font-weight:900;letter-spacing:-.03em;margin-bottom:6px;color:var(--ink)}
.od{font-size:14px;color:var(--ink3);line-height:1.65}
@media(max-width:860px){body{flex-direction:column}.left{width:100%;padding:32px 24px}.feats{display:none}.right{padding:32px 24px}.fbox{max-width:100%}.row2{grid-template-columns:1fr}}
</style></head>
<body>
<div class="left">
  <a href="/" class="l-logo">
    <div class="l-lm"><svg viewBox="0 0 16 16"><path d="M8 2L2 6v8h4v-4h4v4h4V6L8 2z"/></svg></div>
    <span class="l-brand">JobMatch AI</span>
  </a>
  <h1 class="l-h">Your next role,<br><span class="l-h-g">every morning.</span></h1>
  <p class="l-sub">Upload your resume once. We scan 5 job platforms daily and send you the matches that actually fit — AI-scored, ranked by relevance.</p>
  <div class="feats">
    <div class="feat"><div class="feat-icon" style="background:#F5F3FF;border-color:#DDD6FE">🎯</div><div><div class="feat-t">AI function matching</div><div class="feat-d">Role, seniority, domain, location — all scored against your exact profile</div></div></div>
    <div class="feat"><div class="feat-icon" style="background:#EFF6FF;border-color:#BFDBFE">⚡</div><div><div class="feat-t">5 platforms, one email</div><div class="feat-d">LinkedIn, Naukri, JSearch, Adzuna, iimjobs — fresh, de-duplicated daily</div></div></div>
    <div class="feat"><div class="feat-icon" style="background:#F0FDF4;border-color:#BBF7D0">🔒</div><div><div class="feat-t">Zero noise, ever</div><div class="feat-d">Only fresh, relevant roles. Nothing repeated. Unsubscribe in one click.</div></div></div>
  </div>
  <div class="sample">
    <div class="sl">Sample match · yesterday</div>
    <div class="st">Head of Partnerships – Fintech</div>
    <div class="sm">Brahma Finance · Bengaluru · Naukri · ₹30–45L</div>
    <div class="sf"><span class="sbadge">Strong fit</span><span class="sscore">91%</span></div>
  </div>
</div>
<div class="right">
  <div class="fbox">
    <h2 class="fh">Create your account</h2>
    <p class="fsub">Free forever · No credit card · 60 seconds to set up</p>
    <div id="ebox" class="ebox"></div>
    <div id="obox" class="obox">
      <div style="font-size:48px;margin-bottom:12px">🎉</div>
      <div class="ot">You're in!</div>
      <div class="od">Check your inbox shortly.<br>Your first matches are on their way.</div>
    </div>
    <form id="form" enctype="multipart/form-data">
      <div class="row2">
        <div class="fd"><label>Full name *</label><input name="name" required maxlength="60" placeholder="Priya Sharma"></div>
        <div class="fd"><label>WhatsApp *</label><input name="phone" type="tel" required placeholder="+91 98765 43210"></div>
      </div>
      <div class="fd"><label>Email *</label><input name="email" type="email" required placeholder="priya@company.com"></div>
      <div class="divider"><span>Job Preferences</span></div>
      <div class="fd"><label>Industry / Domain *</label>
        <select name="domain" required>
          <option value="">Select your industry</option>
          <option value="Fintech / NBFC / Digital Lending">Fintech / NBFC / Digital Lending</option>
          <option value="SaaS / B2B Tech">SaaS / B2B Tech</option>
          <option value="E-commerce / D2C">E-commerce / D2C</option>
          <option value="Banking / BFSI">Banking / BFSI</option>
          <option value="FMCG / Consumer Goods">FMCG / Consumer Goods</option>
          <option value="EdTech">EdTech</option>
          <option value="HealthTech / MedTech">HealthTech / MedTech</option>
          <option value="Marketing / Growth">Marketing / Growth</option>
          <option value="HR / Talent">HR / Talent</option>
          <option value="Finance / Accounting">Finance / Accounting</option>
          <option value="Operations / Supply Chain">Operations / Supply Chain</option>
          <option value="Engineering / IT">Engineering / IT</option>
          <option value="Data / Analytics / AI">Data / Analytics / AI</option>
          <option value="Consulting / Strategy">Consulting / Strategy</option>
          <option value="General / Open to all">General / Open to all</option>
        </select>
      </div>
      <div class="fd"><label>Preferred location *</label>
        <select name="cities" required>
          <option value="Bengaluru">Bengaluru</option>
          <option value="Mumbai">Mumbai</option>
          <option value="Delhi NCR">Delhi NCR</option>
          <option value="Hyderabad">Hyderabad</option>
          <option value="Pune">Pune</option>
          <option value="Chennai">Chennai</option>
          <option value="Bengaluru, Mumbai">Bengaluru + Mumbai</option>
          <option value="Bengaluru, Delhi NCR">Bengaluru + Delhi NCR</option>
          <option value="Mumbai, Delhi NCR">Mumbai + Delhi NCR</option>
          <option value="Remote">Remote only</option>
          <option value="Bengaluru, Mumbai, Delhi NCR">Pan India (top metros)</option>
        </select>
      </div>
      <label class="uzone" for="resume" id="uzone">
        <input id="resume" name="resume" type="file" accept=".pdf" required>
        <span class="uicon">📄</span>
        <div class="umain">Click to upload your resume</div>
        <div class="usub">PDF only · Max 5MB · We never share it</div>
        <div class="uname" id="uname"></div>
      </label>
      <button type="submit" id="sbtn" class="sbtn">Get my first matches →</button>
      <p class="fine">Free forever · No spam · <a href="/terms">Privacy policy</a></p>
    </form>
  </div>
</div>
<script>
document.getElementById('resume').addEventListener('change',e=>{
  const f=e.target.files[0],n=document.getElementById('uname'),z=document.getElementById('uzone');
  if(f){n.textContent='✓ '+f.name;n.style.display='block';z.classList.add('active');}
});
document.getElementById('form').addEventListener('submit',async e=>{
  e.preventDefault();
  const eb=document.getElementById('ebox'),ob=document.getElementById('obox'),btn=document.getElementById('sbtn');
  eb.style.display='none';btn.disabled=true;btn.textContent='Reading your resume...';
  try{
    const r=await fetch('/signup',{method:'POST',body:new FormData(e.target)});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Signup failed');
    e.target.style.display='none';ob.style.display='block';
  }catch(er){eb.textContent=er.message;eb.style.display='block';btn.disabled=false;btn.textContent='Try again';}
});
</script>
</body></html>`);
});
// /  — Landing page
// ═══════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JobMatch AI — Your morning job digest, AI-curated</title>
<meta name="description" content="Upload your resume once. Get ranked job matches every morning across LinkedIn, Naukri, and 5 platforms. Free.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cabinet+Grotesk:wght@400;500;700;800;900&family=Satoshi:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #F8F9FC;
  --white: #FFFFFF;
  --surface: #F2F4F8;
  --surface2: #E8EBF2;
  --border: #E2E6EF;
  --border2: #CDD2E0;
  --ink: #0D0F1A;
  --ink2: #1E2235;
  --ink3: #6B7280;
  --ink4: #9CA3AF;
  --violet: #5B21B6;
  --violet2: #7C3AED;
  --violet3: #8B5CF6;
  --violet4: rgba(91,33,182,0.08);
  --violet5: rgba(91,33,182,0.15);
  --blue: #1D4ED8;
  --blue2: #3B82F6;
  --blue3: rgba(29,78,216,0.08);
  --green: #059669;
  --green2: rgba(5,150,105,0.1);
  --amber: #D97706;
  --r: 10px;
  --r2: 16px;
  --r3: 24px;
  --shadow-sm: 0 1px 3px rgba(13,15,26,0.06), 0 1px 2px rgba(13,15,26,0.04);
  --shadow: 0 4px 12px rgba(13,15,26,0.08), 0 2px 4px rgba(13,15,26,0.04);
  --shadow-md: 0 12px 32px rgba(13,15,26,0.10), 0 4px 8px rgba(13,15,26,0.06);
  --shadow-lg: 0 24px 64px rgba(13,15,26,0.12), 0 8px 16px rgba(13,15,26,0.06);
  --shadow-violet: 0 16px 48px rgba(91,33,182,0.18), 0 4px 12px rgba(91,33,182,0.10);
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; -webkit-font-smoothing: antialiased; }
body { font-family: 'Satoshi', system-ui, sans-serif; background: var(--bg); color: var(--ink); line-height: 1.6; overflow-x: hidden; }
a { text-decoration: none; color: inherit; }
img { display: block; }

/* ── STICKY NAV ── */
nav {
  position: sticky; top: 0; z-index: 100;
  background: rgba(248,249,252,0.92);
  backdrop-filter: blur(16px) saturate(180%);
  border-bottom: 1px solid var(--border);
  padding: 0 40px; height: 64px;
  display: flex; align-items: center; justify-content: space-between;
}
.nav-logo { display: flex; align-items: center; gap: 10px; }
.nav-logomark {
  width: 32px; height: 32px;
  background: linear-gradient(135deg, var(--violet) 0%, var(--blue) 100%);
  border-radius: 9px;
  display: grid; place-items: center;
  box-shadow: 0 4px 12px rgba(91,33,182,0.3);
}
.nav-logomark svg { width: 16px; height: 16px; fill: white; }
.nav-brand { font-family: 'Cabinet Grotesk', sans-serif; font-size: 17px; font-weight: 800; letter-spacing: -0.03em; color: var(--ink); }
.nav-links { display: flex; align-items: center; gap: 4px; }
.nav-link { font-size: 14px; font-weight: 500; color: var(--ink3); padding: 7px 14px; border-radius: 8px; transition: all 0.15s; }
.nav-link:hover { color: var(--ink); background: var(--surface); }
.nav-right { display: flex; align-items: center; gap: 10px; }
.nav-btn-ghost { font-size: 14px; font-weight: 600; color: var(--ink2); padding: 8px 18px; border-radius: var(--r); border: 1.5px solid var(--border2); transition: all 0.15s; background: var(--white); }
.nav-btn-ghost:hover { border-color: var(--violet3); color: var(--violet); }
.nav-btn-primary {
  font-size: 14px; font-weight: 700; color: white; padding: 9px 20px;
  border-radius: var(--r);
  background: linear-gradient(135deg, var(--violet) 0%, var(--blue) 100%);
  box-shadow: 0 4px 14px rgba(91,33,182,0.3);
  transition: all 0.18s; letter-spacing: -0.01em;
  display: flex; align-items: center; gap: 6px;
}
.nav-btn-primary:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(91,33,182,0.35); }

/* ── HERO ── */
.hero {
  max-width: 1200px; margin: 0 auto;
  padding: 72px 40px 80px;
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 64px; align-items: center;
  position: relative;
}
.hero-bg-grid {
  position: absolute; inset: 0; pointer-events: none; overflow: hidden;
  background-image: radial-gradient(circle at 20% 50%, rgba(91,33,182,0.04) 0%, transparent 50%),
    radial-gradient(circle at 80% 20%, rgba(29,78,216,0.04) 0%, transparent 40%);
}
.hero-badge {
  display: inline-flex; align-items: center; gap: 7px;
  background: var(--violet4); border: 1px solid var(--violet5);
  color: var(--violet); font-size: 12.5px; font-weight: 600;
  padding: 5px 14px 5px 8px; border-radius: 20px;
  margin-bottom: 22px; letter-spacing: 0.01em;
}
.badge-pulse {
  width: 7px; height: 7px; border-radius: 50%; background: var(--violet3);
  animation: badgePulse 2s ease infinite;
}
@keyframes badgePulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(124,58,237,0.5); }
  60% { box-shadow: 0 0 0 5px rgba(124,58,237,0); }
}
h1 {
  font-family: 'Cabinet Grotesk', sans-serif;
  font-size: clamp(42px, 4.5vw, 58px);
  font-weight: 900; line-height: 1.06;
  letter-spacing: -0.04em; color: var(--ink);
  margin-bottom: 20px;
}
.h1-accent {
  background: linear-gradient(135deg, var(--violet) 0%, var(--blue2) 100%);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
}
.hero-sub {
  font-size: 17px; color: var(--ink3); line-height: 1.75;
  max-width: 460px; margin-bottom: 36px; font-weight: 400;
}
.hero-ctas { display: flex; gap: 12px; margin-bottom: 36px; flex-wrap: wrap; align-items: center; }
.cta-primary {
  display: inline-flex; align-items: center; gap: 8px;
  background: linear-gradient(135deg, var(--violet) 0%, var(--blue) 100%);
  color: white; font-size: 15px; font-weight: 700;
  padding: 13px 26px; border-radius: var(--r2);
  box-shadow: var(--shadow-violet); transition: all 0.2s;
  letter-spacing: -0.01em; border: none; cursor: pointer; font-family: inherit;
}
.cta-primary:hover { transform: translateY(-2px); box-shadow: 0 20px 56px rgba(91,33,182,0.22); }
.cta-secondary {
  display: inline-flex; align-items: center; gap: 8px;
  background: var(--white); color: var(--ink2);
  font-size: 15px; font-weight: 600;
  padding: 13px 22px; border-radius: var(--r2);
  border: 1.5px solid var(--border2); transition: all 0.18s;
  cursor: pointer; font-family: inherit; box-shadow: var(--shadow-sm);
}
.cta-secondary:hover { border-color: var(--violet3); color: var(--violet); box-shadow: var(--shadow); }
.trust-items { display: flex; flex-wrap: wrap; gap: 6px; }
.trust-item {
  display: flex; align-items: center; gap: 5px;
  font-size: 12.5px; font-weight: 500; color: var(--ink4);
}
.trust-item::before { content: '✓'; color: var(--green); font-weight: 700; font-size: 11px; }
.trust-dot { width: 3px; height: 3px; border-radius: 50%; background: var(--border2); }

/* ── 3D PHONE MOCKUP ── */
.phone-scene {
  display: flex; align-items: center; justify-content: center;
  position: relative; padding: 40px;
}
.phone-glow {
  position: absolute; top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: 340px; height: 340px;
  background: radial-gradient(circle, rgba(91,33,182,0.12) 0%, rgba(29,78,216,0.06) 40%, transparent 70%);
  pointer-events: none; border-radius: 50%;
}
/* 3D isometric phone using CSS perspective */
.phone-3d-wrap {
  perspective: 1000px;
  animation: phoneFloat 6s ease-in-out infinite;
}
@keyframes phoneFloat {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-14px); }
}
.phone-3d {
  transform: rotateX(8deg) rotateY(-12deg) rotateZ(2deg);
  transform-style: preserve-3d;
  position: relative;
}
.phone-body {
  width: 260px;
  background: linear-gradient(160deg, #1C1C2E 0%, #0D0D1A 100%);
  border-radius: 36px;
  padding: 12px;
  box-shadow:
    0 40px 80px rgba(13,13,26,0.4),
    0 20px 40px rgba(13,13,26,0.3),
    inset 0 1px 0 rgba(255,255,255,0.12),
    inset 0 -1px 0 rgba(0,0,0,0.3),
    6px 6px 0 rgba(0,0,0,0.15),
    12px 12px 0 rgba(0,0,0,0.08);
  border: 1px solid rgba(255,255,255,0.1);
  position: relative;
}
/* Phone side edge for 3D effect */
.phone-body::after {
  content: '';
  position: absolute;
  left: 100%; top: 36px; bottom: 36px;
  width: 10px;
  background: linear-gradient(90deg, rgba(0,0,0,0.4), rgba(0,0,0,0.2));
  border-radius: 0 4px 4px 0;
  transform: skewY(0deg);
}
.phone-notch {
  width: 80px; height: 24px;
  background: #0D0D1A;
  border-radius: 0 0 16px 16px;
  margin: 0 auto 8px;
  display: flex; align-items: center; justify-content: center; gap: 6px;
}
.notch-cam { width: 9px; height: 9px; border-radius: 50%; background: #1A1A2E; border: 1.5px solid #252535; }
.notch-light { width: 5px; height: 5px; border-radius: 50%; background: #2A2A3E; }
.phone-screen {
  background: var(--white);
  border-radius: 26px;
  overflow: hidden;
  min-height: 420px;
}
/* Email inside phone */
.em-head {
  background: linear-gradient(135deg, var(--violet) 0%, var(--blue) 100%);
  padding: 14px 14px 10px;
}
.em-head-brand { font-family: 'Cabinet Grotesk', sans-serif; font-size: 13px; font-weight: 800; color: white; letter-spacing: -0.02em; margin-bottom: 3px; }
.em-head-sub { font-size: 10px; color: rgba(255,255,255,0.7); font-weight: 500; }
.em-body { padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.em-card {
  background: white; border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 11px;
  box-shadow: 0 2px 8px rgba(13,15,26,0.05);
  position: relative; overflow: hidden;
}
.em-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; }
.em-card-green::before { background: var(--green); }
.em-card-blue::before { background: var(--blue2); }
.em-card-amber::before { background: var(--amber); }
.em-card-title { font-size: 10.5px; font-weight: 700; color: var(--ink); margin-bottom: 2px; letter-spacing: -0.01em; line-height: 1.3; }
.em-card-meta { font-size: 9.5px; color: var(--ink3); margin-bottom: 7px; }
.em-card-foot { display: flex; align-items: center; justify-content: space-between; }
.em-score-tag {
  display: flex; align-items: center; gap: 5px;
}
.em-badge {
  font-size: 9px; font-weight: 700; padding: 2px 8px; border-radius: 10px;
  background: rgba(5,150,105,0.1); color: var(--green);
  border: 1px solid rgba(5,150,105,0.2);
}
.em-score {
  font-family: 'Cabinet Grotesk', sans-serif;
  font-size: 18px; font-weight: 900; letter-spacing: -0.04em; color: var(--green);
  filter: drop-shadow(0 0 6px rgba(5,150,105,0.3));
}
.em-apply {
  background: var(--violet); color: white;
  font-size: 9px; font-weight: 700; padding: 4px 10px; border-radius: 6px;
}
.em-footer { padding: 8px 10px; border-top: 1px solid var(--border); text-align: center; }
.em-footer-t { font-size: 9.5px; color: var(--ink4); }
/* Floating badge on phone */
.float-badge {
  position: absolute; top: -10px; right: -20px;
  background: white; border: 1px solid var(--border);
  border-radius: 12px; padding: 8px 12px;
  box-shadow: var(--shadow-md);
  display: flex; align-items: center; gap: 8px;
  animation: floatBadge 4s ease-in-out infinite;
  white-space: nowrap;
}
@keyframes floatBadge {
  0%, 100% { transform: translateY(0) rotate(-2deg); }
  50% { transform: translateY(-8px) rotate(-2deg); }
}
.fb-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 3px rgba(5,150,105,0.2); animation: badgePulse 2s ease infinite; }
.fb-text { font-size: 11px; font-weight: 700; color: var(--ink); }
.fb-score { font-size: 11px; font-weight: 700; color: var(--green); }
/* Second floating element */
.float-stat {
  position: absolute; bottom: 0px; left: -30px;
  background: white; border: 1px solid var(--border);
  border-radius: 12px; padding: 9px 14px;
  box-shadow: var(--shadow-md);
  animation: floatStat 5s ease-in-out infinite;
  animation-delay: 1s;
}
@keyframes floatStat {
  0%, 100% { transform: translateY(0) rotate(1deg); }
  50% { transform: translateY(-6px) rotate(1deg); }
}
.fs-n { font-family: 'Cabinet Grotesk', sans-serif; font-size: 20px; font-weight: 900; color: var(--violet); letter-spacing: -0.04em; line-height: 1; }
.fs-l { font-size: 10px; color: var(--ink3); font-weight: 500; margin-top: 2px; }

/* ── TRUST BANNER ── */
.trust-banner {
  border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
  background: var(--white);
  padding: 20px 40px;
}
.trust-banner-in {
  max-width: 1200px; margin: 0 auto;
  display: flex; align-items: center; justify-content: space-between;
  gap: 20px; flex-wrap: wrap;
}
.tb-label { font-size: 11.5px; font-weight: 600; color: var(--ink4); letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; }
.tb-items { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tb-item {
  display: flex; align-items: center; gap: 6px;
  font-size: 13px; font-weight: 600; color: var(--ink3);
  padding: 7px 16px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 20px;
}
.tb-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.tb-stat {
  font-family: 'Cabinet Grotesk', sans-serif;
  font-size: 13px; font-weight: 800;
  color: var(--violet); letter-spacing: -0.02em;
}
.tb-divider { width: 1px; height: 24px; background: var(--border); }

/* ── HOW IT WORKS ── */
.section { padding: 88px 40px; max-width: 1200px; margin: 0 auto; }
.sec-kicker {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 700; color: var(--violet);
  text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 14px;
}
.sec-kicker::before { content: ''; display: block; width: 20px; height: 2px; background: var(--violet); border-radius: 1px; }
.sec-title { font-family: 'Cabinet Grotesk', sans-serif; font-size: 38px; font-weight: 900; letter-spacing: -0.04em; line-height: 1.1; margin-bottom: 14px; color: var(--ink); }
.sec-sub { font-size: 16px; color: var(--ink3); line-height: 1.72; max-width: 500px; }

.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 52px; }
.step {
  background: var(--white); border: 1px solid var(--border);
  border-radius: var(--r3); padding: 32px 28px;
  box-shadow: var(--shadow-sm); position: relative; overflow: hidden;
  transition: all 0.2s;
}
.step:hover { box-shadow: var(--shadow-md); transform: translateY(-3px); border-color: var(--border2); }
.step-accent { position: absolute; top: 0; left: 0; right: 0; height: 2px; }
.step-num {
  font-family: 'Cabinet Grotesk', sans-serif;
  font-size: 11px; font-weight: 800; letter-spacing: 0.08em;
  text-transform: uppercase; margin-bottom: 18px;
  display: flex; align-items: center; gap: 8px;
}
.step-num-badge {
  width: 24px; height: 24px; border-radius: 7px;
  display: grid; place-items: center;
  font-size: 11px; font-weight: 800; color: white;
}
.step-icon { font-size: 28px; margin-bottom: 16px; }
.step-t { font-family: 'Cabinet Grotesk', sans-serif; font-size: 18px; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 10px; color: var(--ink); }
.step-d { font-size: 14px; color: var(--ink3); line-height: 1.68; }

/* ── PRICING ── */
.pricing-section {
  background: var(--white); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
  padding: 88px 40px;
}
.pricing-in { max-width: 900px; margin: 0 auto; text-align: center; }
.plans { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; max-width: 820px; margin: 52px auto 0; text-align: left; }
.plan {
  background: var(--bg); border: 1.5px solid var(--border);
  border-radius: var(--r3); padding: 32px;
  position: relative; overflow: hidden;
  box-shadow: var(--shadow-sm);
}
.plan-pro {
  background: var(--white);
  border-color: var(--violet3);
  box-shadow: var(--shadow-violet);
}
.plan-pro-shimmer {
  position: absolute; top: 0; left: 0; right: 0; height: 2px;
  background: linear-gradient(90deg, var(--violet), var(--blue));
}
.plan-tag {
  position: absolute; top: 20px; right: 20px;
  background: linear-gradient(135deg, var(--violet), var(--blue));
  color: white; font-size: 10px; font-weight: 800;
  padding: 4px 12px; border-radius: 20px; letter-spacing: 0.04em;
}
.plan-n { font-size: 11px; font-weight: 700; color: var(--ink4); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 10px; }
.plan-price { font-family: 'Cabinet Grotesk', sans-serif; font-size: 48px; font-weight: 900; letter-spacing: -0.06em; line-height: 1; margin-bottom: 4px; color: var(--ink); }
.plan-price-pro { background: linear-gradient(135deg, var(--violet), var(--blue)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.plan-per { font-family: 'Satoshi', sans-serif; font-size: 15px; font-weight: 400; color: var(--ink3); -webkit-text-fill-color: var(--ink3); letter-spacing: 0; }
.plan-desc { font-size: 13px; color: var(--ink4); margin-bottom: 24px; }
.plan-feats { list-style: none; margin-bottom: 28px; }
.plan-feats li { font-size: 14px; color: var(--ink2); padding: 8px 0; border-bottom: 1px solid var(--border); display: flex; align-items: flex-start; gap: 10px; }
.plan-feats li:last-child { border: none; }
.ck { color: var(--green); font-size: 12px; flex-shrink: 0; margin-top: 1px; font-weight: 700; }
.btn-pro {
  display: block; text-align: center;
  background: linear-gradient(135deg, var(--violet), var(--blue));
  color: white; font-size: 14px; font-weight: 700;
  padding: 13px; border-radius: var(--r2);
  transition: all 0.2s; letter-spacing: -0.01em;
  box-shadow: 0 4px 16px rgba(91,33,182,0.25);
}
.btn-pro:hover { box-shadow: 0 8px 28px rgba(91,33,182,0.35); transform: translateY(-1px); }
.btn-free {
  display: block; text-align: center;
  background: transparent; color: var(--ink2);
  font-size: 14px; font-weight: 600;
  padding: 13px; border-radius: var(--r2);
  border: 1.5px solid var(--border2); transition: all 0.18s;
}
.btn-free:hover { border-color: var(--violet3); color: var(--violet); background: var(--violet4); }
.trust-note { display: flex; align-items: flex-start; gap: 14px; max-width: 820px; margin: 18px auto 0; padding: 16px 22px; background: rgba(5,150,105,0.05); border: 1px solid rgba(5,150,105,0.15); border-radius: var(--r2); text-align: left; }
.tn-icon { font-size: 20px; flex-shrink: 0; }
.tn-t { font-size: 13.5px; font-weight: 700; color: var(--green); margin-bottom: 3px; }
.tn-d { font-size: 12.5px; color: var(--ink3); line-height: 1.6; }

/* ── FAQ ── */
.faq-section { padding: 80px 40px; max-width: 720px; margin: 0 auto; text-align: center; }
.faq-wrap { text-align: left; margin-top: 48px; }
.fi { border-bottom: 1px solid var(--border); cursor: pointer; }
.fq { padding: 18px 0; font-size: 15px; font-weight: 600; color: var(--ink); display: flex; justify-content: space-between; align-items: center; gap: 12px; transition: color 0.15s; }
.fq:hover { color: var(--violet); }
.fi-ic { width: 24px; height: 24px; border-radius: 50%; border: 1.5px solid var(--border2); display: grid; place-items: center; color: var(--ink3); font-size: 16px; flex-shrink: 0; transition: all 0.2s; font-weight: 300; }
.fi.o .fi-ic { border-color: var(--violet); color: var(--violet); transform: rotate(45deg); background: var(--violet4); }
.fa { font-size: 14px; color: var(--ink3); line-height: 1.75; max-height: 0; overflow: hidden; transition: max-height 0.35s ease, padding 0.3s; }
.fi.o .fa { max-height: 220px; padding-bottom: 18px; }

/* ── FOOTER ── */
footer { background: var(--ink); padding: 56px 40px 36px; }
.ft-in { max-width: 1200px; margin: 0 auto; }
.ft-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 44px; flex-wrap: wrap; gap: 24px; }
.ft-brand .ft-logo { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.ft-lm { width: 30px; height: 30px; background: linear-gradient(135deg, var(--violet), var(--blue)); border-radius: 8px; display: grid; place-items: center; }
.ft-lm svg { width: 14px; height: 14px; fill: white; }
.ft-brand-name { font-family: 'Cabinet Grotesk', sans-serif; font-size: 16px; font-weight: 800; color: white; letter-spacing: -0.02em; }
.ft-tagline { font-size: 13px; color: rgba(255,255,255,0.35); }
.ft-cols { display: flex; gap: 48px; flex-wrap: wrap; }
.ft-col-t { font-size: 10.5px; font-weight: 700; color: rgba(255,255,255,0.3); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 14px; }
.ft-link { display: block; font-size: 13.5px; color: rgba(255,255,255,0.55); margin-bottom: 10px; transition: color 0.15s; }
.ft-link:hover { color: white; }
.ft-bottom { border-top: 1px solid rgba(255,255,255,0.08); padding-top: 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
.ft-copy { font-size: 12.5px; color: rgba(255,255,255,0.25); }

/* ── RESPONSIVE ── */
@media (max-width: 900px) {
  .hero { grid-template-columns: 1fr; gap: 48px; padding-top: 52px; }
  .steps { grid-template-columns: 1fr; }
  .plans { grid-template-columns: 1fr; }
  .trust-banner-in { flex-direction: column; gap: 14px; }
  nav { padding: 0 20px; }
  .nav-links { display: none; }
  .section, .pricing-section, .faq-section { padding-left: 20px; padding-right: 20px; }
  footer { padding-left: 20px; padding-right: 20px; }
  .ft-top { flex-direction: column; }
}
@media (max-width: 480px) {
  h1 { font-size: 36px; }
  .sec-title { font-size: 30px; }
  .hero { padding-top: 40px; }
}
</style></head>
<body>

<!-- STICKY NAV -->
<nav>
  <a href="/" class="nav-logo">
    <div class="nav-logomark">
      <svg viewBox="0 0 16 16"><path d="M8 2L2 6v8h4v-4h4v4h4V6L8 2z"/></svg>
    </div>
    <span class="nav-brand">JobMatch AI</span>
  </a>
  <div class="nav-links">
    <a href="#how" class="nav-link">How it works</a>
    <a href="#pricing" class="nav-link">Pricing</a>
    <a href="mailto:hello@jobmatchai.co.in" class="nav-link">Contact</a>
  </div>
  <div class="nav-right">
    <a href="/signup" class="nav-btn-ghost">Sign in</a>
    <a href="/signup" class="nav-btn-primary">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      Upload Resume
    </a>
  </div>
</nav>

<!-- HERO -->
<section>
<div class="hero">
  <div class="hero-bg-grid"></div>
  <div>
    <div class="hero-badge"><span class="badge-pulse"></span><span id="lc">59</span> professionals matched this morning</div>
    <h1>Your next role,<br><span class="h1-accent">delivered daily.</span></h1>
    <p class="hero-sub">Upload your resume once. Every morning we scan LinkedIn, Naukri, and 3 more platforms — sending you only the roles that genuinely fit. AI-scored. Zero noise.</p>
    <div class="hero-ctas">
      <a href="/signup">
        <button class="cta-primary">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Upload Resume — Free
        </button>
      </a>
      <a href="#how"><button class="cta-secondary">See how it works →</button></a>
    </div>
    <div class="trust-items">
      <span class="trust-item">Free forever</span>
      <span class="trust-dot"></span>
      <span class="trust-item">No credit card</span>
      <span class="trust-dot"></span>
      <span class="trust-item">60-second setup</span>
      <span class="trust-dot"></span>
      <span class="trust-item">Built for India</span>
    </div>
  </div>

  <!-- 3D ISOMETRIC PHONE -->
  <div class="phone-scene">
    <div class="phone-glow"></div>
    <div class="phone-3d-wrap">
      <div class="phone-3d">
        <div class="float-badge">
          <div class="fb-dot"></div>
          <span class="fb-text">Strong Fit</span>
          <span class="fb-score">91%</span>
        </div>
        <div class="float-stat">
          <div class="fs-n">15+</div>
          <div class="fs-l">matches today</div>
        </div>
        <div class="phone-body">
          <div class="phone-notch">
            <div class="notch-cam"></div>
            <div class="notch-light"></div>
          </div>
          <div class="phone-screen">
            <div class="em-head">
              <div class="em-head-brand">JobMatch AI</div>
              <div class="em-head-sub">Your morning digest · 9:00 AM IST</div>
            </div>
            <div class="em-body">
              <div class="em-card em-card-green">
                <div class="em-card-title">Head of Partnerships – Fintech (NBFC/LSP)</div>
                <div class="em-card-meta">Brahma Finance · Bengaluru · ₹30–45L · Naukri</div>
                <div class="em-card-foot">
                  <div class="em-score-tag">
                    <span class="em-badge">Strong fit</span>
                    <span class="em-score">91%</span>
                  </div>
                  <span class="em-apply">Apply →</span>
                </div>
              </div>
              <div class="em-card em-card-blue" style="opacity:0.85">
                <div class="em-card-title">VP Partnerships – Growth Stage Fintech</div>
                <div class="em-card-meta">Velocity · Bengaluru · LinkedIn · <span style="color:#1D4ED8;font-weight:700">77%</span></div>
              </div>
              <div class="em-card em-card-amber" style="opacity:0.65">
                <div class="em-card-title">Senior Manager – Strategic Alliances</div>
                <div class="em-card-meta">Razorpay · Bengaluru · Naukri · <span style="color:#D97706;font-weight:700">62%</span></div>
              </div>
              <div class="em-footer">
                <div class="em-footer-t">+ 12 more matches in your inbox →</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</section>

<!-- TRUST BANNER -->
<div class="trust-banner">
  <div class="trust-banner-in">
    <span class="tb-label">Searching across</span>
    <div class="tb-items">
      <div class="tb-item"><div class="tb-dot" style="background:#0077b5"></div>LinkedIn</div>
      <div class="tb-item"><div class="tb-dot" style="background:#ff6b35"></div>Naukri</div>
      <div class="tb-item"><div class="tb-dot" style="background:#4285f4"></div>JSearch</div>
      <div class="tb-item"><div class="tb-dot" style="background:#e63946"></div>Adzuna</div>
      <div class="tb-item"><div class="tb-dot" style="background:#6d28d9"></div>iimjobs</div>
    </div>
    <div class="tb-divider"></div>
    <div style="display:flex;align-items:center;gap:6px">
      <div style="font-size:11.5px;color:var(--ink4);font-weight:600">Every morning at</div>
      <span class="tb-stat">9 AM IST</span>
    </div>
    <div class="tb-divider"></div>
    <div style="display:flex;align-items:center;gap:6px">
      <span class="tb-stat" id="su">59</span>
      <div style="font-size:11.5px;color:var(--ink4);font-weight:600">active users</div>
    </div>
  </div>
</div>

<!-- HOW IT WORKS -->
<div class="section" id="how">
  <div class="sec-kicker">How it works</div>
  <h2 class="sec-title">Three steps.<br>One minute setup.</h2>
  <p class="sec-sub">Then we do the work every single morning — automatically, while you sleep.</p>
  <div class="steps">
    <div class="step">
      <div class="step-accent" style="background:linear-gradient(90deg,var(--violet),transparent)"></div>
      <div class="step-num" style="color:var(--violet)">
        <div class="step-num-badge" style="background:var(--violet)">01</div>
        Upload
      </div>
      <div class="step-icon">📄</div>
      <div class="step-t">Upload your resume</div>
      <div class="step-d">Claude reads your role, experience, skills, and domain in seconds. No manual forms. No guesswork. Just drop your PDF.</div>
    </div>
    <div class="step">
      <div class="step-accent" style="background:linear-gradient(90deg,var(--blue),transparent)"></div>
      <div class="step-num" style="color:var(--blue)">
        <div class="step-num-badge" style="background:var(--blue)">02</div>
        Search
      </div>
      <div class="step-icon">🔍</div>
      <div class="step-t">We search 5 platforms</div>
      <div class="step-d">LinkedIn, Naukri, JSearch, Adzuna, iimjobs — every morning. Each role scored against your exact profile by our AI function-matching engine.</div>
    </div>
    <div class="step">
      <div class="step-accent" style="background:linear-gradient(90deg,var(--green),transparent)"></div>
      <div class="step-num" style="color:var(--green)">
        <div class="step-num-badge" style="background:var(--green)">03</div>
        Deliver
      </div>
      <div class="step-icon">📬</div>
      <div class="step-t">Open one email</div>
      <div class="step-d">Up to 15 ranked matches with fit scores, reasoning, salary ranges, and direct apply links. Nothing repeated. Nothing irrelevant.</div>
    </div>
  </div>
</div>

<!-- PRICING -->
<div class="pricing-section" id="pricing">
<div class="pricing-in">
  <div class="sec-kicker" style="justify-content:center">Pricing</div>
  <h2 class="sec-title">Simple. Honest.<br>No surprises.</h2>
  <p class="sec-sub" style="margin:0 auto">Free works forever. Pro covers our running costs and unlocks daily delivery.</p>
  <div class="plans">
    <div class="plan">
      <div class="plan-n">Free</div>
      <div class="plan-price">₹0<span class="plan-per"> /forever</span></div>
      <div class="plan-desc">No card. No commitment.</div>
      <ul class="plan-feats">
        <li><span class="ck">✓</span>2 curated digests per week</li>
        <li><span class="ck">✓</span>Up to 5 matches per email</li>
        <li><span class="ck">✓</span>Core AI matching engine</li>
        <li><span class="ck">✓</span>Unsubscribe anytime</li>
      </ul>
      <a href="/signup" class="btn-free">Start free →</a>
    </div>
    <div class="plan plan-pro">
      <div class="plan-pro-shimmer"></div>
      <div class="plan-tag">★ FOUNDING RATE</div>
      <div class="plan-n" style="color:var(--violet)">Pro</div>
      <div class="plan-price"><span class="plan-price-pro">₹49</span><span class="plan-per"> /month</span></div>
      <div class="plan-desc">or ₹499/year · rate locked in for life</div>
      <ul class="plan-feats">
        <li><span class="ck">✓</span>Daily matches at 9am IST</li>
        <li><span class="ck">✓</span>Up to 15 matches per email</li>
        <li><span class="ck">✓</span>Full LinkedIn + Naukri search</li>
        <li><span class="ck">✓</span>Dashboard + apply history</li>
        <li><span class="ck">✓</span>Priority email support</li>
      </ul>
      <a href="/signup" class="btn-pro">Become a founding member →</a>
      <p style="font-size:11.5px;color:var(--ink4);text-align:center;margin-top:10px">₹149/month after spots fill</p>
    </div>
  </div>
  <div class="trust-note">
    <div class="tn-icon">🤝</div>
    <div><div class="tn-t">We never charge you to apply for jobs</div><div class="tn-d">Every job is free to apply on the original platform. Our only revenue is the optional Pro subscription — and only if you find it worth it.</div></div>
  </div>
</div>
</div>

<!-- FAQ -->
<div class="faq-section">
  <div class="sec-kicker" style="justify-content:center">FAQ</div>
  <h2 class="sec-title">Common questions</h2>
  <div class="faq-wrap">
    ${[
      ['Do you charge employers or take placement fees?', 'No. Zero relationship with employers. We do not get paid when you get hired. Our only revenue is the optional Pro subscription from job seekers.'],
      ['Where do the jobs come from?', 'LinkedIn, Naukri, iimjobs, JSearch (Google for Jobs), and Adzuna. All public listings. We save you the 2 hours of daily searching.'],
      ['Is my resume safe?', 'Stored privately, used only to score relevance for you. Never sold or shared. Delete anytime — we wipe everything within 24 hours.'],
      ['How is this different from Naukri or LinkedIn?', 'Those show every keyword-matching job. We score each role against your specific profile — function, seniority, domain, location — and send only what is genuinely relevant.'],
      ['Can I cancel Pro anytime?', 'Yes. Email hello@jobmatchai.co.in — processed within 12 hours. One-time payment links, not auto-renewal.'],
    ].map(([q,a])=>`<div class="fi" onclick="tf(this)"><div class="fq"><span>${q}</span><span class="fi-ic">+</span></div><div class="fa">${a}</div></div>`).join('')}
  </div>
</div>

<!-- FOOTER -->
<footer>
<div class="ft-in">
  <div class="ft-top">
    <div class="ft-brand">
      <div class="ft-logo">
        <div class="ft-lm"><svg viewBox="0 0 16 16"><path d="M8 2L2 6v8h4v-4h4v4h4V6L8 2z"/></svg></div>
        <span class="ft-brand-name">JobMatch AI</span>
      </div>
      <div class="ft-tagline">Curated daily job matches for India 🇮🇳</div>
    </div>
    <div class="ft-cols">
      <div>
        <div class="ft-col-t">Product</div>
        <a href="#how" class="ft-link">How it works</a>
        <a href="#pricing" class="ft-link">Pricing</a>
        <a href="/signup" class="ft-link">Sign up free</a>
      </div>
      <div>
        <div class="ft-col-t">Company</div>
        <a href="/terms" class="ft-link">Terms & Privacy</a>
        <a href="mailto:hello@jobmatchai.co.in" class="ft-link">Contact</a>
      </div>
    </div>
  </div>
  <div class="ft-bottom">
    <div class="ft-copy">© 2026 JobMatch AI · Built with Claude</div>
    <div class="ft-copy">₹0 charged to apply for jobs, ever</div>
  </div>
</div>
</footer>

<script>
fetch('/count').then(r=>r.json()).then(d=>{
  const n=d.count||59;
  ['lc','su'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent=n.toLocaleString('en-IN');});
}).catch(()=>{});
function tf(el){const o=el.classList.contains('o');document.querySelectorAll('.fi').forEach(f=>f.classList.remove('o'));if(!o)el.classList.add('o');}
const lc=document.getElementById('lc');
if(lc){let c=Math.max(parseInt(lc.textContent)-10,1),t=parseInt(lc.textContent);const tmr=setInterval(()=>{c++;lc.textContent=c.toLocaleString('en-IN');if(c>=t)clearInterval(tmr);},80);}
</script>
</body></html>`);
});
// /terms — minimal terms page
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// /welcome — Post-payment landing for new Pro members
// ═══════════════════════════════════════════════════════════════════
// Razorpay Payment Page redirects users here after successful payment.
// We don't activate Pro from this page — that requires merchant verification.
// activate-pro.js (run by you after Razorpay confirms) does the real work.
// This page just shows confirmation + sets expectations.
// ═══════════════════════════════════════════════════════════════════
// /webhook/razorpay — Auto-activates Pro on payment confirmation
// ═══════════════════════════════════════════════════════════════════
// CRITICAL: this endpoint handles real money. It must:
//   1. Verify Razorpay's signature (no spoofed payments)
//   2. Be idempotent (Razorpay retries if we don't 200 in 5s)
//   3. Always 200 OK to Razorpay (otherwise they keep retrying)
//   4. Log every event for audit trail
//   5. Match payment.amount to plan (49 = monthly, 499 = annual)
//
// SETUP (one-time):
//   1. Razorpay Dashboard → Settings → Webhooks → Add New Webhook
//   2. URL: https://jobmatchai.co.in/webhook/razorpay
//   3. Active events: payment.captured, payment.failed, refund.processed
//   4. Secret: generate strong random string, paste into RAZORPAY_WEBHOOK_SECRET env var
//   5. Save and test with "Send Test Webhook" button
// ═══════════════════════════════════════════════════════════════════

const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

// Razorpay sends raw body — we need it as-is for signature verification
// Capture raw body BEFORE express.json() parses it
app.post('/webhook/razorpay', async (req, res) => {
    try {
        const sig = req.headers['x-razorpay-signature'];
        const rawBody = req.rawBody; // captured by verify callback in express.json()

        // Always respond 200 first — Razorpay retries if we timeout
        // We verify AFTER responding so a slow Airtable call doesn't cause retries
        if (!rawBody) {
            console.error('Webhook: no rawBody — express.json verify callback may not be running');
            return res.status(200).json({ received: true, error: 'no_raw_body' });
        }

        // Verify signature
        if (!RAZORPAY_WEBHOOK_SECRET) {
            console.error('Webhook: RAZORPAY_WEBHOOK_SECRET not set — skipping verification');
            res.status(200).json({ received: true });
        } else if (!sig) {
            console.warn('Webhook: missing signature header');
            res.status(200).json({ received: true, error: 'no_sig' });
        } else {
            const expectedSig = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
                .update(rawBody).digest('hex');
            if (sig !== expectedSig) {
                console.warn(`Webhook: invalid signature`);
                return res.status(400).send('Invalid signature');
            }
            // Signature valid — respond 200 immediately
            res.status(200).json({ received: true });
        }

        // Parse event
        let event;
        try {
            event = JSON.parse(rawBody.toString());
        } catch (e) {
            console.error('Webhook: invalid JSON', e.message);
            return;
        }

        const eventType = event.event;
        console.log(`Webhook received: ${eventType} (id: ${event?.payload?.payment?.entity?.id || event?.payload?.refund?.entity?.id || 'n/a'})`);

        // Process async — errors here don't affect the 200 already sent
        if (eventType === 'payment.captured') {
            await handlePaymentCaptured(event.payload.payment.entity);
        } else if (eventType === 'payment.failed') {
            await handlePaymentFailed(event.payload.payment.entity);
        } else if (eventType === 'refund.processed' || eventType === 'refund.created') {
            await handleRefund(event.payload.refund.entity, event.payload.payment?.entity);
        } else {
            console.log(`Webhook: ignoring event type ${eventType}`);
        }

    } catch (err) {
        console.error('Webhook top-level error:', err.message, err.stack?.split('\n')[1] || '');
        // Ensure we always respond even on catastrophic error
        if (!res.headersSent) res.status(200).json({ received: true, error: 'internal' });
    }
});

// ─── Handler: payment.captured ────────────────────────────────────
// Triggered when payment succeeds. This is the activation path.
async function handlePaymentCaptured(payment) {
    const email = (payment.email || payment.notes?.customer_email || '').toLowerCase().trim();
    const amountRupees = Math.round(payment.amount / 100); // Razorpay sends paise
    const paymentId = payment.id;

    if (!email) {
        console.error(`Webhook: payment ${paymentId} has no email — cannot activate`);
        return;
    }

    // Detect plan from amount — extend this map if you add tiers
    let plan, days;
    if (amountRupees === 49)       { plan = 'monthly'; days = 30; }
    else if (amountRupees === 499) { plan = 'annual';  days = 365; }
    else if (amountRupees === 99)  { plan = 'monthly'; days = 30; }  // future tier
    else if (amountRupees === 999) { plan = 'annual';  days = 365; } // future tier
    else {
        console.warn(`Webhook: payment ${paymentId} amount ₹${amountRupees} doesn't match known plan — defaulting to 30d monthly`);
        plan = 'monthly'; days = 30;
    }

    // Idempotency check — has this payment already been processed?
    const existing = await findUserRecord(email);
    if (!existing) {
        console.error(`Webhook: payment ${paymentId} from ${email} but no Airtable user — creating partial record`);
        // Auto-create stub record so payment isn't lost; user can complete profile later
        await fetch(`https://api.airtable.com/v0/${AT_BASE}/${USERS_TABLE}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields: {
                    Email: email,
                    Name: payment.notes?.name || email.split('@')[0],
                    Phone: payment.contact || '',
                    Status: 'Active',
                    PaidStatus: 'pro',
                    PaidUntil: addDays(new Date(), days).toISOString().split('T')[0],
                    LastPaymentAmount: amountRupees,
                    LastPaymentDate: new Date().toISOString(),
                    LastPaymentId: paymentId,
                    Notes: 'Stub record from webhook — needs profile completion'
                }
            })
        });
        await sendWelcomeEmail(email, payment.notes?.name || email.split('@')[0], plan, amountRupees, days, true);
        return;
    }

    // Idempotency: skip if same paymentId already recorded
    if (existing.fields?.['LastPaymentId'] === paymentId) {
        console.log(`Webhook: payment ${paymentId} already processed for ${email} — skipping`);
        return;
    }

    // Activate Pro
    const newExpiry = addDays(new Date(), days).toISOString().split('T')[0];
    const patchResp = await fetch(`https://api.airtable.com/v0/${AT_BASE}/${USERS_TABLE}/${existing.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            fields: {
                PaidStatus: 'pro',
                PaidUntil: newExpiry,
                LastPaymentAmount: amountRupees,
                LastPaymentDate: new Date().toISOString(),
                LastPaymentId: paymentId,
                RenewalReminderSent: '',
                Status: 'Active',
                LastEngagement: new Date().toISOString(),
            }
        })
    });

    if (!patchResp.ok) {
        const errBody = await patchResp.json().catch(() => ({}));
        console.error(`❌ Airtable PATCH failed for ${email}: ${patchResp.status} ${JSON.stringify(errBody)}`);
        // Don't return — still send welcome email so user isn't left hanging
    } else {
        console.log(`✅ Activated Pro for ${email} (${plan}, ₹${amountRupees}, valid until ${newExpiry})`);
    }

    // Send welcome email
    await sendWelcomeEmail(email, existing.fields?.Name || email.split('@')[0], plan, amountRupees, days, false);

    // Log to webhook audit table (non-blocking)
    logWebhookEvent('payment.captured', email, paymentId, amountRupees).catch(()=>{});
}

// ─── Handler: payment.failed ──────────────────────────────────────
async function handlePaymentFailed(payment) {
    const email = (payment.email || '').toLowerCase().trim();
    const reason = payment.error_description || 'Unknown';
    console.warn(`Payment failed: ${email} - ${reason} (${payment.id})`);
    logWebhookEvent('payment.failed', email, payment.id, payment.amount/100, reason).catch(()=>{});
    // Don't email user — Razorpay shows them the failure inline
}

// ─── Handler: refund ──────────────────────────────────────────────
async function handleRefund(refund, payment) {
    const email = (payment?.email || refund.notes?.customer_email || '').toLowerCase().trim();
    if (!email) return;
    const rec = await findUserRecord(email);
    if (!rec) return;

    // Downgrade to free, log refund
    await fetch(`https://api.airtable.com/v0/${AT_BASE}/${USERS_TABLE}/${rec.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            fields: {
                PaidStatus: 'churned',
                Notes: `Refunded ₹${refund.amount/100} on ${new Date().toISOString().split('T')[0]} (refund_id: ${refund.id})`
            }
        })
    });
    console.log(`Refund processed: ${email} ₹${refund.amount/100}`);
    logWebhookEvent('refund', email, refund.id, refund.amount/100).catch(()=>{});
}

// ─── Welcome email — designed, mobile-friendly ────────────────────
async function sendWelcomeEmail(email, name, plan, amount, days, isStubRecord = false) {
    if (!BREVO_KEY) return;

    const expiryDate = addDays(new Date(), days).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'long', year: 'numeric'
    });

    const stubNote = isStubRecord
        ? `<div style="background:#fff8e1;border:1px solid #fde68a;border-radius:10px;padding:14px;margin-bottom:18px;font-size:13px;color:#92600A;line-height:1.6">
            <strong>One quick step:</strong> we don't have your resume yet. Please <a href="https://jobmatchai.co.in/signup" style="color:#0055FF;font-weight:600">complete your profile here</a> so we can start matching jobs for you tomorrow.
          </div>`
        : '';

    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:540px;margin:0 auto;padding:24px;background:#f8fafc">
<div style="background:linear-gradient(135deg,#0055FF 0%,#7c3aed 100%);border-radius:14px 14px 0 0;padding:24px 28px">
  <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-.02em">Welcome to JobMatch Pro 🎉</div>
  <div style="font-size:13px;color:rgba(255,255,255,.85);margin-top:6px">Founding member · ${plan === 'annual' ? 'Annual' : 'Monthly'} · Activated</div>
</div>
<div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 14px 14px;padding:26px 28px">
  <p style="font-size:16px;font-weight:700;color:#111;margin:0 0 14px">Hi ${name},</p>
  <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 18px">
    Thank you for becoming a founding member. Your Pro subscription is active. Your first daily Pro digest lands in your inbox tomorrow at 9am IST.
  </p>

  ${stubNote}

  <div style="background:#f0f5ff;border:1px solid #c7d7ff;border-radius:10px;padding:18px;margin-bottom:20px">
    <div style="font-size:11px;color:#0055FF;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Your subscription</div>
    <div style="font-size:13px;color:#374151;line-height:2">
      Plan: <strong>Pro ${plan === 'annual' ? 'Annual' : 'Monthly'}</strong><br>
      Amount paid: <strong>₹${amount}</strong><br>
      Active until: <strong>${expiryDate}</strong>
    </div>
  </div>

  <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em">What changes for you</div>
  <div style="font-size:13px;color:#374151;line-height:1.9;margin-bottom:18px">
    ✓ Daily curated matches at 9am IST (was 2x/week)<br>
    ✓ Up to 15 matches per email (was 5)<br>
    ✓ Full search across LinkedIn, Naukri, JSearch, Adzuna, iimjobs<br>
    ✓ Complete dashboard with apply history<br>
    ✓ Priority email support — replies within 12 hours
  </div>

  <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em">Coming soon (free for founding members)</div>
  <div style="font-size:13px;color:#6b7280;line-height:1.9;margin-bottom:22px;font-style:italic">
    · WhatsApp daily digest at 9am IST<br>
    · ATS resume optimiser (paste a JD, get keyword gaps)<br>
    · Expanded hiring contact directory
  </div>

  <a href="https://jobmatchai.co.in/dashboard?email=${encodeURIComponent(email)}&token=${makeUnsubToken(email)}" style="display:block;text-align:center;background:#0055FF;color:#fff;padding:13px;border-radius:9px;text-decoration:none;font-size:14px;font-weight:700;margin-bottom:16px">View your dashboard →</a>

  <p style="font-size:13px;color:#6b7280;line-height:1.6;margin:0 0 8px">
    A heads-up about renewals: we use one-time payment links (not auto-charge), so you'll never see surprise bills. We'll email you 5 days before expiry to renew with one click.
  </p>
  <p style="font-size:13px;color:#6b7280;margin:14px 0 0">
    Reply to this email anytime — I read every message and respond personally.
  </p>
</div>
</div>`;

    try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sender: { name: 'JobMatch AI', email: BREVO_FROM_EMAIL },
                to: [{ email, name }],
                subject: `Welcome to JobMatch Pro 🎉 — your founding member access is live`,
                htmlContent: html
            })
        });
        console.log(`Welcome email sent to ${email}`);
    } catch (e) {
        console.error('Welcome email failed:', e.message);
    }
}

// ─── Audit logger — writes to optional WebhookEvents Airtable table ───────
async function logWebhookEvent(type, email, paymentId, amount, error = '') {
    try {
        await fetch(`https://api.airtable.com/v0/${AT_BASE}/WebhookEvents`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields: {
                    EventType: type,
                    Email: email,
                    PaymentId: paymentId,
                    Amount: amount,
                    Error: error,
                    ReceivedAt: new Date().toISOString()
                }
            })
        });
    } catch (e) {
        // Silent — audit log failure shouldn't block payment processing
    }
}

// ─── Date helper ──────────────────────────────────────────────────
function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

// ═══════════════════════════════════════════════════════════════════
// /apply-status — Update job application status from dashboard
// ═══════════════════════════════════════════════════════════════════
// Called by client-side cycleStatus() JS — no auth token needed
// because recordId is an opaque Airtable ID, not guessable
// Status cycle: Applied → Heard back → Interviewing → Offered → (Rejected via long-press)
app.post('/apply-status', async (req, res) => {
    const { recordId, status, email } = req.body;
    const VALID = ['Applied', 'Heard back', 'Interviewing', 'Offered', 'Rejected'];
    if (!recordId || !VALID.includes(status)) {
        return res.status(400).json({ error: 'Invalid request' });
    }
    try {
        const r = await fetch(`https://api.airtable.com/v0/${AT_BASE}/${CLICKS_TABLE}/${recordId}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: { ApplyStatus: status } })
        });
        if (!r.ok) {
            const err = await r.json().catch(()=>({}));
            console.error(`apply-status PATCH failed: ${r.status}`, err);
            return res.status(500).json({ error: 'Airtable update failed' });
        }
        console.log(`Apply status: ${email} → ${status} (${recordId.slice(-6)})`);
        res.json({ ok: true, status });
    } catch (e) {
        console.error('apply-status error:', e.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.get('/welcome', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome to JobMatch Pro 🎉</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,sans-serif;background:#f1f5f9;color:#0f172a;line-height:1.6;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{max-width:520px;width:100%;background:#fff;border-radius:18px;padding:40px 32px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.06);border:1px solid #e5e7eb}
  .check{width:72px;height:72px;background:linear-gradient(135deg,#10b981 0%,#059669 100%);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:18px;font-size:36px;color:#fff;box-shadow:0 8px 24px rgba(16,185,129,.3)}
  h1{font-size:28px;font-weight:800;letter-spacing:-.02em;margin-bottom:10px}
  .sub{font-size:15px;color:#64748b;margin-bottom:28px;line-height:1.6}
  .info{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:18px;text-align:left;margin-bottom:24px}
  .info-title{font-size:11px;font-weight:700;color:#0055FF;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px}
  .step{display:flex;gap:12px;margin-bottom:14px;align-items:flex-start}
  .step:last-child{margin-bottom:0}
  .step-num{flex-shrink:0;width:24px;height:24px;background:#0055FF;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}
  .step-text{font-size:13px;color:#374151;line-height:1.5}
  .step-text strong{color:#0f172a}
  .cta{display:block;background:#0055FF;color:#fff;padding:13px;border-radius:9px;text-decoration:none;font-size:14px;font-weight:700;margin-bottom:12px}
  .micro{font-size:12px;color:#94a3b8;margin-top:18px;line-height:1.6}
  .micro a{color:#0055FF;text-decoration:none}
</style></head>
<body>
<div class="card">
  <div class="check">✓</div>
  <h1>Payment received! 🎉</h1>
  <p class="sub">Thank you for becoming a JobMatch Pro founding member. Your subscription is being activated.</p>

  <div class="info">
    <div class="info-title">What happens next</div>
    <div class="step">
      <div class="step-num">1</div>
      <div class="step-text"><strong>Within 2 hours:</strong> Your account upgrades to Pro and you'll receive a personal welcome email confirming activation.</div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-text"><strong>Tomorrow morning at 9am IST:</strong> Your first daily Pro digest lands in your inbox with up to 15 ranked matches.</div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-text"><strong>Coming soon:</strong> WhatsApp alerts, ATS resume optimiser, and hiring contact directory — all free for founding members.</div>
    </div>
  </div>

  <a href="https://jobmatchai.co.in" class="cta">Back to JobMatch AI →</a>

  <p class="micro">Questions? Reply to your welcome email or write to <a href="mailto:hello@jobmatchai.co.in">hello@jobmatchai.co.in</a>. We read every message.</p>
</div>
</body></html>`);
});

app.get('/terms', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terms · JobMatch AI</title></head>
<body style="font-family:system-ui;max-width:680px;margin:0 auto;padding:40px 20px;color:#334155;line-height:1.7">
<a href="/" style="color:#0055FF;text-decoration:none;font-size:13px">← Back</a>
<h1 style="margin-top:20px">Terms & Privacy</h1>
<p><strong>What we collect:</strong> Your name, email, phone, city preference, and the resume you upload. Nothing else.</p>
<p><strong>How we use it:</strong> Solely to match you with relevant jobs and send you daily digests. We do not sell, rent, or share your data with third parties.</p>
<p><strong>Resume storage:</strong> Stored encrypted on our private servers. Used only by our matching engine. Deleted within 24 hours of account deletion.</p>
<p><strong>Job listings:</strong> Aggregated from public sources (LinkedIn, Naukri, JSearch, Adzuna, iimjobs). We do not endorse any employer.</p>
<p><strong>Payments:</strong> Optional Pro subscription processed via Razorpay. We never store card details. Refunds within 7 days, no questions asked.</p>
<p><strong>Cancellation:</strong> Email <a href="mailto:hello@jobmatchai.co.in">hello@jobmatchai.co.in</a> to cancel anytime. Account deletion within 24 hours of request.</p>
<p style="margin-top:30px;font-size:13px;color:#94a3b8">Last updated: ${new Date().toLocaleDateString('en-IN', {day:'numeric', month:'long', year:'numeric'})}. Questions? <a href="mailto:hello@jobmatchai.co.in" style="color:#0055FF">hello@jobmatchai.co.in</a></p>
</body></html>`);
});

// ─── Boot ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 JobMatch server live on :${PORT}`);
    console.log(`   AT_BASE=${AT_BASE ? '✓' : '✗'} | APIFY=${APIFY_TOKEN ? '✓' : '✗'} | BREVO=${BREVO_KEY ? '✓' : '✗'} | CLAUDE=${ANTHROPIC_KEY ? '✓' : '✗'}`);
});
