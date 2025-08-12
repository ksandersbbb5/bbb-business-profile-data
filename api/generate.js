import * as cheerio from 'cheerio';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 BBB Profile Scraper' } });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return await res.text();
}

function extractVisibleText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

async function crawl(rootUrl) {
  const start = new URL(rootUrl);
  const visited = new Set();
  const queue = [start.href];
  const texts = [];
  let htmlPages = [];

  while (queue.length && htmlPages.length < 8) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    try {
      const html = await fetchHtml(current);
      htmlPages.push(html);
      const text = extractVisibleText(html);
      if (text) texts.push(text);
      const $ = cheerio.load(html);
      $('a[href]').each((_, el) => {
        try {
          const href = $(el).attr('href');
          if (!href) return;
          const abs = new URL(href, start.href);
          if (abs.origin !== start.origin) return;
          if (queue.length < 25 && !visited.has(abs.href)) queue.push(abs.href);
        } catch {}
      });
    } catch {}
  }
  return { text: texts.join('\n\n'), htmlPages };
}

async function callOpenAI(systemPrompt, userPrompt) {
  if (!OPENAI_API_KEY) {
    const err = new Error('Missing OPENAI_API_KEY');
    err.statusCode = 500;
    throw err;
  }
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2
  };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`OpenAI error: ${res.status} ${errText}`);
    err.statusCode = res.status;
    throw err;
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const startTime = Date.now();

  try {
    const body = await readJsonBody(req);
    const { url } = body || {};
    if (!url) return res.status(400).send('Missing url');

    let parsed;
    try {
      parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('bad protocol');
    } catch {
      return res.status(400).send('Please enter a valid URL.');
    }

    const { text: corpus, htmlPages } = await crawl(parsed.href);
    if (!corpus || corpus.length < 40) {
      return res.status(422).send('Could not extract enough content from the provided site.');
    }

    // Extract all <a> and <img> href/src for social and BBB Seal search
    let allLinks = [];
    let allImgs = [];
    for (const html of htmlPages) {
      const $ = cheerio.load(html);
      $('a[href]').each((_, el) => allLinks.push($(el).attr('href')));
      $('img[src]').each((_, el) => allImgs.push($(el).attr('src')));
    }
    // Prepare for social links & seal
    const allLinksJoined = allLinks.filter(Boolean).join('\n');
    const allImgsJoined = allImgs.filter(Boolean).join('\n');

    // ==== PROMPT INSTRUCTIONS (ALL DATA POINTS) ====
    const systemPrompt = `
You are a BBB AI assistant for extracting business information from a website. Use ONLY the provided content (text and URLs) to answer.
Return STRICT JSON as follows:
{
"description": string,
"clientBase": string,
"ownerDemographic": string,
"productsServices": string,
"hours": string,
"addresses": string,
"phones": string,
"socialMedia": string,
"licenseNumbers": string,
"emails": string,
"paymentMethods": string,
"bbbSeal": string,
"serviceArea": string,
"refundExchangePolicy": string
}

1) Business Description:
Strict, factual summary (≤900 chars, Arial font, never promotional). Do NOT include 'Business Description'. Exclude owner names, location, hours, dates. No links. No advertising.
2) Client Base:
One of: residential, commercial, residential and commercial, government, non-profit.
3) Owner Demographic:
If website text matches EXACTLY (case-insensitive, no variations) one of:
Asian American Owned, Black/African American Owned, African American Owned, Black Owned, Disabled Owned, Employee Owned Owned, Family Owned, Family-Owned, First Responder Owned, Hispanic Owned, Indigenous Owned, LBGTQ Owned, Middle Eastern Owned, Minority Owned, Native American Owned, Pacific Owned, Veteran Owned, Woman Owned
...then output the value. Else 'None'.
4) Products and Services:
List each product/service as a category, 1–4 words each, **capitalize each word, separate with commas**. No numbers/bullets. No service areas. No marketing words. If none, output 'None'.
5) Hours of Operation:
Output each day as: Monday: 09:00 AM - 05:00 PM etc. (12-hour, AM/PM, "Closed" if not open). If not found for all 7 days, output 'None'. Do not make up hours.
6) Address(es):
Extract only **valid physical addresses** in this 3-line format. If more than one, separate with a single blank line:
123 Main St, Suite 400
Boston, MA 02108
USA
If not found, output 'None'.
7) Phone Number(s):
Extract every valid US phone, format as (123) 456-7890 or with ext. if present. Each on its own line. If none, output 'None'.
8) Social Media URLs:
If found, output as:
Facebook: https://www.facebook.com/username
Instagram: ...
(see list). **Do NOT include URLs that are only the root domain** (e.g., facebook.com/). Remove duplicates. Check both header and footer. If none, output 'None'.
9) License Number(s):
For every license found, output all fields:
License Number: ABC-123456
Issuing Authority: ...
License Type: ...
Status: ...
Expiration Date: ...
If a field is missing, use "None". Each license separated by a blank line. If none, output 'None'.
10) Email Addresses:
List all found, each on its own line. If none, output 'None'.
11) Methods of Payment:
Extract and output as comma-separated values (from: ACH, Amazon Payments, American Express, ...). If none, output 'None'.
12) BBB Seal on Website:
If an image file name (from img src) includes "bbb" or "accredited", or text "BBB Accredited" is found in content (not "Site managed by BBB"), output:
FOUND    It appears the BBB Accredited Business Seal IS on this website or the website uses the text BBB Accredited.
If not found, output:
<span style="color: red">NOT FOUND    It appears the BBB Accredited Business Seal is NOT on this website.</span>
13) Service Area:
Extract the service/geographical territory as stated (city, county, state, zip). If none, output 'None'.
14) Refund and Exchange Policy:
Extract if present. If not, output 'None'.

All output must be STRICT JSON. Do NOT invent or hallucinate data.
`;

    const userPrompt = `
Website URL: ${parsed.href}

WEBSITE CONTENT:
${corpus}

ALL <a> LINKS (for social/search):
${allLinksJoined}

ALL <img> SRCs (for BBB Seal):
${allImgsJoined}
`;

    let aiRaw = await callOpenAI(systemPrompt, userPrompt);

    // JSON tolerant parse
    let payload;
    try {
      const jsonMatch = aiRaw.match(/\{[\s\S]*\}$/);
      payload = JSON.parse(jsonMatch ? jsonMatch[0] : aiRaw);
    } catch {
      const fix = await callOpenAI(
        'Return ONLY valid JSON with the same keys as above, nothing else.',
        `Please convert the following into strict JSON: ${aiRaw}`
      );
      payload = JSON.parse(fix);
    }

    const elapsedMs = Date.now() - startTime;

    // Always sanitize fields and handle None
    function clean(v) { return (typeof v === 'string' && v.trim()) ? v.trim() : 'None'; }

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify({
      url: parsed.href,
      elapsed: elapsedMs,
      description: clean(payload.description),
      clientBase: clean(payload.clientBase),
      ownerDemographic: clean(payload.ownerDemographic),
      productsServices: clean(payload.productsServices),
      hours: clean(payload.hours),
      addresses: clean(payload.addresses),
      phones: clean(payload.phones),
      socialMedia: clean(payload.socialMedia),
      licenseNumbers: clean(payload.licenseNumbers),
      emails: clean(payload.emails),
      paymentMethods: clean(payload.paymentMethods),
      bbbSeal: clean(payload.bbbSeal),
      serviceArea: clean(payload.serviceArea),
      refundExchangePolicy: clean(payload.refundExchangePolicy)
    }));

  } catch (err) {
    const code = err.statusCode || 500;
    return res.status(code).send(err.message || 'Internal Server Error');
  }
}
