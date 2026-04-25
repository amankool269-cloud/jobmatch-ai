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

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
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
const BREVO_KEY    = process.env.BREVO_API_KEY;
const UNSUB_SECRET = process.env.UNSUBSCRIBE_SECRET || 'jobmatch-secret-2026';
const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || 'https://jobmatch-ai-z19k.onrender.com';

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

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui;text-align:center;padding:80px 20px;background:#f8fafc">
<h1 style="font-size:32px;color:#111">JobMatch <span style="color:#0055FF">AI</span></h1>
<p style="font-size:14px;color:#6b7280">Daily curated job matches for India. Powered by Claude.</p>
<a href="https://jobmatchai.co.in" style="display:inline-block;margin-top:18px;background:#0055FF;color:#fff;padding:12px 24px;border-radius:9px;text-decoration:none;font-weight:600">Get started →</a>
</body></html>`);
});

// ─── Boot ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 JobMatch server live on :${PORT}`);
    console.log(`   AT_BASE=${AT_BASE ? '✓' : '✗'} | APIFY=${APIFY_TOKEN ? '✓' : '✗'} | BREVO=${BREVO_KEY ? '✓' : '✗'} | CLAUDE=${ANTHROPIC_KEY ? '✓' : '✗'}`);
});
