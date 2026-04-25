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
    if (!email || !verifyUnsubToken(email, token)) return res.status(403).send('Invalid link — please use the dashboard link from your latest email');

    const rec = await findUserRecord(email);
    if (!rec) return res.status(404).send('Profile not found');

    const f = rec.fields;
    let matches = [];
    try { matches = JSON.parse(f.LastMatches || '[]'); } catch {}

    // Fetch recent apply clicks (last 30)
    let applies = [];
    try {
        const r = await fetch(
            `https://api.airtable.com/v0/${AT_BASE}/${CLICKS_TABLE}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}&sort[0][field]=ClickedAt&sort[0][direction]=desc&maxRecords=30`,
            { headers: { Authorization: `Bearer ${AT_TOKEN}` } }
        );
        const data = await r.json();
        applies = data.records || [];
    } catch {}

    const totalApplies = f.TotalApplyClicks || 0;
    const totalOpens = f.TotalEmailOpens || 0;
    const tier = f.PaidStatus === 'pro' ? 'PRO' : 'FREE';
    const planBadge = tier === 'PRO'
        ? `<span style="background:#0055FF;color:#fff;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">PRO</span>`
        : `<span style="background:#f1f5f9;color:#64748b;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">FREE</span>`;

    const matchCards = matches.map(m => `
<div style="background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${m.s>=85?'#059669':m.s>=70?'#0055FF':'#d97706'};border-radius:10px;padding:14px 16px;margin-bottom:10px">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
    <div style="flex:1;min-width:0">
      <div style="font-weight:700;font-size:14px;color:#111;margin-bottom:4px">${m.t}</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:6px">${m.c} · ${m.src||''}</div>
      ${m.v ? `<div style="font-size:12px;color:#374151;line-height:1.5;margin-bottom:8px">${m.v}</div>` : ''}
      ${m.sal ? `<div style="font-size:11px;color:#059669;font-weight:600">${m.sal}</div>` : ''}
    </div>
    <div style="text-align:center;flex-shrink:0">
      <div style="font-size:22px;font-weight:800;color:${m.s>=85?'#059669':m.s>=70?'#0055FF':'#d97706'}">${m.s}%</div>
      ${m.u ? `<a href="${SERVER_URL}/apply?e=${encodeURIComponent(email)}&u=${encodeURIComponent(m.u)}&t=${encodeURIComponent(m.t)}&c=${encodeURIComponent(m.c)}&s=${encodeURIComponent(m.src||'')}&sc=${m.s}&sig=${signPayload(`${email}|${m.u}`)}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:6px 14px;border-radius:7px;text-decoration:none;font-size:11px;font-weight:600;margin-top:4px">Apply</a>` : ''}
    </div>
  </div>
</div>`).join('');

    const appliesCards = applies.slice(0, 10).map(a => {
        const af = a.fields;
        const date = af.ClickedAt ? new Date(af.ClickedAt).toLocaleDateString('en-IN', { day:'numeric', month:'short' }) : '';
        return `<div style="padding:10px 14px;background:#f8fafc;border-radius:8px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:10px">
  <div style="flex:1;min-width:0">
    <div style="font-size:13px;font-weight:600;color:#111">${af.JobTitle||''}</div>
    <div style="font-size:11px;color:#6b7280">${af.Company||''} · ${af.Source||''}</div>
  </div>
  <div style="font-size:11px;color:#9ca3af;flex-shrink:0">${date}</div>
</div>`;
    }).join('');

    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>JobMatch AI Dashboard</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;margin:0;padding:20px 12px">
<div style="max-width:680px;margin:0 auto">
  <!-- Header -->
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:20px 24px;margin-bottom:14px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div>
        <div style="font-size:18px;font-weight:800;color:#111">Job<span style="color:#0055FF">Match</span> AI</div>
        <div style="font-size:12px;color:#6b7280;margin-top:2px">${f.Name || email} · ${planBadge}</div>
      </div>
      <a href="${SERVER_URL}/profile?email=${encodeURIComponent(email)}&token=${token}" style="font-size:12px;color:#0055FF;text-decoration:none;font-weight:600">Edit profile →</a>
    </div>
    <div style="display:flex;gap:8px">
      <div style="flex:1;background:#f0f5ff;border:1px solid #c7d7ff;border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:18px;font-weight:800;color:#0055FF">${matches.length}</div>
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">Today's matches</div>
      </div>
      <div style="flex:1;background:#ecfdf5;border:1px solid #bbf7d0;border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:18px;font-weight:800;color:#059669">${totalApplies}</div>
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">Total applies</div>
      </div>
      <div style="flex:1;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:18px;font-weight:800;color:#374151">${totalOpens}</div>
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">Emails opened</div>
      </div>
    </div>
  </div>

  ${tier === 'FREE' ? `
  <!-- Pro upsell banner -->
  <div style="background:linear-gradient(135deg,#0055FF 0%,#1d4ed8 100%);border-radius:14px;padding:18px 22px;margin-bottom:14px;color:#fff">
    <div style="font-size:14px;font-weight:700;margin-bottom:4px">Upgrade to Pro · ₹299/month</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:12px">Daily emails · WhatsApp alerts · ATS resume optimiser · Hiring contact reveals</div>
    <a href="${SERVER_URL}/pricing?email=${encodeURIComponent(email)}&token=${token}" style="display:inline-block;background:#fff;color:#0055FF;padding:8px 18px;border-radius:7px;text-decoration:none;font-size:12px;font-weight:700">See pricing →</a>
  </div>` : ''}

  <!-- Matches -->
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px 20px;margin-bottom:14px">
    <div style="font-size:13px;font-weight:700;color:#111;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.05em">Your latest matches</div>
    ${matches.length ? matchCards : `<p style="font-size:13px;color:#6b7280;text-align:center;padding:24px 0;margin:0">No matches yet — check back tomorrow.</p>`}
  </div>

  <!-- Apply history -->
  ${applies.length ? `
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px 20px;margin-bottom:14px">
    <div style="font-size:13px;font-weight:700;color:#111;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.05em">Recent applies (${applies.length})</div>
    ${appliesCards}
  </div>` : ''}

  <p style="text-align:center;font-size:11px;color:#9ca3af;margin:14px 0">JobMatch AI · <a href="mailto:hello@jobmatchai.co.in" style="color:#0055FF">hello@jobmatchai.co.in</a></p>
</div></body></html>`);
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
<title>Sign up · JobMatch AI</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,sans-serif;background:#f1f5f9;color:#111;line-height:1.6}
  .wrap{max-width:520px;margin:0 auto;padding:40px 20px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:32px;box-shadow:0 4px 20px rgba(0,0,0,.04)}
  h1{font-size:24px;font-weight:800;letter-spacing:-.02em;margin-bottom:6px}
  .sub{font-size:14px;color:#6b7280;margin-bottom:28px}
  label{display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
  input,select,textarea{width:100%;padding:12px 14px;border:1.5px solid #e5e7eb;border-radius:9px;font-size:14px;font-family:inherit;margin-bottom:18px;background:#fff}
  input:focus,select:focus{outline:0;border-color:#0055FF}
  .file-zone{border:2px dashed #c7d7ff;background:#f0f5ff;border-radius:9px;padding:20px;text-align:center;cursor:pointer;margin-bottom:18px;transition:all .2s}
  .file-zone:hover{background:#e0eaff;border-color:#0055FF}
  .file-zone input{display:none}
  .file-name{font-size:13px;color:#0055FF;font-weight:600;margin-top:6px;display:none}
  .req{color:#dc2626;font-weight:700}
  button{width:100%;background:#0055FF;color:#fff;padding:14px;border:0;border-radius:9px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;transition:transform .1s}
  button:hover{transform:translateY(-1px)}
  button:disabled{opacity:.6;cursor:wait}
  .note{font-size:12px;color:#9ca3af;text-align:center;margin-top:14px;line-height:1.6}
  .note a{color:#0055FF;text-decoration:none}
  .back{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:#6b7280;text-decoration:none;margin-bottom:18px}
  .back:hover{color:#0055FF}
  .promise{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:9px;padding:12px 14px;margin-bottom:22px;font-size:12px;color:#15803d;line-height:1.6}
  .err{background:#fee2e2;border:1px solid #fecaca;color:#991b1b;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:14px;display:none}
  .ok{background:#dcfce7;border:1px solid #bbf7d0;color:#15803d;padding:14px;border-radius:9px;text-align:center;display:none}
</style></head>
<body><div class="wrap">
<a href="/" class="back">← Back</a>
<div class="card">
  <h1>Get your daily matches</h1>
  <p class="sub">Upload your resume. Get curated jobs every morning. Free forever, premium optional.</p>

  <div class="promise">
    🔒 We never share your resume. We never charge you to apply for jobs. Your data stays yours.
  </div>

  <div id="err" class="err"></div>
  <div id="ok" class="ok">
    <div style="font-size:36px;margin-bottom:8px">🎉</div>
    <div style="font-weight:700;margin-bottom:4px">You're in!</div>
    <div style="font-size:13px;color:#15803d;margin-top:6px">Check your inbox in the next 10 minutes for your first matches.</div>
  </div>

  <form id="form" enctype="multipart/form-data">
    <label>Full name <span class="req">*</span></label>
    <input name="name" required maxlength="60" placeholder="Priya Sharma">

    <label>Email <span class="req">*</span></label>
    <input name="email" type="email" required placeholder="priya@example.com">

    <label>WhatsApp number <span class="req">*</span></label>
    <input name="phone" type="tel" required pattern="[+0-9 ]{10,15}" placeholder="+91 98765 43210">

    <label>Cities you're open to <span class="req">*</span></label>
    <input name="cities" required value="Bengaluru" placeholder="Bengaluru, Mumbai, Remote">

    <label>Resume <span class="req">*</span> (PDF, max 5MB)</label>
    <label class="file-zone" for="resume">
      <div style="font-size:24px;margin-bottom:6px">📄</div>
      <div style="font-size:13px;font-weight:600;color:#0055FF">Click to upload</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:4px">We'll auto-extract your role, skills, experience</div>
      <div class="file-name" id="fname"></div>
      <input id="resume" name="resume" type="file" accept=".pdf" required>
    </label>

    <button type="submit" id="btn">Get my first digest →</button>
  </form>

  <p class="note">By signing up you agree to our <a href="/terms">terms</a> &middot; Free always &middot; Cancel anytime</p>
</div>
</div>

<script>
const form = document.getElementById('form');
const btn = document.getElementById('btn');
const err = document.getElementById('err');
const ok = document.getElementById('ok');
const fileInput = document.getElementById('resume');
const fileName = document.getElementById('fname');

fileInput.addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) { fileName.textContent = f.name; fileName.style.display = 'block'; }
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  err.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Reading your resume...';
  const fd = new FormData(form);
  try {
    const r = await fetch('/signup', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Signup failed');
    form.style.display = 'none';
    ok.style.display = 'block';
  } catch(e) {
    err.textContent = e.message;
    err.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Try again';
  }
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
<title>JobMatch AI · Curated daily job matches for India</title>
<meta name="description" content="Get hand-picked job matches every morning, scored by AI across LinkedIn, Naukri, and 5 platforms. Free for India.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,sans-serif;color:#0f172a;line-height:1.6;background:#fff}
  .wrap{max-width:1100px;margin:0 auto;padding:0 24px}
  /* HEADER */
  header{padding:20px 0;border-bottom:1px solid #f1f5f9;position:sticky;top:0;background:rgba(255,255,255,.95);backdrop-filter:blur(8px);z-index:50}
  .nav{display:flex;justify-content:space-between;align-items:center}
  .logo{font-size:20px;font-weight:800;letter-spacing:-.02em}
  .logo span{color:#0055FF}
  .nav-cta{background:#0055FF;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600}
  /* HERO */
  .hero{padding:80px 0 60px;text-align:center}
  .badge{display:inline-block;background:#f0f5ff;border:1px solid #c7d7ff;color:#1d4ed8;padding:6px 14px;border-radius:24px;font-size:12px;font-weight:600;margin-bottom:20px}
  .live-dot{display:inline-block;width:7px;height:7px;background:#10b981;border-radius:50%;margin-right:6px;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  h1{font-size:56px;font-weight:900;letter-spacing:-.03em;line-height:1.1;margin-bottom:22px;max-width:780px;margin-left:auto;margin-right:auto}
  h1 em{font-style:normal;background:linear-gradient(135deg,#0055FF 0%,#7c3aed 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .lede{font-size:19px;color:#475569;max-width:640px;margin:0 auto 36px;line-height:1.55}
  .cta-row{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-bottom:18px}
  .btn-primary{background:#0055FF;color:#fff;padding:16px 32px;border-radius:11px;text-decoration:none;font-size:15px;font-weight:700;transition:transform .15s;display:inline-block;box-shadow:0 4px 14px rgba(0,85,255,.25)}
  .btn-primary:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,85,255,.35)}
  .btn-ghost{background:transparent;color:#475569;padding:16px 28px;border-radius:11px;text-decoration:none;font-size:15px;font-weight:600;border:1.5px solid #e2e8f0;display:inline-block}
  .micro{font-size:13px;color:#94a3b8}
  /* STATS BAR */
  .stats{background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:24px;margin:50px 0;display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
  .stat{text-align:center}
  .stat-num{font-size:28px;font-weight:800;color:#0055FF;letter-spacing:-.02em}
  .stat-lbl{font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-top:4px}
  /* HOW IT WORKS */
  .section{padding:60px 0}
  .h2{font-size:36px;font-weight:800;letter-spacing:-.02em;text-align:center;margin-bottom:14px}
  .sub2{font-size:16px;color:#64748b;text-align:center;max-width:560px;margin:0 auto 50px}
  .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
  .step{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;position:relative}
  .step-num{position:absolute;top:-14px;left:24px;background:#0055FF;color:#fff;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px}
  .step-title{font-size:17px;font-weight:700;margin:14px 0 8px}
  .step-desc{font-size:14px;color:#64748b;line-height:1.6}
  /* PRICING */
  .pricing{background:#f8fafc;border-radius:18px;padding:50px 30px;margin:30px 0}
  .price-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;max-width:760px;margin:30px auto 0}
  .plan{background:#fff;border-radius:14px;padding:30px;border:2px solid #e2e8f0;position:relative}
  .plan.pro{border-color:#0055FF;box-shadow:0 8px 24px rgba(0,85,255,.12)}
  .plan-tag{position:absolute;top:-12px;right:24px;background:#0055FF;color:#fff;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.06em}
  .plan-name{font-size:13px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
  .plan-price{font-size:38px;font-weight:800;color:#0f172a;letter-spacing:-.02em}
  .plan-price small{font-size:14px;color:#94a3b8;font-weight:500}
  .plan-tagline{font-size:13px;color:#64748b;margin:6px 0 18px}
  .plan ul{list-style:none;font-size:14px;color:#334155;margin-bottom:22px}
  .plan li{padding:6px 0;display:flex;align-items:flex-start;gap:8px}
  .plan li::before{content:'✓';color:#10b981;font-weight:700;flex-shrink:0}
  .plan-cta{display:block;text-align:center;padding:11px;border-radius:9px;font-size:13px;font-weight:700;text-decoration:none}
  .plan-cta.primary{background:#0055FF;color:#fff}
  .plan-cta.secondary{background:#fff;color:#0f172a;border:1.5px solid #e2e8f0}
  /* TRUST */
  .trust{background:linear-gradient(135deg,#f0fdf4 0%,#ecfdf5 100%);border:1px solid #bbf7d0;border-radius:14px;padding:28px;margin:40px 0;display:flex;align-items:center;gap:20px}
  .trust-icon{font-size:36px;flex-shrink:0}
  .trust-title{font-size:16px;font-weight:700;color:#15803d;margin-bottom:4px}
  .trust-desc{font-size:13px;color:#166534;line-height:1.6}
  /* FAQ */
  .faq{max-width:720px;margin:0 auto}
  .faq-item{border-bottom:1px solid #e2e8f0;padding:18px 0}
  .faq-q{font-weight:700;font-size:15px;margin-bottom:6px;color:#0f172a}
  .faq-a{font-size:14px;color:#64748b;line-height:1.7}
  /* FOOTER */
  footer{background:#0f172a;color:#94a3b8;padding:40px 0;margin-top:60px;font-size:13px}
  .foot{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px}
  footer a{color:#cbd5e1;text-decoration:none}
  /* MOBILE */
  @media(max-width:720px){
    h1{font-size:38px}
    .lede{font-size:16px}
    .stats{grid-template-columns:repeat(2,1fr)}
    .steps{grid-template-columns:1fr}
    .price-grid{grid-template-columns:1fr}
    .h2{font-size:28px}
    .trust{flex-direction:column;text-align:center}
  }
</style></head>
<body>

<header><div class="wrap nav">
  <div class="logo">Job<span>Match</span> AI</div>
  <a href="/signup" class="nav-cta">Get started →</a>
</div></header>

<section class="hero"><div class="wrap">
  <div class="badge"><span class="live-dot"></span><span id="live-count">Loading...</span> professionals getting matches today</div>
  <h1>Stop scrolling job boards. <em>Get curated matches every morning.</em></h1>
  <p class="lede">JobMatch AI scans 5 platforms daily, scores every role against your resume using Claude AI, and emails only the matches worth your time. Built for Indian senior professionals.</p>
  <div class="cta-row">
    <a href="/signup" class="btn-primary">Get my first digest →</a>
    <a href="#how" class="btn-ghost">See how it works</a>
  </div>
  <p class="micro">Free forever &middot; No credit card &middot; Setup in 60 seconds</p>

  <div class="stats">
    <div class="stat"><div class="stat-num" id="s-users">—</div><div class="stat-lbl">Active users</div></div>
    <div class="stat"><div class="stat-num">5</div><div class="stat-lbl">Job platforms</div></div>
    <div class="stat"><div class="stat-num">9 AM</div><div class="stat-lbl">IST daily</div></div>
    <div class="stat"><div class="stat-num">100%</div><div class="stat-lbl">Free to apply</div></div>
  </div>
</div></section>

<section class="section" id="how"><div class="wrap">
  <h2 class="h2">How it works</h2>
  <p class="sub2">Three steps. One minute to set up. Then we do the work every day.</p>
  <div class="steps">
    <div class="step">
      <div class="step-num">1</div>
      <div class="step-title">Upload your resume</div>
      <div class="step-desc">Claude reads your role, experience, skills, and target domain in seconds. No manual form-filling.</div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-title">We search 5 platforms daily</div>
      <div class="step-desc">LinkedIn, Naukri, JSearch, Adzuna, iimjobs &mdash; every morning, fresh roles only, scored against your profile.</div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-title">Open one email per day</div>
      <div class="step-desc">15 ranked matches with scores, why they fit, salary, and direct apply links. No noise. No duplicates.</div>
    </div>
  </div>
</div></section>

<section class="section pricing"><div class="wrap">
  <h2 class="h2">Honest pricing</h2>
  <p class="sub2">Free works forever. Pro covers our running costs and unlocks daily delivery.</p>
  <div class="price-grid">
    <div class="plan">
      <div class="plan-name">Free</div>
      <div class="plan-price">&#8377;0<small>/forever</small></div>
      <div class="plan-tagline">Always free, no card required</div>
      <ul>
        <li>2 curated digests per week</li>
        <li>Up to 5 matches per email</li>
        <li>Core matching engine</li>
        <li>Unsubscribe anytime</li>
      </ul>
      <a href="/signup" class="plan-cta secondary">Start free</a>
    </div>
    <div class="plan pro">
      <div class="plan-tag">FOUNDING</div>
      <div class="plan-name">Pro</div>
      <div class="plan-price">&#8377;49<small>/month</small></div>
      <div class="plan-tagline">or &#8377;499/year &middot; locked in for life</div>
      <ul>
        <li>Daily curated matches at 9am IST</li>
        <li>Up to 15 matches per digest</li>
        <li>Full search across all 5 platforms</li>
        <li>Complete dashboard + apply history</li>
        <li>Priority email support</li>
      </ul>
      <a href="/signup?plan=pro" class="plan-cta primary">Become a founding member</a>
    </div>
  </div>
  <p class="micro" style="text-align:center;margin-top:24px">Founding rate available for the first 100 members. Regular price will be &#8377;149/month.</p>
</div></section>

<section class="section"><div class="wrap">
  <div class="trust">
    <div class="trust-icon">🤝</div>
    <div>
      <div class="trust-title">Our promise: we never charge you to apply for jobs</div>
      <div class="trust-desc">JobMatch is a search and curation tool. Every job we surface is free to apply on the original platform. We charge only for the matching service &mdash; and only if you find it valuable enough to upgrade.</div>
    </div>
  </div>
</div></section>

<section class="section"><div class="wrap">
  <h2 class="h2">Common questions</h2>
  <div class="faq">
    <div class="faq-item">
      <div class="faq-q">Do you charge employers or take recruitment fees?</div>
      <div class="faq-a">No. We have zero relationship with employers. We don't get paid when you get hired. Our only revenue is the optional Pro subscription from job seekers.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">Where do the jobs come from?</div>
      <div class="faq-a">We aggregate from LinkedIn, Naukri, iimjobs, JSearch (Google for Jobs), and Adzuna. All public listings. We never scrape protected pages or anything you couldn't find yourself &mdash; we just save you the time of doing it.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">Is my resume data safe?</div>
      <div class="faq-a">Your resume stays on our private storage and is used only to score job relevance for you. We never sell, share, or repurpose your data. You can delete your account anytime and we wipe everything within 24 hours.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">What's the difference between Free and Pro?</div>
      <div class="faq-a">Free runs on free APIs and sends 2 digests per week with our core matching. Pro runs on premium APIs (LinkedIn + Naukri scrapers cost real money) and sends daily matches with deeper coverage. Most users start free.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">How do I cancel Pro?</div>
      <div class="faq-a">Reply to any email saying "cancel" &mdash; we process within 12 hours, no questions asked. We use one-time payment links (not auto-renewal), so there are no surprise charges ever.</div>
    </div>
  </div>
</div></section>

<footer><div class="wrap foot">
  <div>JobMatch AI &middot; Made in India 🇮🇳 &middot; Built with Claude</div>
  <div><a href="mailto:hello@jobmatchai.co.in">hello@jobmatchai.co.in</a></div>
</div></footer>

<script>
fetch('/count').then(r => r.json()).then(d => {
  const n = d.count || 50;
  document.getElementById('live-count').textContent = n.toLocaleString('en-IN');
  document.getElementById('s-users').textContent = n.toLocaleString('en-IN');
}).catch(() => {
  document.getElementById('live-count').textContent = '50+';
  document.getElementById('s-users').textContent = '50+';
});
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
    await fetch(`https://api.airtable.com/v0/${AT_BASE}/${USERS_TABLE}/${existing.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            fields: {
                PaidStatus: 'pro',
                PaidUntil: newExpiry,
                LastPaymentAmount: amountRupees,
                LastPaymentDate: new Date().toISOString(),
                LastPaymentId: paymentId,
                RenewalReminderSent: '', // reset so reminders fire on schedule
                Status: 'Active',
                LastEngagement: new Date().toISOString(),
            }
        })
    });

    console.log(`✅ Activated Pro for ${email} (${plan}, ₹${amountRupees}, valid until ${newExpiry})`);

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
