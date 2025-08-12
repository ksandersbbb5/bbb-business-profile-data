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
  'residential', 'commercial', 'residential and commercial', 'government', 'non-profit'
])

const APPROVED_PAYMENT_METHODS = [
  'ACH', 'Amazon Payments', 'American Express', 'Apply Pay', 'Balance Adjustment',
  'Bitcoin', 'Cash', 'Certified Check', 'China UnionPay', 'Coupon', 'Credit Card',
  'Debit Car', 'Discover', 'Electronic Check', 'Financing', 'Google Pay', 'Invoice',
  'MasterCard', 'Masterpass', 'Money Order', 'PayPal', 'Samsung Pay', 'Store Card',
  'Venmo', 'Visa', 'Western Union', 'Wire Transfer', 'Zelle'
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
  const rawHtmls = []

  while (queue.length) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)
    try {
      const html = await fetchHtml(current)
      rawHtmls.push(html)
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
  return {
    text: texts.join('\n\n'),
    html: rawHtmls.join('\n\n<!--PAGEBREAK-->\n\n')
  }
}

// --- social media extraction (cheerio, stricter path check) ---
function extractSocialUrls(allHtml) {
  const $ = cheerio.load(allHtml)
  const found = []
  const patterns = [
    { label: 'Facebook', rx: /^https?:\/\/(www\.)?facebook\.com\/([^/?#]+)[^?#]*$/i },
    { label: 'Instagram', rx: /^https?:\/\/(www\.)?instagram\.com\/([^/?#]+)[^?#]*$/i },
    { label: 'LinkedIn', rx: /^https?:\/\/(www\.)?linkedin\.com\/(company|in)\/([^/?#]+)[^?#]*$/i },
    { label: 'X', rx: /^https?:\/\/(www\.)?(twitter\.com|x\.com)\/([^/?#]+)[^?#]*$/i },
    { label: 'TikTok', rx: /^https?:\/\/(www\.)?tiktok\.com\/(@|user\/)?([^/?#]+)[^?#]*$/i },
    { label: 'YouTube', rx: /^https?:\/\/(www\.)?youtube\.com\/(user|channel|c|embed)\/([^/?#]+)[^?#]*$/i },
    { label: 'Vimeo', rx: /^https?:\/\/(www\.)?vimeo\.com\/([^/?#]+)[^?#]*$/i },
    { label: 'Flickr', rx: /^https?:\/\/(www\.)?flickr\.com\/([^/?#]+)[^?#]*$/i },
    { label: 'Foursquare', rx: /^https?:\/\/(www\.)?foursquare\.com\/([^/?#]+)[^?#]*$/i },
    { label: 'Threads', rx: /^https?:\/\/(www\.)?threads\.net\/([^/?#]+)[^?#]*$/i },
    { label: 'Tumblr', rx: /^https?:\/\/(www\.)?tumblr\.com\/([^/?#]+)[^?#]*$/i }
  ]
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return
    for (const { label, rx } of patterns) {
      if (rx.test(href)) {
        found.push(`${label}: ${href}`)
        return
      }
    }
  })
  return found.length ? found.join('\n') : 'None'
}

// --- address extraction (basic US format) ---
function extractAddresses(text) {
  // Simple US address regex (street, city, state, ZIP)
  const rx = /(\d{1,5}(?: [A-Za-z0-9\.\#\-]+)+)[, ]+\s*([A-Za-z\s]+),?\s*([A-Z]{2})\s*(\d{5})(?:[\-, ]+)?(US|United States)?/gi
  const addresses = []
  let match
  while ((match = rx.exec(text))) {
    const [_, street, city, state, zip] = match
    let country = 'US'
    addresses.push(`${street}\n${city}, ${state} ${zip}\n${country}`)
  }
  return addresses.length ? addresses.join('\n\n') : 'None'
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

    // Crawl for text and html
    const crawlResult = await crawl(parsed.href)
    const corpus = crawlResult.text
    const allHtml = crawlResult.html

    if (!corpus || corpus.length < 40) {
      return res.status(422).send('Could not extract enough content from the provided site.')
    }

    // --- Compose the system prompt as described ---
    const systemPrompt = `
You are a BBB representative enhancing a BBB Business Profile. Strictly follow these rules when writing the Business Description and extracting all other fields.
INFORMATION SOURCE: Use ONLY the provided website content.
EXCLUSIONS: Do not reference other businesses in the industry. Exclude owner names, locations, hours of operation, and time-related information from the description field. Avoid the characters * [ ].
DO NOT INCLUDE: the text “Business Description” or any variation; the phrase “for more information visit their website…” or any variation; links to any websites; promotional words/phrases; any wording implying trust/endorsement/popularity.
GENERAL GUIDELINES: Max 900 characters; factual; no advertising claims, business history, or storytelling.
TEMPLATE: "[Company Name] provides [products/services offered], including [specific details about products/services]. The company assists clients with [details on the service process]."
OUTPUT: Return a strict JSON object with the following keys:
- description (string)
- clientBase (one of: residential, commercial, residential and commercial, government, non-profit)
- ownerDemographic (see below)
- productsAndServices (see below)
- hoursOfOperation (see below)
- addresses (see below)
- phoneNumbers (see below)
- socialMediaUrls (see below)
- licenseNumbers (see below)
- emailAddresses (see below)
- methodsOfPayment (see below)
- bbbSeal (see below)
- serviceArea (see below)

Specific Instructions for each key:
1. description: See above instructions.
2. clientBase: Only output one of the allowed values.
3. ownerDemographic: Use exact-match logic as previously provided.
4. productsAndServices: List all products/services as a comma-separated list. The first letter of each word should be capitalized (e.g., 'Landscape Design, Irrigation Systems'). Do NOT make up or guess products or services. If none are found, output 'None'.
5. hoursOfOperation: Only extract if there is explicit data for all days of the week, using the format "Monday: 09:00 AM - 05:00 PM". If no explicit hours for all days, output 'None'. Do not guess or invent hours of operation.
6. addresses: Extract only valid, physical addresses with street, city, state, and zip (no PO Boxes). If none, output 'None'.
7. phoneNumbers: Extract only valid US phone numbers. Format as (XXX) XXX-XXXX. If none, output 'None'.
8. socialMediaUrls: Extract only social media URLs that are not root domains (e.g., facebook.com/username is valid, but facebook.com/ is not). If none, output 'None'.
9. licenseNumbers: See previous licensing instructions.
10. emailAddresses: Extract valid email addresses. If none, output 'None'.
11. methodsOfPayment: Only list from the approved list. If none, output 'None'.
12. bbbSeal: If a BBB seal image or "BBB Accredited" phrase is found, output: "FOUND    It appears the BBB Accredited Business Seal IS on this website or the website uses the text BBB Accredited." If not found, output: "NOT FOUND    It appears the BBB Accredited Business Seal is NOT on this website." (If NOT FOUND, output must be shown in red on the frontend.)
13. serviceArea: Extract any service area details (city, county, state, zip). If none, output 'None'.

DO NOT GUESS or make up any data. Return "None" for any field where no explicit information is found.
`

    const userPrompt = `Website URL: ${parsed.href}
WEBSITE CONTENT (verbatim, may be long):

${corpus}

IMPORTANT: Ensure your description (<=900 chars) contains no promotional language and no forbidden words/characters. Determine clientBase from the content and sentiment, choosing exactly one of the allowed options. Extract all fields per the guidelines above.`

    let aiRaw = await callOpenAI(systemPrompt, userPrompt)
    let payload
    try {
      const jsonMatch = aiRaw.match(/\{[\s\S]*\}$/)
      payload = JSON.parse(jsonMatch ? jsonMatch[0] : aiRaw)
    } catch {
      const fix = await callOpenAI(
        'Return ONLY valid JSON with the specified keys and correct values, nothing else.',
        `Please convert the following into strict JSON (no extra text): ${aiRaw}`
      )
      payload = JSON.parse(fix)
    }

    // Address fallback: if the model fails, do a direct parse
    if (!payload.addresses || payload.addresses === 'None') {
      const extractedAddrs = extractAddresses(corpus)
      if (extractedAddrs !== 'None') payload.addresses = extractedAddrs
    }

    // Social media fallback: model often misses, so check HTML
    if (!payload.socialMediaUrls || payload.socialMediaUrls === 'None') {
      const sm = extractSocialUrls(allHtml)
      if (sm && sm !== 'None') payload.socialMediaUrls = sm
    }

    // Description strip, sanitize
    let description = String(payload.description || '')
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

    // Final build
    payload.description = description
    payload.clientBase = enforceClientBase(payload.clientBase)
    if (!payload.ownerDemographic) payload.ownerDemographic = 'None'
    if (!payload.productsAndServices) payload.productsAndServices = 'None'
    if (!payload.hoursOfOperation) payload.hoursOfOperation = 'None'
    if (!payload.addresses) payload.addresses = 'None'
    if (!payload.phoneNumbers) payload.phoneNumbers = 'None'
    if (!payload.socialMediaUrls) payload.socialMediaUrls = 'None'
    if (!payload.licenseNumbers) payload.licenseNumbers = 'None'
    if (!payload.emailAddresses) payload.emailAddresses = 'None'
    if (!payload.methodsOfPayment) payload.methodsOfPayment = 'None'
    if (!payload.bbbSeal) payload.bbbSeal = 'None'
    if (!payload.serviceArea) payload.serviceArea = 'None'

    res.setHeader('Content-Type', 'application/json')
    return res.status(200).send(JSON.stringify({
      url: parsed.href,
      ...payload
    }))
  } catch (err) {
    const code = err.statusCode || 500
    return res.status(code).send(err.message || 'Internal Server Error')
  }
}
