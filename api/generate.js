// api/generate.js
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

/* ---------------- Owner Demographic (exact match only) ---------------- */
const OWNER_CATEGORIES = [
  'Asian American Owned',
  'Black/African American Owned',
  'African American Owned',
  'Black Owned',
  'Disabled Owned',
  'Employee Owned Owned',
  'Family Owned',
  'Family-Owned',
  'First Responder Owned',
  'Hispanic Owned',
  'Indigenous Owned',
  'LBGTQ Owned',
  'Middle Eastern Owned',
  'Minority Owned',
  'Native American Owned',
  'Pacific Owned',
  'Veteran Owned',
  'Woman Owned'
]
function detectOwnerDemographic(text = '') {
  for (const label of OWNER_CATEGORIES) {
    const escaped = label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
    const re = new RegExp(`\\b${escaped}\\b`, 'i')
    if (re.test(text)) return label
  }
  return 'None'
}
/* --------------------------------------------------------------------- */

/* ---------------- Products & Services helpers ---------------- */
function cleanProductsAndServices(value) {
  if (!value) return 'None'
  const v = String(value).trim()
  return v || 'None'
}
/* ------------------------------------------------------------- */

/* ---------------- Hours of Operation: validation ---------------- */
const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const TIME_RE = '(0?[1-9]|1[0-2]):[0-5][0-9] (AM|PM)'
const LINE_RE = new RegExp(`^(${DAYS.join('|')}): ((${TIME_RE} - ${TIME_RE})|Closed)$`)

function normalizeHours(raw) {
  if (!raw) return 'None'
  // normalize whitespace and line endings
  let t = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (!t) return 'None'
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean)
  if (lines.length !== 7) return 'None'

  // Ensure each day is present exactly once and in any order—or in order? Spec shows fixed order; enforce order.
  for (let i = 0; i < 7; i++) {
    const expectedDay = DAYS[i]
    if (!LINE_RE.test(lines[i])) return 'None'
    if (!lines[i].startsWith(expectedDay + ':')) return 'None'
  }
  return lines.join('\n')
}
/* -------------------------------------------------------------------- */

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed')

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

    const systemPrompt = `You are a BBB representative enhancing a BBB Business Profile.

INFORMATION SOURCE:
Use ONLY the provided website content.

OUTPUT FORMAT (JSON only):
{
  "description": string,            // <=900 chars, plain text, factual, no promotional tone
  "clientBase": string,             // one of: residential, commercial, residential and commercial, government, non-profit
  "ownerDemographic": string,       // exact match from provided list or "None"
  "productsAndServices": string,    // categories only, 1–4 words each, comma-separated with a space after comma; or "None"
  "hoursOfOperation": string        // 7 lines formatted EXACTLY as shown, or "None" if all seven days not available
}

HOURS FORMAT (exact; 7 lines):
Monday: 09:00 AM - 05:00 PM
Tuesday: 09:00 AM - 05:00 PM
Wednesday: 09:00 AM - 05:00 PM
Thursday: 09:00 AM - 05:00 PM
Friday: 09:00 AM - 05:00 PM
Saturday: Closed
Sunday: Closed

HOURS RULES:
- 12-hour time with "AM"/"PM".
- Use "Closed" when not open.
- If hours are not available for ALL seven days, output "None".

OWNER DEMOGRAPHIC (case-insensitive exact match; otherwise "None"):
Asian American Owned
Black/African American Owned
African American Owned
Black Owned
Disabled Owned
Employee Owned Owned
Family Owned
Family-Owned
First Responder Owned
Hispanic Owned
Indigenous Owned
LBGTQ Owned
Middle Eastern Owned
Minority Owned
Native American Owned
Pacific Owned
Veteran Owned
Woman Owned

PRODUCTS & SERVICES RULES:
- List categories only (1–4 words each).
- Comma-separated (", ") with NO numbering or bullets.
- Factual, neutral tone; no service areas.
- If none found, return "None".
- Exclude and do not output these (or variations): Free Shipping, Quality Assurance, Product Warranty, Customer Service, Extra Services, Prunes.

DESCRIPTION RULES:
- No promotional language or implied endorsements.
- No owner names, locations, hours, or time-related info.
- No references to other businesses.
- Do not use characters * [ ].
- Do NOT include the literal text "Business Description".`

    const userPrompt = `Website URL: ${parsed.href}

WEBSITE CONTENT (verbatim, may be long):

${corpus}

Follow all rules exactly and return ONLY valid JSON with the specified keys.`

    // Ask OpenAI for all fields
    let aiRaw = await callOpenAI(systemPrompt, userPrompt)

    // Parse JSON (be tolerant)
    let payload
    try {
      const jsonMatch = aiRaw.match(/\{[\s\S]*\}$/)
      payload = JSON.parse(jsonMatch ? jsonMatch[0] : aiRaw)
    } catch {
      const fix = await callOpenAI('Return ONLY valid JSON with keys description, clientBase, ownerDemographic, productsAndServices, hoursOfOperation. Nothing else.', `Please convert the following into strict JSON: ${aiRaw}`)
      payload = JSON.parse(fix)
    }

    // Extract & enforce constraints
    let description = String(payload.description || '')
    let clientBase = enforceClientBase(payload.clientBase)
    let ownerDemographic = detectOwnerDemographic(corpus) // exact-match from site text only
    // Prefer site-detected owner demo; if model returned exact allowed label and site lacks it, okay to keep model's none.
    if (ownerDemographic === 'None' && typeof payload.ownerDemographic === 'string') {
      // still enforce exact list
      if (OWNER_CATEGORIES.find(c => c.toLowerCase() === payload.ownerDemographic.trim().toLowerCase())) {
        ownerDemographic = OWNER_CATEGORIES.find(c => c.toLowerCase() === payload.ownerDemographic.trim().toLowerCase()) || 'None'
      }
    }

    let productsAndServices = cleanProductsAndServices(payload.productsAndServices)
    let hoursOfOperation = normalizeHours(payload.hoursOfOperation)

    // Enforce exclusions / sanitization for description
    description = stripExcluded(description)
    if (badWordPresent(description)) {
      const neutral = await callOpenAI(
        'Neutralize promotional language and remove forbidden words/characters. Return ONLY the text, <=900 chars.',
        description
      )
      description = neutral
    }
    description = sanitize(description)
    if (badWordPresent(description)) {
      for (const p of BANNED_PHRASES) {
        const re = new RegExp(p, 'gi')
        description = description.replace(re, '')
      }
      description = sanitize(description)
    }

    res.setHeader('Content-Type', 'application/json')
    return res.status(200).send(JSON.stringify({
      url: parsed.href,
      description,
      clientBase,
      ownerDemographic,
      productsAndServices,
      hoursOfOperation
    }))
  } catch (err) {
    const code = err.statusCode || 500
    return res.status(code).send(err.message || 'Internal Server Error')
  }
}
