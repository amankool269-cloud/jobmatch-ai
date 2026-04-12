import express from 'express';
import multer from 'multer';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, unlinkSync } from 'fs';
import { createHmac } from 'crypto';

const app = express();
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 5 * 1024 * 1024 } });
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const {
    ANTHROPIC_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID,
    AIRTABLE_TABLE = 'tblJtDvebLwnXvV9i',
    APIFY_TOKEN, APIFY_ACTOR_ID = 'flexible_transaction/my-actor',
    PORT = 3000,
} = process.env;
const UNSUB_SECRET = process.env.UNSUBSCRIBE_SECRET || 'jobmatch-secret-2026';

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Brevo HTTP API — no port blocking, full dashboard tracking
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL || 'hello@jobmatchai.co.in';
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME || 'JobMatch AI';

const runCache = new Map();

// ── Unsubscribe token helpers ─────────────────────────────────────────────────
function makeToken(email) {
    return createHmac('sha256', UNSUB_SECRET).update(email.toLowerCase()).digest('hex').slice(0, 16);
}
function validToken(email, token) {
    return makeToken(email) === token;
}

// ── PARSE RESUME ──────────────────────────────────────────────────────────────
async function parseResume(buffer, filename) {
    const isDocx = filename?.endsWith('.docx') || filename?.endsWith('.doc');
    const prompt = `You are an expert resume parser for the Indian job market. Extract ALL information from this resume.

CRITICAL: Return ONLY valid JSON. Never say "I cannot" or "I apologize". Always extract what you can see.

Return ONLY this JSON object (no markdown, no explanation):
{
  "currentRole": "exact current or most recent job title",
  "targetRole": "the next logical role up — if 0-3yr use current title, if 3-7yr add Senior prefix, if 7-10yr use Head/AVP/Director level, if 10+yr use VP/GM/CXO level",
  "currentCompany": "current or most recent company name",
  "experience": "total years as a number e.g. 6 years",
  "location": "current city in India",
  "domain": "industry/sector e.g. Financial Services, Technology, FMCG",
  "skills": "top 8 skills comma separated",
  "education": "highest degree e.g. MBA, B.Tech, B.Com",
  "seniority": "one of: fresher / junior / mid-level / senior / lead / head",
  "companyType": "one of: startup / mid-size / large enterprise / MNC / NBFC / bank"
}

SENIORITY GUIDE:
- fresher: 0-1 years
- junior: 1-3 years
- mid-level: 3-6 years
- senior: 6-10 years
- lead/head: 10+ years

TARGET ROLE FRAMEWORK — use the right track based on education:

TRACK A — Professional qualifications (CA / CFA / CPA / MBA-Finance / MBA):
- 0-3yr  → Analyst / Associate (keep current title)
- 3-6yr  → Senior Analyst / Manager / AVP
- 6-9yr  → VP / Principal / Senior Manager
- 10+yr  → Director / CFO / Partner

TRACK B — General roles (Sales / Tech / Ops / Product / Marketing / HR):
- 0-3yr  → current role (early career)
- 3-6yr  → Senior [role] / Manager
- 6-9yr  → Head / AVP / [function] Lead
- 10+yr  → Director / VP / GM

CRITICAL RULES for targetRole:
1. For CA/CFA/CPA — use finance-specific titles (Credit Manager, AVP Credit, Investment Manager)
2. For MBA — use management titles (Senior Manager, AVP, Deputy Director)
3. NEVER use generic "Growth" or "Marketing" unless the current role is explicitly in those functions
4. targetRole must stay in the SAME DOMAIN as currentRole — do not cross functions

EXAMPLES:
{"currentRole":"Credit & Investment Associate","targetRole":"Credit Manager","currentCompany":"Wint Wealth","experience":"3 years","location":"Mumbai","domain":"Financial Services / Fintech / Lending","skills":"Financial Analysis, Credit Evaluation, Due Diligence, Portfolio Monitoring","education":"CA","seniority":"mid-level","companyType":"startup"}

{"currentRole":"Area Sales Manager","targetRole":"Senior Manager Sales","currentCompany":"Finnable Technologies","experience":"6 years","location":"New Delhi","domain":"Financial Services / Lending","skills":"DSA channel management, loan disbursement, NBFC, team leadership, client acquisition, B2B sales","education":"MBA","seniority":"senior","companyType":"NBFC"}

{"currentRole":"Software Engineer","targetRole":"Senior Software Engineer","currentCompany":"Infosys","experience":"3 years","location":"Bengaluru","domain":"Technology / IT Services","skills":"React, Node.js, Python, AWS, REST APIs, SQL, Docker, Git","education":"B.Tech","seniority":"mid-level","companyType":"large enterprise"}

{"currentRole":"Senior UI/UX Designer","targetRole":"Head of Design","currentCompany":"NeoFinity","experience":"6 years","location":"Gurugram","domain":"Fintech / EdTech","skills":"UI/UX Design, Design Systems, User Research, Interaction Design","education":"MCA","seniority":"senior","companyType":"startup"}`;

    const content = isDocx
        ? [{ type: 'text', text: `${prompt}\n\nResume text:\n${buffer.toString('utf8', 0, 5000)}` }]
        : [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
            { type: 'text', text: prompt }
        ];

    try {
        const msg = await claude.messages.create({
            model: 'claude-haiku-4-5-20251001', max_tokens: 800,
            messages: [{ role: 'user', content }]
        });
        const raw = msg.content[0].text.replace(/```json|```/g, '').trim();
        try {
            const p = JSON.parse(raw);
            if (p.currentRole || p.targetRole || p.skills) {
                // ── Post-processing: validate experience vs seniority ──
                const expYears = parseFloat(p.experience) || 0;

                // Override seniority based on actual experience
                if (expYears < 1)        p.seniority = 'fresher';
                else if (expYears < 3)   p.seniority = 'junior';
                else if (expYears < 6)   p.seniority = 'mid-level';
                else if (expYears < 10)  p.seniority = 'senior';
                else                     p.seniority = 'lead';

                // Strip inflated seniority prefixes from role if experience doesn't match
                const seniorPrefixes = /^(senior|lead|principal|head of|director|vp|avp|chief)\s+/i;
                if (expYears < 2 && seniorPrefixes.test(p.currentRole)) {
                    p.currentRole = p.currentRole.replace(seniorPrefixes, '').trim();
                    console.log(`Corrected inflated role title for ${expYears}yr experience`);
                }

                // Apply correct targetRole based on validated experience
                const coreRole = p.currentRole.replace(seniorPrefixes, '').trim();
                if (expYears < 1)       p.targetRole = coreRole;
                else if (expYears < 3)  p.targetRole = coreRole;
                else if (expYears < 6)  p.targetRole = 'Senior ' + coreRole;
                else if (expYears < 10) p.targetRole = p.targetRole; // keep AI's suggestion
                else                    p.targetRole = p.targetRole; // keep AI's suggestion

                console.log('Profile extracted (10 fields):', JSON.stringify(p));
                return p;
            }
        } catch {}
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) {
            try {
                const p = JSON.parse(m[0]);
                if (p.currentRole || p.skills) {
                    console.log('Profile extracted via regex:', JSON.stringify(p));
                    return p;
                }
            } catch {}
        }
        console.warn('Claude refused to parse resume — using text fallback');
    } catch (e) {
        console.error('Claude API error:', e.message);
    }

    const text = buffer.toString('utf8', 0, 6000).replace(/[^\x20-\x7E\n]/g, ' ');
    const cities = ['Bengaluru','Bangalore','Mumbai','Delhi','Hyderabad','Pune','Chennai','Kolkata','Noida','Gurgaon'];
    const foundCity = cities.find(c => text.toLowerCase().includes(c.toLowerCase())) || 'Bengaluru';
    const expMatch = text.match(/(\d+)\+?\s*(?:years?|yrs?)(?:\s*of)?\s*(?:experience|exp)/i);
    const expYears = expMatch ? parseInt(expMatch[1]) : 3;
    return {
        currentRole: 'Professional', targetRole: 'Professional',
        currentCompany: '', experience: `${expYears} years`,
        location: foundCity, domain: 'General', skills: '',
        education: '', seniority: expYears <= 2 ? 'junior' : expYears <= 6 ? 'mid-level' : 'senior',
        companyType: 'large enterprise',
    };
}

// ── Save to Airtable ──────────────────────────────────────────────────────────
async function saveToAirtable(name, email, phone, cities, profile) {
    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) return;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`;
    const headers = { 'Authorization': `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

    const check = await fetch(`${url}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}`, { headers });
    const cd = await check.json();
    const existing = cd.records || [];

    const fullFields = {
        'Name': name, 'Email': email,
        'Target role': profile.targetRole || profile.currentRole || '',
        'Current role': profile.currentRole || '',
        'Location': profile.location || 'Bengaluru',
        'Experience': profile.experience || '',
        'Domain': profile.domain || '',
        'Skills': profile.skills || '',
        'Education': profile.education || '',
        'Seniority': profile.seniority || '',
        'Company type': profile.companyType || '',
        'Phone': phone || '',
        'Cities': Array.isArray(cities) ? cities.join(', ') : '',
        'Status': 'Active',
    };
    const coreFields = {
        'Name': name, 'Email': email,
        'Target role': profile.targetRole || profile.currentRole || '',
        'Location': profile.location || 'Bengaluru',
        'Experience': profile.experience || '',
        'Domain': profile.domain || '',
        'Skills': profile.skills || '',
        'Status': 'Active',
    };

    async function upsert(fields, recordId) {
        if (recordId) return fetch(`${url}/${recordId}`, { method: 'PATCH', headers, body: JSON.stringify({ fields }) });
        return fetch(url, { method: 'POST', headers, body: JSON.stringify({ records: [{ fields }] }) });
    }

    const recordId = existing[0]?.id || null;
    let resp = await upsert(fullFields, recordId);
    if (resp.status === 422) {
        console.log('Full fields failed — retrying with core fields');
        resp = await upsert(coreFields, recordId);
    }
    const result = await resp.json();
    if (!resp.ok) console.error(`Airtable error ${resp.status}:`, JSON.stringify(result?.error));
    else console.log(`Airtable ${recordId ? 'updated' : 'created'}: ${resp.status} for ${email}`);

    for (const dup of existing.slice(1)) {
        await fetch(`${url}/${dup.id}`, { method: 'DELETE', headers });
        console.log(`Deleted duplicate row for ${email}`);
    }
}

// ── Welcome email via Brevo HTTP API (no port blocking) ──────────────────────
async function sendWelcomeEmail(name, email, profile) {
    if (!BREVO_API_KEY) { console.log('Brevo API key not set — skipping welcome email'); return; }
    try {
        const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'api-key': BREVO_API_KEY,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                sender: { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL },
                to: [{ email, name }],
                subject: `Welcome ${name} — searching ${profile.targetRole || 'your next role'} now!`,
                htmlContent: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px">
<div style="background:#0055FF;border-radius:12px;padding:20px 24px;margin-bottom:20px">
  <div style="font-size:18px;font-weight:700;color:#fff">JobMatch AI</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.75);margin-top:2px">Your AI job search is live</div>
</div>
<p style="color:#374151;font-size:14px;margin-bottom:16px">Hi <strong>${name}</strong> — we have read your resume and are now scanning LinkedIn, Naukri, iimjobs, Instahyre and more.</p>
<div style="background:#f9fafb;border-radius:10px;padding:14px;margin:16px 0;font-size:13px;color:#374151">
  <b>Your profile:</b><br><br>
  Role: ${profile.targetRole || profile.currentRole}<br>
  Experience: ${profile.experience} · ${profile.seniority}<br>
  Domain: ${profile.domain}<br>
  Skills: ${profile.skills}
</div>
<div style="background:#e8f0ff;padding:14px;border-radius:10px;color:#0055FF;font-size:13px">
  &#10003; Job digest arriving within 10 minutes<br>
  &#10003; Fresh matches every morning at 8am IST<br>
  &#10003; Zero duplicate jobs ever
</div>
<p style="font-size:11px;color:#9ca3af;margin-top:20px">JobMatch AI &middot; Free Beta &middot; <a href="mailto:hello@jobmatchai.co.in" style="color:#0055FF">hello@jobmatchai.co.in</a></p>
</div>`
            })
        });
        const result = await resp.json();
        if (!resp.ok) throw new Error(JSON.stringify(result));
        console.log(`Welcome email sent to ${email} (messageId: ${result.messageId})`);
    } catch (e) {
        console.error('Welcome email error:', e.message);
    }
}

// ── Trigger Apify actor ───────────────────────────────────────────────────────
async function triggerApify(email, profile, cities) {
    if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not set');
    const actorId = (APIFY_ACTOR_ID || '').replace('/', '~');
    const resp = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            airtableToken: AIRTABLE_TOKEN,
            airtableBaseId: AIRTABLE_BASE_ID,
            anthropicApiKey: ANTHROPIC_API_KEY,
            jsearchApiKey: process.env.JSEARCH_API_KEY || '',
            adzunaAppId: process.env.ADZUNA_APP_ID || '',
            adzunaAppKey: process.env.ADZUNA_APP_KEY || '',
            brevoApiKey: BREVO_API_KEY,
            brevoFromEmail: BREVO_FROM_EMAIL,
            brevoFromName: BREVO_FROM_NAME,
            brevoFrom: BREVO_FROM,
            maxResultsPerSource: 10,
            filterEmail: email,
        })
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Apify: ${resp.status} — ${text.slice(0, 100)}`);
    const runId = JSON.parse(text).data?.id;
    console.log(`Apify run: ${runId}`);
    return runId;
}

// ── Poll Apify ────────────────────────────────────────────────────────────────
async function pollApifyRun(runId) {
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 5000));
        try {
            const resp = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
            const data = await resp.json();
            const status = data?.data?.status;
            console.log(`Apify ${runId}: ${status}`);
            if (status === 'SUCCEEDED') {
                const dsResp = await fetch(`https://api.apify.com/v2/datasets/${data.data.defaultDatasetId}/items?token=${APIFY_TOKEN}&limit=50`);
                const items = await dsResp.json();
                runCache.set(runId, { ready: true, jobs: Array.isArray(items) ? items : [] });
                setTimeout(() => runCache.delete(runId), 3600000);
                return;
            }
            if (status === 'FAILED' || status === 'ABORTED') {
                runCache.set(runId, { ready: true, jobs: [] });
                return;
            }
        } catch (e) { console.error(`Poll error: ${e.message}`); }
    }
    runCache.set(runId, { ready: true, jobs: [] });
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', version: '5.1.0' }));

app.get('/debug', async (req, res) => {
    let at = 'untested';
    try {
        const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}?maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
        at = `HTTP ${r.status}`;
    } catch (e) { at = e.message; }
    res.json({
        version: '5.1.0',
        env: {
            ANTHROPIC: ANTHROPIC_API_KEY ? 'SET' : 'MISSING',
            AIRTABLE:  AIRTABLE_TOKEN    ? 'SET' : 'MISSING',
            BREVO:     BREVO_API_KEY     ? 'SET' : 'MISSING',
            APIFY:     APIFY_TOKEN       ? 'SET' : 'MISSING',
            JSEARCH:   process.env.JSEARCH_API_KEY ? 'SET' : 'MISSING',
            ADZUNA:    process.env.ADZUNA_APP_ID   ? 'SET' : 'MISSING',
        },
        airtableStatus: at
    });
});

app.get('/results', (req, res) => {
    const { runId } = req.query;
    if (!runId) return res.json({ status: 'pending' });
    const cached = runCache.get(runId);
    if (cached?.ready) return res.json({ status: 'ready', jobs: cached.jobs });
    return res.json({ status: 'pending' });
});

app.post('/signup', upload.single('resume'), async (req, res) => {
    const { name, email, phone, cities: citiesRaw } = req.body;
    const file = req.file;
    const cities = citiesRaw ? JSON.parse(citiesRaw) : ['Bengaluru'];

    console.log(`\n[${new Date().toISOString()}] Signup: ${name} (${email})`);

    if (!name || !email) return res.status(400).json({ error: 'Name and email required.' });
    if (!file) return res.status(400).json({ error: 'Resume required.' });

    const cleanup = () => { try { unlinkSync(file.path); } catch {} };

    try {
        const t0 = Date.now();
        console.log('Parsing resume (10 fields)...');
        const buffer = readFileSync(file.path);
        const profile = await parseResume(buffer, file.originalname || 'resume.pdf');
        cleanup();
        console.log(`Profile (${Date.now()-t0}ms):`, JSON.stringify(profile));

        saveToAirtable(name, email, phone, cities, profile).catch(e => console.error('Airtable:', e.message));
        sendWelcomeEmail(name, email, profile).catch(e => console.error('Email:', e.message));

        const runId = await triggerApify(email, profile, cities);
        pollApifyRun(runId).catch(e => console.error('Poll:', e.message));

        res.json({ success: true, runId, profile, totalTime: Date.now()-t0 });
    } catch (err) {
        cleanup();
        console.error('Signup error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Unsubscribe / Resubscribe routes ─────────────────────────────────────────
app.get('/unsubscribe', async (req, res) => {
    const { email, token } = req.query;
    if (!email || !token || !validToken(email, token)) {
        return res.status(400).send(page('Invalid link', 'This unsubscribe link is invalid or expired.', '', ''));
    }
    try {
        const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`;
        const headers = { 'Authorization': `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
        const check = await fetch(`${url}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}`, { headers });
        const data = await check.json();
        const rec = data.records?.[0];
        if (!rec) return res.send(page('Not found', 'We could not find your account.', '', ''));
        await fetch(`${url}/${rec.id}`, { method: 'PATCH', headers, body: JSON.stringify({ fields: { Status: 'Inactive' } }) });
        const resubUrl = `/resubscribe?email=${encodeURIComponent(email)}&token=${token}`;
        res.send(page('Unsubscribed', `You've been unsubscribed from JobMatch AI daily alerts.`, 'Changed your mind?', resubUrl));
    } catch (e) {
        res.status(500).send(page('Error', 'Something went wrong. Please try again.', '', ''));
    }
});

app.get('/resubscribe', async (req, res) => {
    const { email, token } = req.query;
    if (!email || !token || !validToken(email, token)) {
        return res.status(400).send(page('Invalid link', 'This link is invalid or expired.', '', ''));
    }
    try {
        const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`;
        const headers = { 'Authorization': `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
        const check = await fetch(`${url}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}`, { headers });
        const data = await check.json();
        const rec = data.records?.[0];
        if (!rec) return res.send(page('Not found', 'We could not find your account.', '', ''));
        await fetch(`${url}/${rec.id}`, { method: 'PATCH', headers, body: JSON.stringify({ fields: { Status: 'Active' } }) });
        res.send(page("You're back!", "Daily job alerts reactivated. Fresh matches arrive every morning at 8am IST.", "", ""));
    } catch (e) {
        res.status(500).send(page('Error', 'Something went wrong. Please try again.', '', ''));
    }
});

function page(title, message, btnText, btnUrl) {
    const icon = title === "You're back!" ? "🎯" : title === "Unsubscribed" ? "👋" : title === "Error" ? "⚠️" : "ℹ️";
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — JobMatch AI</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#FAFAFA;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem}
.card{background:#fff;border:1px solid rgba(0,0,0,0.08);border-radius:20px;padding:2.5rem;max-width:420px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.06)}
.logo{font-size:1.1rem;font-weight:700;color:#0055FF;margin-bottom:2rem;letter-spacing:-0.02em}
.icon{font-size:2.5rem;margin-bottom:1rem}
h1{font-size:1.3rem;font-weight:600;color:#111;margin-bottom:0.75rem}
p{font-size:0.9rem;color:#666;line-height:1.65;margin-bottom:1.5rem}
.btn{display:inline-block;padding:0.75rem 1.75rem;background:#0055FF;color:#fff;border-radius:10px;text-decoration:none;font-size:0.88rem;font-weight:600;transition:background 0.2s}
.btn:hover{background:#0044CC}
.home{display:block;margin-top:1rem;font-size:0.78rem;color:#999;text-decoration:none}
.home:hover{color:#0055FF}
</style>
</head>
<body>
<div class="card">
  <div class="logo">JobMatch AI</div>
  <div class="icon">${icon}</div>
  <h1>${title}</h1>
  <p>${message}</p>
  ${btnText && btnUrl ? `<a href="${btnUrl}" class="btn">${btnText}</a>` : ''}
  <a href="/" class="home">Back to JobMatch AI →</a>
</div>
</body>
</html>`;
}

app.listen(PORT, () => {
    console.log(`JobMatch API v5.1 on port ${PORT}`);
    console.log(`Brevo API: ${BREVO_API_KEY?'SET':'MISSING'} | Anthropic: ${ANTHROPIC_API_KEY?'SET':'MISSING'}`);
});
