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
  // preserve some line breaks for better regex detection
  const text = $('body').text().replace(/\r/g, '').replace(/\n\s*\n+/g, '\n\n').replace(/[ \t]+/g, ' ').trim()
  return text
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

// ====== Deterministic extractors (social, phones, emails, addresses, BBB seal) ======
function uniq(arr) { return [...new Set(arr.filter(Boolean))] }

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
  // Look for: 123 Main St, Suite 400, Boston, MA 02108 (comma between city & state optional)
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
    { key: 'Facebook', hosts: ['facebook.com'] , disallow: ['/sharer'] },
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
        const u = new URL(href, 'https://example.com') // allow relative parsing; we only care path
        const host = u.hostname.replace(/^www\./, '')
        const path = u.pathname || '/'
        for (const d of domains) {
          if (d.hosts.some(h => host.endsWith(h))) {
            if (!path || path === '/' || path.length <= 1) return
            if (d.disallow && d.disallow.some(bad => path.startsWith(bad))) return
            // keep absolute if present, else fallback to href
            found.push(`${d.key}: ${href.startsWith('http') ? href : `https://${host}${path}${u.search || ''}`}`)
          }
        }
      } catch { /* ignore */ }
    })
  }
  return uniq(found)
}

function detectBBBSeal(pages) {
  let found = false
  for (const { html } of pages) {
    const $ = cheerio.load(html)
    const bodyText = $('body').text().toLowerCase()
    if (/\bbbb accredited\b/.test(bodyText) && !/site managed by bbb/i.test(bodyText)) {
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
  // remove explicit link fragments just in case
  t = t.replace(/https?:\S+/g, '')
  return t.trim()
}

function ensureHeaderBlocks(str) {
  // Normalize newlines and ensure addresses/licenses keep blank lines
  return String(str || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
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

    // Crawl same origin home + depth 1
    const { corpus, pages } = await crawl(parsed.href)
    if (!corpus || corpus.length < 40) {
      return res.status(422).send('Could not extract enough content from the provided site.')
    }

    // Deterministic fields we can extract from HTML/text directly
    const emails = extractEmails(corpus)
    const phones = extractPhones(corpus)
    const addresses = extractAddresses(corpus)
    const socialFound = extractSocialFromPages(pages)
    const bbbFound = detectBBBSeal(pages)

    // Build deterministic strings
    const emailAddresses = emails.length ? emails.join('\n') : 'None'
    const phoneNumbers = phones.length ? phones.join('\n') : 'None'
    const addressesBlock = addresses.length ? addresses.join('\n\n') : 'None'
    const socialMediaUrls = socialFound.length ? socialFound.join('\n') : 'None'
    const bbbSeal = bbbFound
      ? 'FOUND    It appears the BBB Accredited Business Seal IS on this website or the website uses the text BBB Accredited.'
      : 'NOT FOUND    It appears the BBB Accredited Business Seal is NOT on this website.'

    // ====== Ask the model for the *judgment* fields (desc, client base, hours, licenses, products, owner demo, methods, service area, refund) ======
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

ADDRESSES/PHONES/EMAILS/SOCIALS:
- Will be provided separately; do not fabricate them.

OWNER DEMOGRAPHIC:
- Return exact match from the approved list (case-insensitive) or "None".

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
- Geographic areas (city/county/state/zip) explicitly listed on the site. If none, "None".

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
Do not include addresses, phoneNumbers, emailAddresses, socialMediaUrls, or bbbSeal in JSON—they are sent separately.`

    const userPrompt = `Website URL: ${parsed.href}

WEBSITE CONTENT (verbatim):
${corpus}

IMPORTANT:
- Never fabricate values.
- For Hours of Operation: if you cannot list all Monday-Sunday lines from the site, return "None".
- Follow the templates exactly.
- Return ONLY strict JSON.`

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
    let description = sanitizeDescription(String(payload.description || ''))
    let clientBase = enforceClientBase(payload.clientBase)

    // Final description must append client base sentence and remove banned words if any
    description = description.replace(/\s+$/, '')
    if (description) {
      if (!/[.!?]$/.test(description)) description += '.'
      description += ` The business provides services to ${clientBase} customers.`
    } else {
      description = `The business provides services to ${clientBase} customers.`
    }
    if (containsBanned(description)) {
      // last-ditch removal of banned words
      for (const p of BANNED_PHRASES) {
        const re = new RegExp(p, 'gi')
        description = description.replace(re, '')
      }
      description = sanitizeDescription(description)
    }

    let ownerDemographic = String(payload.ownerDemographic || 'None') || 'None'
    let productsAndServices = String(payload.productsAndServices || 'None') || 'None'
    // Normalize capitalization for products/services list
    if (productsAndServices !== 'None') {
      const items = productsAndServices.split(',').map(s => s.trim()).filter(Boolean).map(s =>
        s.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
      )
      productsAndServices = uniq(items).join(', ')
    }

    // Hours: must contain all 7 days correctly or set to "None"
    let hoursOfOperation = String(payload.hoursOfOperation || 'None') || 'None'
    if (hoursOfOperation !== 'None') {
      const lines = hoursOfOperation.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      const required = ['Monday:','Tuesday:','Wednesday:','Thursday:','Friday:','Saturday:','Sunday:']
      const ok = required.every(day => lines.some(l => l.startsWith(day)))
      if (!ok) hoursOfOperation = 'None'
    }

    // Licenses: ensure block formatting and ensure each field present (or None)
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

    let methodsOfPayment = String(payload.methodsOfPayment || 'None') || 'None'
    let serviceArea = String(payload.serviceArea || 'None') || 'None'
    let refundAndExchangePolicy = String(payload.refundAndExchangePolicy || 'None') || 'None'

    // Timing
    const elapsed = Date.now() - start
    const mins = Math.floor(elapsed / 60000)
    const secs = Math.floor((elapsed % 60000) / 1000)
    const timeTaken = `${mins} minute${mins === 1 ? '' : 's'} ${secs} second${secs === 1 ? '' : 's'}`

    // Return everything (UI will render bold headers / spacing)
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
      bbbSeal,
      serviceArea,
      refundAndExchangePolicy
    }))

  } catch (err) {
    const code = err.statusCode || 500
    return res.status(code).send(err.message || 'Internal Server Error')
  }
}
