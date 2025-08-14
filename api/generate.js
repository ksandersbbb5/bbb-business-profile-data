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

// ====== PATCHED: Crawl only homepage and level 1 pages ======
async function crawl(rootUrl) {
  const start = new URL(rootUrl)
  const visited = new Set()
  const queue = [start.href]
  const texts = []
  const htmls = []
  const MAX_PAGES = 20

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
          // Only keep home (0) and level 1 (1) pages, e.g. /about/, /contact-us/
          const segs = abs.pathname.split('/').filter(Boolean)
          if (segs.length > 1) return
          if (!visited.has(abs.href) && !queue.includes(abs.href) && htmls.length + queue.length < MAX_PAGES) {
            queue.push(abs.href)
          }
        } catch {}
      })
    } catch {}
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
    .replace(/(Expiration Date: .*)\n(?!\n|$)/g, '$1\n\n') // Blank line after each Expiration Date
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

// ====== Addresses ======
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
// PATCH: Also consider "seal-boston.bbb.org/badge/badge.min.js" in HTML as found
function detectBBBSeal(pages) {
  let found = false
  for (const { html } of pages) {
    // Check for badge JS in raw HTML
    if (html.includes('seal-boston.bbb.org/badge/badge.min.js')) {
      found = true
    }
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
// ...unchanged...

// ====== Model Call ======
// ...unchanged...

// ====== Enforcers & cleaners ======
// ...unchanged...

// ====== Handler ======
// ...unchanged export default async function handler(req, res) { ... }
