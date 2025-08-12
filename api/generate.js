import * as cheerio from 'cheerio'

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

// --- helpers ---
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  const chunks = []
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  const raw = Buffer.concat(chunks).toString('utf8') || '{}'
  try { return JSON.parse(raw) } catch { return {} }
}

const ALLOWED_CLIENT_BASE = new Set([
  'residential',
  'commercial',
  'residential and commercial',
  'government',
  'non-profit'
])

const BANNED_PHRASES = [
  'warranties','warranty','guarantee','guaranteed','quality','needs','free','reliable','premier','expert','experts','best','unique','peace of mind','largest','top','selection','ultimate','consultation','skilled','known for','prominent','paid out','commitment','Experts at','Experts in','Cost effective','cost saving','Ensuring efficiency','Best at','best in','Ensuring','Excels','Rely on us',
  'trusted by','relied on by','endorsed by','preferred by','backed by',
  'Free','Save','Best','New','Limited','Exclusive','Instant','Now','Proven','Sale','Bonus','Act Fast','Unlock'
]

function badWordPresent(text) {
  const lower = (text || '').toLowerCase()
  return BANNED_PHRASES.some(p => lower.includes(p.toLowerCase()))
}
function sanitize(text) {
  let t = (text || '').replace(/[\*\[\]]/g, '')
  if (t.length > 900) t = t.slice(0, 900)
  return t.trim()
}
function sameOrigin(u1, u2) { return u1.origin === u2.origin }
function pathLevel(u) { return u.pathname.split('/').filter(Boolean).length }

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 BBB Profile Scraper' } })
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  return await res.text()
}
function extractVisibleText(html) {
  const $ = cheerio.load(html)
  $('script, style, noscript, svg, iframe').remove()
  return $('body').text().replace(/\s+/g, ' ').trim()
}

async function crawl(rootUrl) {
  const start = new URL(rootUrl)
  const visited = new Set()
  const queue = [start.href]
  const texts = []

  while (queue.length) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)
    try {
      const html = await fetchHtml(current)
      const text = extractVisibleText(html)
      if (text) texts.push(text)
      const $ = cheerio.load(html)
      $('a[href]').each((_, el) => {
        try {
          const href = $(el).attr('href')
          if (!href) return
          const abs = new URL(href, start.href)
          if (!sameOrigin(start, abs)) return
          if (pathLevel(abs) <= 1) {
            if (!visited.has(abs.href) && queue.length < 25) queue.push(abs.href)
          }
        } catch {}
      })
    } catch {}
  }
  return texts.join('\n\n')
}

async function callOpenAI(systemPrompt, userPrompt) {
  if (!OPENAI_API_KEY) {
    const err = new Error('Missing OPENAI_API_KEY')
    err.statusCode = 500
    throw err
  }
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const errText = await res.text()
    const err = new Error(`OpenAI error: ${res.status} ${errText}`)
    err.statusCode = res.status
    throw err
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

function enforceClientBase(value) {
  const v = (value || '').trim().toLowerCase()
  return ALLOWED_CLIENT_BASE.has(v) ? v : 'residential'
}
function stripExcluded(text) {
  let t = text || ''
  t = t.replace(/https?:\S+/g, '')
  const NEVER = [
    'Business Description','Business description','business description',
    'for more information visit their website','for more information, visit their website'
  ]
  NEVER.forEach(p => { t = t.replace(new RegExp(p, 'gi'), '') })
  return t
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed')

  const startTime = Date.now()

  try {
    const body = await readJsonBody(req)
    const { url } = body || {}
    if (!url) return res.status(400).send('Missing url')

    let parsed
    try {
      parsed = new URL(url)
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('bad protocol')
    } catch {
      return res.status(400).send('Please enter a valid URL.')
    }

    const corpus = await crawl(parsed.href)
    if (!corpus || corpus.length < 40) {
      return res.status(422).send('Could not extract enough content from the provided site.')
    }

    // --- LLM PROMPT ---

    const systemPrompt = `
You are a BBB representative enhancing a BBB Business Profile. Use ONLY the provided website content for each data point. DO NOT make up information or use prior knowledge. If a data point cannot be found, output exactly 'None' (no quotes, no extra spaces).

**Data Points & Output Formats**

1) Business Description and Client Base
- Strictly factual, max 900 characters, no promotional words, no advertising, no forbidden language (see below), do not reference owner names, locations, hours, or time.
- Template: "Business Description: <description> The business provides services to <clientBase> customers."
- Allowed clientBase values: residential, commercial, residential and commercial, government, non-profit.

2) Owner Demographic
- If exact match (case-insensitive) to this list, return category: Asian American Owned, Black/African American Owned, African American Owned, Black Owned, Disabled Owned, Employee Owned Owned, Family Owned, Family-Owned, First Responder Owned, Hispanic Owned, Indigenous Owned, LBGTQ Owned, Middle Eastern Owned, Minority Owned, Native American Owned, Pacific Owned, Veteran Owned, Woman Owned. Else, return 'None'.
- Output: Owner Demographic: <ownerDemographic>

3) Products and Services
- List each product/service as a 1-4 word capitalized category, separated by commas. No numbering or bulleting. Each word capitalized. No service areas. Exclude generic phrases (e.g., "Additional Offers", "Free Shipping"). If none, output "None".
- Output: Products and Services: <productsAndServices>

4) Hours of Operation
- If found for all 7 days, output each as "Monday: 09:00 AM - 05:00 PM". If only partial week or info, output "None". If hours say "Mon-Fri: 8am-7pm", expand to all five weekdays, weekends as "Closed". Always use 12-hour format with AM/PM.
- Output: Hours of Operation:
Monday: <monday>
Tuesday: <tuesday>
Wednesday: <wednesday>
Thursday: <thursday>
Friday: <friday>
Saturday: <saturday>
Sunday: <sunday>
(Or: None)

5) Address(es)
- Extract every valid street address. Format each as:
123 Main St, Suite 400
Boston, MA 02108
USA
- If multiple, add a blank line between each. If none, output "None".

6) Phone Number(s)
- Extract all valid U.S. phone numbers and format as (123) 456-7890 (with "ext. 1234" if extension). One per row. If none, output "None".

7) Social Media URLs
- List only if a valid URL with a non-root path segment (e.g., facebook.com/username). Check for all standard platforms (Facebook, Instagram, LinkedIn, X (Twitter), TikTok, YouTube, Vimeo, Flickr, Foursquare, Threads, Tumblr). One per row, platform name first, e.g., Facebook: https://facebook.com/example. If none, output "None".

8) License Number(s)
- Format each as:
License Number: <licenseNumber>
Issuing Authority: <authority or None>
License Type: <type or None>
Status: <status or None>
Expiration Date: <expiration or None>
Blank line after each license. If none, output "None".

9) Email Addresses
- List each valid email found, one per row. If none, output "None".

10) Methods of Payment
- Extract only from this list: ACH, Amazon Payments, American Express, Apply Pay, Balance Adjustment, Bitcoin, Cash, Certified Check, China UnionPay, Coupon, Credit Card, Debit Card, Discover, Electronic Check, Financing, Google Pay, Invoice, MasterCard, Masterpass, Money Order, PayPal, Samsung Pay, Store Card, Venmo, Visa, Western Union, Wire Transfer, Zelle. Comma-separated. If none, output "None".

11) BBB Seal on Website
- If any image filename contains "bbb" or "accredited" or the text "BBB Accredited" appears, and NOT just "site managed by BBB", output: FOUND    It appears the BBB Accredited Business Seal IS on this website or the website uses the text BBB Accredited.
- If not found, output in red text: NOT FOUND    It appears the BBB Accredited Business Seal is NOT on this website.

12) Service Area
- Extract any service area/territory mentioned (county, city, state, zip, region, or phrases like "serving..."). If none, output "None".

13) Refund and Exchange Policy
- Extract exact refund/exchange policy details. If none, output "None".

BANNED WORDS/PHRASES: ${BANNED_PHRASES.join(', ')}

---

Return output for each data point exactly in the order above, labeled as shown, separated by a single blank line. DO NOT make up or infer data points. DO NOT invent plausible answers. Use ONLY website content.
    `

    const userPrompt = `Website URL: ${parsed.href}

WEBSITE CONTENT:

${corpus}

IMPORTANT: For each data point, return exactly as described. If not found, output "None". Do not invent or infer.`
    // ---

    let aiRaw = await callOpenAI(systemPrompt, userPrompt)

    // Parse output (robust, extract JSON or sectioned plain text)
    // Here we simply pass through the text, as the LLM returns fully formatted output.

    // Post-processing (optional): None needed if LLM obeys the prompt

    const durationMs = Date.now() - startTime
    res.setHeader('Content-Type', 'application/json')
    return res.status(200).send(JSON.stringify({
      url: parsed.href,
      output: aiRaw,
      duration: durationMs
    }))
  } catch (err) {
    const code = err.statusCode || 500
    return res.status(code).send(err.message || 'Internal Server Error')
  }
}
