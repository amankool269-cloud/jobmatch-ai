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

// ── FIX 1: Resume parsing with 3-layer fallback (handles scanned/locked PDFs) ─
async function parseResume(buffer, filename) {
    const isDocx = filename?.endsWith('.docx') || filename?.endsWith('.doc');

    const prompt = `You are a resume parser. Extract information from this resume and return ONLY a valid JSON object.
Do NOT say "I cannot", "I'm unable", or "I apologize". Always extract what you can.
If any field is unclear, make your best educated guess based on available context.

Return ONLY this JSON (no markdown, no explanation, no other text):
{"targetRole":"exact job title","location":"Indian city","experience":"X years","domain":"industry sector","skills":"comma separated top 5 skills"}

Examples of good responses:
{"targetRole":"Area Sales Manager","location":"New Delhi","experience":"6 years","domain":"Financial Services","skills":"sales management, NBFC, loan disbursement, team leadership, client acquisition"}
{"targetRole":"Software Engineer","location":"Bengaluru","experience":"3 years","domain":"Technology","skills":"React, Node.js, Python, AWS, REST APIs"}`;

    const content = isDocx
        ? [{ type: 'text', text: `${prompt}\n\nResume text:\n${buffer.toString('utf8', 0, 4000)}` }]
        : [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
            { type: 'text', text: prompt }
        ];

    try {
        const msg = await claude.messages.create({
            model: 'claude-haiku-4-5-20251001', max_tokens: 600,
            messages: [{ role: 'user', content }]
        });

        const raw = msg.content[0].text.replace(/```json|```/g, '').trim();

        // Layer 1: direct JSON parse
        try {
            const parsed = JSON.parse(raw);
            if (parsed.targetRole || parsed.skills || parsed.domain) {
                console.log('Resume parsed successfully:', JSON.stringify(parsed));
                return parsed;
            }
        } catch {}

        // Layer 2: extract JSON from mixed response
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.targetRole || parsed.skills) {
                    console.log('Resume parsed via regex:', JSON.stringify(parsed));
                    return parsed;
                }
            } catch {}
        }

        // Layer 3: Claude refused — extract from raw PDF text
        console.warn(`Claude could not parse resume (response: "${raw.slice(0, 50)}") — using text fallback`);
    } catch (e) {
        console.error('Claude API error during resume parse:', e.message);
    }

    // Text extraction fallback
    const text = buffer.toString('utf8', 0, 6000).replace(/[^\x20-\x7E\n]/g, ' ');
    const cities = ['Bengaluru','Bangalore','Mumbai','Delhi','Hyderabad','Pune','Chennai','Kolkata','Noida','Gurgaon','Ahmedabad','Jaipur'];
    const foundCity = cities.find(c => text.toLowerCase().includes(c.toLowerCase())) || 'Bengaluru';
    const expMatch = text.match(/(\d+)\+?\s*(?:years?|yrs?)(?:\s*of)?\s*(?:experience|exp)/i);
    const experience = expMatch ? `${expMatch[1]} years` : '3 years';

    // Try to find role from common keywords
    const rolePatterns = [/(?:role|position|title)[:\s]+([A-Za-z\s]{5,40})/i, /(?:am a|working as|designation)[:\s]+([A-Za-z\s]{5,40})/i];
    let targetRole = 'Professional';
    for (const p of rolePatterns) {
        const m = text.match(p);
        if (m) { targetRole = m[1].trim(); break; }
    }

    const result = { targetRole, location: foundCity, experience, domain: 'General', skills: '' };
    console.log('Resume fallback result:', JSON.stringify(result));
    return result;
}

// ── FIX 2: Save to Airtable with phone + cities ───────────────────────────────
async function saveToAirtable(name, email, phone, cities, profile) {
    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) return;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`;
    const headers = { 'Authorization': `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

    // Check if exists
    const check = await fetch(`${url}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}`, { headers });
    const cd = await check.json();
    if (cd.records?.[0]) {
        console.log(`${email} already in Airtable — updating profile`);
        await fetch(`${url}/${cd.records[0].id}`, {
            method: 'PATCH', headers,
            body: JSON.stringify({ fields: { 'Target role': profile.targetRole || '', 'Location': profile.location || '', 'Experience': profile.experience || '', 'Domain': profile.domain || '', 'Skills': profile.skills || '', 'Cities': cities?.join(', ') || '', 'Phone': phone || '', 'Status': 'Active' } })
        });
        return;
    }
    const resp = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ records: [{ fields: { 'Name': name, 'Email': email, 'Phone': phone || '', 'Target role': profile.targetRole || '', 'Location': profile.location || 'Bengaluru', 'Experience': profile.experience || '', 'Domain': profile.domain || '', 'Skills': profile.skills || '', 'Cities': cities?.join(', ') || '', 'Status': 'Active' } }] })
    });
    console.log(`Airtable save: ${resp.status}`);
}

// ── FIX 3: Welcome email via Resend ──────────────────────────────────────────
async function sendWelcomeEmail(name, email) {
    if (!resendClient) { console.log('Resend not set — skip welcome email'); return; }
    const { error } = await resendClient.emails.send({
        from: 'JobMatch AI <onboarding@resend.dev>',
        to: email,
        subject: `Welcome ${name} — your job search is live!`,
        html: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px">
<h2 style="color:#6c63ff;margin-bottom:8px">Your AI job search is running! 🎯</h2>
<p style="color:#6b7280">Hi ${name}, we are scanning LinkedIn, Naukri, iimjobs and more for roles matching your profile.</p>
<p style="background:#eeecff;padding:14px;border-radius:10px;color:#6c63ff;margin:16px 0">✓ Your personalised job digest will arrive within 10 minutes.<br>✓ Fresh matches every morning at 8am IST — zero duplicates.</p>
<p style="font-size:12px;color:#d1d5db">JobMatch AI · Free Beta</p></div>`
    });
    if (error) console.error('Welcome email error:', error);
    else console.log(`Welcome email sent to ${email}`);
}

// ── FIX 4: Trigger Apify actor ────────────────────────────────────────────────
async function triggerApify(email) {
    if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not configured');
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
            maxResultsPerSource: 8,
            filterEmail: email,
        })
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Apify trigger failed: ${resp.status} — ${text.slice(0, 100)}`);
    const runId = JSON.parse(text).data?.id;
    console.log(`Apify run started: ${runId}`);
    return runId;
}

// ── Poll Apify results ────────────────────────────────────────────────────────
async function pollApifyRun(runId) {
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 5000));
        try {
            const resp = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
            const data = await resp.json();
            const status = data?.data?.status;
            console.log(`Apify run ${runId}: ${status}`);
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
app.get('/health', (req, res) => res.json({ status: 'ok', version: '4.0.0' }));

app.get('/debug', async (req, res) => {
    let at = 'untested';
    try { const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}?maxRecords=1`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }); at = `HTTP ${r.status}`; } catch (e) { at = e.message; }
    res.json({ version: '4.0.0', env: { ANTHROPIC_API_KEY: ANTHROPIC_API_KEY ? 'SET' : 'MISSING', AIRTABLE_TOKEN: AIRTABLE_TOKEN ? 'SET' : 'MISSING', AIRTABLE_BASE_ID: AIRTABLE_BASE_ID || 'MISSING', RESEND_API_KEY: RESEND_API_KEY ? 'SET' : 'MISSING', APIFY_TOKEN: APIFY_TOKEN ? 'SET' : 'MISSING', JSEARCH_API_KEY: process.env.JSEARCH_API_KEY ? 'SET' : 'MISSING', ADZUNA_APP_ID: process.env.ADZUNA_APP_ID ? 'SET' : 'MISSING' }, airtableStatus: at });
});

app.get('/results', (req, res) => {
    const { runId } = req.query;
    if (!runId) return res.json({ status: 'pending' });
    const cached = runCache.get(runId);
    if (cached?.ready) return res.json({ status: 'ready', jobs: cached.jobs });
    return res.json({ status: 'pending' });
});

app.post('/signup', upload.single('resume'), async (req, res) => {
    const { name, email, phone, schedule, cities: citiesRaw } = req.body;
    const file = req.file;
    const cities = citiesRaw ? JSON.parse(citiesRaw) : ['Bengaluru'];

    console.log(`\n[${new Date().toISOString()}] Signup: ${name} (${email}) cities=${cities.join(',')}`);

    if (!name || !email) return res.status(400).json({ error: 'Name and email required.' });
    if (!file) return res.status(400).json({ error: 'Resume required.' });

    const cleanup = () => { try { unlinkSync(file.path); } catch {} };

    try {
        const t0 = Date.now();

        // Parse resume with full fallback chain
        console.log('Parsing resume...');
        const buffer = readFileSync(file.path);
        const profile = await parseResume(buffer, file.originalname || file.filename || 'resume.pdf');
        cleanup();
        console.log(`Profile extracted (${Date.now()-t0}ms):`, JSON.stringify(profile));

        // Save to Airtable + send welcome email (non-blocking)
        saveToAirtable(name, email, phone, cities, profile).catch(e => console.error('Airtable error:', e.message));
        sendWelcomeEmail(name, email).catch(e => console.error('Welcome email error:', e.message));

        // Trigger Apify for job scraping
        const runId = await triggerApify(email);

        // Poll in background — website will poll /results
        pollApifyRun(runId).catch(e => console.error('Poll error:', e.message));

        res.json({ success: true, runId, profile, totalTime: Date.now()-t0 });

    } catch (err) {
        cleanup();
        console.error('Signup error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`JobMatch API v4.0 on port ${PORT}`);
    console.log(`Resend: ${RESEND_API_KEY ? 'SET' : 'MISSING'} | Anthropic: ${ANTHROPIC_API_KEY ? 'SET' : 'MISSING'} | Apify: ${APIFY_TOKEN ? 'SET' : 'MISSING'}`);
});
