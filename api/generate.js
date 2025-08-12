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
  return { corpus: texts.join('\n\n'), pages: htmls }
}

// ====== Deterministic extractors ======
function uniq(arr) { return [...new Set((arr || []).filter(Boolean))] }

function extractEmails(text) {
  return uniq(text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
}

function extractPhones(text) {
  const out = []
  const re = /(?:\+?1[\s.-]?)?(?:\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4}))(?:\s*(?:ext\.?|x|extension)\s*(\d+))?/gi
  let m
  while ((m = re.exec(text))) {
    let s = `(${m[1]}) ${m[2]}-${m[3]}`
    if (m[4]) s += ` ext. ${m[4]}`
    out.push(s)
  }
  return uniq(out)
}

function extractAddresses(text) {
  // 123 Main St, Suite 400, Boston, MA 02108   (comma after city optional)
  const re = /(\d{1,6}[^\n,]*?(?:\b(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Pl|Place|Pkwy|Parkway|Hwy|Highway|Way|Terr|Terrace|Cir|Circle|Unit|Suite|Ste|#)\b[^\n,]*)?)\s*,?\s*([A-Za-z][A-Za-z\s\.'-]+),?\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)/g
  const out = []
  let m
  while ((m = re.exec(text))) {
    const line1 = m[1].replace(/\s{2,}/g, ' ').trim()
    const city = m[2].replace(/,$/, '').replace(/\s{2,}/g, ' ').trim()
    const state = m[3].trim()
    const zip = m[4].trim()
    out.push(`${line1}\n${city}, ${state} ${zip}\nUSA`)
  }
  return uniq(out)
}

function extractSocialFromPages(pages) {
  const domains = [
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
  const found = []
  for (const { html } of pages) {
    const $ = cheerio.load(html)
    $('a[href]').each((_, a) => {
      const href = String($(a).attr('href') || '')
      try {
        const u = new URL(href, 'https://example.com') // relative safe
        const host = u.hostname.replace(/^www\./, '')
        const path = u.pathname || '/'
        for (const d of domains) {
          if (d.hosts.some(h => host.endsWith(h))) {
            if (!path || path === '/' || path.length <= 1) return // require at least one path segment
            if (d.disallow && d.disallow.some(bad => path.startsWith(bad))) return
            found.push(`${d.key}: ${href.startsWith('http') ? href : `https://${host}${path}${u.search || ''}`}`)
          }
        }
      } catch {}
    })
  }
  return uniq(found)
}

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
      if (src.includes('bbb') || src.includes('accredited')) found = true
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
  // Accept 8, 8am, 8 am, 08:00, 8:00pm, etc.
  const t = tok.trim().toLowerCase()
  const m1 = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!m1) return null
  let h = parseInt(m1[1], 10)
  let m = m1[2] ? parseInt(m1[2],10) : 0
  const ap = m1[3]
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (!ap && h <= 7) {
    // If no AM/PM and small hour, assume AM for open and PM for close handled by caller
  }
  return { h, m, hasAP: !!ap }
}

function expandRange(token) {
  // e.g., "Mon-Fri: 8am - 7pm" or "Mon – Fri 8:00 - 19:00"
  const re = /(Mon|Tue|Wed|Thu|Thur|Fri|Sat|Sun)\s*[-–]\s*(Mon|Tue|Wed|Thu|Thur|Fri|Sat|Sun)\s*[:\-]?\s*([0-9: ]+(?:am|pm)?)\s*[-–]\s*([0-9: ]+(?:am|pm)?)/i
  const m = token.match(re)
  if (!m) return null
  const startDay = DAY_ABBR[m[1]]
  const endDay = DAY_ABBR[m[2]]
  const openTok = m[3]; const closeTok = m[4]
  const open = parseTimeToken(openTok); const close = parseTimeToken(closeTok)
  if (!open || !close) return null

  const startIdx = FULL_DAYS.indexOf(startDay)
  const endIdx = FULL_DAYS.indexOf(endDay)
  if (startIdx < 0 || endIdx < 0) return null

  const lines = {}
  for (let i = startIdx; i <= endIdx; i++) {
    const openStr = toAmPm(open.h, open.m)
    const closeStr = toAmPm(close.h, close.m)
    lines[FULL_DAYS[i]] = `${FULL_DAYS[i]}: ${openStr} - ${closeStr}`
  }
  return lines
}

function normalizeHoursFromCorpus(corpus) {
  // Try pattern like "Mon-Fri: 8am - 7pm"
  const rangeMatches = corpus.match(/(?:Mon|Tue|Wed|Thu|Thur|Fri|Sat|Sun)\s*[-–]\s*(?:Mon|Tue|Wed|Thu|Thur|Fri|Sat|Sun)[^.\n]*?\d[^.\n]*?(?:am|pm)?\s*[-–]\s*\d[^.\n]*?(?:am|pm)?/ig) || []
  const dayLineMatches = corpus.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*:\s*[^\n]+/ig) || []
  const map = {}

  // Expand ranges
  for (const rm of rangeMatches) {
    const lines = expandRange(rm)
    if (lines) Object.assign(map, lines)
  }

  // Direct day lines like "Monday: 09:00 AM - 05:00 PM" or "Monday: 8am - 7pm"
  for (const dl of dayLineMatches) {
    const m = dl.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*:\s*(.*)$/i)
    if (!m) continue
    const day = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
    const times = m[2].trim()

    if (/closed/i.test(times)) {
      map[day] = `${day}: Closed`
      continue
    }

    // Parse "8am - 7pm" | "08:00 - 19:00"
    const tm = times.match(/^([0-9: ]+(?:am|pm)?)\s*[-–]\s*([0-9: ]+(?:am|pm)?)$/i)
    if (tm) {
      const o = parseTimeToken(tm[1]); const c = parseTimeToken(tm[2])
      if (o && c) {
        map[day] = `${day}: ${toAmPm(o.h, o.m)} - ${toAmPm(c.h, c.m)}`
      }
    }
  }

  // Only return if we have ALL seven days
  const lines = FULL_DAYS.map(d => map[d] || null)
  if (lines.every(Boolean)) return lines.join('\n')
  return 'None'
}

function fixHoursFormatting(modelHours, corpus) {
  // If model returned concatenated or incorrect, try to split/normalize; else fall back to corpus
  if (!modelHours || modelHours === 'None') {
    return normalizeHoursFromCorpus(corpus)
  }
  let s = String(modelHours).replace(/\r/g, '').trim()

  // Insert newlines before each full day if missing
  s = s.replace(/\s*(Monday:)/g, '\n$1')
       .replace(/\s*(Tuesday:)/g, '\n$1')
       .replace(/\s*(Wednesday:)/g, '\n$1')
       .replace(/\s*(Thursday:)/g, '\n$1')
       .replace(/\s*(Friday:)/g, '\n$1')
       .replace(/\s*(Saturday:)/g, '\n$1')
       .replace(/\s*(Sunday:)/g, '\n$1')
       .trim()
  const lines = s.split(/\n+/).map(x => x.trim()).filter(Boolean)

  // Validate exact format
  const re = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday):\s*(?:Closed|(\d{2}:\d{2}\s(?:AM|PM))\s-\s(\d{2}:\d{2}\s(?:AM|PM)))$/
  const ok = FULL_DAYS.every(day => lines.some(l => re.test(l) && l.startsWith(day + ':')))
  if (!ok) {
    // fallback: try corpus extraction
    return normalizeHoursFromCorpus(corpus)
  }
  // Return as-is (already one line per day)
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
  // remove accidental headers
  t = t.replace(/^\s*Business\s*Description\s*:?\s*/i, '')
  return t.trim()
}

function ensureHeaderBlocks(str) {
  return String(str || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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
    const { corpus, pages } = await crawl(parsed.href)
    if (!corpus || corpus.length < 40) {
      return res.status(422).send('Could not extract enough content from the provided site.')
    }

    // Deterministic fields
    const emails = extractEmails(corpus)
    const phones = extractPhones(corpus)
    const addresses = extractAddresses(corpus)
    const socialFound = extractSocialFromPages(pages)
    const bbbFound = detectBBBSeal(pages)

    const emailAddresses = emails.length ? emails.join('\n') : 'None'
    const phoneNumbers = phones.length ? phones.join('\n') : 'None'
    const addressesBlock = addresses.length ? addresses.join('\n\n') : 'None'
    const socialMediaUrls = socialFound.length ? socialFound.join('\n') : 'None'
    const bbbSealPlain = bbbFound
      ? 'FOUND    It appears the BBB Accredited Business Seal IS on this website or the website uses the text BBB Accredited.'
      : 'NOT FOUND    It appears the BBB Accredited Business Seal is NOT on this website.'

    // ====== Model for judgment fields ======
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
    let desc0 = sanitizeDescription(String(payload.description || ''))
    let clientBase = enforceClientBase(payload.clientBase)

    // Re-write description to exact template + neutralize (second pass)
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

    // Hours: normalize/validate (one line per day or None)
    let hoursOfOperation = fixHoursFormatting(String(payload.hoursOfOperation || 'None') || 'None', corpus)

    // Licenses: format each block and ensure blank line after each block
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

    // Final response (plain text fields, with proper newlines)
    res.setHeader('Content-Type', 'application/json')
    return res.status(200).send(JSON.stringify({
      url: parsed.href,
      timeTaken,

      description,
      clientBase,
      ownerDemographic,
      productsAndServices,

      hoursOfOperation, // one line per day or "None"

      addresses: ensureHeaderBlocks(addresses.length ? addresses.join('\n\n') : 'None'), // includes USA + blank line
      phoneNumbers: ensureHeaderBlocks(phones.length ? phones.join('\n') : 'None'),      // one per row
      emailAddresses: ensureHeaderBlocks(emails.length ? emails.join('\n') : 'None'),    // one per row
      socialMediaUrls: ensureHeaderBlocks(socialFound.length ? socialFound.join('\n') : 'None'), // one per row

      licenseNumbers: ensureHeaderBlocks(licenseNumbers),
      methodsOfPayment,
      bbbSeal: bbbSealPlain, // plain text, no HTML
      serviceArea,
      refundAndExchangePolicy
    }))

  } catch (err) {
    const code = err.statusCode || 500
    return res.status(code).send(err.message || 'Internal Server Error')
  }
}
