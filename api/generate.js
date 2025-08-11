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
  let t = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (!t) return 'None'
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean)
  if (lines.length !== 7) return 'None'
  for (let i = 0; i < 7; i++) {
    const expectedDay = DAYS[i]
    if (!LINE_RE.test(lines[i])) return 'None'
    if (!lines[i].startsWith(expectedDay + ':')) return 'None'
  }
  return lines.join('\n')
}
/* -------------------------------------------------------------------- */

/* ---------------- Address extraction (US‑first, cleaned) ----------------
  Fixes issues like "St reet" and removes nav noise (e.g., "Change Address").
  Matches:
    <number> <name> <StreetType> [Suite/Unit]
    City, ST ZIP
  Then formats as:
    Line1: Street + suite
    Line2: City, ST ZIP
    Line3: US
-------------------------------------------------------------------------- */
const STREET_TYPES = [
  'Street','St','Avenue','Ave','Road','Rd','Boulevard','Blvd','Drive','Dr','Lane','Ln','Court','Ct','Circle','Cir',
  'Way','Parkway','Pkwy','Place','Pl','Terrace','Ter','Highway','Hwy','Route','Rte','Trail','Trl','Center','Ctr'
]
const STREET_TYPES_RE = STREET_TYPES.map(s => s.replace(/\./g, '\\.')).join('|')

const NAV_NOISE_RE = new RegExp(
  '\\b(' + [
    'Change Address','Location Info','Areas Served','Make Payment','Request Service','View locations',
    'Reviews','Careers','Contact Us','Northern New England','Southern New England','About Us'
  ].join('|') + ')\\b',
  'gi'
)

// limit the street block to avoid gobbling random words far away
const STREET_BLOCK =
  String.raw`(?:[A-Za-z0-9'&.-]+(?:\s+[A-Za-z0-9'&.-]+){0,5}\s+(?:${STREET_TYPES_RE})\.?)(?:\s*(?:,?\s*(?:Suite|Ste|Unit|Apt|#)\s*[A-Za-z0-9\-]+))?`

// strict address: number + limited street block + city + state + zip
const ADDRESS_RE = new RegExp(
  String.raw`\b(\d{1,6})\s+(${STREET_BLOCK})\s*,?\s*` +      // line1 pieces
  String.raw`([A-Za-z.\- ]{2,}?)\s*,?\s+` +                   // city (allow missing comma)
  String.raw`([A-Z]{2})\s+` +                                 // state
  String.raw`(\d{5}(?:-\d{4})?)\b`,                           // ZIP
  'g'
)

function preCleanText(corpus) {
  if (!corpus) return ''
  let t = corpus

  // Remove common nav/control phrases that appear before addresses
  t = t.replace(NAV_NOISE_RE, ' ')

  // Collapse broken street words e.g., "St reet" -> "Street"
  const fixPairs = [
    [/S\s*t\s*reet/gi, 'Street'],
    [/A\s*v\s*e\s*n\s*ue/gi, 'Avenue'],
    [/B\s*o\s*u\s*l\s*e\s*v\s*a\s*r\s*d/gi, 'Boulevard'],
    [/D\s*r\s*ive/gi, 'Drive'],
    [/R\s*o\s*a\s*d/gi, 'Road'],
    [/L\s*a\s*n\s*e/gi, 'Lane'],
    [/C\s*o\s*u\s*r\s*t/gi, 'Court'],
    [/C\s*i\s*r\s*c\s*l\s*e/gi, 'Circle'],
    [/P\s*a\s*r\s*k\s*w\s*a\s*y/gi, 'Parkway'],
    [/T\s*e\s*r\s*r\s*a\s*c\s*e/gi, 'Terrace'],
    [/T\s*r\s*a\s*i\s*l/gi, 'Trail'],
    [/H\s*i\s*g\s*h\s*w\s*a\s*y/gi, 'Highway'],
    [/R\s*o\s*u\s*t\s*e/gi, 'Route'],
    [/C\s*e\s*n\s*t\s*e\s*r/gi, 'Center'],
    [/S\s*u\s*i\s*t\s*e/gi, 'Suite'],
    [/U\s*n\s*i\s*t/gi, 'Unit'],
    [/A\s*p\s*t/gi, 'Apt'],
  ]
  for (const [re, rep] of fixPairs) t = t.replace(re, rep)

  // Remove excessive whitespace; keep single spaces so regex sees inline addresses
  t = t.replace(/\s+/g, ' ').trim()
  return t
}

function normalizeSpaces(s=''){ return s.replace(/\s+/g, ' ').trim() }

function formatAddress(line1Name, streetBlock, city, state, zip) {
  const line1 = normalizeSpaces(`${line1Name} ${streetBlock}`).replace(/,\s*$/, '')
  const line2 = `${normalizeSpaces(city).replace(/,\s*$/,'')}, ${state} ${zip}`
  const line3 = 'US' // default per spec unless clearly other; we keep US
  return `${line1}\n${line2}\n${line3}`
}

function extractAddresses(corpus) {
  if (!corpus) return 'None'
  const text = preCleanText(corpus)
  const found = new Set()
  let m
  while ((m = ADDRESS_RE.exec(text)) !== null) {
    const num = m[1] || ''
    const streetBlock = m[2] || ''
    const city = m[3] || ''
    const state = m[4] || ''
    const zip = m[5] || ''

    // exclude PO Boxes / emails in the captured block (extra safety)
    const line1Raw = `${num} ${streetBlock}`
    if (/p\.?\s*o\.?\s*box/i.test(line1Raw)) continue
    if (/@/.test(line1Raw)) continue

    const formatted = formatAddress(num, streetBlock, city, state, zip)
    const key = formatted.toLowerCase().replace(/\s+/g,' ')
    if (!found.has(key)) found.add(key)
  }
  if (found.size === 0) return 'None'
  return Array.from(found).join('\n\n') // single blank line between addresses
}
/* -------------------------------------------------------------------- */

/* ---------------- Phone extraction (US only, format + ext) ---------------- */
const PHONE_CANDIDATE =
  /(?<!\+)(?:\(\s*\d{3}\s*\)\s*\d{3}[\s\.-]?\d{4}|\d{3}[\s\.-]?\d{3}[\s\.-]?\d{4}|\b\d{10}\b)/g
const EXT_PATTERN = /(ext\.?|x|extension)\s*[:#\-]?\s*(\d{1,6})/i

function formatPhone(digits) {
  return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`
}
function extractPhones(corpus) {
  if (!corpus) return 'None'
  const text = corpus.replace(/\r/g,' ').replace(/\n/g,' ')
  const results = []
  const seen = new Set()
  let m
  while ((m = PHONE_CANDIDATE.exec(text)) !== null) {
    const raw = m[0]
    const idx = m.index

    // Skip if nearby "fax"
    const ctxStart = Math.max(0, idx - 16)
    const ctxEnd = Math.min(text.length, idx + raw.length + 16)
    const ctx = text.slice(ctxStart, ctxEnd)
    if (/\bfax\b/i.test(ctx)) continue

    let digits = raw.replace(/\D/g, '')
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
    if (digits.length !== 10) continue

    let formatted = formatPhone(digits)

    // extension within small window after match
    const tail = text.slice(idx + raw.length, Math.min(text.length, idx + raw.length + 40))
    const extMatch = EXT_PATTERN.exec(tail)
    if (extMatch) {
      const extDigits = (extMatch[2] || '').replace(/\D/g,'')
      if (extDigits) formatted += ` ext. ${extDigits}`
    }

    if (!seen.has(formatted)) {
      seen.add(formatted)
      results.push(formatted)
    }
  }
  return results.length ? results.join('\n') : 'None'
}
/* ------------------------------------------------------------------------- */

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
  "productsAndServices": string,    // categories (1–4 words), comma-separated; or "None"
  "hoursOfOperation": string        // 7 lines EXACTLY as shown; or "None" if all seven days not available
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
${OWNER_CATEGORIES.join('\n')}

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

    // Ask OpenAI for description/clientBase/ownerDemo/products/hours
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

    // Owner demographic — prefer exact matches from site text; fall back to model if exact label
    let ownerDemographic = detectOwnerDemographic(corpus)
    if (ownerDemographic === 'None' && typeof payload.ownerDemographic === 'string') {
      const match = OWNER_CATEGORIES.find(c => c.toLowerCase() === payload.ownerDemographic.trim().toLowerCase())
      if (match) ownerDemographic = match
    }

    let productsAndServices = cleanProductsAndServices(payload.productsAndServices)
    let hoursOfOperation = normalizeHours(payload.hoursOfOperation)

    // Description sanitization
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

    // Extract addresses & phone numbers from cleaned/raw corpus
    const addresses = extractAddresses(corpus)
    const phoneNumbers = extractPhones(corpus)

    res.setHeader('Content-Type', 'application/json')
    return res.status(200).send(JSON.stringify({
      url: parsed.href,
      description,
      clientBase,
      ownerDemographic,
      productsAndServices,
      hoursOfOperation,
      addresses,
      phoneNumbers
    }))
  } catch (err) {
    const code = err.statusCode || 500
    return res.status(code).send(err.message || 'Internal Server Error')
  }
}
