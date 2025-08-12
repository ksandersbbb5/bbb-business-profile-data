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
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) BBB Profile Scraper',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  })
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  return await res.text()
}

function extractVisibleText(html) {
  const $ = cheerio.load(html)
  $('script:not([type="application/ld+json"]), style, noscript, svg, iframe').remove()
  return $('body').text()
    .replace(/\|/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

function extractJsonLd(html) {
  const $ = cheerio.load(html)
  const blocks = []
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text()
    if (!raw) return
    try {
      // Handle multiple JSON objects/arrays in one script
      let arr = []
      if (raw.trim().startsWith('[')) {
        arr = JSON.parse(raw)
      } else if (raw.trim().startsWith('{')) {
        arr = [JSON.parse(raw)]
      }
      blocks.push(...arr)
    } catch {}
  })
  return blocks
}

async function crawl(rootUrl) {
  const start = new URL(rootUrl)
  const visited = new Set()
  const queue = [start.href]
  const texts = []
  const htmls = []

  const MAX_PAGES = 30
  const FALLBACK_SLUGS = [
    '/about', '/about-us', '/contact', '/contact-us', '/locations', '/hours',
    '/menu', '/privacy', '/legal', '/store-locator', '/find-us', '/reservation', '/book'
  ]

  while (queue.length && htmls.length < MAX_PAGES) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)
    try {
      const html = await fetchHtml(current)
      htmls.push({ url: current, html, jsonld: extractJsonLd(html) })
      const text = extractVisibleText(html)
      if (text) texts.push(text)
      const $ = cheerio.load(html)
      $('a[href]').each((_, el) => {
        try {
          const href = $(el).attr('href')
          if (!href) return
          const abs = new URL(href, current)
          if (!sameOrigin(start, abs)) return
          if (pathLevel(abs) <= 2) {
            if (!visited.has(abs.href) && !queue.includes(abs.href) && htmls.length + queue.length < MAX_PAGES) {
              queue.push(abs.href)
            }
          }
        } catch {}
      })
    } catch {}
  }

  // If corpus looks thin, try some common slugs
  if (texts.join('\n\n').length < 200) {
    for (const slug of FALLBACK_SLUGS) {
      try {
        const extra = new URL(slug, rootUrl).href
        if (visited.has(extra)) continue
        const html = await fetchHtml(extra)
        htmls.push({ url: extra, html, jsonld: extractJsonLd(html) })
        const text = extractVisibleText(html)
        if (text) texts.push(text)
      } catch {}
      if (htmls.length >= MAX_PAGES) break
    }
  }

  return { corpus: texts.join('\n\n'), pages: htmls }
}

// ====== Utilities ======
function uniq(arr) { return [...new Set((arr || []).filter(Boolean))] }
function ensureHeaderBlocks(str) {
  return String(str || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([^\n])(\nLicense Number: )/g, '$1\n\n$2') // Ensure blank line before each license number
    .trim()
}

// ====== JSON-LD harvesters ======
function harvestFromJsonLd(pages) {
  const out = {
    phones: [],
    addresses: [],
    hoursMap: {},
    socials: []
  }
  const FULL_DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']

  const toAmPm = (h, m) => {
    const H = parseInt(h, 10)
    const M = parseInt(m || 0, 10)
    const ampm = H >= 12 ? 'PM' : 'AM'
    let hh = H % 12; if (hh === 0) hh = 12
    return `${hh.toString().padStart(2,'0')}:${M.toString().padStart(2,'0')} ${ampm}`
  }

  for (const { jsonld } of pages) {
    for (const node of jsonld || []) {
      // phones
      if (typeof node.telephone === 'string') {
        out.phones.push(node.telephone)
      }
      // sameAs (socials)
      if (Array.isArray(node.sameAs)) {
        out.socials.push(...node.sameAs)
      }
      // addresses
      const addrs = []
      if (node.address && typeof node.address === 'object') {
        addrs.push(node.address)
      }
      if (Array.isArray(node.address)) {
        addrs.push(...node.address)
      }
      for (const a of addrs) {
        try {
          const line1 = (a.streetAddress || '').replace(/\s{2,}/g, ' ').trim()
          const city = (a.addressLocality || '').toString().trim()
          const state = (a.addressRegion || '').toString().trim()
          const zip = (a.postalCode || '').toString().trim()
          const country = (a.addressCountry || 'USA').toString().trim()
          if (line1 && city && state && zip) {
            out.addresses.push(`${line1}\n${city}, ${state} ${zip}\n${country.toUpperCase() === 'US' ? 'USA' : country}`)
          }
        } catch {}
      }
      // hours
      const hrs = node.openingHoursSpecification
      if (Array.isArray(hrs)) {
        for (const h of hrs) {
          try {
            const days = h.dayOfWeek
            const opens = h.opens
            const closes = h.closes
            if (!days || !opens || !closes) continue
            const openParts = String(opens).split(':'); const closeParts = String(closes).split(':')
            const openStr = toAmPm(openParts[0], openParts[1])
            const closeStr = toAmPm(closeParts[0], closeParts[1])
            const dayList = Array.isArray(days) ? days : [days]
            for (let d of dayList) {
              d = String(d).replace(/^https?:.*\//, '') // schema.org/Monday
              d = d.charAt(0).toUpperCase() + d.slice(1).toLowerCase()
              if (FULL_DAYS.includes(d)) {
                out.hoursMap[d] = `${d}: ${openStr} - ${closeStr}`
              }
            }
          } catch {}
        }
      }
    }
  }
  return out
}

// ====== Email ======
function extractEmails(text) {
  return uniq(text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
}

// ====== Phones ======
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

// ====== Addresses (regex) ======
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
const NAV_WORDS_RE = /\b(Home|About|Services|Contact|Reviews|Specials|Privacy|Terms|COVID|Update|Name:|Email:|Phone:|Menu|All rights reserved)\b/i

function extractAddresses(rawText) {
  const text = normalizeAddressBreaks(rawText)
  const re = new RegExp(
    String.raw`(^|\n)\s*` +
    String.raw`(\d{1,6}\s+[A-Za-z0-9.\-# ]+?)\s+` +
    String.raw`(?:${STREET_TYPES.join('|')})` +
    String.raw`(?:\s*,?\s*(?:Suite|Ste|Unit|#)\s*\w+)?` +
    String.raw`\s*[\n,]\s*` +
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

// ====== Social media (dedup) ======
function canonicalSocialUrl(href) {
  try {
    const u = new URL(href, 'https://example.com')
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    let path = (u.pathname || '/').replace(/\/+$/, '')
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

// ====== BBB Seal ======
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
function fixHoursFormatting(modelHours, corpus, jsonldHoursMap) {
  if (jsonldHoursMap && Object.keys(jsonldHoursMap).length === 7) {
    return FULL_DAYS.map(d => jsonldHoursMap[d] || `${d}: Closed`).join('\n')
  }
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

// ====== Lead Form detection ======
function detectLeadForm(pages, originUrl) {
  const start = new URL(originUrl)
  const domByUrl = new Map(pages.map(p => [p.url, cheerio.load(p.html)]))

  const INTENT = /(quote|estimate|consult|consultation|request|schedule|book|appointment|service|contact|reserve|reservation|table)/i
  const TITLE_HINT = /(get a quote|request service|schedule a consultation|book now|book a table|make a reservation|reserve|reservation|table|book)/i

  const candidates = []
  for (const { url, html } of pages) {
    const $ = cheerio.load(html)
    $('a[href], button[onclick]').each((_, el) => {
      let href = $(el).attr('href') || ''
      const txt = ($(el).text() || '').trim()
      const aria = ($(el).attr('aria-label') || '').trim()
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

  const FIELD_RE = /(name|email|phone|message|address)/i
  function pageHasRealForm(u) {
    const $ = domByUrl.get(u)
    if (!$) return false
    const forms = $('form')
    if (!forms.length) return false
    let hasField = false
    forms.each((_, f) => {
      const ff = $(f)
      if (ff.find('input, textarea, select').filter((_, i) => {
        const nm = ($(i).attr('name') || '').toLowerCase()
        const pl = ($(i).attr('placeholder') || '').toLowerCase()
        const lbFor = $(`label[for="${$(i).attr('id') || ''}"]`).text().toLowerCase()
        return FIELD_RE.test(nm) || FIELD_RE.test(pl) || FIELD_RE.test(lbFor)
      }).length) hasField = true
    })
    return hasField
  }

  // prefer labels that look like CTAs
  candidates.sort((a, b) => {
    const aScore = TITLE_HINT.test(a.label) ? 1 : 0
    const bScore = TITLE_HINT.test(b.label) ? 1 : 0
    if (aScore !== bScore) return bScore - aScore
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
  let t = (text || '').replace(/[\*\[\]]/g, '')
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

    // Crawl site (home + depth 2 + fallbacks)
    const { corpus, pages } = await crawl(parsed.href)

    // JSON-LD harvest (phones, addresses, hours, socials)
    const harvested = harvestFromJsonLd(pages)

    // Deterministic fields from free text
    const emails = extractEmails(corpus)
    const phones = uniq([...extractPhones(corpus), ...extractPhones(harvested.phones.join(' '))])
    const addressesText = extractAddresses(corpus)
    const addressesJsonLd = harvested.addresses || []
    const addresses = uniq([...(addressesJsonLd || []), ...(addressesText || [])])

    const socialFound = uniq([
      ...(extractSocialFromPages(pages) || []),
      ...(
        (harvested.socials || [])
          .map(u => {
            try {
              const canon = new URL(u)
              const host = canon.hostname.replace(/^www\./,'').toLowerCase()
              const path = canon.pathname.replace(/\/+$/,'')
              if (!path || path === '/') return null
              if (host.includes('facebook.com')) return `Facebook: https://${host}${path}`
              if (host.includes('instagram.com')) return `Instagram: https://${host}${path}`
              if (host.includes('linkedin.com')) return `LinkedIn: https://${host}${path}`
              if (host.includes('twitter.com') || host.includes('x.com')) return `X: https://${host}${path}`
              if (host.includes('tiktok.com')) return `TikTok: https://${host}${path}`
              if (host.includes('youtube.com')) return `YouTube: https://${host}${path}`
              if (host.includes('vimeo.com')) return `Vimeo: https://${host}${path}`
              if (host.includes('flickr.com')) return `Flickr: https://${host}${path}`
              if (host.includes('foursquare.com')) return `Foursquare: https://${host}${path}`
              if (host.includes('threads.net') || host.includes('threads.com')) return `Threads: https://${host}${path}`
              if (host.includes('tumblr.com')) return `Tumblr: https://${host}${path}`
              return null
            } catch { return null }
          })
          .filter(Boolean)
      )
    ])

    const bbbFound = detectBBBSeal(pages)
    const leadInfo = detectLeadForm(pages, parsed.href)

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

    // If extremely thin but we have JSON-LD, still call the model
    if (!corpus || corpus.length < 40) {
      const hasStructured = (harvested.phones.length + harvested.addresses.length + Object.keys(harvested.hoursMap).length + harvested.socials.length) > 0
      if (!hasStructured) {
        return res.status(422).send('Could not extract enough content from the provided site.')
      }
    }

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

    const clientBase = enforceClientBase(String(payload.clientBase || 'residential'))

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

    // Products & Services
    let productsAndServices = String(payload.productsAndServices || 'None') || 'None'
    if (productsAndServices !== 'None') {
      const items = productsAndServices.split(',').map(s => s.trim()).filter(Boolean).map(s =>
        s.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
      )
      productsAndServices = uniq(items).join(', ')
    }

    // Hours (prefer JSON-LD if complete)
    let hoursOfOperation = fixHoursFormatting(String(payload.hoursOfOperation || 'None') || 'None', corpus, harvested.hoursMap)

    // Licenses (ensure labels; blank line between blocks)
    let licenseNumbers = String(payload.licenseNumbers || 'None') || 'None'
    
  if (licenseNumbers !== 'None') {
  const blocks = licenseNumbers
    .split(/(?:\n\s*){2,}/)
    .map(b => b.trim())
    .filter(Boolean)
    .map(b => {
      const get = (label) => {
        const m = b.match(new RegExp(`${label}:\\s*(.*)`, 'i'))
        return (m && m[1] && m[1].trim()) || 'None'
      }
      return [
        `License Number: ${get('License Number')}`,
        `Issuing Authority: ${get('Issuing Authority')}`,
        `License Type: ${get('License Type')}`,
        `Status: ${get('Status')}`,
        `Expiration Date: ${get('Expiration Date')}`,
        '' // Blank row after each license
      ].join('\n')
    })
  licenseNumbers = uniq(blocks).join('\n')
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

    // Lead form (formatted)
    let leadForm = 'None'
    let leadFormTitle = ''
    let leadFormUrl = ''
    if (leadInfo) {
      leadFormTitle = leadInfo.title || ''
      leadFormUrl = leadInfo.url || ''
      leadForm = `Lead Form Title: ${leadFormTitle || 'None'}\nLead Form URL: ${leadFormUrl || 'None'}`
    }

    // Final response
    res.setHeader('Content-Type', 'application/json')
    return res.status(200).send(JSON.stringify({
      url: parsed.href,
      timeTaken,

      description,
      clientBase,
      ownerDemographic,
      productsAndServices,

      hoursOfOperation,
      addresses: ensureHeaderBlocks(addressesBlock),
      phoneNumbers: ensureHeaderBlocks(phoneNumbers),
      emailAddresses: ensureHeaderBlocks(emailAddresses),
      socialMediaUrls: ensureHeaderBlocks(socialMediaUrls),

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
