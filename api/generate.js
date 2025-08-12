import * as cheerio from 'cheerio'

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

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

const OWNER_DEMOGRAPHIC_CATEGORIES = [
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

const PAYMENT_METHODS = [
  "ACH", "Amazon Payments", "American Express", "Apply Pay", "Balance Adjustment",
  "Bitcoin", "Cash", "Certified Check", "China UnionPay", "Coupon", "Credit Card",
  "Debit Car", "Discover", "Electronic Check", "Financing", "Google Pay", "Invoice",
  "MasterCard", "Masterpass", "Money Order", "PayPal", "Samsung Pay", "Store Card",
  "Venmo", "Visa", "Western Union", "Wire Transfer", "Zelle"
]

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
  const htmls = []

  while (queue.length) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)
    try {
      const html = await fetchHtml(current)
      htmls.push(html)
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
  return { text: texts.join('\n\n'), htmls }
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

// Helper for owner demographic (exact match, case insensitive)
function extractOwnerDemographic(text) {
  for (let cat of OWNER_DEMOGRAPHIC_CATEGORIES) {
    const re = new RegExp(`\\b${cat}\\b`, 'i')
    if (re.test(text)) return cat
  }
  return 'None'
}

// Helper for payment methods
function extractPaymentMethods(text) {
  const found = []
  for (const method of PAYMENT_METHODS) {
    const re = new RegExp(`\\b${method}\\b`, 'i')
    if (re.test(text)) found.push(method)
  }
  return found.length ? found.join('\n') : 'None'
}

// Data point 4: Properly format, comma-separated, first letter capitalized per word
function extractProductsAndServices(text) {
  // Use OpenAI for more accurate extraction if desired, this is a fallback
  const matches = []
  const lines = text.split('\n')
  for (let l of lines) {
    if (/services|products|offer|specializes in|our/i.test(l)) {
      let items = l.split(/,| and |\bor\b|•|-|\u2022/)
      for (let item of items) {
        let cleaned = item.replace(/products?|services?|offered?|include|including|offering|we offer|we provide|our|specializes in|:|•|-|\u2022/gi, '').trim()
        // No promotional words
        if (
          cleaned &&
          cleaned.length <= 40 &&
          !matches.includes(cleaned) &&
          !/free shipping|quality assurance|product warranty|customer service|extra services|prunes/i.test(cleaned)
        ) {
          // Capitalize each word
          cleaned = cleaned.split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ')
          matches.push(cleaned)
        }
      }
    }
  }
  // Remove dups, filter out empty
  const unique = [...new Set(matches)].filter(x => x && x.length <= 40)
  return unique.length ? unique.join(', ') : 'None'
}

// Extract US-style addresses (3-line, only with city, state, zip; ignore PO Boxes, emails)
function extractAddresses(text) {
  const addressRegex = /(\d{1,6}[\w\s\.\#\-\,]*)(?:\n|,)\s*([A-Za-z\s]+),?\s+([A-Z]{2})\s+(\d{5})(?:[\n\,]|$)/g
  const matches = []
  let match
  while ((match = addressRegex.exec(text))) {
    let [_, line1, city, state, zip] = match
    if (/p\.?\s*o\.?\s*box/i.test(line1)) continue
    let addr = `${line1.trim()}\n${city.trim()}, ${state} ${zip}\nUS`
    matches.push(addr)
  }
  return matches.length ? matches.join('\n\n') : 'None'
}

// Extract hours of operation (example fallback, replace with OpenAI extraction for accuracy)
function extractHours(text) {
  const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
  const regex = new RegExp(days.join('|'), 'gi')
  if (!regex.test(text)) return 'None'
  const out = []
  for (let day of days) {
    const r = new RegExp(`${day}:?\\s*([0-9]{1,2}:?[0-9]{0,2}\\s*[APMapm\\.]{2,4})\\s*[-–]\\s*([0-9]{1,2}:?[0-9]{0,2}\\s*[APMapm\\.]{2,4})`, 'i')
    const m = text.match(r)
    if (m) {
      let [_, open, close] = m
      out.push(`${day}: ${open.toUpperCase()} - ${close.toUpperCase()}`)
    } else {
      if (new RegExp(`${day}:?\\s*Closed`, 'i').test(text)) {
        out.push(`${day}: Closed`)
      } else {
        out.push(`${day}: Closed`)
      }
    }
  }
  return out.length === 7 ? out.join('\n') : 'None'
}

function extractPhoneNumbers(text) {
  const phoneRegex = /(?:\+1[\s\-\.])?\(?([2-9]\d{2})\)?[\s\-\.]?(\d{3})[\s\-\.]?(\d{4})(?:\s*(?:x|ext\.?|extension)\s*(\d{1,6}))?/g
  const numbers = []
  let match
  while ((match = phoneRegex.exec(text))) {
    let [_, area, first, last, ext] = match
    let num = `(${area}) ${first}-${last}`
    if (ext) num += ` ext. ${ext}`
    numbers.push(num)
  }
  return numbers.length ? numbers.join('\n') : 'None'
}

// Data point 11: Always return None if empty
function extractEmails(text) {
  const emailRegex = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g
  const emails = new Set()
  let match
  while ((match = emailRegex.exec(text))) {
    emails.add(match[1].toLowerCase())
  }
  return emails.size ? Array.from(emails).join('\n') : 'None'
}

// Extract license info: basic regex for License, State, Type, Status, Exp Date
function extractLicenses(text) {
  const lines = text.split('\n')
  const results = []
  for (let l of lines) {
    if (/license/i.test(l)) {
      let m = {}
      let num = l.match(/License (?:Number|#):?\s*([A-Z0-9\-]+)/i)
      let auth = l.match(/Issuing Authority:?\s*([\w\s,.]+)/i)
      let type = l.match(/License Type:?\s*([\w\s]+)/i)
      let status = l.match(/Status:?\s*(Active|Inactive|Pending|Expired)/i)
      let exp = l.match(/Expiration Date:?\s*([\d/]+)/i)
      if (num) m['License Number'] = num[1]
      if (auth) m['Issuing Authority'] = auth[1]
      if (type) m['License Type'] = type[1]
      if (status) m['Status'] = status[1]
      if (exp) m['Expiration Date'] = exp[1]
      if (Object.keys(m).length) {
        results.push(Object.entries(m).map(([k,v]) => `${k}: ${v}`).join('\n'))
      }
    }
  }
  return results.length ? results.join('\n\n') : 'None'
}

// Social media URLs
function extractSocialMediaUrls(htmls) {
  const patterns = {
    Facebook: /https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9_.-]+/gi,
    Instagram: /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.-]+/gi,
    LinkedIn: /https?:\/\/(?:www\.)?linkedin\.com\/[A-Za-z0-9_\-\/]+/gi,
    X: /https?:\/\/(?:www\.)?(x\.com|twitter\.com)\/[A-Za-z0-9_.-]+/gi,
    TikTok: /https?:\/\/(?:www\.)?tiktok\.com\/[A-Za-z0-9_.-]+/gi,
    YouTube: /https?:\/\/(?:www\.)?youtube\.com\/[A-Za-z0-9_\-\/]+/gi,
    Vimeo: /https?:\/\/(?:www\.)?vimeo\.com\/[A-Za-z0-9_.-]+/gi,
    Flickr: /https?:\/\/(?:www\.)?flickr\.com\/[A-Za-z0-9_.-]+/gi,
    Foursquare: /https?:\/\/(?:www\.)?foursquare\.com\/[A-Za-z0-9_.-]+/gi,
    Threads: /https?:\/\/(?:www\.)?threads\.net\/[A-Za-z0-9_.-]+/gi,
    Tumblr: /https?:\/\/(?:www\.)?tumblr\.com\/[A-Za-z0-9_.-]+/gi
  }
  const found = []
  for (const html of htmls) {
    for (const [platform, regex] of Object.entries(patterns)) {
      const matches = html.match(regex)
      if (matches) {
        for (const url of matches) {
          if (/\.com\/[^\/\s]+/.test(url) || /\.net\/[^\/\s]+/.test(url)) {
            found.push(`${platform}: ${url}`)
          }
        }
      }
    }
  }
  return found.length ? Array.from(new Set(found)).join('\n') : 'None'
}

// BBB Seal (data point 10) - NOT FOUND output in red
function extractBbbSeal(htmls, text) {
  for (const html of htmls) {
    if (/img[^>]+(?:bbb|accredited)/i.test(html)) {
      return 'FOUND    It appears the BBB Accredited Business Seal IS on this website or the website uses the text BBB Accredited.'
    }
  }
  if (/BBB Accredited/i.test(text)) {
    return 'FOUND    It appears the BBB Accredited Business Seal IS on this website or the website uses the text BBB Accredited.'
  }
  // Output red font for NOT FOUND (html encoded)
  return '<span style="color:#c00;font-weight:bold;">NOT FOUND    It appears the BBB Accredited Business Seal is NOT on this website.</span>'
}

// Data point 13: Service Area
function extractServiceArea(text) {
  // Try to match patterns like "serving [territory...]" or "service area includes [..]"
  const areas = []
  const serviceRegex = /\b(serving|service area(?: includes)?|areas we serve|providing service to)\b[:\-]?\s*([A-Za-z0-9,\s\-]+[\.]?)/gi
  let match
  while ((match = serviceRegex.exec(text))) {
    let phrase = (match[2] || '').replace(/\.\s*$/, '').trim()
    // Avoid repeats, trim, filter empty
    if (phrase && !areas.includes(phrase)) areas.push(phrase)
  }
  return areas.length ? areas.join(', ') : 'None'
}

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

    // Crawl site
    const { text: corpus, htmls } = await crawl(parsed.href)
    if (!corpus || corpus.length < 40) {
      return res.status(422).send('Could not extract enough content from the provided site.')
    }

    // Call OpenAI for the main business description and client base
    const systemPrompt = `You are a BBB representative enhancing a BBB Business Profile.
Strictly follow these rules when writing the Business Description.
INFORMATION SOURCE: Use ONLY the provided website content.
EXCLUSIONS: Do not reference other businesses in the industry. Exclude owner names, locations, hours of operation, and time-related information. Avoid the characters * [ ].
DO NOT INCLUDE: the text “Business Description” or any variation; the phrase “for more information visit their website…” or any variation; links to any websites; promotional words/phrases; any wording implying trust/endorsement/popularity.
GENERAL GUIDELINES: Max 900 characters; factual; no advertising claims, business history, or storytelling.
TEMPLATE: "[Company Name] provides [products/services offered], including [specific details about products/services]. The company assists clients with [details on the service process]."
OUTPUT: JSON with keys description (string) and clientBase (one of: residential, commercial, residential and commercial, government, non-profit). Do not add extra keys. Write the description in plain text complying with all constraints.`

    const userPrompt = `Website URL: ${parsed.href}

WEBSITE CONTENT (verbatim, may be long):

${corpus}

IMPORTANT: Ensure your description (<=900 chars) contains no promotional language and no forbidden words/characters. Determine clientBase from the content and sentiment, choosing exactly one of the allowed options.`

    let aiRaw = await callOpenAI(systemPrompt, userPrompt)

    // Parse JSON (be tolerant)
    let payload
    try {
      const jsonMatch = aiRaw.match(/\{[\s\S]*\}$/)
      payload = JSON.parse(jsonMatch ? jsonMatch[0] : aiRaw)
    } catch {
      const fix = await callOpenAI(
        'Return ONLY valid JSON with keys description and clientBase, nothing else.',
        `Please convert the following into strict JSON: ${aiRaw}`
      )
      payload = JSON.parse(fix)
    }

    let description = String(payload.description || '')
    let clientBase = enforceClientBase(payload.clientBase)

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

    // All other extractions (from site text/html)
    const ownerDemographic = extractOwnerDemographic(corpus)
    const productsAndServices = extractProductsAndServices(corpus)
    const hoursOfOperation = extractHours(corpus)
    const addresses = extractAddresses(corpus)
    const phoneNumbers = extractPhoneNumbers(corpus)
    const socialMediaUrls = extractSocialMediaUrls(htmls)
    const licenseNumbers = extractLicenses(corpus)
    const emails = extractEmails(corpus)
    const paymentMethods = extractPaymentMethods(corpus)
    const bbbSeal = extractBbbSeal(htmls, corpus)
    const serviceArea = extractServiceArea(corpus)

    res.setHeader('Content-Type', 'application/json')
    return res.status(200).send(JSON.stringify({
      url: parsed.href,
      description,
      clientBase,
      ownerDemographic,
      productsAndServices,
      hoursOfOperation,
      addresses,
      phoneNumbers,
      socialMediaUrls,
      licenseNumbers,
      emails,
      paymentMethods,
      bbbSeal,
      serviceArea
    }))
  } catch (err) {
    console.error('API ERROR:', err, err.stack)
    const code = err.statusCode || 500
    return res.status(code).send(err.message || 'Internal Server Error')
  }
}
