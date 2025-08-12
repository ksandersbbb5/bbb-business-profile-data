import * as cheerio from 'cheerio';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}

function sameOrigin(u1, u2) { return u1.origin === u2.origin; }
function pathLevel(u) { return u.pathname.split('/').filter(Boolean).length; }

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
  const htmls = [];

  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    try {
      const html = await fetchHtml(current);
      htmls.push(html);
      const text = extractVisibleText(html);
      if (text) texts.push(text);
      const $ = cheerio.load(html);
      $('a[href]').each((_, el) => {
        try {
          const href = $(el).attr('href');
          if (!href) return;
          const abs = new URL(href, start.href);
          if (!sameOrigin(start, abs)) return;
          if (pathLevel(abs) <= 1) {
            if (!visited.has(abs.href) && queue.length < 25) queue.push(abs.href);
          }
        } catch {}
      });
    } catch {}
  }
  return { text: texts.join('\n\n'), htmls };
}

async function callOpenAI(systemPrompt, userPrompt) {
  if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
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
    throw new Error(`OpenAI error: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// Helper: Remove root social URLs (e.g. facebook.com/) from results
function filterValidSocialLinks(arr) {
  return arr.filter(url => {
    try {
      const u = new URL(url);
      return u.pathname.length > 1; // At least one segment after the slash
    } catch {
      return false;
    }
  });
}

// Helper: Remove duplicate social URLs
function uniqueArr(arr) {
  return [...new Set(arr)];
}

// Helper: Returns a regex for extracting emails
function extractEmails(text) {
  const matches = (text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []);
  return uniqueArr(matches);
}

// Helper: Extract phone numbers (US formats, robust)
function extractPhones(text) {
  const phoneRegex = /(?:\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4}))(?:\s*(?:ext\.?|x|extension)\s*(\d+))?/g;
  const phones = [];
  let match;
  while ((match = phoneRegex.exec(text))) {
    let formatted = `(${match[1]}) ${match[2]}-${match[3]}`;
    if (match[4]) formatted += ` ext. ${match[4]}`;
    phones.push(formatted);
  }
  return uniqueArr(phones);
}

// Helper: Extract and format addresses, allowing for three lines, and group by 3 with blank line
function extractAddresses(text) {
  const lines = text.split('\n').map(line => line.trim());
  const addresses = [];
  // Matches: 123 Main St, Boston, MA 02108
  const addressRegex = /(\d{1,6}[\w\s\.,#-]*),?\s*([A-Za-z\s]+),?\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)/g;
  let match;
  while ((match = addressRegex.exec(text))) {
    const line1 = match[1];
    const city = match[2].replace(/,$/, '').trim();
    const state = match[3].trim();
    const zip = match[4];
    addresses.push(`${line1}\n${city}, ${state} ${zip}\nUSA`);
  }
  return uniqueArr(addresses);
}

// Helper: Remove duplicate license blocks
function uniqueBlocks(blocks) {
  return blocks.filter((item, pos) => blocks.indexOf(item) === pos);
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

    const { text: corpus, htmls } = await crawl(parsed.href);
    if (!corpus || corpus.length < 40) {
      return res.status(422).send('Could not extract enough content from the provided site.');
    }

    // System prompt: All fields!
    const systemPrompt = `
You are a BBB data extraction assistant. Strictly use only the website content.
Return a JSON object with the following keys:
- description: Strictly factual summary, no promotion. <=900 chars.
- clientBase: residential, commercial, residential and commercial, government, non-profit.
- ownerDemographic: (from exact list, else None).
- productsAndServices: comma-separated, each product/service 1-4 words, no made up, no bullets, each word capitalized, e.g. Landscaping Design, Landscape Maintenance.
- hoursOfOperation: List hours for each day, Mon-Sun, or None.
- addresses: List all physical addresses, each as three lines (see example), or None.
- phoneNumbers: All US phone numbers, (XXX) XXX-XXXX ext. XXXX format, one per row, or None.
- socialMediaUrls: List all, one per row, and only valid URLs (must have path after domain), or None.
- licenseNumbers: All licenses, each as multi-line block: License Number: <value>\nIssuing Authority: <value or None>\nLicense Type: <value or None>\nStatus: <value or None>\nExpiration Date: <value or None>. Blank line between licenses, or None.
- emailAddresses: All found, one per row, or None.
- methodsOfPayment: List from approved list, comma-separated, or None.
- bbbSeal: If any image on site has "bbb" or "accredited" in filename, or text "BBB Accredited" (not "site managed by BBB"), return FOUND, else return NOT FOUND in red font.
- serviceArea: All counties/cities/states/zip codes served, comma-separated, or None.
- refundAndExchangePolicy: If found, output policy as plain text, else None.

Formatting rules:
- Never make up information.
- If not found, return "None" (without quotes).
- Use correct linebreaks and case per above.
`;

    const userPrompt = `Website URL: ${parsed.href}

WEBSITE CONTENT (verbatim):

${corpus}

NOTE: Do not fabricate data. If field is not found, return "None".`;

    let aiRaw = await callOpenAI(systemPrompt, userPrompt);

    // Try parsing the JSON
    let payload;
    try {
      const jsonMatch = aiRaw.match(/\{[\s\S]*\}$/);
      payload = JSON.parse(jsonMatch ? jsonMatch[0] : aiRaw);
    } catch (e) {
      // Try asking GPT to fix its own output
      const fix = await callOpenAI(
        'Return ONLY valid JSON with all the above fields and correct linebreaks, no extra explanation.',
        `Convert to valid JSON:\n${aiRaw}`
      );
      payload = JSON.parse(fix);
    }

    // Process/clean up payload fields as needed
    // Social media: filter only those with path
    if (payload.socialMediaUrls && typeof payload.socialMediaUrls === "string") {
      let arr = payload.socialMediaUrls.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      arr = filterValidSocialLinks(arr);
      arr = uniqueArr(arr);
      payload.socialMediaUrls = arr.length ? arr.join('\n') : "None";
    }

    // Phone numbers: ensure one per line, unique
    if (payload.phoneNumbers && typeof payload.phoneNumbers === "string") {
      let arr = payload.phoneNumbers.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      arr = uniqueArr(arr);
      payload.phoneNumbers = arr.length ? arr.join('\n') : "None";
    }

    // Emails: one per line, unique
    if (payload.emailAddresses && typeof payload.emailAddresses === "string") {
      let arr = payload.emailAddresses.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      arr = uniqueArr(arr);
      payload.emailAddresses = arr.length ? arr.join('\n') : "None";
    }

    // Addresses: one per block with blank line between
    if (payload.addresses && typeof payload.addresses === "string" && payload.addresses !== "None") {
      let arr = payload.addresses.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
      arr = uniqueArr(arr);
      payload.addresses = arr.length ? arr.join('\n\n') : "None";
    }

    // License numbers: multi-line blocks, blank line between
    if (payload.licenseNumbers && typeof payload.licenseNumbers === "string" && payload.licenseNumbers !== "None") {
      let blocks = payload.licenseNumbers.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
      blocks = uniqueBlocks(blocks);
      payload.licenseNumbers = blocks.length ? blocks.join('\n\n') : "None";
    }

    // Products and Services: format commas, capitalization, etc
    if (payload.productsAndServices && typeof payload.productsAndServices === "string") {
      let arr = payload.productsAndServices.split(',').map(s =>
        s.trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
      ).filter(Boolean);
      arr = uniqueArr(arr);
      payload.productsAndServices = arr.length ? arr.join(', ') : "None";
    }

    // BBB Seal: handle color for NOT FOUND
    if (payload.bbbSeal && payload.bbbSeal.startsWith('NOT FOUND')) {
      payload.bbbSeal = `<span style="color:red">${payload.bbbSeal}</span>`;
    }

    // Refund and Exchange Policy: make sure present
    if (!payload.refundAndExchangePolicy) payload.refundAndExchangePolicy = "None";

    // Owner Demographic: always one line
    if (!payload.ownerDemographic) payload.ownerDemographic = "None";

    // Service Area: list, else None
    if (!payload.serviceArea) payload.serviceArea = "None";

    // Methods of Payment
    if (!payload.methodsOfPayment) payload.methodsOfPayment = "None";

    // Description: fallback
    if (!payload.description) payload.description = "None";

    // Client base
    if (!payload.clientBase) payload.clientBase = "None";

    // Hours of Operation: pass through (AI provides format)
    if (!payload.hoursOfOperation) payload.hoursOfOperation = "None";

    // Timing
    const timeTaken = `${Math.floor((Date.now() - startTime) / 60000)}m ${(Math.floor((Date.now() - startTime) / 1000) % 60)}s`;

    // Return everything
    return res.status(200).json({
      url: parsed.href,
      description: payload.description,
      clientBase: payload.clientBase,
      ownerDemographic: payload.ownerDemographic,
      productsAndServices: payload.productsAndServices,
      hoursOfOperation: payload.hoursOfOperation,
      addresses: payload.addresses,
      phoneNumbers: payload.phoneNumbers,
      socialMediaUrls: payload.socialMediaUrls,
      licenseNumbers: payload.licenseNumbers,
      emailAddresses: payload.emailAddresses,
      methodsOfPayment: payload.methodsOfPayment,
      bbbSeal: payload.bbbSeal,
      serviceArea: payload.serviceArea,
      refundAndExchangePolicy: payload.refundAndExchangePolicy,
      timeTaken
    });

  } catch (err) {
    const code = err.statusCode || 500;
    return res.status(code).send(err.message || 'Internal Server Error');
  }
}
