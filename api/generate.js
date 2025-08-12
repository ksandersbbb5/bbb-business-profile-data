import * as cheerio from 'cheerio'

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

// -- Helper functions --
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

const ALLOWED_OWNER_DEMOGRAPHICS = [
  'Asian American Owned', 'Black/African American Owned', 'African American Owned', 'Black Owned', 'Disabled Owned',
  'Employee Owned Owned', 'Family Owned', 'Family-Owned', 'First Responder Owned', 'Hispanic Owned', 'Indigenous Owned',
  'LBGTQ Owned', 'Middle Eastern Owned', 'Minority Owned', 'Native American Owned', 'Pacific Owned', 'Veteran Owned', 'Woman Owned'
]

const ALLOWED_PAYMENT_METHODS = [
  'ACH', 'Amazon Payments', 'American Express', 'Apply Pay', 'Balance Adjustment', 'Bitcoin', 'Cash', 'Certified Check',
  'China UnionPay', 'Coupon', 'Credit Card', 'Debit Car', 'Discover', 'Electronic Check', 'Financing', 'Google Pay', 'Invoice',
  'MasterCard', 'Masterpass', 'Money Order', 'PayPal', 'Samsung Pay', 'Store Card', 'Venmo', 'Visa', 'Western Union',
  'Wire Transfer', 'Zelle'
]

const BANNED_PHRASES = [
  // ... same as your list ...
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

  while (queue.length) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)
    try {
      const html = await fetchHtml(current)
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
  return texts.join('\n\n')
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

// -- Data point post-processors --
function dedupList(items) {
  return Array.from(new Set(items.map(i => i.trim()).filter(Boolean)))
}

function fixProductsAndServices(str) {
  // Remove anything after a period or new line that is not a list
  if (!str) return 'None'
  // Remove numbers/phone/offers/extra
  let parts = str.split(/,|\n/).map(s => s.trim()).filter(s =>
    s.length > 0 &&
    s.length < 40 &&
    !/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(s) && // not a phone
    !/offer|call|message|email|contact|estimate|price|free|saving|financ/i.test(s)
  )
  parts = parts.map(s =>
    s.split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
  )
  return dedupList(parts).join(', ') || 'None'
}
function dedupAndFormatPhones(str) {
  if (!str) return 'None'
  let nums = str.match(/\(\d{3}\) \d{3}-\d{4}( ext\. \d+)?/g)
  return dedupList(nums || []).join('\n') || 'None'
}
function filterSocialUrls(lines) {
  if (!lines) return 'None'
  let socials = lines
    .split('\n')
    .map(x => x.trim())
    .filter(x => /^(Facebook|Instagram|LinkedIn|X|TikTok|YouTube|Vimeo|Flickr|Foursquare|Threads|Tumblr):\s*https?:\/\/[^\s]+/i.test(x))
    .filter(x => !/\/(sharer|intent|embed|showcase|home|about|videos|posts)?(?:[/?]|$)/i.test(x)) // no generic/intent/share etc.
    .filter(x => /https?:\/\/[^\/]+\/[^\/]+/i.test(x)) // must have a path segment after domain
  return dedupList(socials).join('\n') || 'None'
}
function cleanEmails(str) {
  if (!str) return 'None'
  const emails = str.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)
  return dedupList(emails || []).join('\n') || 'None'
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

    const corpus = await crawl(parsed.href)
    if (!corpus || corpus.length < 40) {
      return res.status(422).send('Could not extract enough content from the provided site.')
    }

    // --- COMBINED PROMPT ---
    const systemPrompt = `
You are a BBB representative enhancing a BBB Business Profile. Use ONLY the provided website content.
EXCLUSIONS: No promotional words/phrases, trust/endorsement, advertising, offers, owner names, locations, time, or history.
Avoid: *, [, ], and output fields strictly per instructions. Return "None" (no quotes) if a value can't be found.

Respond with a JSON object:
{
"description": <see template below>,
"clientBase": <residential|commercial|residential and commercial|government|non-profit>,
"ownerDemographic": <from approved list or 'None'>,
"productsAndServices": <comma-separated, category-style, each word capitalized, no sentences, max 20 items, 'None' if empty>,
"hoursOfOperation": <format below or 'None'>,
"addresses": <see instructions; each address as 3 lines, blank line between>,
"phoneNumbers": <all valid US phone numbers formatted (XXX) XXX-XXXX [ext. 1234] each on new line, deduped, 'None' if none>,
"socialMediaUrls": <valid social URLs only as instructed, 1 per line, deduped, 'None' if none>,
"licenseNumbers": <see licensing instructions; each license as multiline, blank line between, 'None' if none>,
"emailAddresses": <all valid emails, 1 per line, 'None' if none>,
"methodsOfPayment": <comma-separated from approved list, each capitalized, no sentences, 'None' if none>,
"bbbSeal": <'FOUND    It appears the BBB Accredited Business Seal IS on this website or the website uses the text BBB Accredited.' | 'NOT FOUND    It appears the BBB Accredited Business Seal is NOT on this website.'>,
"serviceArea": <comma-separated list of cities/counties/states/zips or 'None'>
}

DESCRIPTION TEMPLATE: "[Company Name] provides [products/services offered], including [specific details about products/services]. The company assists clients with [details on the service process]."
- Max 900 chars. No promotional/ad/offer words, no owner names, no storytelling, no forbidden characters.

PRODUCTS/SERVICES: Comma-separated, category-style, 1–4 words each, each word capitalized. Do NOT use offers, phone, address, or sentences. If none, 'None'. Example: "Landscaping Design, Landscape Maintenance, Irrigation Systems"

OWNER DEMOGRAPHIC: Only return a value from the approved list if the input matches exactly, else 'None'.

HOURS: For each day, in 12-hour format, e.g. "Monday: 09:00 AM - 05:00 PM". Use "Closed" for closed days. If any day is missing, output 'None'.

ADDRESSES: Extract valid US/Intl addresses only, each as three lines (see instructions), blank line between, or 'None'.

PHONE: US phone numbers only, deduped, (XXX) XXX-XXXX [ext. 1234] each on a new line, or 'None'.

SOCIALS: List only if there is at least one path segment after domain (e.g., facebook.com/username). Do NOT list generic, share, intent, embed, or root domain links. One per line, deduped, 'None' if none.

LICENSING: Each license number as multiline (see example), blank line between, or 'None'.

EMAIL: All valid emails found, 1 per line, or 'None'.

METHODS OF PAYMENT: Only from the approved list, comma-separated, each capitalized. No extra text or sentences. If none found, 'None'.

BBB SEAL: Output 'FOUND    It appears the BBB Accredited Business Seal IS on this website or the website uses the text BBB Accredited.' if an image filename contains "bbb" or "accredited" or the phrase is found, else 'NOT FOUND    It appears the BBB Accredited Business Seal is NOT on this website.'

SERVICE AREA: Comma-separated list of service areas (cities/counties/states/zips), no sentences, or 'None'.
    `.trim()

    const userPrompt = `Website URL: ${parsed.href}\n\nWEBSITE CONTENT:\n${corpus}`

    let aiRaw = await callOpenAI(systemPrompt, userPrompt)
    let payload
    try {
      const jsonMatch = aiRaw.match(/\{[\s\S]*\}$/)
      payload = JSON.parse(jsonMatch ? jsonMatch[0] : aiRaw)
    } catch {
      const fix = await callOpenAI(
        'Return ONLY valid JSON with the requested keys, nothing else.',
        `Please convert the following into strict JSON: ${aiRaw}`
      )
      payload = JSON.parse(fix)
    }

    // -- POSTPROCESSING --
    let {
      description, clientBase, ownerDemographic, productsAndServices, hoursOfOperation,
      addresses, phoneNumbers, socialMediaUrls, licenseNumbers, emailAddresses, methodsOfPayment, bbbSeal, serviceArea
    } = payload

    // Remove forbidden words/chars from all fields as needed
    description = sanitize(stripExcluded(description))
    if (badWordPresent(description)) {
      const neutral = await callOpenAI(
        'Neutralize promotional language and remove forbidden words/characters. Return ONLY the text, <=900 chars.',
        description
      )
      description = sanitize(neutral)
    }

    clientBase = enforceClientBase(clientBase)
    ownerDemographic = ALLOWED_OWNER_DEMOGRAPHICS.includes(ownerDemographic) ? ownerDemographic : 'None'
    productsAndServices = fixProductsAndServices(productsAndServices)
    phoneNumbers = dedupAndFormatPhones(phoneNumbers)
    socialMediaUrls = filterSocialUrls(socialMediaUrls)
    emailAddresses = cleanEmails(emailAddresses)
    methodsOfPayment = fixProductsAndServices(methodsOfPayment) // reuse capitalization/dedup logic
    // BBB Seal: add red color if NOT FOUND
    if (typeof bbbSeal === 'string' && bbbSeal.startsWith('NOT FOUND')) {
      bbbSeal = `<span style="color:red">${bbbSeal}</span>`
    }
    // Service Area: remove sentences, just comma-separated list
    if (typeof serviceArea === 'string') {
      serviceArea = serviceArea.split(/[.\n;]/)[0]
    }

    // Send output
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
      emailAddresses,
      methodsOfPayment,
      bbbSeal,
      serviceArea
    }))
  } catch (err) {
    const code = err.statusCode || 500
    return res.status(code).send(err.message || 'Internal Server Error')
  }
}
