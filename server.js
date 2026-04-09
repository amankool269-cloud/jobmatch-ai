import express from 'express';
import multer from 'multer';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import { readFileSync } from 'fs';

const app = express();
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 5 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const {
    ANTHROPIC_API_KEY,
    AIRTABLE_TOKEN,
    AIRTABLE_BASE_ID,
    AIRTABLE_TABLE,
    APIFY_TOKEN,
    APIFY_ACTOR_ID,
    SMTP_USER,
    SMTP_PASS,
    PORT = 3000,
} = process.env;

// In-memory store for run results (use Redis in production)
const runResults = new Map();

// ─── Parse resume with Claude ─────────────────────────────────────────────────
async function parseResume(fileBuffer, filename) {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const isDocx = filename?.endsWith('.docx') || filename?.endsWith('.doc');

    let content;
    if (isDocx) {
        // For DOCX, send as plain text extraction prompt
        content = [{
            type: 'text',
            text: `This is a resume file. Extract the key information and return ONLY valid JSON:
{
  "targetRole": "most recent job title or target role",
  "location": "city preference (default Bengaluru if unclear)",
  "experience": "total years as string",
  "domain": "primary industry",
  "currentCompany": "current or last company",
  "skills": "top skills comma separated"
}

File content (may be garbled for binary files — do your best): ${fileBuffer.toString('utf8', 0, 3000)}`
        }];
    } else {
        // PDF — send as document
        const base64 = fileBuffer.toString('base64');
        content = [
            {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: base64 },
            },
            {
                type: 'text',
                text: `Extract from this resume and return ONLY valid JSON (no markdown):
{
  "targetRole": "most recent job title or target role (e.g. Senior Manager Partnerships)",
  "location": "preferred city (e.g. Bengaluru)",
  "experience": "total years as string (e.g. 9 years)",
  "domain": "primary industry (e.g. Fintech, NBFC, HR, IT, SaaS)",
  "currentCompany": "current or most recent company",
  "skills": "top 4 skills comma separated"
}`
            }
        ];
    }

    const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content }],
    });

    const raw = message.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(raw);
}

// ─── Save user to Airtable ────────────────────────────────────────────────────
async function saveToAirtable(name, email, phone, profile, schedule) {
    // Use table ID directly — never fails regardless of table name
    const tableId = process.env.AIRTABLE_TABLE || 'tblJtDvebLwnXvV9i';
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}`;
    console.log(`Saving to Airtable: ${url}`);

    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            records: [{
                fields: {
                    'Name': name,
                    'Email': email,
                    'Phone': phone || '',
                    'Target role': profile.targetRole || '',
                    'Location': profile.location || 'Bengaluru',
                    'Experience': profile.experience || '',
                    'Domain': profile.domain || '',
                    'Status': schedule === '1' ? 'Active' : 'One-time',
                    'Joined': new Date().toISOString().split('T')[0],
                }
            }]
        })
    });
    if (!resp.ok) throw new Error(`Airtable: ${resp.status}`);
    const data = await resp.json();
    return data.records[0].id;
}

// ─── Send welcome email ───────────────────────────────────────────────────────
async function sendWelcomeEmail(name, email, schedule) {
    if (!SMTP_USER || !SMTP_PASS) return;
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    await transporter.sendMail({
        from: `JobMatch AI <${SMTP_USER}>`,
        to: email,
        subject: `Welcome ${name} — your job search is running!`,
        html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:2rem;color:#1a1a2e">
  <h2 style="color:#5b4fff;margin-bottom:.5rem">Your AI job search is live 🎯</h2>
  <p style="color:#6b6b80;margin-bottom:1.5rem">Hi ${name}, we're scanning LinkedIn, Naukri and Indeed right now. Your personalised matches will arrive in this inbox within 10 minutes.</p>
  ${schedule === '1' ? '<p style="background:#f0f0ff;padding:1rem;border-radius:8px;color:#5b4fff;font-size:.9rem">✓ Daily digest scheduled — fresh matches every morning at 8am IST</p>' : ''}
  <p style="margin-top:2rem;font-size:.8rem;color:#aaa">JobMatch AI · Free during beta</p>
</div>`
    });
}

// ─── Trigger Apify actor ──────────────────────────────────────────────────────
async function triggerApify(name, email, profile, schedule) {
    const resp = await fetch(
        `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                airtableToken: AIRTABLE_TOKEN,
                airtableBaseId: AIRTABLE_BASE_ID,
                smtpUser: SMTP_USER,
                smtpPass: SMTP_PASS,
                anthropicApiKey: ANTHROPIC_API_KEY,
                maxResultsPerSource: 8,
                filterEmail: email,
            })
        }
    );
    if (!resp.ok) throw new Error(`Apify trigger: ${resp.status}`);
    const data = await resp.json();
    return data.data?.id;
}

// ─── Poll Apify run results ───────────────────────────────────────────────────
async function pollApifyResults(runId) {
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const runResp = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
        const runData = await runResp.json();
        const status = runData?.data?.status;
        if (status === 'SUCCEEDED') {
            const datasetId = runData.data.defaultDatasetId;
            const itemsResp = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`);
            const items = await itemsResp.json();
            return Array.isArray(items) ? items : [];
        }
        if (status === 'FAILED' || status === 'ABORTED') return [];
    }
    return [];
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile('index.html', { root: '.' }));

app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.0.0' }));

// Temporary debug endpoint — remove after fixing
app.get('/debug', async (req, res) => {
    const baseId = AIRTABLE_BASE_ID || 'MISSING';
    const token = AIRTABLE_TOKEN ? AIRTABLE_TOKEN.slice(0, 20) + '...' : 'MISSING';
    const tableId = 'tblJtDvebLwnXvV9i';
    const url = `https://api.airtable.com/v0/${baseId}/${tableId}`;

    let airtableStatus = 'not tested';
    try {
        const r = await fetch(url, {
            headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
        });
        airtableStatus = `HTTP ${r.status}`;
        if (!r.ok) {
            const body = await r.text();
            airtableStatus += ` — ${body.slice(0, 200)}`;
        }
    } catch (e) {
        airtableStatus = `fetch error: ${e.message}`;
    }

    res.json({
        env: {
            AIRTABLE_BASE_ID: baseId,
            AIRTABLE_TOKEN: token,
            APIFY_ACTOR_ID: APIFY_ACTOR_ID || 'MISSING',
            SMTP_USER: SMTP_USER || 'MISSING',
            ANTHROPIC_API_KEY: ANTHROPIC_API_KEY ? 'SET' : 'MISSING',
        },
        airtableUrl: url,
        airtableStatus,
    });
});

// Signup + trigger
app.post('/signup', upload.single('resume'), async (req, res) => {
    const { name, email, phone, schedule } = req.body;
    const file = req.file;

    console.log(`\nNew signup: ${name} (${email}) schedule=${schedule}`);

    if (!name || !email) return res.status(400).json({ error: 'Name and email required.' });
    if (!file) return res.status(400).json({ error: 'Resume file required.' });

    try {
        // 1. Parse resume
        const buffer = readFileSync(file.path);
        const profile = await parseResume(buffer, file.originalname || file.filename);
        console.log('Profile extracted:', profile);

        // 2. Save to Airtable (non-blocking — don't fail if Airtable errors)
        try {
            await saveToAirtable(name, email, phone, profile, schedule);
            console.log('Airtable: user saved successfully');
        } catch (airtableErr) {
            console.warn('Airtable save failed (non-fatal):', airtableErr.message);
            // Continue anyway — user still gets job results
        }

        // 3. Send welcome email
        sendWelcomeEmail(name, email, schedule).catch(console.error);

        // 4. Trigger Apify
        const runId = await triggerApify(name, email, profile, schedule);
        console.log(`Apify run started: ${runId}`);

        // 5. Poll results in background and cache them
        pollApifyResults(runId).then(jobs => {
            console.log(`Run ${runId} finished: ${jobs.length} jobs for ${email}`);
            runResults.set(runId, { jobs, email, ready: true });
            // Clean up after 1 hour
            setTimeout(() => runResults.delete(runId), 3600000);
        }).catch(console.error);

        // Return immediately with runId
        res.json({
            success: true,
            message: `Welcome ${name}! Your search is running.`,
            apifyRunId: runId,
            profile,
        });

    } catch (err) {
        console.error('Signup error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Poll results endpoint
app.get('/results', (req, res) => {
    const { runId, email } = req.query;
    const result = runResults.get(runId);
    if (result?.ready) {
        res.json({ status: 'ready', jobs: result.jobs });
    } else {
        res.json({ status: 'pending' });
    }
});

app.listen(PORT, () => {
    console.log(`JobMatch API v2 running on port ${PORT}`);
    console.log(`Actor ID: ${APIFY_ACTOR_ID}`);
});
