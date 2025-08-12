// /api/generate.js (Vercel serverless function - Node ESM)
import * as cheerio from 'cheerio'

// ===== Config =====
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

// ===== Helpers =====
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  const chunks = []
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  const raw = Buffer.concat(chunks).toString('utf8') || '{}'
  try { return JSON.parse(raw) } catch { return {} }
}

function sameOrigin(u1, u2) { return u1.origin === u2.origin }

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      // slightly more browser-y
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) BBBProfileBot/1.0 Chrome/123 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  })
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  return await res.text()
}

function extractVisibleText(html) {
  const $ = cheerio.load(html)
  // Keep <script type="application/ld+json"> for structured data pass; remove others later
  $('script:not([type="application/ld+json"]), style, noscript, svg, iframe').remove()
  return $('body').text()
    .replace(/\|/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

// Crawl: same-origin, depth up to 2, cap 30 pages. Add fallback common slugs.
async function crawl(rootUrl) {
  const start = new URL(rootUrl)
  const visited = new Set()
  const queue = [{ href: start.href, depth: 0 }]
  const texts = []
  const htmls = []

  const MAX_PAGES = 30
  const MAX_DEPTH = 2

  const seenToEnqueue = new Set()

  while (queue.length && htmls.length < MAX_PAGES) {
    const { href, depth } = queue.shift()
    if (visited.has(href)) continue
    visited.add(href)

    try {
      const html = await fetchHtml(href)
      htmls.push({ url: href, html })
      const $ = cheerio.load(html)
      // For corpus text, remove non-LD scripts now:
      $('script:not([type="application/ld+json"]), style, noscript, svg, iframe').remove()
      const text = $('body').text()
        .replace(/\|/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n\n')
        .trim()
      if (text) texts.push(text)

      if (depth < MAX_DEPTH) {
        $('a[href]').each((_, el) => {
          try {
            const raw = String($(el).attr('href') || '')
            if (!raw || raw.startsWith('mailto:') || raw.startsWith('tel:')) return
            const abs = new URL(raw, href)
            if (!sameOrigin(start, abs)) return
            const clean = abs.href.split('#')[0]
            if (!visited.has(clean) && !seenToEnqueue.has(clean)) {
              seenToEnqueue.add(clean)
              queue.push({ href: clean, depth: depth + 1 })
            }
          } catch {}
        })
      }
    } catch {}
  }

  // If the corpus is thin, try a few common slugs
  const COMMON = ['about', 'about-us', 'contact', 'locations', 'hours', 'menu', 'privacy', 'legal', 'store-locator']
  if (texts.join(' ').length < 40) {
    for (const slug of COMMON) {
      const u = new URL(rootUrl)
      u.pathname = `/${slug.replace(/^\//,'')}`
      const href = u.href
      if (visited.has(href) || htmls.length >= MAX_PAGES) continue
      try {
        const html = await fetchHtml(href)
        htmls.push({ url: href, html })
        const $ = cheerio.load(html)
        $('script:not([type="application/ld+json"]), style, noscript, svg, iframe').remove()
        const text = $('body').text()
          .replace(/\|/g, ' ')
          .replace(/\r/g, '')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n\s*\n+/g, '\n\n')
          .trim()
        if (text) texts.push(text)
      } catch {}
    }
  }

  return { corpus: texts.join('\n\n'), pages: htmls }
}

// ===== Utilities =====
function uniq(arr) { return [...new Set((arr || []).filter(Boolean))] }
function ensureHeaderBlocks(str) {
  return String(str || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ===== JSON-LD harvesting (schema.org) =====
function harvestJsonLd(pages) {
  const addresses = []
  const phones = []
  const social = []
  let hoursMap = {} // { Monday: "Monday: ..", ... }

  const dayMap = { Monday:'Monday', Tuesday:'Tuesday', Wednesday:'Wednesday', Thursday:'Thursday', Friday:'Friday', Saturday:'Saturday', Sunday:'Sunday' }

  for (const { html } of pages) {
    const $ = cheerio.load(html)
    $('script[type="application/ld+json"]').each((_, s) => {
      const raw = $(s).contents().text()
      if (!raw) return
      let data
      try {
        data = JSON.parse(raw)
      } catch {
        // Some sites chain multiple JSON blocks separated by </script><script>, or wrap arrays poorly
        try { data = JSON.parse(raw.replace(/}\s*{/, '},{').replace(/^\s*({)/, '[$1').replace(/(})\s*$/, '$1]')) } catch { return }
      }
      const nodes = Array.isArray(data) ? data : [data]

      for (const node of nodes) {
        const n = node || {}
        // Phones
        if (typeof n.telephone === 'string') phones.push(n.telephone)

        // Social
        if (Array.isArray(n.sameAs)) {
          for (const u of n.sameAs) if (typeof u === 'string') social.push(u)
        }

        // Address
        const a = n.address
        if (a && typeof a === 'object') {
          const line1 = [a.streetAddress, a.address2].filter(Boolean).join(', ')
          const city = a.addressLocality
          const state = a.addressRegion
          const zip = a.postalCode
          if (line1 && city && state && zip) {
            addresses.push(`${line1}\n${city}, ${state} ${zip}\nUSA`)
          }
        }

        // OpeningHoursSpecification
        const ohs = n.openingHoursSpecification
        if (Array.isArray(ohs)) {
          const temp = {}
          for (const spec of ohs) {
            const day = dayMap[spec.dayOfWeek?.replace(/^.*\//,'')] || null
            if (!day) continue
            if (spec.opens && spec.closes) {
              const toAmPm = (t) => {
                // "08:00" -> 08:00 AM
                const m = String(t).match(/^(\d{2}):(\d{2})/)
                if (!m) return null
                let h = parseInt(m[1],10); const mm = m[2]
                const ap = h >= 12 ? 'PM' : 'AM'
                h = h % 12; if (h === 0) h = 12
                return `${String(h).padStart(2,'0')}:${mm} ${ap}`
              }
              const open = toAmPm(spec.opens); const close = toAmPm(spec.closes)
              if (open && close) temp[day] = `${day}: ${open} - ${close}`
            } else if (spec.opens === 'Closed' || spec.closes === 'Closed') {
              temp[day] = `${day}: Closed`
            }
          }
          // only accept if all 7 present
          const fullDays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
          if (fullDays.every(d => temp[d])) hoursMap = temp
        }
      }
    })
  }

  const hours = Object.keys(hoursMap).length
    ? ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(d => hoursMap[d]).join('\n')
    : 'None'

  return {
    addresses: uniq(addresses),
    phones: uniq(phones),
    social: uniq(social),
    hours
  }
}

// ===== Email =====
function extractEmails(text) {
  return uniq(text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
}

// ===== Phones (strict NANP) =====
function isValidNanp(area, exch, line) {
  return /^[2-9]\d{2}$/.test(area) && /^[2-9]\d{2}$/.test(exch) && /^\d{4}$/.test(line)
}
function extractPhones(text) {
  const out = []
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

// ===== Addresses (text) =====
function normalizeAddressBreaks(text) {
  return text
    .replace(/(\d{1,6})\s*\n\s*([A-Za-z])/g, '$1 $2')
    .replace(/(\bSuite|Ste|#|Unit)\s*\n\s*/gi, '$1 ')
    .replace(/,\s*\n\s*/g, ', ')
    .replace(/\|\s*/g, ' ')
}

const STREET_TYPES = [
  'Street','St','Avenue','Ave','Road','Rd','Boulevard','Blvd','Drive','Dr',
  'Lane','Ln','Court','Ct','Place','Pl','Parkway','Pkwy','Highway','Hwy',
  'Way','Terrace','Terr','Circle','Cir','Pike'
]
const STREET_TYPES_RE = new RegExp(`\\b(?:${STREET_TYPES.join('|')})\\b`, 'i')
const NAV_WORDS_RE = /\b(Home|About|Services|Contact|Reviews|Specials|Privacy|Terms|COVID|Update|Name:|Email:|Phone:|Menu|Cookie|Policy)\b/i

function extractAddressesFromText(rawText) {
  const text = normalizeAddressBreaks(rawText)
  const re = new RegExp(
    String.raw`(^|\n)\s*` +
    String.raw`(\d{1,6}\s+[A-Za-z0-9.\-# ]+?)\s+` +
    String.raw`(?:${STREET_TYPES.join('|')})\b[^\n,]*` +
    String.raw`(?:\s*,?\s*(?:Suite|Ste|Unit|#)\s*\w+)?\s*` +
    String.raw`[\n,]\s*` +
    String.raw`([A-Za-z][A-Za-z\s\.'-]+),?\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)`
  , 'gi')

  const out = []
  let m
  while ((m = re.exec(text))) {
    let street = (m[2] || '').replace(/\s{2,}/g, ' ').trim()
    const city = (m[3] || '').replace(/\s{2,}/g, ' ').trim()
    const state = (m[4] || '').trim()
    const zip = (m[5] || '').trim()

    if (!street || !STREET_TYPES_RE.test(street)) continue
    if (NAV_WORDS_RE.test(street)) continue
    const letters = (street.match(/[A-Za-z]/g) || []).length
    if (letters < 3) continue

    street = street.replace(/\s+(Suite|Ste|Unit|#)\s*/i, ', $1 ')
    out.push(`${street}\n${city}, ${state} ${zip}\nUSA`)
  }
  return uniq(out)
}

// ===== Social (anchors) =====
function canonicalSocialUrl(href) {
  try {
    const u = new URL(href, 'https://example.com')
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    let path = (u.pathname || '/').replace(/\/+$/, '')
    if (!path) path = '/'
    return `https://${host}${path}${u.search || ''}`
  } catch { return null }
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
        if (!path || path === '/') return
        for (const p of platforms) {
          if (p.hosts.some(h => host.endsWith(h))) {
            if (p.disallow && p.disallow.some(bad => path.startsWith(bad))) return
            foundPairs.push([p.key, canon])
          }
        }
      } catch {}
    })
  }
  const seen = new Set()
  const lines = []
  for (const [key, url] of foundPairs) {
    if (seen.has(url)) continue
    seen.add(url)
    lines.push(`${key}: ${url}`)
  }
  return lines.length ? lines : []
}

// ===== BBB Seal =====
function detectBBBSeal(pages) {
  let found = false
  for (const { html } of pages) {
    const $ = cheerio.load(html)
    const bodyText = $('body').text()
    if (/\bBBB Accredited\b/i.test(bodyText) && !/site managed by bbb/i.test(bodyText)) {
      found = true
    }
    $('img[src]').each((_, img) => {
      const src = String($(img).attr('src') || '').toLowerCase()
      if (src.includes('bbb') || src.includes('accredited') || src.includes('sscc-bbb-logos-footer')) found = true
    })
    if (found) break
  }
  return found
}

// ===== Hours helpers (text normalizer) =====
const FULL_DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
function toAmPm(h, m) {
  h = parseInt(h, 10); m = m == null ? 0 : parseInt(m, 10)
  const ap = h >= 12 ? 'PM' : 'AM'
  let hh = h % 12; if (hh === 0) hh = 12
  return `${String(hh).padStart(2,'0')}:${String(m).padStart(2,'0')} ${ap}`
}
function parseTimeToken(tok) {
  const t = tok.trim().toLowerCase()
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!m) return null
  let h = parseInt(m[1], 10)
  let min = m[2] ? parseInt(m[2],10) : 0
  const ap = m[3]
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  return { h, m: min }
}
function normalizeHoursFromCorpus(corpus) {
  // Accept explicit per-day lines only; otherwise None (no guessing)
  const lines = {}
  const re = /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*:\s*([^\n]+)/ig
  let m
  while ((m = re.exec(corpus))) {
    const day = m[1]
    const val = m[2].trim()
    if (/closed/i.test(val)) { lines[day] = `${day}: Closed`; continue }
    const tm = val.match(/^([0-9: ]+(?:am|pm)?)\s*[-–]\s*([0-9: ]+(?:am|pm)?)$/i)
    if (tm) {
      const o = parseTimeToken(tm[1]); const c = parseTimeToken(tm[2])
      if (o && c) lines[day] = `${day}: ${toAmPm(o.h,o.m)} - ${toAmPm(c.h,c.m)}`
    }
  }
  const out = FULL_DAYS.map(d => lines[d] || null)
  return out.every(Boolean) ? out.join('\n') : 'None'
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

// ===== Lead Form detection (expanded) =====
function detectLeadForm(pages, originUrl) {
  const start = new URL(originUrl)
  const domByUrl = new Map(pages.map(p => [p.url, cheerio.load(p.html)]))

  // Expanded intent list (added reservation/table/order)
  const INTENT = /(quote|estimate|consult|consultation|request|schedule|book|reserve|reservation|table|appointment|service|contact|order|order online)/i

  const candidates = []
  for (const { url, html } of pages) {
    const $ = cheerio.load(html)
    $('a[href], button[onclick]').each((_, el) => {
      const href = String($(el).attr('href') || '')
      const txt   = ($(el).text() || '').trim()
      const aria  = ($(el).attr('aria-label') || '').trim()
      const title = ($(el).attr('title') || '').trim()
      const label = `${txt} ${aria} ${title}`.trim()
      if (!INTENT.test(label)) return
      if (!href) return
      try {
        const abs = new URL(href, url)
        if (abs.origin !== start.origin) return
        if (abs.pathname === '/' || abs.hash === '#') return
        candidates.push({ label, target: abs.href })
      } catch {}
    })
  }

  const FIELD_RE = /(name|email|phone|message|address|guests|date|time)/i
  function pageHasRealForm(u) {
    const $ = domByUrl.get(u)
    if (!$) return false
    const forms = $('form, iframe')
    if (!forms.length) return false
    // if iframe exists to a known form provider, accept
    let has = false
    $('form').each((_, f) => {
      const ff = $(f)
      if (ff.find('input, textarea, select').filter((_, i) => {
        const nm = ($(i).attr('name') || '').toLowerCase()
        const pl = ($(i).attr('placeholder') || '').toLowerCase()
        const lbFor = $(`label[for="${$(i).attr('id') || ''}"]`).text().toLowerCase()
        return FIELD_RE.test(nm) || FIELD_RE.test(pl) || FIELD_RE.test(lbFor)
      }).length) has = true
    })
    if (!has) {
      $('iframe[src]').each((_, ifr) => {
        const src = String($(ifr).attr('src') || '').toLowerCase()
        if (/form|typeform|jotform|hubspot|marketo|pardot|salesforce|gravityforms|wpforms/.test(src)) has = true
      })
    }
    return has
  }

  // prefer deeper paths
  candidates.sort((a, b) => {
    const ap = new URL(a.target).pathname.split('/').filter(Boolean).length
    const bp = new URL(b.target).pathname.split('/').filter(Boolean).length
    return bp - ap
  })

  for (const c of candidates) {
    if (pageHasRealForm(c.target)) {
      const title = c.label.replace(/\s+/g, ' ').replace(/\s*\|\s*/g, ' ').trim()
      return { title, url: c.target }
    }
  }
  return null
}

// ===== OpenAI =====
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

// ===== Enforcers / cleaners =====
const ALLOWED_CLIENT_BASE = new Set(['residential','commercial','residential and commercial','government','non-profit'])
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
  let t = (text || '').replace(/[\*\[\]]/g, '')
  if (t.length > 900) t = t.slice(0, 900)
  t = t.replace(/https?:\S+/g, '')
  t = t.replace(/^\s*Business\s*Description\s*:?\s*/i, '')
  return t.trim()
}

// ===== Handler =====
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

    // Crawl (with deeper depth + fallbacks)
    const { corpus, pages } = await crawl(parsed.href)

    // Harvest JSON-LD (works for JS-heavy sites)
    const fromLd = harvestJsonLd(pages)

    // Fail only if we truly have nothing at all
    if (!corpus && !fromLd.addresses.length && !fromLd.phones.length && fromLd.hours === 'None' && !fromLd.social.length) {
      return res.status(422).send('Could not extract enough content from the provided site.')
    }

    // Deterministic fields (combine LD + text)
    const emails = extractEmails(corpus)
    const phonesText = extractPhones(corpus)
    const phones = uniq([
      ...phonesText,
      ...extractPhones(fromLd.phones.join(' '))
    ])

    const addressesText = extractAddressesFromText(corpus)
    const addresses = uniq([ ...fromLd.addresses, ...addressesText ])

    // Social: LD sameAs + anchors
    const socialFromAnchors = extractSocialFromPages(pages)
    const socialFromLd = fromLd.social
      .map(u => {
        try {
          const { hostname, pathname, search } = new URL(u)
          const host = hostname.replace(/^www\./,'').toLowerCase()
          const path = (pathname || '/').replace(/\/+$/,'')
          if (!path || path === '/') return null
          return `https://${host}${path}${search || ''}`
        } catch { return null }
      })
      .filter(Boolean)
    const socialLines = uniq([...socialFromAnchors, ...socialFromLd])

    const bbbFound = detectBBBSeal(pages)
    const bbbSealPlain = bbbFound
      ? 'FOUND    It appears the BBB Accredited Business Seal IS on this website or the website uses the text BBB Accredited.'
      : 'NOT FOUND    It appears the BBB Accredited Business Seal is NOT on this website.'

    const lead = detectLeadForm(pages, parsed.href)

    // ===== OpenAI (judgment fields) =====
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

    const clientBase = ALLOWED_CLIENT_BASE.has(String(payload.clientBase || '').toLowerCase())
      ? String(payload.clientBase).toLowerCase()
      : 'residential'

    // Description to strict template + append client-base sentence
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

    // Products & Services (capitalize, dedup)
    let productsAndServices = String(payload.productsAndServices || 'None') || 'None'
    if (productsAndServices !== 'None') {
      const items = productsAndServices.split(',').map(s => s.trim()).filter(Boolean).map(s =>
        s.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
      )
      productsAndServices = uniq(items).join(', ')
    }

    // Hours: prefer JSON-LD full set; otherwise normalize from corpus; no guessing
    let hoursOfOperation = fromLd.hours !== 'None'
      ? fromLd.hours
      : fixHoursFormatting(String(payload.hoursOfOperation || 'None') || 'None', corpus)

    // Licenses: ensure labeled blocks
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

    // Lead form
    let leadForm = 'None'
    let leadFormTitle = ''
    let leadFormUrl = ''
    if (lead) {
      leadFormTitle = lead.title || ''
      leadFormUrl = lead.url || ''
      leadForm = `Lead Form Title: ${leadFormTitle || 'None'}\nLead Form URL: ${leadFormUrl || 'None'}`
    }

    // Response
    res.setHeader('Content-Type', 'application/json')
    return res.status(200).send(JSON.stringify({
      url: parsed.href,
      timeTaken,

      description,
      clientBase,
      ownerDemographic,
      productsAndServices,

      hoursOfOperation,
      addresses: ensureHeaderBlocks(addresses.length ? addresses.join('\n\n') : 'None'),
      phoneNumbers: ensureHeaderBlocks(phones.length ? phones.join('\n') : 'None'),
      emailAddresses: ensureHeaderBlocks(extractEmails(corpus).length ? extractEmails(corpus).join('\n') : 'None'),
      socialMediaUrls: ensureHeaderBlocks(socialLines.length ? socialLines.join('\n') : 'None'),

      licenseNumbers: ensureHeaderBlocks(licenseNumbers),
      methodsOfPayment,
      bbbSeal: bbbSealPlain,
      serviceArea,
      refundAndExchangePolicy,

      leadForm,
      leadFormTitle,
      leadFormUrl
    }))

  } catch (err) {
    const code = err.statusCode || 500
    return res.status(code).send(err.message || 'Internal Server Error')
  }
}
