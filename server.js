import express from 'express';
import multer from 'multer';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import { readFileSync, unlinkSync } from 'fs';

const app = express();
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 5 * 1024 * 1024 } });
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const {
    ANTHROPIC_API_KEY,
    AIRTABLE_TOKEN,
    AIRTABLE_BASE_ID,
    AIRTABLE_TABLE = 'tblJtDvebLwnXvV9i',
    APIFY_TOKEN,
    APIFY_ACTOR_ID = 'flexible_transaction/my-actor',
    SMTP_USER,
    SMTP_PASS,
    PORT = 3000,
} = process.env;

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

async function parseResume(buffer, filename) {
    const isDocx = filename?.endsWith('.docx') || filename?.endsWith('.doc');
    const content = isDocx
        ? [{ type: 'text', text: `Extract from this resume, return ONLY JSON:\n{"targetRole":"","location":"Bengaluru","experience":"","domain":"","skills":""}\n\nResume: ${buffer.toString('utf8', 0, 3000)}` }]
        : [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
            { type: 'text', text: 'Extract from this resume, return ONLY valid JSON (no markdown):\n{"targetRole":"job title","location":"city","experience":"X years","domain":"industry","skills":"top skills"}' }
        ];
    const msg = await client.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content }] });
    return JSON.parse(msg.content[0].text.replace(/```json|```/g, '').trim());
}

async function generateQueries(profile) {
    const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 300,
        messages: [{ role: 'user', content: `Generate 3 specific LinkedIn job search queries for this candidate. Return ONLY a JSON array of strings.\nProfile: ${JSON.stringify(profile)}\nRules: Use their exact domain terms. Each query 3-5 words. Target ${profile.location || 'Bengaluru'}.` }]
    });
    try { return JSON.parse(msg.content[0].text.replace(/```json|```/g, '').trim()); }
    catch { return [`${profile.targetRole} ${profile.location}`, `${profile.domain} ${profile.targetRole}`]; }
}

async function scrapeLinkedIn(query, location, limit = 10) {
    try {
        const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(query)}&location=${encodeURIComponent(location || 'Bengaluru')}&f_TPR=r604800&start=0&count=${limit}`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } });
        if (!resp.ok) return [];
        const html = await resp.text();
        const titles = [...html.matchAll(/class="base-search-card__title"[^>]*>\s*([^<\n]+)/g)];
        const companies = [...html.matchAll(/class="base-search-card__subtitle"[^>]*>[\s\S]*?<a[^>]*>\s*([^<\n]+)/g)];
        const locations = [...html.matchAll(/class="job-search-card__location"[^>]*>\s*([^<\n]+)/g)];
        const links = [...html.matchAll(/href="(https:\/\/[^"]*\/jobs\/view\/[^"?]+)/g)];
        const times = [...html.matchAll(/datetime="([^"]+)"/g)];
        const jobs = [];
        for (let i = 0; i < Math.min(titles.length, limit); i++) {
            const title = titles[i]?.[1]?.trim();
            if (!title) continue;
            jobs.push({ title, company: companies[i]?.[1]?.trim() || 'Unknown', location: locations[i]?.[1]?.trim() || location, jobUrl: links[i]?.[1] || '', postedAt: times[i]?.[1] || 'Recently', source: 'LinkedIn', description: `${title} at ${companies[i]?.[1]?.trim()}` });
        }
        return jobs;
    } catch (e) { console.error('LinkedIn error:', e.message); return []; }
}

async function scoreJobs(jobs, profile) {
    if (!jobs.length) return [];
    const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 4000,
        messages: [{ role: 'user', content: `Score these jobs for this candidate. Return ONLY a JSON array — no markdown.\nCandidate: Role=${profile.targetRole}, Domain=${profile.domain}, Exp=${profile.experience}, Location=${profile.location}\nJobs: ${JSON.stringify(jobs.map((j,i) => ({id:i,title:j.title,company:j.company,location:j.location})))}\nFormat: [{"id":0,"matchScore":85,"fitLabel":"Strong fit","verdict":"One sentence.","pitch":"2-sentence outreach pitch."}]\nRules: 80+ only if role directly matches domain and seniority. Be strict and honest.` }]
    });
    let scores = [];
    try { scores = JSON.parse(msg.content[0].text.replace(/```json|```/g,'').trim()); } catch {}
    const map = {};
    scores.forEach(s => map[s.id] = s);
    return jobs.map((j,i) => ({ ...j, matchScore: map[i]?.matchScore ?? 50, fitLabel: map[i]?.fitLabel ?? 'Unscored', verdict: map[i]?.verdict ?? '', pitch: map[i]?.pitch ?? '' })).sort((a,b) => b.matchScore - a.matchScore);
}

async function saveToAirtable(name, email, profile) {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`;
    const check = await fetch(`${url}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}`, { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } });
    const cd = await check.json();
    if (cd.records?.[0]) { console.log(`${email} already in Airtable`); return; }
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields: { 'Name': name, 'Email': email, 'Target role': profile.targetRole||'', 'Location': profile.location||'Bengaluru', 'Experience': profile.experience||'', 'Domain': profile.domain||'', 'Status': 'Active' } }] })
    });
    console.log(`Airtable save: ${resp.status}`);
}

async function sendEmail(name, email, jobs) {
    if (!SMTP_USER || !SMTP_PASS) { console.log('SMTP missing — skip email'); return; }
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASS } });
    const scoreColor = s => s >= 80 ? '#00c48c' : s >= 65 ? '#5b4fff' : '#888';
    const rows = jobs.slice(0,15).map(j => `
      <tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:14px 12px">
          <div style="font-weight:600;font-size:14px;color:#1a1a2e">${j.title}</div>
          <div style="font-size:12px;color:#666;margin-top:3px">${j.company} · ${j.location}</div>
          ${j.verdict ? `<div style="font-size:12px;color:#555;margin-top:6px">${j.verdict}</div>` : ''}
          ${j.pitch ? `<div style="font-size:12px;color:#444;margin-top:6px;padding:8px;background:#f9f9f9;border-left:3px solid #ddd"><strong>Outreach:</strong> ${j.pitch}</div>` : ''}
        </td>
        <td style="padding:14px 12px;text-align:center;min-width:60px">
          <div style="font-size:24px;font-weight:800;color:${scoreColor(j.matchScore)}">${j.matchScore}%</div>
          <div style="font-size:10px;color:#999">${j.fitLabel}</div>
        </td>
        <td style="padding:14px 12px;text-align:center">
          ${j.jobUrl ? `<a href="${j.jobUrl}" style="background:#5b4fff;color:#fff;padding:7px 14px;border-radius:6px;text-decoration:none;font-size:12px">Apply →</a>` : ''}
        </td>
      </tr>`).join('');
    const html = `<div style="font-family:sans-serif;max-width:700px;margin:0 auto;padding:20px">
<div style="border-bottom:2px solid #5b4fff;padding-bottom:12px;margin-bottom:20px"><h2 style="margin:0;color:#5b4fff">JobMatch AI 🎯</h2><p style="margin:4px 0 0;color:#666;font-size:13px">Hi ${name} — your personalised job matches · ${new Date().toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long'})}</p></div>
<table style="width:100%;border-collapse:collapse"><thead><tr style="background:#f8f8ff"><th style="padding:8px 12px;text-align:left;font-size:12px;color:#666">Role</th><th style="padding:8px;font-size:12px;color:#666">Match</th><th style="padding:8px;font-size:12px;color:#666">Apply</th></tr></thead><tbody>${rows}</tbody></table>
<div style="margin-top:20px;padding:12px;background:#f0f0ff;border-radius:8px;font-size:12px;color:#5b4fff">✓ Fresh job matches will arrive every morning at 8am IST — only roles you haven't seen before.</div>
</div>`;
    await transporter.sendMail({ from: `JobMatch AI <${SMTP_USER}>`, to: email, subject: `${jobs.filter(j=>j.matchScore>=75).length} strong matches found — JobMatch AI`, html });
    console.log(`Email sent to ${email}`);
}

function triggerApifyAsync(email) {
    if (!APIFY_TOKEN) return;
    const actorId = (APIFY_ACTOR_ID || '').replace('/', '~');
    fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ airtableToken: AIRTABLE_TOKEN, airtableBaseId: AIRTABLE_BASE_ID, smtpUser: SMTP_USER, smtpPass: SMTP_PASS, anthropicApiKey: ANTHROPIC_API_KEY, maxResultsPerSource: 6, filterEmail: email })
    }).then(r => console.log(`Apify trigger: ${r.status}`)).catch(e => console.log(`Apify skipped: ${e.message}`));
}

app.get('/health', (req, res) => res.json({ status: 'ok', version: '3.0.0' }));

app.get('/debug', async (req, res) => {
    let airtableStatus = 'not tested';
    try { const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`, { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } }); airtableStatus = `HTTP ${r.status}`; } catch (e) { airtableStatus = e.message; }
    res.json({ env: { ANTHROPIC_API_KEY: ANTHROPIC_API_KEY ? 'SET' : 'MISSING', AIRTABLE_TOKEN: AIRTABLE_TOKEN ? 'SET' : 'MISSING', AIRTABLE_BASE_ID: AIRTABLE_BASE_ID || 'MISSING', APIFY_ACTOR_ID: APIFY_ACTOR_ID, SMTP_USER: SMTP_USER || 'MISSING' }, airtableStatus });
});

app.post('/signup', upload.single('resume'), async (req, res) => {
    const { name, email, schedule } = req.body;
    const file = req.file;
    console.log(`\n[${new Date().toISOString()}] Signup: ${name} (${email})`);
    if (!name || !email) return res.status(400).json({ error: 'Name and email required.' });
    if (!file) return res.status(400).json({ error: 'Resume required.' });
    const cleanup = () => { try { unlinkSync(file.path); } catch {} };
    try {
        const t0 = Date.now();
        console.log('Parsing resume...');
        const buffer = readFileSync(file.path);
        const profile = await parseResume(buffer, file.originalname || file.filename);
        cleanup();
        console.log(`Profile: ${JSON.stringify(profile)} (${Date.now()-t0}ms)`);

        console.log('Generating queries...');
        const queries = await generateQueries(profile);
        console.log(`Queries: ${queries} (${Date.now()-t0}ms)`);

        console.log('Scraping LinkedIn...');
        const results = await Promise.all(queries.slice(0,3).map(q => scrapeLinkedIn(q, profile.location || 'Bengaluru', 10)));
        const seen = new Set();
        let jobs = results.flat().filter(j => { const k = `${j.title?.toLowerCase()}__${j.company?.toLowerCase()}`; if(seen.has(k)) return false; seen.add(k); return true; });
        console.log(`${jobs.length} unique jobs (${Date.now()-t0}ms)`);

        console.log('Scoring with Claude...');
        const scored = await scoreJobs(jobs, profile);
        console.log(`Done. Top: ${scored[0]?.title} @ ${scored[0]?.company} (${scored[0]?.matchScore}%) — Total: ${Date.now()-t0}ms`);

        // Non-blocking side effects
        saveToAirtable(name, email, profile).catch(console.error);
        sendEmail(name, email, scored).catch(console.error);
        triggerApifyAsync(email);

        res.json({ success: true, jobs: scored, profile, totalTime: Date.now()-t0 });
    } catch (err) {
        cleanup();
        console.error('Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`JobMatch API v3 on port ${PORT}`);
    console.log(`SMTP: ${SMTP_USER || 'NOT SET'} | Anthropic: ${ANTHROPIC_API_KEY ? 'SET' : 'NOT SET'}`);
});
