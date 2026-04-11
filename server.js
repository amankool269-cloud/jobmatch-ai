import express from 'express';
import multer from 'multer';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';
import { readFileSync, unlinkSync } from 'fs';

const app = express();
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 5 * 1024 * 1024 } });
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const {
    ANTHROPIC_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID,
    AIRTABLE_TABLE = 'tblJtDvebLwnXvV9i',
    APIFY_TOKEN, APIFY_ACTOR_ID = 'flexible_transaction/my-actor',
    RESEND_API_KEY, PORT = 3000,
} = process.env;

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const resendClient = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const runCache = new Map();

// ── PARSE RESUME: Extract 10 fields for maximum search accuracy ───────────────
async function parseResume(buffer, filename) {
    const isDocx = filename?.endsWith('.docx') || filename?.endsWith('.doc');

    const prompt = `You are an expert resume parser for the Indian job market. Extract ALL information from this resume.

CRITICAL: Return ONLY valid JSON. Never say "I cannot" or "I apologize". Always extract what you can see.

Return ONLY this JSON object (no markdown, no explanation):
{
  "currentRole": "exact current or most recent job title",
  "targetRole": "job title they are seeking (same as current if not stated)",
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

EXAMPLES:
{"currentRole":"Area Sales Manager","targetRole":"Area Sales Manager","currentCompany":"Finnable Technologies","experience":"6 years","location":"New Delhi","domain":"Financial Services / Lending","skills":"DSA channel management, loan disbursement, NBFC, team leadership, client acquisition, B2B sales, sales targeting, digital lending","education":"MBA","seniority":"senior","companyType":"NBFC"}

{"currentRole":"Software Engineer","targetRole":"Senior Software Engineer","currentCompany":"Infosys","experience":"3 years","location":"Bengaluru","domain":"Technology / IT Services","skills":"React, Node.js, Python, AWS, REST APIs, SQL, Docker, Git","education":"B.Tech","seniority":"mid-level","companyType":"large enterprise"}`;

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

        // Layer 1: direct parse
        try {
            const p = JSON.parse(raw);
            if (p.currentRole || p.targetRole || p.skills) {
                console.log('Profile extracted (10 fields):', JSON.stringify(p));
                return p;
            }
        } catch {}

        // Layer 2: extract JSON from mixed response
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

        console.warn(`Claude refused to parse resume — using text fallback`);
    } catch (e) {
        console.error('Claude API error:', e.message);
    }

    // Layer 3: raw text fallback
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

// ── Save to Airtable — upsert (update if exists, create if new) ───────────────
async function saveToAirtable(name, email, phone, cities, profile) {
    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) return;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`;
    const headers = { 'Authorization': `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

    const fields = {
        'Name': name,
        'Email': email,
        'Phone': phone || '',
        'Target role': profile.targetRole || profile.currentRole || '',
        'Current role': profile.currentRole || '',
        'Location': profile.location || 'Bengaluru',
        'Experience': profile.experience || '',
        'Domain': profile.domain || '',
        'Skills': profile.skills || '',
        'Education': profile.education || '',
        'Seniority': profile.seniority || '',
        'Company type': profile.companyType || '',
        'Cities': Array.isArray(cities) ? cities.join(', ') : '',
        'Status': 'Active',
    };

    // Check if user already exists
    const check = await fetch(
        `${url}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}&sort[0][field]=Created&sort[0][direction]=desc`,
        { headers }
    );
    const cd = await check.json();
    const existing = cd.records || [];

    if (existing.length > 0) {
        // Update the newest record — preserve SeenJobs
        const rec = existing[0];
        await fetch(`${url}/${rec.id}`, {
            method: 'PATCH', headers,
            body: JSON.stringify({ fields }) // SeenJobs not touched — preserved
        });
        console.log(`Airtable updated: ${email} (re-upload)`);

        // Delete any extra duplicate rows
        for (const dup of existing.slice(1)) {
            await fetch(`${url}/${dup.id}`, { method: 'DELETE', headers });
            console.log(`Deleted duplicate Airtable row for ${email}`);
        }
        return;
    }

    // New user — create row
    const resp = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ records: [{ fields }] })
    });
    console.log(`Airtable created: ${resp.status} for ${email}`);
}

// ── Welcome email via Resend ──────────────────────────────────────────────────
async function sendWelcomeEmail(name, email, profile) {
    if (!resendClient) return;
    const { error } = await resendClient.emails.send({
        from: 'JobMatch AI <onboarding@resend.dev>',
        to: email,
        subject: `Welcome ${name} — searching ${profile.targetRole || 'your next role'} now!`,
        html: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px">
<h2 style="color:#6c63ff">Your AI job search is live! 🎯</h2>
<p style="color:#6b7280">Hi ${name}, we extracted your profile and are now scanning LinkedIn, Naukri, iimjobs, Indeed and more.</p>
<div style="background:#f9fafb;border-radius:10px;padding:14px;margin:16px 0;font-size:13px">
  <b>Your profile:</b><br>
  Role: ${profile.targetRole || profile.currentRole}<br>
  Experience: ${profile.experience} · ${profile.seniority}<br>
  Domain: ${profile.domain}<br>
  Skills: ${profile.skills}
</div>
<p style="background:#eeecff;padding:12px;border-radius:10px;color:#6c63ff;font-size:13px">✓ Job digest arriving within 10 minutes<br>✓ Fresh matches every morning at 8am IST</p>
<p style="font-size:11px;color:#d1d5db">JobMatch AI · Free Beta</p></div>`
    });
    if (error) console.error('Welcome email error:', error);
    else console.log(`Welcome email sent to ${email}`);
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
            smtpUser: process.env.SMTP_USER || '',
            smtpPass: process.env.SMTP_PASS || '',
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
app.get('/health', (req, res) => res.json({ status: 'ok', version: '5.0.0' }));

app.get('/debug', async (req, res) => {
    let at = 'untested';
    try { const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}?maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }); at = `HTTP ${r.status}`; } catch (e) { at = e.message; }
    res.json({ version: '5.0.0', env: { ANTHROPIC: ANTHROPIC_API_KEY ? 'SET' : 'MISSING', AIRTABLE: AIRTABLE_TOKEN ? 'SET' : 'MISSING', RESEND: RESEND_API_KEY ? 'SET' : 'MISSING', APIFY: APIFY_TOKEN ? 'SET' : 'MISSING', JSEARCH: process.env.JSEARCH_API_KEY ? 'SET' : 'MISSING', ADZUNA: process.env.ADZUNA_APP_ID ? 'SET' : 'MISSING' }, airtableStatus: at });
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

        // Non-blocking
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

app.listen(PORT, () => {
    console.log(`JobMatch API v5.0 on port ${PORT}`);
    console.log(`Resend: ${RESEND_API_KEY?'SET':'MISSING'} | Anthropic: ${ANTHROPIC_API_KEY?'SET':'MISSING'}`);
});
