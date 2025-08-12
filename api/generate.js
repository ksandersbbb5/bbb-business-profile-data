// /api/generate.js (Vercel serverless function - Node ESM)
import * as cheerio from 'cheerio'

// ====== Config ======
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

// ====== Helpers ======
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  const chunks = []
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  const raw = Buffer.concat(chunks).toString('utf8') || '{}'
  try { return JSON.parse(raw) } catch { return {} }
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
  return $('body').text()
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

async function crawl(rootUrl) {
  const start = new URL(rootUrl)
  const visited = new Set()
  const queue = [start.href]
  const texts = []
  const htmls = []

  while (queue.length) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)
    try {
      const html = await fetchHtml(current)
      htmls.push({ url: current, html })
      const text = extractVisibleText(html)
      if (text) texts.push(text)

      // enqueue same-origin, depth <= 1
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
  return { corpus: texts.join('\n\n'), pages: htmls, origin: start.origin }
}

// ====== Utilities ======
function uniq(arr) { return [...new Set((arr || []).filter(Boolean))] }
function ensureHeaderBlocks(str) {
  return String(str || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
function cleanInlineText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

// ====== Email ======
function extractEmails(text) {
  return uniq(text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
}

// ====== Phones (strict NANP) ======
function isValidNanp(area, exch, line) {
  // NANP rules: area & exchange cannot start with 0 or 1
  return /^[2-9]\d{2}$/.test(area) && /^[2-9]\d{2}$/.test(exch) && /^\d{4}$/.test(line)
}
function extractPhones(text) {
  const out = []
  // Boundaries to avoid matching inside long digit strings/IDs
  const re = /(?<!\d)(?:\+?1[\s.\-]?)?(?:\(?(\d{3})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4}))(?:\s*(?:ext\.?|x|extension)\s*(\d+))?(?!\d)/gi
  let m
  while ((m = re.exec(text))) {
    const [_, a, b, c, ext] = m
    if (!isValidNanp(a, b, c)) continue
    let s = `(${a}) ${b}-${c}`
    if (ext) s += ` ext. ${ext}`
    out.push(s)
  }
  return uniq(out)
}

// ====== Addresses ======
// Fix cases like "475\nWashington Street" caused by CMS line breaks
function normalizeAddressBreaks(text) {
  // join split street numbers/names and common unit breaks
  return text
    .replace(/(\d{1,6})\s*\n\s*([A-Za-z])/g, '$1 $2')
    .replace(/(\bSuite|#|Unit|Apt|Apartment)\s*\n\s*/gi, '$1 ')
    .replace(/,\s*\n\s*/g, ', ')
}

// Require a street type to reduce false positives
const STREET_TYPES = [
  'St','Street','Ave','Avenue','Rd','Road','Blvd','Boulevard','Dr','Drive',
  'Ln','Lane','Ct','Court','Pl','Place','Pkwy','Parkway','Hwy','Highway',
  'Way','Terr','Terrace','Cir','Circle','Pike'
]
const STREET_TYPES_RE = new RegExp(`\\b(?:${STREET_TYPES.join('|')})\\b`, 'i')

function extractAddresses(rawText) {
  const text = normalizeAddressBreaks(rawText)
  // Allow optional commas and flexible whitespace/newlines
  const re = /(\d{1,6}[^\n,]*?(?:\b(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Pl|Place|Pkwy|Parkway|Hwy|Highway|Way|Terr|Terrace|Cir|Circle|Pike)\b[^\n,]*)?)\s*,?\s*([A-Za-z][A-Za-z\s\.'-]+),?\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)/g
  const out = []
  let m
  while ((m = re.exec(text))) {
    let line1 = m[1].replace(/\s{2,}/g, ' ').trim()
    const city = m[2].replace(/,$/, '').replace(/\s{2,}/g, ' ').trim()
    const state = m[3].trim()
    const zip = m[4].trim()

    // Quality gates
    if (!STREET_TYPES_RE.test(line1)) continue
    const letters = (line1.match(/[A-Za-z]/g) || []).length
    if (letters < 3) continue

    // Ensure comma before suite/unit if missing
    line1 = line1.replace(/\s+(Suite|Ste|Unit|#)\s*/i, ', $1 ')

    out.push(`${line1}\n${city}, ${state} ${zip}\nUSA`)
  }
  return uniq(out)
}

// ====== Social media (canonical + dedup) ======
function canonicalSocialUrl(href) {
  try {
    const u = new URL(href, 'https://example.com')
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    let path = (u.pathname || '/').replace(/\/+$/, '') // strip trailing slash
    if (!path) path = '/'
    return `https://${host}${path}${u.search || ''}`
  } catch {
    return null
  }
}

function extractSocialFromPages(pages) {
  const platforms = [
    { key: 'Facebook', hosts: ['facebook.com'], disallow: ['/sharer'] },
    { key: 'Instagram', hosts: ['instagram.com'] },
    { key: 'LinkedIn', hosts: ['linkedin.com'] },
    { key: 'X', hosts: ['twitter.com','x.com'], disallow: ['/intent'] },
    { key: 'TikTok', hosts: ['tiktok.com'] },
    { key: 'YouTube', hosts: ['youtube.com'] },
    { key: 'Vimeo', hosts: ['vimeo.com'] },
    { key: 'Flickr', hosts: ['flickr.com'] },
    { key: 'Foursquare', hosts: ['foursquare.com'] },
    { key: 'Threads', hosts: ['threads.net','threads.com'] },
    { key: 'Tumblr', hosts: ['tumblr.com'] }
  ]
  const foundPairs = []
  for (const { html } of pages) {
    const $ = cheerio.load(html)
    $('a[href]').each((_, a) => {
      const raw = String($(a).attr('href') || '')
      const canon = canonicalSocialUrl(raw)
      if (!canon) return
      try {
        const u = new URL(canon)
        const host = u.hostname
        const path = u.pathname
        if (!path || path === '/') return // require at least one segment
        for (const p of platforms) {
          if (p.hosts.some(h => host.endsWith(h))) {
            if (p.disallow && p.disallow.some(bad => path.startsWith(bad))) return
            foundPairs.push([p.key, canon])
          }
        }
      } catch {}
    })
  }
  // Dedup by canonical URL
  const seen = new Set()
  const lines = []
  for (const [key, url] of foundPairs) {
    if (seen.has(url)) continue
    seen.add(url)
    lines.push(`${key}: ${url}`)
  }
  return lines.length ? lines : []
}

// ====== BBB Seal ======
function detectBBBSeal(pages) {
  let found = false
  for (const { html } of pages) {
    const $ = cheerio.load(html)
    const bodyText = $('body').text()
    // Text signal (exclude "site managed by BBB")
    if (/\bBBB Accredited\b/i.test(bodyText) && !/site managed by bbb/i.test(bodyText)) {
      found = true
    }
    // Image filename signal (e.g., sscc-bbb-logos-footer.png)
    $('img[src]').each((_, img) => {
      const src = String($(img).attr('src') || '').toLowerCase()
      if (src.includes('bbb') || src.includes('accredited')) found = true
    })
    if (found) break
  }
  return found
}

// ====== Lead Form (Data Point #15) ======
function pickNearestHeading($, formOrLink) {
  // Try aria-label/legend/label/placeholder/button first
  const $node = $(formOrLink)
  const aria = $node.attr('aria-label')
  if (aria) return cleanInlineText(aria)

  const legends = $node.find('legend').map((_, el) => $(el).text()).get()
  if (legends[0]) return cleanInlineText(legends[0])

  const buttons = $node.find('button, input[type=submit]').map((_, el) => $(el).text() || $(el).attr('value')).get()
  if (buttons[0]) return cleanInlineText(buttons[0])

  // Nearest previous heading
  const headings = []
  let prev = $node.prev()
  let hops = 0
  while (prev.length && hops < 6) {
    if (/^h[1-6]$/i.test(prev[0].name)) {
      headings.push(prev.text())
      break
    }
    prev = prev.prev()
    hops++
  }
  if (headings[0]) return cleanInlineText(headings[0])

  // Fallback to page title if available
  const title = $('title').first().text()
  if (title) return cleanInlineText(title)

  return ''
}

function detectLeadForm(pages, origin) {
  const LINK_KEYWORDS = /(quote|consultation|request|service|book|schedule|estimate|appointment|get\s*a\s*quote|get\s*started|contact)/i
  const FORM_HINT_INPUTS = /(name|email|phone|message|address|zip|city)/i
  const candidates = []

  for (const { url, html } of pages) {
    const $ = cheerio.load(html)

    // 1) Forms
    $('form').each((_, f) => {
      const $f = $(f)
      const action = $f.attr('action') ? new URL($f.attr('action'), url).href : url
      if (!action.startsWith(origin)) return

      const textBlob = $f.text() + ' ' + $f.find('input,button,label').map((i, el) =>
        ($(el).attr('placeholder') || '') + ' ' + ($(el).attr('aria-label') || '') + ' ' + ($(el).text() || '')
      ).get().join(' ')

      if (FORM_HINT_INPUTS.test(textBlob) || LINK_KEYWORDS.test(textBlob)) {
        const title = pickNearestHeading($, f) || 'Lead Form'
        candidates.push({ title, url: action })
      }
    })

    // 2) Links/Buttons to lead pages
    $('a[href], button').each((_, el) => {
      const $el = $(el)
      const href = $el.is('a') ? $el.attr('href') : ($el.attr('formaction') || '')
      const text = cleanInlineText($el.text() || $el.attr('aria-label') || '')
      if (!href && !LINK_KEYWORDS.test(text)) return
      if (href) {
        const abs = new URL(href, url)
        if (!abs.href.startsWith(origin)) return
        if (LINK_KEYWORDS.test(abs.pathname) || LINK_KEYWORDS.test(text)) {
          const title = text || pickNearestHeading($, el) || 'Lead Form'
          candidates.push({ title, url: abs.href })
        }
      }
    })
  }

  // Pick best: prefer shortest path + strongest keyword appearance in title
  const rank = (c) => {
    const pathLen = (new URL(c.url)).pathname.length
    const kwBoost = /(quote|estimate|request|schedule|book|consult|appointment)/i.test(c.title) ? -50 : 0
    return pathLen + kwBoost
  }
  const dedup = new Map()
  for (const c of candidates) {
    const key = c.url
    if (!dedup.has(key) || rank(c) < rank(dedup.get(key))) dedup.set(key, c)
  }
  const best = [...dedup.values()].sort((a,b) => rank(a) - rank(b))[0]
  if (!best) return 'None'
  return `Lead Form Title: ${best.title}\nLead Form URL: ${best.url}`
}

// ====== Hours normalization ======
const FULL_DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const DAY_ABBR = { Mon:'Monday', Tue:'Tuesday', Wed:'Wednesday', Thu:'Thursday', Thur:'Thursday', Fri:'Friday', Sat:'Saturday', Sun:'Sunday' }

function toAmPm(h, m) {
  h = parseInt(h, 10); m = m == null ? 0 : parseInt(m, 10)
  const ampm = h >= 12 ? 'PM' : 'AM'
  let hh = h % 12; if (hh === 0) hh = 12
  const mm = m.toString().padStart(2, '0')
  return `${hh.toString().padStart(2,'0')}:${mm} ${ampm}`
}
function parseTimeToken(tok) {
  const t = tok.trim().toLowerCase()
  const m1 = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!m1) return null
  let h = parseInt(m1[1], 10)
  let m = m1[2] ? parseInt(m1[2],10) : 0
  const ap = m1[3]
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  return { h, m }
}
function expandRange(token) {
  const re = /(Mon|Tue|Wed|Thu|Thur|Fri|Sat|Sun)\s*[-–]\s*(Mon|Tue|Wed|Thu|Thur|Fri|Sat|Sun)\s*[:\-]?\s*([0-9: ]+(?:am|pm)?)\s*[-–]\s*([0-9: ]+(?:am|pm)?)/i
  const m = token.match(re)
  if (!m) return null
  const startDay = DAY_ABBR[m[1]]
  const endDay = DAY_ABBR[m[2]]
  const open = parseTimeToken(m[3]); const close = parseTimeToken(m[4])
  if (!open || !close) return null
  const startIdx = FULL_DAYS.indexOf(startDay)
  const endIdx = FULL_DAYS.indexOf(endDay)
  const lines = {}
  for (let i = startIdx; i <= endIdx; i++) {
    lines[FULL_DAYS[i]] = `${FULL_DAYS[i]}: ${toAmPm(open.h, open.m)} - ${toAmPm(close.h, close.m)}`
  }
  return lines
}
function normalizeHoursFromCorpus(corpus) {
  const rangeMatches = corpus.match(/(?:Mon|Tue|Wed|Thu|Thur|Fri|Sat|Sun)\s*[-–]\s*(?:Mon|Tue|Wed|Thu|Thur|Fri|Sat|Sun)[^.\n]*?\d[^.\n]*?(?:am|pm)?\s*[-–]\s*\d[^.\n]*?(?:am|pm)?/ig) || []
  const dayLineMatches = corpus.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*:\s*[^\n]+/ig) || []
  const map = {}
  for (const rm of rangeMatches) {
    const lines = expandRange(rm)
    if (lines) Object.assign(map, lines)
  }
  for (const dl of dayLineMatches) {
    const m = dl.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*:\s*(.*)$/i)
    if (!m) continue
    const day = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
    const times = m[2].trim()
    if (/closed/i.test(times)) { map[day] = `${day}: Closed`; continue }
    const tm = times.match(/^([0-9: ]+(?:am|pm)?)\s*[-–]\s*([0-9: ]+(?:am|pm)?)$/i)
    if (tm) {
      const o = parseTimeToken(tm[1]); const c = parseTimeToken(tm[2])
      if (o && c) map[day] = `${day}: ${toAmPm(o.h, o.m)} - ${toAmPm(c.h, c.m)}`
    }
  }
  const lines = FULL_DAYS.map(d => map[d] || null)
  if (lines.every(Boolean)) return lines.join('\n')
  return 'None'
}
function fixHoursFormatting(modelHours, corpus) {
  if (!modelHours || modelHours === 'None') return normalizeHoursFromCorpus(corpus)
  let s = String(modelHours).replace(/\r/g, '').trim()
  s = s.replace(/\s*(Monday:)/g, '\n$1')
       .replace(/\s*(Tuesday:)/g, '\n$1')
       .replace(/\s*(Wednesday:)/g, '\n$1')
       .replace(/\s*(Thursday:)/g, '\n$1')
       .replace(/\s*(Friday:)/g, '\n$1')
       .replace(/\s*(Saturday:)/g, '\n$1')
       .replace(/\s*(Sunday:)/g, '\n$1')
       .trim()
  const lines = s.split(/\n+/).map(x => x.trim()).filter(Boolean)
  const re = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday):\s*(?:Closed|(\d{2}:\d{2}\s(?:AM|PM))\s-\s(\d{2}:\d{2}\s(?:AM|PM)))$/
  const ok = FULL_DAYS.every(day => lines.some(l => re.test(l) && l.startsWith(day + ':')))
  if (!ok) return normalizeHoursFromCorpus(corpus)
  return lines.join('\n')
}

// ====== Model Call ======
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
    temperature: 0.1
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

// ====== Enforcers & cleaners ======
const ALLOWED_CLIENT_BASE = new Set([
  'residential',
  'commercial',
  'residential and commercial',
  'government',
  'non-profit'
])
function enforceClientBase(value) {
  const v = (value || '').trim().toLowerCase()
  return ALLOWED_CLIENT_BASE.has(v) ? v : 'residential'
}

const BANNED_PHRASES = [
  'warranties','warranty','guarantee','guaranteed','quality','needs','free','reliable','premier','expert','experts','best','unique','peace of mind','largest','top','selection','ultimate','consultation','skilled','known for','prominent','paid out','commitment','Experts at','Experts in','Cost effective','cost saving','Ensuring efficiency','Best at','best in','Ensuring','Excels','Rely on us',
  'trusted by','relied on by','endorsed by','preferred by','backed by',
  'Free','Save','Best','New','Limited','Exclusive','Instant','Now','Proven','Sale','Bonus','Act Fast','Unlock'
]
function containsBanned(text) {
  const lower = (text || '').toLowerCase()
  return BANNED_PHRASES.some(p => lower.includes(p.toLowerCase()))
}
function sanitizeDescription(text) {
  let t = (text || '').replace(/[\*\[\]]/g, '') // remove forbidden characters
  if (t.length > 900) t = t.slice(0, 900)
  t = t.replace(/https?:\S+/g, '')
  t = t.replace(/^\s*Business\s*Description\s*:?\s*/i, '')
  return t.trim()
}

// ====== Handler ======
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed')

  const start = Date.now()

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

    // Crawl site (home + depth 1)
    const { corpus, pages, origin } = await crawl(parsed.href)
    if (!corpus || corpus.length < 40) {
      return res.status(422).send('Could not extract enough content from the provided site.')
    }

    // Deterministic fields
    const emails = extractEmails(corpus)
    const phones = extractPhones(corpus)
    const addresses = extractAddresses(corpus)
    const socialFound = extractSocialFromPages(pages)
    const bbbFound = detectBBBSeal(pages)
    const leadForm = detectLeadForm(pages, origin)

    const emailAddresses = emails.length ? emails.join('\n') : 'None'
    const phoneNumbers = phones.length ? phones.join('\n') : 'None'
    const addressesBlock = addresses.length ? addresses.join('\n\n') : 'None'
    const socialMediaUrls = socialFound.length ? socialFound.join('\n') : 'None'
    const bbbSealPlain = bbbFound
      ? 'FOUND    It appears the BBB Accredited Business Seal IS on this website or the website uses the text BBB Accredited.'
      : 'NOT FOUND    It appears the BBB Accredited Business Seal is NOT on this website.'

    // ====== Model (judgment fields) ======
    const systemPrompt = `You are a BBB representative enhancing a BBB Business Profile.

INFORMATION SOURCE:
Use ONLY the provided website content.

EXCLUSIONS:
- Do not reference other businesses in the industry.
- Exclude owner names, locations, hours of operation, and time-related information (including start dates and time in business) unless the field specifically requests them.
- Avoid the characters * [ ].
- Do NOT include links to any websites.

DO NOT INCLUDE:
- The text “Business Description” or any variation.
- The phrase “for more information visit their website at the provided URL” or any variation.
- Promotional language of any kind, including the listed banned words/phrases.
- Any wording implying trust/endorsement/popularity (e.g., "trusted by", "preferred by").

GENERAL GUIDELINES:
- Business Description: factual only, no advertising claims, no history or storytelling, <=900 characters.
- If a requested field cannot be fully satisfied from the website content, return "None" (without quotes).

BUSINESS DESCRIPTION TEMPLATE:
"[Company Name] provides [products/services offered], including [specific details about products/services]. The company assists clients with [details on the service process]."

PRODUCTS & SERVICES:
- List as comma-separated categories, each item 1–4 words, each word capitalized. No bullets or numbering. No service areas. If none, "None".

HOURS OF OPERATION:
- MUST list all seven days in the exact format:
Monday: 09:00 AM - 05:00 PM
...
Sunday: Closed
- If the site does not provide all seven days, return "None". NEVER invent or infer.

OWNER DEMOGRAPHIC:
- Return exact match from the approved list or "None".

LICENSE NUMBER(S):
- For each license found, return exactly:
License Number: <value or None>
Issuing Authority: <value or None>
License Type: <value or None>
Status: <value or None>
Expiration Date: <value or None>
- Blank line between each license. If none, "None".

METHODS OF PAYMENT:
- Return comma-separated from this approved list only (case-sensitive format):
ACH, Amazon Payments, American Express, Apple Pay, Balance Adjustment, Bitcoin, Cash, Certified Check, China UnionPay, Coupon, Credit Card, Debit Card, Discover, Electronic Check, Financing, Google Pay, Invoice, MasterCard, Masterpass, Money Order, PayPal, Samsung Pay, Store Card, Venmo, Visa, Western Union, Wire Transfer, Zelle
- If none, "None".

SERVICE AREA:
- Geographic areas explicitly listed on the site. If none, "None".

REFUND AND EXCHANGE POLICY:
- Extract policy text if present. If none, "None".

OUTPUT:
Return strict JSON with keys (all strings):
description
clientBase
ownerDemographic
productsAndServices
hoursOfOperation
licenseNumbers
methodsOfPayment
serviceArea
refundAndExchangePolicy
Return ONLY JSON.`

    const userPrompt = `Website URL: ${parsed.href}

WEBSITE CONTENT (verbatim):
${corpus}
`

    let aiRaw = await callOpenAI(systemPrompt, userPrompt)

    let payload
    try {
      const jsonMatch = aiRaw.match(/\{[\s\S]*\}$/)
      payload = JSON.parse(jsonMatch ? jsonMatch[0] : aiRaw)
    } catch {
      const fix = await callOpenAI(
        'Return ONLY valid JSON with the exact keys requested. No commentary.',
        `Convert to valid JSON:\n${aiRaw}`
      )
      payload = JSON.parse(fix)
    }

    // Enforce/clean model fields
    const clientBase = enforceClientBase(payload.clientBase)

    // Description: rewrite to exact template and append client base sentence
    let desc0 = sanitizeDescription(String(payload.description || ''))
    const descRewrite = await callOpenAI(
      'Return ONLY the following text, <=900 chars, neutral tone, no promotional words, no links:\nTemplate: "[Company Name] provides [products/services offered], including [specific details about products/services]. The company assists clients with [details on the service process]."',
      desc0
    )
    let description = sanitizeDescription(descRewrite || desc0)
    if (!/[.!?]$/.test(description)) description += '.'
    description += ` The business provides services to ${clientBase} customers.`
    if (containsBanned(description)) {
      for (const p of BANNED_PHRASES) {
        const re = new RegExp(p, 'gi')
        description = description.replace(re, '')
      }
      description = sanitizeDescription(description)
    }

    // Products & Services (capitalized comma list)
    let productsAndServices = String(payload.productsAndServices || 'None') || 'None'
    if (productsAndServices !== 'None') {
      const items = productsAndServices.split(',').map(s => s.trim()).filter(Boolean).map(s =>
        s.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
      )
      productsAndServices = uniq(items).join(', ')
    }

    // Hours of Operation (one per line or None)
    let hoursOfOperation = fixHoursFormatting(String(payload.hoursOfOperation || 'None') || 'None', corpus)

    // Licenses: ensure every field label present; blank line between licenses
    let licenseNumbers = String(payload.licenseNumbers || 'None') || 'None'
    if (licenseNumbers !== 'None') {
      const blocks = licenseNumbers.split(/\n{2,}/).map(b => b.trim()).filter(Boolean).map(b => {
        const get = (label) => {
          const m = b.match(new RegExp(`${label}:\\s*(.*)`, 'i'))
          return (m && m[1] && m[1].trim()) || 'None'
        }
        return `License Number: ${get('License Number')}\nIssuing Authority: ${get('Issuing Authority')}\nLicense Type: ${get('License Type')}\nStatus: ${get('Status')}\nExpiration Date: ${get('Expiration Date')}`
      })
      licenseNumbers = uniq(blocks).join('\n\n')
    }

    let ownerDemographic = String(payload.ownerDemographic || 'None') || 'None'
    let methodsOfPayment = String(payload.methodsOfPayment || 'None') || 'None'
    let serviceArea = String(payload.serviceArea || 'None') || 'None'
    let refundAndExchangePolicy = String(payload.refundAndExchangePolicy || 'None') || 'None'

    // Timing
    const elapsed = Date.now() - start
    const mins = Math.floor(elapsed / 60000)
    const secs = Math.floor((elapsed % 60000) / 1000)
    const timeTaken = `${mins} minute${mins === 1 ? '' : 's'} ${secs} second${secs === 1 ? '' : 's'}`

    // Final response
    res.setHeader('Content-Type', 'application/json')
    return res.status(200).send(JSON.stringify({
      url: parsed.href,
      timeTaken,

      description,
      clientBase,
      ownerDemographic,
      productsAndServices,

      hoursOfOperation, // one line per day or "None"

      addresses: ensureHeaderBlocks(addressesBlock), // includes USA + blank line between
      phoneNumbers: ensureHeaderBlocks(phoneNumbers), // one per row
      emailAddresses: ensureHeaderBlocks(emailAddresses), // one per row
      socialMediaUrls: ensureHeaderBlocks(socialMediaUrls), // one per row (canonicalized)

      licenseNumbers: ensureHeaderBlocks(licenseNumbers),
      methodsOfPayment,
      bbbSeal: bbbSealPlain, // plain text
      serviceArea,
      refundAndExchangePolicy,

      // New Data Point #15
      leadForm: leadForm // either "Lead Form Title: ...\nLead Form URL: ..." or "None"
    }))

  } catch (err) {
    const code = err.statusCode || 500
    return res.status(code).send(err.message || 'Internal Server Error')
  }
}
