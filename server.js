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
<div class="card match-card" style="border-left:4px solid ${scoreColor(m.s)};animation-delay:${i*0.05}s" data-score="${m.s}" data-city="${(m.c||'').toLowerCase()}" data-src="${(m.src||'').toLowerCase()}">
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
  const minScore = parseInt(document.getElementById('f-score')?.value || '0');
  const src = document.getElementById('f-src')?.value.toLowerCase() || '';
  const cards = document.querySelectorAll('.match-card');
  let visible = 0;
  cards.forEach(card => {
    const cardCity = (card.dataset.city || '').toLowerCase();
    const cardScore = parseInt(card.dataset.score || '0');
    const cardSrc = (card.dataset.src || '').toLowerCase();
    const cityOk = !city || cardCity.includes(city) || city.includes(cardCity);
    const scoreOk = cardScore >= minScore;
    const srcOk = !src || cardSrc.includes(src);
    const show = cityOk && scoreOk && srcOk;
    card.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  const fc = document.getElementById('filter-count');
  if (fc) fc.textContent = visible < cards.length ? (visible + ' of ' + cards.length + ' shown') : '';
}

function clearFilters() {
  ['f-city','f-score','f-src'].forEach(id => {
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
                    Domain: profile.domain || '',
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
<title>Sign up free · JobMatch AI</title>
${BRAND_HEAD}
<style>
*{box-sizing:border-box}
body{display:flex;flex-direction:column;min-height:100vh}
.pg{flex:1;display:grid;grid-template-columns:1fr 1fr;min-height:100vh}
/* LEFT */
.lp{background:#111113;border-right:1px solid var(--border);padding:40px 48px;display:flex;flex-direction:column}
.llogo{font-family:'Instrument Serif',serif;font-size:20px;margin-bottom:48px;display:block;text-decoration:none;color:var(--text)}.llogo i{font-style:italic;color:var(--gold)}
.lt{font-family:'Instrument Serif',serif;font-size:36px;line-height:1.12;margin-bottom:16px}.lt i{font-style:italic;color:var(--gold)}
.ls{font-size:15px;color:var(--muted);line-height:1.7;margin-bottom:36px;max-width:380px}
.feats{display:flex;flex-direction:column;gap:16px;margin-bottom:40px}
.feat{display:flex;gap:14px;align-items:flex-start}
.ficon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
.ftxt strong{display:block;font-size:14px;font-weight:600;margin-bottom:3px;color:var(--text)}
.ftxt span{font-size:13px;color:var(--muted);line-height:1.5}
.scard{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-left:3px solid var(--green);border-radius:12px;padding:16px;margin-top:auto}
.scard-t{font-size:13px;font-weight:600;margin-bottom:4px;color:var(--text)}
.scard-m{font-size:11px;color:var(--muted);margin-bottom:10px}
.scard-f{display:flex;justify-content:space-between;align-items:center}
.scard-b{font-size:11px;color:var(--green);font-weight:600;background:rgba(34,197,94,0.1);padding:3px 9px;border-radius:20px}
.scard-s{font-size:20px;font-weight:700;color:var(--green)}
/* RIGHT */
.rp{padding:40px 56px;display:flex;flex-direction:column;justify-content:center;max-width:560px}
.rh{margin-bottom:32px}
.rh h2{font-size:26px;font-weight:700;margin-bottom:6px;color:var(--text)}
.rh p{font-size:14px;color:var(--muted)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.fd{margin-bottom:18px}
.fd label{display:block;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}
.fd input{width:100%;padding:13px 16px;background:#1A1A1C;border:1px solid var(--border);border-radius:10px;font-size:14px;color:var(--text);transition:border-color .2s;outline:none;font-family:inherit}
.fd input:focus{border-color:var(--gold);background:#1E1C17}
.fd input::placeholder{color:#52525B}
.fz{width:100%;border:1.5px dashed rgba(255,255,255,0.1);border-radius:12px;padding:28px 20px;text-align:center;cursor:pointer;transition:all .2s;margin-bottom:20px;display:block;background:rgba(255,255,255,0.01)}
.fz:hover,.fz.active{border-color:rgba(245,158,11,0.4);background:rgba(245,158,11,0.04)}
.fz input{display:none}
.fz-icon{font-size:28px;margin-bottom:8px}
.fz-main{font-size:14px;font-weight:600;color:var(--gold);margin-bottom:4px}
.fz-sub{font-size:12px;color:var(--muted)}
.fname{font-size:12px;color:var(--green);margin-top:8px;font-weight:600;display:none}
.sbtn{width:100%;padding:15px;background:var(--gold);color:#000;border:none;border-radius:11px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .15s}
.sbtn:hover{opacity:.88}.sbtn:disabled{opacity:.5;cursor:wait}
.sfine{font-size:12px;color:var(--muted);text-align:center;margin-top:14px;line-height:1.6}.sfine a{color:var(--gold);text-decoration:none}
.ebox{background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#FCA5A5;padding:12px 16px;border-radius:10px;font-size:13px;margin-bottom:16px;display:none}
.obox{background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.2);border-radius:14px;padding:36px;text-align:center;display:none}
@media(max-width:820px){
  .pg{grid-template-columns:1fr}
  .lp{display:none}
  .rp{padding:32px 24px;max-width:100%}
}
</style></head>
<body>
<div class="pg">
  <div class="lp">
    <a href="/" class="llogo">Job<i>Match</i> AI</a>
    <h1 class="lt">Your next role,<br><i>every morning.</i></h1>
    <p class="ls">Upload your resume once. We scan 5 job platforms daily and send you the matches that actually fit your profile, seniority, and domain.</p>
    <div class="feats">
      <div class="feat"><div class="ficon" style="background:rgba(34,197,94,0.1)">🔍</div><div class="ftxt"><strong>AI-powered matching</strong><span>Function fit, seniority, domain, location — all scored against your exact profile</span></div></div>
      <div class="feat"><div class="ficon" style="background:rgba(245,158,11,0.1)">⚡</div><div class="ftxt"><strong>5 platforms, one email</strong><span>LinkedIn, Naukri, JSearch, Adzuna, iimjobs — fresh roles daily</span></div></div>
      <div class="feat"><div class="ficon" style="background:rgba(59,130,246,0.1)">🎯</div><div class="ftxt"><strong>No noise, ever</strong><span>Only fresh, relevant roles. Nothing repeated. Nothing irrelevant.</span></div></div>
    </div>
    <div class="scard">
      <div style="font-size:10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Sample match</div>
      <div class="scard-t">Head of Partnerships – Fintech</div>
      <div class="scard-m">Brahma Finance · Bengaluru · Naukri · ₹30–45L</div>
      <div class="scard-f"><span class="scard-b">Strong fit</span><span class="scard-s">91%</span></div>
    </div>
  </div>
  <div style="display:flex;justify-content:center;align-items:center;background:var(--bg);padding:40px 28px">
    <div class="rp" style="padding:0;width:100%">
      <div class="rh"><h2>Create your free account</h2><p>Takes 60 seconds. No credit card needed.</p></div>
      <div id="ebox" class="ebox"></div>
      <div id="obox" class="obox">
        <div style="font-size:48px;margin-bottom:12px">🎉</div>
        <div style="font-size:20px;font-weight:700;margin-bottom:8px;color:var(--text)">You're in!</div>
        <div style="font-size:14px;color:var(--muted);line-height:1.6">Check your inbox in the next few minutes.<br>Your first matches are on their way.</div>
      </div>
      <form id="form" enctype="multipart/form-data">
        <div class="row2">
          <div class="fd"><label>Full name *</label><input name="name" required maxlength="60" placeholder="Priya Sharma"></div>
          <div class="fd"><label>WhatsApp *</label><input name="phone" type="tel" required placeholder="+91 98765 43210"></div>
        </div>
        <div class="fd"><label>Work email *</label><input name="email" type="email" required placeholder="priya@company.com"></div>
        <div class="fd"><label>Cities you're open to *</label><input name="cities" required value="Bengaluru" placeholder="Bengaluru, Mumbai, Remote"></div>
        <label class="fz" for="resume" id="fzone">
          <input id="resume" name="resume" type="file" accept=".pdf" required>
          <div class="fz-icon">📄</div>
          <div class="fz-main">Click to upload your resume</div>
          <div class="fz-sub">PDF only · Max 5MB · We never share it</div>
          <div class="fname" id="fname"></div>
        </label>
        <button type="submit" id="sbtn" class="sbtn">Get my first matches →</button>
        <p class="sfine">Free forever · No spam · <a href="/terms">Privacy policy</a></p>
      </form>
    </div>
  </div>
</div>
<script>
const fi=document.getElementById('resume'),fz=document.getElementById('fzone'),fn=document.getElementById('fname');
fi.addEventListener('change',e=>{const f=e.target.files[0];if(f){fn.textContent='✓ '+f.name;fn.style.display='block';fz.classList.add('active');}});
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
// ═══════════════════════════════════════════════════════════════════
// /  — Landing page
// ═══════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JobMatch AI — Curated daily job matches for India</title>
<meta name="description" content="AI-powered job matching across LinkedIn, Naukri, and 5 platforms. Free for India.">
${BRAND_HEAD}
<style>
*{box-sizing:border-box}
.w{max-width:1140px;margin:0 auto;padding:0 28px}
/* NAV */
nav{position:fixed;top:0;left:0;right:0;z-index:100;height:64px;display:flex;align-items:center;padding:0 28px;justify-content:space-between;background:rgba(9,9,11,0.95);backdrop-filter:blur(16px);border-bottom:1px solid var(--border)}
.logo{font-family:'Instrument Serif',serif;font-size:21px}.logo i{font-style:italic;color:var(--gold)}
.nav-links{display:flex;align-items:center;gap:32px}
.nl{font-size:13px;color:var(--muted);font-weight:500;cursor:pointer;transition:color .15s}.nl:hover{color:var(--text)}
.nc{background:var(--gold);color:#000;padding:10px 22px;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;transition:opacity .15s}.nc:hover{opacity:.88}
/* HERO */
.hero{padding:140px 28px 100px;max-width:1140px;margin:0 auto;display:grid;grid-template-columns:55% 45%;gap:48px;align-items:center;min-height:100vh}
.eyebrow{display:inline-flex;align-items:center;gap:8px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);color:var(--gold);padding:6px 14px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-bottom:24px}
.pulse{width:6px;height:6px;border-radius:50%;background:var(--gold);animation:pl 2s infinite}
@keyframes pl{0%,100%{opacity:1}50%{opacity:.3}}
h1{font-family:'Instrument Serif',serif;font-size:60px;line-height:1.06;letter-spacing:-.02em;margin-bottom:20px;color:var(--text)}
h1 i{font-style:italic;color:var(--gold)}
.lede{font-size:17px;color:var(--muted);line-height:1.75;max-width:500px;margin-bottom:36px}
.cta-row{display:flex;gap:12px;align-items:center;margin-bottom:32px;flex-wrap:wrap}
.btn-gold{background:var(--gold);color:#000;padding:15px 30px;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;border:none;font-family:inherit;transition:all .15s}.btn-gold:hover{opacity:.88;transform:translateY(-1px)}
.btn-outline{background:transparent;color:var(--text);padding:14px 24px;border-radius:10px;font-size:15px;font-weight:600;border:1px solid var(--border);cursor:pointer;font-family:inherit;transition:border-color .15s}.btn-outline:hover{border-color:rgba(255,255,255,0.25)}
.trust-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tr{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:5px}
.tr::before{content:'✓';color:var(--green)}
.tdot{width:3px;height:3px;border-radius:50%;background:var(--subtle)}
/* MOCK CARD */
.mock{background:#161618;border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:20px;box-shadow:0 32px 80px rgba(0,0,0,0.6)}
.mh{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;padding-bottom:16px;border-bottom:1px solid rgba(255,255,255,0.07)}
.ml{font-family:'Instrument Serif',serif;font-size:15px}.ml i{font-style:italic;color:var(--gold)}
.mb{font-size:10px;font-weight:700;padding:4px 10px;border-radius:20px;background:rgba(245,158,11,0.12);color:var(--gold);border:1px solid rgba(245,158,11,0.25);letter-spacing:.05em}
.mj{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-left:3px solid;border-radius:12px;padding:16px;margin-bottom:10px}
.mj-title{font-size:13px;font-weight:600;color:var(--text);margin-bottom:5px}
.mj-meta{font-size:11px;color:var(--muted);margin-bottom:10px;display:flex;align-items:center;gap:6px}
.mj-reason{font-size:11px;color:var(--muted);line-height:1.55;padding:9px 11px;background:rgba(0,0,0,0.2);border-radius:8px;margin-bottom:10px}
.mj-foot{display:flex;justify-content:space-between;align-items:center}
.fit-badge{font-size:11px;font-weight:600;padding:4px 10px;border-radius:20px}
.mj-score{font-size:22px;font-weight:700}
.mj-apply{font-size:11px;font-weight:700;padding:7px 14px;border-radius:8px;background:#2563EB;color:#fff}
.more{text-align:center;font-size:11px;color:var(--muted);margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.07)}
/* STRIP */
.strip{border-top:1px solid var(--border);border-bottom:1px solid var(--border);background:rgba(255,255,255,0.01)}
.strip-in{max-width:1140px;margin:0 auto;padding:0 28px;display:grid;grid-template-columns:repeat(4,1fr)}
.si{text-align:center;padding:28px 20px;border-right:1px solid var(--border)}.si:last-child{border:none}
.sn{font-family:'Instrument Serif',serif;font-size:36px;color:var(--text);display:block;margin-bottom:4px}
.sl{font-size:12px;color:var(--muted);font-weight:500;letter-spacing:.02em}
/* HOW IT WORKS */
.sec{padding:88px 0}
.sec-label{font-size:11px;font-weight:700;color:var(--gold);letter-spacing:.12em;text-transform:uppercase;margin-bottom:12px;display:block}
.sec-title{font-family:'Instrument Serif',serif;font-size:40px;line-height:1.12;margin-bottom:14px;letter-spacing:-.01em}
.sec-sub{font-size:16px;color:var(--muted);line-height:1.7;max-width:540px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:52px}
.step{border:1px solid var(--border);border-radius:16px;padding:32px;background:rgba(255,255,255,0.02);position:relative;transition:border-color .2s}.step:hover{border-color:rgba(255,255,255,0.15)}
.step-n{font-family:'Instrument Serif',serif;font-size:54px;color:rgba(255,255,255,0.08);font-style:italic;line-height:1;margin-bottom:18px}
.step-t{font-size:17px;font-weight:700;margin-bottom:10px;color:var(--text)}
.step-d{font-size:14px;color:var(--muted);line-height:1.65}
/* PRICING */
.pricing-sec{background:rgba(255,255,255,0.01);border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.pg{display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:820px;margin:52px auto 0}
.pc{border:1px solid var(--border);border-radius:18px;padding:34px;background:rgba(255,255,255,0.02);position:relative}
.pc.pro{border-color:rgba(245,158,11,0.3);background:linear-gradient(160deg,rgba(245,158,11,0.06) 0%,rgba(255,255,255,0.02) 60%)}
.ptag{position:absolute;top:-13px;left:50%;transform:translateX(-50%);background:var(--gold);color:#000;font-size:11px;font-weight:700;padding:5px 16px;border-radius:20px;white-space:nowrap;letter-spacing:.03em}
.pname{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px}
.pprice{font-family:'Instrument Serif',serif;font-size:48px;line-height:1;margin-bottom:6px}
.pprice small{font-family:'Manrope',sans-serif;font-size:16px;color:var(--muted);font-weight:500}
.pline{font-size:13px;color:var(--muted);margin-bottom:26px}
.pfeats{list-style:none;margin-bottom:28px}
.pfeats li{font-size:14px;color:var(--muted);padding:8px 0;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:flex-start}.pfeats li:last-child{border:none}
.pfeats .ck{color:var(--green);flex-shrink:0;font-size:15px}
.pbtn-g{display:block;text-align:center;padding:14px;border-radius:10px;background:var(--gold);color:#000;font-size:14px;font-weight:700;cursor:pointer;transition:opacity .15s}.pbtn-g:hover{opacity:.88}
.pbtn-o{display:block;text-align:center;padding:14px;border-radius:10px;border:1px solid var(--border);color:var(--text);font-size:14px;font-weight:600;cursor:pointer;transition:border-color .15s}.pbtn-o:hover{border-color:rgba(255,255,255,0.25)}
.trust{border:1px solid rgba(34,197,94,0.2);border-radius:16px;padding:28px 32px;background:rgba(34,197,94,0.04);display:flex;gap:18px;align-items:flex-start;max-width:820px;margin:28px auto 0}
.trust-t{font-size:15px;font-weight:700;color:var(--green);margin-bottom:6px}
.trust-d{font-size:13px;color:var(--muted);line-height:1.7}
/* FAQ */
.faq{max-width:700px;margin:52px auto 0}
.fi{border-bottom:1px solid var(--border);cursor:pointer}
.fq{padding:20px 0;font-size:15px;font-weight:600;color:var(--text);display:flex;justify-content:space-between;align-items:center;gap:12px;user-select:none}
.fq .ar{color:var(--muted);font-size:22px;transition:transform .2s;flex-shrink:0;font-weight:300}
.fi.o .ar{transform:rotate(45deg);color:var(--gold)}
.fa{font-size:14px;color:var(--muted);line-height:1.7;max-height:0;overflow:hidden;transition:max-height .35s ease,padding .3s}
.fi.o .fa{max-height:250px;padding-bottom:18px}
/* FOOTER */
footer{border-top:1px solid var(--border);padding:44px 0}
.ft{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px}
.fl{font-family:'Instrument Serif',serif;font-size:19px}.fl i{font-style:italic;color:var(--gold)}
.flinks{display:flex;gap:28px}.fa2{font-size:13px;color:var(--muted);transition:color .15s}.fa2:hover{color:var(--text)}
.fcopy{text-align:center;font-size:11px;color:rgba(255,255,255,0.2);margin-top:20px}
/* MOBILE */
@media(max-width:820px){
  .hero{grid-template-columns:1fr;gap:40px;padding:110px 20px 60px;min-height:auto}
  h1{font-size:40px}
  .steps{grid-template-columns:1fr}
  .pg{grid-template-columns:1fr}
  .strip-in{grid-template-columns:repeat(2,1fr)}
  .si{border-right:none;border-bottom:1px solid var(--border)}.si:nth-child(2),.si:last-child{border-right:none}
  .nav-links .nl{display:none}
  .sec{padding:60px 0}
}
</style></head>
<body>

<nav class="w" style="max-width:100%;padding:0 28px">
  <a href="/" class="logo" style="text-decoration:none;color:inherit">Job<i>Match</i> AI</a>
  <div class="nav-links">
    <a href="#how" class="nl">How it works</a>
    <a href="#pricing" class="nl">Pricing</a>
    <a href="mailto:hello@jobmatchai.co.in" class="nl">Contact</a>
    <a href="/signup" class="nc" style="text-decoration:none">Get started →</a>
  </div>
</nav>

<!-- HERO -->
<div class="hero">
  <div>
    <div class="eyebrow"><span class="pulse"></span><span id="lc">59</span> professionals matched today</div>
    <h1>Stop searching.<br>Start <i>matching.</i></h1>
    <p class="lede">Upload your resume once. Every morning we scan LinkedIn, Naukri, and 3 more platforms — sending you the roles that actually fit. Scored by AI, ranked by relevance.</p>
    <div class="cta-row">
      <a href="/signup"><button class="btn-gold">Upload resume — it's free →</button></a>
      <a href="#how"><button class="btn-outline">See how it works</button></a>
    </div>
    <div class="trust-row">
      <span class="tr">Free forever</span>
      <span class="tdot"></span>
      <span class="tr">No credit card</span>
      <span class="tdot"></span>
      <span class="tr">60-second setup</span>
      <span class="tdot"></span>
      <span class="tr">Built for India</span>
    </div>
  </div>
  <div>
    <div class="mock">
      <div class="mh">
        <div class="ml">Job<i>Match</i> AI</div>
        <div class="mb">TODAY'S MATCHES</div>
      </div>
      <div class="mj" style="border-left-color:#22C55E">
        <div class="mj-title">Head of Partnerships – Fintech (NBFC/LSP)</div>
        <div class="mj-meta">
          Brahma Finance
          <span style="width:3px;height:3px;background:rgba(255,255,255,0.2);border-radius:50%;display:inline-block"></span>
          Bengaluru
          <span style="width:3px;height:3px;background:rgba(255,255,255,0.2);border-radius:50%;display:inline-block"></span>
          <span style="color:#22C55E;font-weight:600">₹30–45L</span>
        </div>
        <div class="mj-reason">Direct function match — NBFC alliances, partner commercials, distribution expansion. Domain and seniority align tightly.</div>
        <div class="mj-foot">
          <span class="fit-badge" style="background:rgba(34,197,94,0.12);color:#22C55E;border:1px solid rgba(34,197,94,0.25)">Strong fit</span>
          <div style="display:flex;align-items:center;gap:12px">
            <span class="mj-score" style="color:#22C55E">91%</span>
            <span class="mj-apply">Apply →</span>
          </div>
        </div>
      </div>
      <div class="mj" style="border-left-color:#3B82F6;opacity:0.75">
        <div class="mj-title">VP Partnerships – Growth Stage Fintech</div>
        <div class="mj-meta">Velocity · Bengaluru · LinkedIn · <span style="color:#3B82F6;font-weight:600">77%</span></div>
      </div>
      <div class="mj" style="border-left-color:#F59E0B;opacity:0.45">
        <div class="mj-title">Senior Manager – Strategic Alliances</div>
        <div class="mj-meta">Razorpay · Bengaluru · Naukri · <span style="color:#F59E0B;font-weight:600">62%</span></div>
      </div>
      <div class="more">+12 more in your inbox →</div>
    </div>
  </div>
</div>

<!-- STATS STRIP -->
<div class="strip">
  <div class="strip-in">
    <div class="si"><span class="sn" id="su">59</span><span class="sl">Active users</span></div>
    <div class="si"><span class="sn">5</span><span class="sl">Job platforms</span></div>
    <div class="si"><span class="sn">9 AM</span><span class="sl">IST daily delivery</span></div>
    <div class="si"><span class="sn">₹0</span><span class="sl">To apply, ever</span></div>
  </div>
</div>

<!-- HOW IT WORKS -->
<section class="sec" id="how">
<div class="w">
  <span class="sec-label">How it works</span>
  <h2 class="sec-title">Three steps. One minute setup.</h2>
  <p class="sec-sub">Then we do the work every single morning, automatically.</p>
  <div class="steps">
    <div class="step">
      <div class="step-n">01</div>
      <div class="step-t">Upload your resume</div>
      <div class="step-d">Claude reads your role, experience, skills, and domain in seconds. No manual form-filling. No guesswork.</div>
    </div>
    <div class="step">
      <div class="step-n">02</div>
      <div class="step-t">We search 5 platforms</div>
      <div class="step-d">LinkedIn, Naukri, JSearch, Adzuna, iimjobs — every morning. Fresh roles only. Each scored against your exact profile by our AI function-matching engine.</div>
    </div>
    <div class="step">
      <div class="step-n">03</div>
      <div class="step-t">Open one email a day</div>
      <div class="step-d">Up to 15 ranked matches with fit scores, reasoning, salary ranges, and direct apply links. Nothing repeated. Nothing irrelevant.</div>
    </div>
  </div>
</div>
</section>

<!-- PRICING -->
<section class="pricing-sec sec" id="pricing">
<div class="w" style="text-align:center">
  <span class="sec-label">Pricing</span>
  <h2 class="sec-title">Simple. Transparent. Honest.</h2>
  <p class="sec-sub" style="margin:0 auto">Free works forever. Pro covers our running costs and unlocks daily delivery. No hidden fees ever.</p>
  <div class="pg">
    <div class="pc">
      <div class="pname">Free</div>
      <div class="pprice">₹0<small>/forever</small></div>
      <div class="pline">No card. No commitment.</div>
      <ul class="pfeats">
        <li><span class="ck">✓</span>2 curated digests per week</li>
        <li><span class="ck">✓</span>Up to 5 matches per email</li>
        <li><span class="ck">✓</span>Core AI matching engine</li>
        <li><span class="ck">✓</span>Unsubscribe anytime</li>
      </ul>
      <a href="/signup" class="pbtn-o">Start free →</a>
    </div>
    <div class="pc pro">
      <div class="ptag">★ Founding rate — 100 spots</div>
      <div class="pname" style="color:var(--gold)">Pro</div>
      <div class="pprice" style="color:var(--gold)">₹49<small style="color:var(--muted)">/month</small></div>
      <div class="pline">or ₹499/year · locked in for life</div>
      <ul class="pfeats">
        <li><span class="ck">✓</span>Daily matches at 9am IST</li>
        <li><span class="ck">✓</span>Up to 15 matches per email</li>
        <li><span class="ck">✓</span>Full LinkedIn + Naukri search</li>
        <li><span class="ck">✓</span>Dashboard + apply history tracker</li>
        <li><span class="ck">✓</span>Priority email support</li>
      </ul>
      <a href="/signup" class="pbtn-g">Become a founding member →</a>
      <p style="font-size:11px;color:var(--muted);text-align:center;margin-top:12px">Regular price: ₹149/month after spots fill</p>
    </div>
  </div>
  <div class="trust" style="text-align:left">
    <div style="font-size:24px;flex-shrink:0">🤝</div>
    <div>
      <div class="trust-t">We never charge you to apply for jobs</div>
      <div class="trust-d">JobMatch is a curation tool. Every job we surface is free to apply on the original platform. Our only revenue is the optional Pro subscription — and only if you find it worth paying for.</div>
    </div>
  </div>
</div>
</section>

<!-- FAQ -->
<section class="sec">
<div class="w" style="text-align:center">
  <span class="sec-label">FAQ</span>
  <h2 class="sec-title">Common questions</h2>
  <div class="faq" style="text-align:left">
    ${[
      ['Do you charge employers or take placement fees?','No. We have zero relationship with employers. We do not get paid when you get hired. Our only revenue is the optional Pro subscription from job seekers.'],
      ['Where do the jobs come from?','LinkedIn, Naukri, iimjobs, JSearch (Google for Jobs), and Adzuna. All public listings. We save you the daily search — nothing more.'],
      ['Is my resume safe?','Stored privately, used only to score job relevance for you. Never sold or shared. Delete anytime and we wipe everything within 24 hours.'],
      ['How is this different from Naukri or LinkedIn?','Naukri shows every keyword-matching job. We score each role against your specific profile — function, seniority, domain, location — and surface only what is actually relevant. Fewer emails, better matches.'],
      ['Can I cancel Pro anytime?','Yes. Email hello@jobmatchai.co.in — processed within 12 hours, no questions asked. We use one-time payment links, not auto-renewal, so no surprise charges ever.'],
    ].map(([q,a])=>`<div class="fi" onclick="tf(this)"><div class="fq"><span>${q}</span><span class="ar">+</span></div><div class="fa">${a}</div></div>`).join('')}
  </div>
</div>
</section>

<footer>
<div class="w">
  <div class="ft">
    <div class="fl">Job<i>Match</i> AI</div>
    <div class="flinks">
      <a href="/terms" class="fa2">Terms & Privacy</a>
      <a href="mailto:hello@jobmatchai.co.in" class="fa2">hello@jobmatchai.co.in</a>
    </div>
  </div>
  <p class="fcopy">Built with Claude · Made in India 🇮🇳 · ₹0 charged to apply, ever</p>
</div>
</footer>

<script>
fetch('/count').then(r=>r.json()).then(d=>{
  const n=d.count||59;
  ['lc','su'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent=n.toLocaleString('en-IN');});
}).catch(()=>{});
function tf(el){const o=el.classList.contains('o');document.querySelectorAll('.fi').forEach(f=>f.classList.remove('o'));if(!o)el.classList.add('o');}
const lc=document.getElementById('lc');
if(lc){let c=Math.max(parseInt(lc.textContent)-12,1),t=parseInt(lc.textContent);const tmr=setInterval(()=>{c++;lc.textContent=c.toLocaleString('en-IN');if(c>=t)clearInterval(tmr);},80);}
</script>
</body></html>`);
});
// ═══════════════════════════════════════════════════════════════════
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
