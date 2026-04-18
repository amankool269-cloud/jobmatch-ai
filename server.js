import express from 'express';
import multer from 'multer';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, unlinkSync } from 'fs';


const app = express();
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 5 * 1024 * 1024 } });
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // parse HTML form POST bodies
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
    let hash = 0;
    const str = email.toLowerCase() + UNSUB_SECRET;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8,'0') + str.length.toString(16);
}
function validToken(email, token) {
    if (!token || !email) return false;
    // Try current secret first
    if (makeToken(email) === token) return true;
    // Fallback: try alternative secrets for backwards compatibility
    // (old emails may have been generated with different secret)
    const fallbacks = ['jobmatch-secret-2026', 'jobmatch2024', 'secret'];
    return fallbacks.some(s => {
        let hash = 0;
        const str = email.toLowerCase() + s;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        const t = Math.abs(hash).toString(16).padStart(8,'0') + str.length.toString(16);
        return t === token;
    });
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
  "domain": "PRIMARY industry the person wants to work in NEXT — based on their most recent 2 roles and stated target. Use the most specific term: Fintech / NBFC / Digital Lending / Payments / SaaS / EdTech / HealthTech / E-commerce / IT Services / FMCG / Manufacturing / Consulting. If multi-domain, pick the DOMINANT recent one.",
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

CRITICAL RULES for domain:
1. Use the MOST RECENT 2 jobs to determine domain — not older jobs
2. If the person has recently moved domains (e.g., pharma → fintech), use the LATEST domain
3. Be specific — "Fintech" not "Financial Services", "SaaS" not "Technology"
4. If person is in Partnerships/Growth/BD, the domain is the INDUSTRY they work in, not their function

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
            model: 'claude-haiku-4-5-20251001', max_tokens: 400,
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

// ── Store resume in Airtable as base64 attachment ────────────────────────────
async function storeResume(email, buffer, filename) {
    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) return;
    try {
        // Wait 3s for Airtable record to be created first
        await new Promise(r => setTimeout(r, 3000));
        const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`;
        const headers = { 'Authorization': `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
        // Find user record
        const check = await fetch(`${url}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}`, { headers });
        const data = await check.json();
        const rec = data.records?.[0];
        if (!rec) { console.error(`Resume store: no Airtable record found for ${email}`); return; }
        // Store resume as base64 string
        const base64 = buffer.toString('base64');
        const mimeType = filename?.endsWith('.docx') || filename?.endsWith('.doc')
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/pdf';
        const patchResp = await fetch(`${url}/${rec.id}`, {
            method: 'PATCH', headers,
            body: JSON.stringify({ fields: {
                'Resume Filename': filename || 'resume.pdf',
                'Resume Base64': base64.slice(0, 99000),
                'Resume Type': mimeType,
                'Resume Uploaded At': new Date().toISOString(),
            }})
        });
        if (!patchResp.ok) {
            const err = await patchResp.text();
            console.error(`Resume store PATCH failed (${patchResp.status}): ${err}`);
            return;
        }
        console.log(`✅ Resume stored for ${email} (${Math.round(buffer.length/1024)}KB)`);
    } catch (e) {
        console.error('Resume storage error:', e.message);
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
                subject: `You're set, ${name} — first matches arriving within 10 minutes`,
                htmlContent: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:540px;margin:0 auto;background:#f9fafb;padding:24px">
<div style="background:#0055FF;border-radius:14px;padding:22px 26px;margin-bottom:20px">
  <div style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.02em">JobMatch AI</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:3px">Your AI-powered job search is now live</div>
</div>
<div style="background:#fff;border-radius:12px;padding:20px 22px;margin-bottom:14px;border:1px solid #e5e7eb">
  <p style="color:#111;font-size:15px;font-weight:600;margin:0 0 12px">Hi ${name},</p>
  <p style="color:#374151;font-size:13px;line-height:1.7;margin:0 0 16px">We've read your resume and built your profile. We're now scanning <strong>LinkedIn, Naukri, Indeed, Glassdoor</strong> and more for roles that match you specifically.</p>
  <div style="background:#f0f4ff;border-radius:10px;padding:14px 16px;font-size:13px;color:#374151;margin-bottom:16px">
    <div style="font-size:10px;font-weight:700;color:#0055FF;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:8px">Your profile</div>
    <b>Target role:</b> ${profile.targetRole || profile.currentRole}<br>
    <b>Industry:</b> ${profile.domain}<br>
    <b>Experience:</b> ${profile.experience} &middot; ${profile.seniority}<br>
    <b>Top skills:</b> ${(profile.skills||'').split(',').slice(0,4).join(', ')}
  </div>
  <div style="font-size:13px;color:#374151;line-height:1.8">
    <div style="margin-bottom:6px">&#9989; First results arriving <strong>within 10 minutes</strong></div>
    <div style="margin-bottom:6px">&#9989; Daily digest every morning at <strong>9am IST</strong></div>
    <div style="margin-bottom:6px">&#9989; Every match includes a <strong>personalised recruiter pitch</strong></div>
    <div>&#9989; <strong>Zero duplicate jobs</strong> — ever</div>
  </div>
</div>
<p style="font-size:11px;color:#9ca3af;text-align:center;margin:0">JobMatch AI &middot; Free Beta &middot; <a href="mailto:hello@jobmatchai.co.in" style="color:#0055FF">hello@jobmatchai.co.in</a></p>
</div>`
            })
        });
        const result = await resp.json();
        if (!resp.ok) {
            const errMsg = result?.message || result?.error || JSON.stringify(result);
            console.error(`Welcome email FAILED for ${email}: ${resp.status} — ${errMsg}`);
            // Don't throw — still complete signup, just log the email failure
            return;
        }
        console.log(`Welcome email sent to ${email} (messageId: ${result.messageId})`);
    } catch (e) {
        console.error('Welcome email error:', e.message);
    }
}

// ── Trigger Apify actor ───────────────────────────────────────────────────────
async function triggerApify(name, email, profile, cities) {
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
            maxResultsPerSource: 10,
            filterEmail: email,
            unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET || 'jobmatch-secret-2026',
            // Pass full profile directly so actor doesn't re-fetch from Airtable
            // This fixes the race condition where Airtable write hasn't committed yet
            inlineProfile: {
                name: name || email.split('@')[0],
                email,
                targetRole:   profile.targetRole   || profile.currentRole || '',
                currentRole:  profile.currentRole  || '',
                experience:   profile.experience   || '3 years',
                seniority:    profile.seniority    || 'mid-level',
                domain:       profile.domain       || '',
                skills:       profile.skills       || '',
                education:    profile.education    || '',
                companyType:  profile.companyType  || '',
                location:     profile.location     || (cities?.[0] || 'Bengaluru'),
                cities:       cities               || ['Bengaluru'],
            },
        })
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Apify: ${resp.status} — ${text.slice(0, 100)}`);
    const runId = JSON.parse(text).data?.id;
    console.log(`Apify run: ${runId}`);
    return runId;
}

// ── Poll Apify ────────────────────────────────────────────────────────────────
// pollApifyRun is now lightweight — just warms the cache if server is awake
// The real status check happens in /results route directly via Apify API
// This survives Render restarts because runId is sent back to the frontend
async function pollApifyRun(runId) {
    // Still poll server-side to warm cache when server stays alive
    for (let i = 0; i < 72; i++) {
        await new Promise(r => setTimeout(r, 5000));
        try {
            const resp = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
            const data = await resp.json();
            const status = data?.data?.status;
            console.log(`Apify ${runId}: ${status}`);
            if (status === 'SUCCEEDED') {
                const dsResp = await fetch(`https://api.apify.com/v2/datasets/${data.data.defaultDatasetId}/items?token=${APIFY_TOKEN}&limit=200`);
                const items = await dsResp.json();
                const jobs = Array.isArray(items) ? items : [];
                console.log(`Poll: ${runId} SUCCEEDED — ${jobs.length} jobs in dataset`);
                runCache.set(runId, { ready: true, jobs });
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

app.get('/results', async (req, res) => {
    const { runId } = req.query;
    if (!runId) return res.json({ status: 'pending' });

    // 1. Check in-memory cache first (fast path)
    const cached = runCache.get(runId);
    if (cached?.ready) return res.json({ status: 'ready', jobs: cached.jobs });

    // 2. Cache miss (server restarted) — check Apify directly
    // This is the key fix: runId is safe to pass to Apify even after restart
    if (!APIFY_TOKEN) return res.json({ status: 'pending' });
    try {
        const resp = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
        if (!resp.ok) return res.json({ status: 'pending' });
        const data = await resp.json();
        const status = data?.data?.status;
        console.log(`/results direct Apify check: ${runId} → ${status}`);

        if (status === 'SUCCEEDED') {
            const dsResp = await fetch(`https://api.apify.com/v2/datasets/${data.data.defaultDatasetId}/items?token=${APIFY_TOKEN}&limit=200`);
            const items = await dsResp.json();
            const jobs = Array.isArray(items) ? items : [];
            const above55 = jobs.filter(j => (j.matchScore||0) >= 55).length;
            console.log(`/results: ${runId} SUCCEEDED — ${jobs.length} total jobs, ${above55} above 55%`);
            runCache.set(runId, { ready: true, jobs });
            setTimeout(() => runCache.delete(runId), 3600000);
            return res.json({ status: 'ready', jobs });
        }
        if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
            runCache.set(runId, { ready: true, jobs: [] });
            return res.json({ status: 'ready', jobs: [] });
        }
        // Still RUNNING or READY
        return res.json({ status: 'pending' });
    } catch (e) {
        console.error(`/results Apify check error: ${e.message}`);
        return res.json({ status: 'pending' });
    }
});

app.post('/signup', upload.single('resume'), async (req, res) => {
    const { name, email, phone, cities: citiesRaw, industry } = req.body;
    const file = req.file;
    const cities = citiesRaw ? JSON.parse(citiesRaw) : ['Bengaluru'];

    console.log(`\n[${new Date().toISOString()}] Signup: ${name} (${email})`);

    if (!name || !email) return res.status(400).json({ error: 'Name and email required.' });
    if (!file) return res.status(400).json({ error: 'Resume required.' });

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

    // Block obviously disposable/temp email domains
    const disposableDomains = /mailinator\.|guerrillamail\.|tempmail\.|throwaway\.|yopmail\.|sharklasers\.|trashmail\.|maildrop\.|dispostable\.|spamgourmet\.|fakeinbox\.|temp-mail\.|getairmail\.|mailnull\.|spamhole\.|discard\.email/i;
    if (disposableDomains.test(email)) return res.status(400).json({ error: 'Disposable email addresses are not allowed. Please use your work or personal email.' });

    const cleanup = () => { try { unlinkSync(file.path); } catch {} };

    try {
        const t0 = Date.now();
        console.log('Parsing resume (10 fields)...');
        const buffer = readFileSync(file.path);
        const profile = await parseResume(buffer, file.originalname || 'resume.pdf');
        cleanup();
        // Store resume for future analysis (non-blocking)
        storeResume(email, buffer, file.originalname || 'resume.pdf').catch(e => console.error('Resume store:', e.message));
        console.log(`Profile (${Date.now()-t0}ms):`, JSON.stringify(profile));

        // ── Guard: detect corrupted / unreadable resume ─────────────────
        const isCorrupted = profile.currentRole?.toLowerCase().includes('unable to extract')
            || profile.currentRole?.toLowerCase().includes('corrupted')
            || !profile.currentRole
            || profile.currentRole === 'Professional';

        if (isCorrupted) {
            console.warn(`Corrupted resume for ${email} — skipping Apify, sending re-upload email`);
            saveToAirtable(name, email, phone, cities, { ...profile, Status: 'Needs Resume' }).catch(e => console.error('Airtable:', e.message));
            // Send re-upload email instead of welcome
            await fetch('https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: { 'accept': 'application/json', 'api-key': BREVO_API_KEY, 'content-type': 'application/json' },
                body: JSON.stringify({
                    sender: { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL },
                    to: [{ email, name }],
                    subject: 'Quick fix needed for your JobMatch AI profile',
                    htmlContent: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px">
<div style="background:#0055FF;border-radius:12px;padding:20px 24px;margin-bottom:20px">
  <div style="font-size:18px;font-weight:700;color:#fff">JobMatch AI</div>
</div>
<p style="color:#374151;font-size:14px;margin-bottom:16px">Hi <strong>${name}</strong>,</p>
<p style="color:#374151;font-size:14px;margin-bottom:16px">Thank you for signing up! Unfortunately we were unable to read your resume — it may be password-protected, scanned as an image, or in an unsupported format.</p>
<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px;margin-bottom:16px;font-size:13px;color:#dc2626">
  Please re-upload your resume and make sure it is:<br><br>
  ✓ A text-based PDF or Word document (.docx)<br>
  ✓ Not password protected<br>
  ✓ Under 5MB
</div>
<a href="https://jobmatch-ai-z19k.onrender.com" style="display:inline-block;background:#0055FF;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600">Re-upload resume →</a>
<p style="font-size:11px;color:#9ca3af;margin-top:20px">JobMatch AI · hello@jobmatchai.co.in</p>
</div>`
                })
            }).catch(e => console.error('Re-upload email error:', e.message));
            return res.json({ success: true, runId: null, profile, corrupted: true, totalTime: Date.now()-t0 });
        }

        // Override AI-parsed domain with user-selected industry if provided
        if (industry && industry.trim() && industry !== 'Other') {
            profile.domain = industry.trim();
            console.log(`Domain overridden by user selection: ${profile.domain}`);
        }

        // Await Airtable save before triggering Apify (prevents race condition)
        await saveToAirtable(name, email, phone, cities, profile).catch(e => console.error('Airtable:', e.message));
        sendWelcomeEmail(name, email, profile).catch(e => console.error('Email:', e.message));

        const runId = await triggerApify(name, email, profile, cities);
        pollApifyRun(runId).catch(e => console.error('Poll:', e.message));

        res.json({ success: true, runId, profile, totalTime: Date.now()-t0 });
    } catch (err) {
        cleanup();
        console.error('Signup error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Feedback routes ───────────────────────────────────────────────────────────
app.get('/feedback', async (req, res) => {
    const { email, rating, token } = req.query;
    if (!email || !rating || !token || !validToken(email, token)) {
        return res.status(400).send(page('Invalid link', 'This feedback link is invalid.', '', ''));
    }
    const r = parseInt(rating);
    if (r < 1 || r > 5) return res.status(400).send(page('Invalid rating', 'Rating must be 1-5.', '', ''));

    try {
        const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`;
        const headers = { 'Authorization': `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
        const check = await fetch(`${url}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}`, { headers });
        const data = await check.json();
        const rec = data.records?.[0];
        if (!rec) return res.send(page('Not found', 'We could not find your account.', '', ''));

        // Try saving rating as number, then as string
        // Airtable field type determines which works
        let saved = false;
        for (const val of [r, String(r), ['😞','😐','🙂','😊','🤩'][r-1]]) {
            const sr = await fetch(`${url}/${rec.id}`, {
                method: 'PATCH', headers,
                body: JSON.stringify({ fields: { 'Rating': val } })
            });
            const sd = await sr.json();
            if (sr.ok) {
                console.log(`Rating ${r} (as ${typeof val}) saved for ${email} ✅`);
                saved = true;
                break;
            } else {
                console.error(`Rating save failed with value "${val}" (${sr.status}): ${sd?.error?.message}`);
            }
        }
        if (!saved) console.error(`All rating save attempts failed for ${email}`);

        const stars = '★'.repeat(r) + '☆'.repeat(5 - r);
        res.send(feedbackPage(stars, r, email, token));
    } catch (e) {
        res.status(500).send(page('Error', 'Something went wrong. Please try again.', '', ''));
    }
});

app.post('/feedback/comment', async (req, res) => {
    const email = req.query.email || req.body.email;
    const token = req.query.token || req.body.token;
    const rating = req.query.rating || req.body.rating;
    const comment = req.body.comment;
    // Token already validated on GET /feedback — just need email here
    if (!email) {
        return res.status(400).send(page('Invalid link', 'Email is missing.', '', ''));
    }
    try {
        const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`;
        const headers = { 'Authorization': `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
        const check = await fetch(`${url}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}`, { headers });
        const data = await check.json();
        const rec = data.records?.[0];
        if (!rec) {
            console.error(`Feedback comment: user not found for ${email}`);
            return res.send(page('Thank you!', 'Your feedback has been noted.', '', ''));
        }
        const saveResp = await fetch(`${url}/${rec.id}`, {
            method: 'PATCH', headers,
            body: JSON.stringify({ fields: { 'Feedback': comment || '' } })
        });
        const saveData = await saveResp.json();
        if (!saveResp.ok) {
            console.error(`Feedback comment save failed: ${JSON.stringify(saveData)}`);
        } else {
            console.log(`Feedback comment saved for ${email}: "${(comment||'').slice(0,50)}"`);
        }
        res.send(page('Thank you! 🙏', 'Your feedback helps us improve the matches for everyone.', '', ''));
    } catch (e) {
        res.status(500).send(page('Error', 'Something went wrong.', '', ''));
    }
});

function feedbackPage(stars, rating, email, token) {
    const msgs = ["", "Sorry to hear that. We'll do better.", "Thanks — we'll improve.", "Good to know, we're working on it.", "Great — glad it's useful!", "Amazing! You made our day."];
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feedback — JobMatch AI</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#FAFAFA;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem}
.card{background:#fff;border:1px solid rgba(0,0,0,0.08);border-radius:20px;padding:2.5rem;max-width:440px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.06)}
.logo{font-size:1.1rem;font-weight:700;color:#0055FF;margin-bottom:1.5rem}
.stars{font-size:2rem;color:#f59e0b;margin-bottom:0.75rem;letter-spacing:4px}
h1{font-size:1.2rem;font-weight:600;color:#111;margin-bottom:0.5rem}
p{font-size:0.88rem;color:#666;margin-bottom:1.5rem;line-height:1.6}
textarea{width:100%;border:1.5px solid #e5e7eb;border-radius:10px;padding:10px 12px;font-size:0.88rem;font-family:inherit;resize:vertical;min-height:90px;outline:none;margin-bottom:1rem}
textarea:focus{border-color:#0055FF}
.btn{width:100%;padding:0.75rem;background:#0055FF;color:#fff;border:none;border-radius:10px;font-size:0.88rem;font-weight:600;cursor:pointer}
.skip{display:block;margin-top:0.75rem;font-size:0.78rem;color:#999;text-decoration:none}
.skip:hover{color:#0055FF}
</style>
</head>
<body>
<div class="card">
  <div class="logo">JobMatch AI</div>
  <div class="stars">${stars}</div>
  <h1>${msgs[rating]}</h1>
  <p>Want to tell us more? Takes 10 seconds.</p>
  <form method="POST" action="/feedback/comment?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}">
    <input type="hidden" name="email" value="${email}">
    <input type="hidden" name="token" value="${token}">
    <input type="hidden" name="rating" value="${rating}">
    <textarea name="comment" placeholder="What would make your matches better? Any specific roles or companies you'd like to see?"></textarea>
    <button type="submit" class="btn">Send feedback</button>
  </form>
  <a href="/" class="skip">Skip — go back to JobMatch AI</a>
</div>
</body>
</html>`;
}

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
