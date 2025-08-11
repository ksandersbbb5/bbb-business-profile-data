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

/**
 * Crawl home + depth-1 same-origin pages.
 * Returns: { text: string, hrefs: string[] }
 */
async function crawl(rootUrl) {
  const start = new URL(rootUrl)
  const visited = new Set()
  const queue = [start.href]
  const texts = []
  const hrefs = []

  while (queue.length) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)

    try {
      const html = await fetchHtml(current)
      const $ = cheerio.load(html)

      // text
      $('script, style, noscript, svg, iframe').remove()
      const t = $('body').text().replace(/\s+/g, ' ').trim()
      if (t) texts.push(t)

      // collect anchors (for social detection)
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href')
        if (!href) return
        try {
          const abs = new URL(href, start.href)
          hrefs.push(abs.href)

          // enqueue only same-origin, depth <= 1
          if (sameOrigin(start, abs) && pathLevel(abs) <= 1) {
            if (!visited.has(abs.href) && queue.length < 25) queue.push(abs.href)
          }
        } catch {
          // ignore bad hrefs
        }
      })
    } catch {
      // ignore per-page failures
    }
  }

  return { text: texts.join('\n\n'), hrefs }
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

/* ---------------- Address extraction (cleaned & stricter) ---------------- */
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

function preCleanText(corpus) {
  if (!corpus) return ''
  let t = corpus

  // Remove common nav/control phrases around addresses
  t = t.replace(NAV_NOISE_RE, ' ')

  // Fix split words
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
    [/H\s*a\s*r\s*t\s*f\s*o\s*r\s*d/gi, 'Hartford'],
    [/N\s*e\s*w\s*\s*W\s*i\s*n\s*d\s*s\s*o\s*r/gi, 'New Windsor']
  ]
  for (const [re, rep] of fixPairs) t = t.replace(re, rep)

  // Insert space if suite token glues to City word
  t = t.replace(/(Suite|Ste|Unit|Apt|#)\s*([A-Za-z0-9\-]+)(?=[A-Z][a-z])/g, '$1 $2 ')

  // Normalize whitespace
  t = t.replace(/\s+/g, ' ').trim()
  return t
}

function titleCaseCity(s='') {
  return s
    .split(/\s+/)
    .map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)
    .join(' ')
}

const STREET_BLOCK =
  String.raw`(?:[A-Za-z0-9'&.-]+(?:\s+[A-Za-z0-9'&.-]+){0,5}\s+(?:${STREET_TYPES_RE})\.?)(?:\s*(?:,?\s*(?:Suite|Ste|Unit|Apt|#)\s*[A-Za-z0-9\-]+))?`

const ADDRESS_RE = new RegExp(
  String.raw`\b(\d{1,4})\s+(${STREET_BLOCK})\s*,?\s*` +
  String.raw`([A-Za-z.\- ]{2,}?)\s*,?\s+` +
  String.raw`([A-Z]{2})\s+` +
  String.raw`(\d{5}(?:-\d{4})?)\b`,
  'g'
)

function normalizeSpaces(s=''){ return s.replace(/\s+/g, ' ').trim() }

function formatAddress(num, streetBlock, city, state, zip) {
  const line1 = normalizeSpaces(`${num} ${streetBlock}`).replace(/,\s*$/, '')
  const cityClean = titleCaseCity(normalizeSpaces(city).replace(/,\s*$/, ''))
  const line2 = `${cityClean}, ${state.toUpperCase()} ${zip}`
  const line3 = 'US'
  return `${line1}\n${line2}\n${line3}`
}

function extractAddresses(corpus) {
  if (!corpus) return 'None'
  const text = preCleanText(corpus)
  const seen = new Set()
  const out = []

  let m
  while ((m = ADDRESS_RE.exec(text)) !== null) {
    const num = m[1] || ''
    const streetBlock = m[2] || ''
    const city = m[3] || ''
    const state = m[4] || ''
    const zip = m[5] || ''

    const line1Raw = `${num} ${streetBlock}`
    if (/p\.?\s*o\.?\s*box/i.test(line1Raw)) continue
    if (/@/.test(line1Raw)) continue

    const formatted = formatAddress(num, streetBlock, city, state, zip)
    const key = formatted.toLowerCase().replace(/\s+/g, ' ')
    if (!seen.has(key)) {
      seen.add(key)
      out.push(formatted)
    }
  }
  return out.length ? out.join('\n\n') : 'None'
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

/* ---------------- Social media URL extraction (root-only excluded) -------- */
const SOCIAL_SITES = [
  { key: 'Facebook', hosts: ['facebook.com','fb.com'], exclude: ['sharer.php','share','dialog/feed'] },
  { key: 'Instagram', hosts: ['instagram.com'], exclude: [] },
  { key: 'LinkedIn', hosts: ['linkedin.com'], exclude: ['shareArticle','sharing'] },
  { key: 'X', hosts: ['x.com','twitter.com'], exclude: ['intent','share'] },
  { key: 'TikTok', hosts: ['tiktok.com'], exclude: [] },
  { key: 'YouTube', hosts: ['youtube.com'], exclude: ['share'], allowHostsExtra: ['youtu.be'] },
  { key: 'Vimeo', hosts: ['vimeo.com'], exclude: [] },
  { key: 'Flickr', hosts: ['flickr.com'], exclude: [] },
  { key: 'Foursquare', hosts: ['foursquare.com'], exclude: [] },
  { key: 'Threads', hosts: ['threads.net','threads.com'], exclude: [] },
  { key: 'Tumblr', hosts: ['tumblr.com'], exclude: [] }
]

function normalizeUrl(u) {
  try {
    const url = new URL(u)
    url.hash = '' // drop fragments
    return url.toString()
  } catch { return '' }
}
function hostMatches(hostname, hosts = []) {
  const h = (hostname || '').toLowerCase()
  return hosts.some(dom => h === dom || h.endsWith('.' + dom))
}
function pathExcluded(pathname, excludes = []) {
  const p = (pathname || '').toLowerCase()
  return excludes.some(x => p.includes(x.toLowerCase()))
}
function hasAtLeastOnePathSegment(pathname) {
  const segs = (pathname || '').split('/').filter(Boolean)
  return segs.length >= 1
}

function extractSocialMediaUrls(allHrefs = []) {
  const found = new Map()
  for (const raw of allHrefs) {
    const u = normalizeUrl(raw)
    if (!u) continue
    let parsed
    try { parsed = new URL(u) } catch { continue }
    if (!/^https?:$/.test(parsed.protocol)) continue

    for (const site of SOCIAL_SITES) {
      const allHosts = site.allowHostsExtra ? site.hosts.concat(site.allowHostsExtra) : site.hosts
      if (!hostMatches(parsed.hostname, allHosts)) continue

      const pathname = parsed.pathname || '/'

      if (pathExcluded(pathname, site.exclude)) continue
      if (!hasAtLeastOnePathSegment(pathname)) continue

      const firstSeg = pathname.split('/').filter(Boolean)[0]?.toLowerCase() || ''
      if (['home','share'].includes(firstSeg)) continue

     
