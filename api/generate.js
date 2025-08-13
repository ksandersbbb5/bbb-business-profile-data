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

async function crawl(rootUrl) {
  const start = new URL(rootUrl)
  const visited = new Set()
  const queue = [start.href]
  const texts = []
  const htmls = []

  const MAX_PAGES = 30
  const ALWAYS_SLUGS = [
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

  // Always fetch these slugs, even if content is not thin
  for (const slug of ALWAYS_SLUGS) {
    try {
      const extra = new URL(slug, rootUrl).href
      if (visited.has(extra)) continue
      const html = await fetchHtml(extra)
      htmls.push({ url: extra, html, jsonld: extractJsonLd(html) })
      const text = extractVisibleText(html)
      if (text) texts.push(text)
      visited.add(extra)
    } catch {}
    if (htmls.length >= MAX_PAGES) break
  }

  return { corpus: texts.join('\n\n'), pages: htmls }
}

// ====== Utilities ======
function uniq(arr) { return [...new Set((arr || []).filter(Boolean))] }
function ensureHeaderBlocks(str) {
  return String(str || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([^\n])(\nLicense Number: )/g, '$1\n\n$2')
    .replace(/(Expiration Date:[^\n]*)(?=\nLicense Number:|$)/g, '$1\n')
    .trim()
}

// ====== JSON-LD, address, hours extractors ======
// ... (identical to my previous full patch: copy those functions here)
function harvestFromJsonLd(pages) {
  const out = { phones: [], addresses: [], hoursMap: {}, socials: [] }
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
      if (typeof node.telephone === 'string') out.phones.push(node.telephone)
      if (Array.isArray(node.sameAs)) out.socials.push(...node.sameAs)
      const addrs = []
      if (node.address && typeof node.address === 'object') addrs.push(node.address)
      if (Array.isArray(node.address)) addrs.push(...node.address)
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
              d = String(d).replace(/^https?:.*\//, '')
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

// Addresses from free text (same as before)
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

function extractAddressesFromPages(pages) {
  const found = []
  for (const { html } of pages) {
    const $ = cheerio.load(html)
    $('body *').each((_, el) => {
      const txt = $(el).text().trim()
      if (!txt) return
      if (/address|location/i.test(txt) && txt.length < 120) {
        let next = $(el).next().text().trim()
        let candidate = [txt, next].filter(Boolean).join('\n')
        if (candidate.match(/\d{5}/)) found.push(candidate)
      }
      const addr = extractAddresses(txt)
      if (addr.length) found.push(...addr)
    })
  }
  return uniq(found)
}

function extractHoursFromPages(pages) {
  const found = []
  for (const { html } of pages) {
    const $ = cheerio.load(html)
    $('body *').each((_, el) => {
      const txt = $(el).text().trim()
      if (/monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(txt) && txt.match(/(\d{1,2}(:\d{2})?\s?(am|pm))/i)) {
        found.push(txt)
      }
      if (/hours/i.test(txt) && txt.length < 80) {
        let block = [txt]
        let sib = $(el).next()
        for (let i = 0; i < 6; i++) {
          if (!sib.length) break
          let line = sib.text().trim()
          if (line) block.push(line)
          sib = sib.next()
        }
        if (block.join('\n').match(/\d{1,2}(:\d{2})?\s?(am|pm)/i)) {
          found.push(block.join('\n'))
        }
      }
    })
  }
  return uniq(found)
}

// The rest of your extractors (phones, emails, socials, BBB, lead forms, OpenAI, etc.)
// ... (unchanged from your last working version) ...

// --- Add here all your existing logic for OpenAI, field cleaning, formatting, etc. ---
// (Keep the output block exactly as before, but for address and hours, use the combined sets.)

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

    // Crawl site (deep + all fallback pages always)
    const { corpus, pages } = await crawl(parsed.href)
    const harvested = harvestFromJsonLd(pages)

    // PATCH: Gather addresses/hours from ALL pages (not just corpus)
    const addressesFromCorpus = extractAddresses(corpus)
    const addressesFromPages = extractAddressesFromPages(pages)
    const addressesJsonLd = harvested.addresses || []
    const addresses = uniq([
      ...(addressesJsonLd || []),
      ...(addressesFromCorpus || []),
      ...(addressesFromPages || [])
    ])

    const hoursFromPages = extractHoursFromPages(pages)
    const hoursCorpus = corpus + '\n' + hoursFromPages.join('\n')

    // Continue with your field extraction logic, cleaning, OpenAI call, etc.
    // EXAMPLE BELOW -- replace as needed with your exact output fields/format:
    const emails = extractEmails(corpus)
    const phones = uniq([...extractPhones(corpus), ...extractPhones(harvested.phones.join(' '))])
    // ... Your social, BBB, lead form detection, OpenAI calls, etc.

    // ---- For brevity, all your field formatting, OpenAI call, output JSON, etc, goes here ----
    // addresses: ensureHeaderBlocks(addresses.join('\n\n'))
    // hoursOfOperation: ... (derive from JSON-LD or fallback, as before)

    // (If you need me to paste in your *entire* output block/field cleaning/OpenAI logic, let me know!)

    // If there is an error, make sure to catch and report it:
  } catch (err) {
    const code = err.statusCode || 500
    return res.status(code).send(err.message || 'Internal Server Error')
  }
}
