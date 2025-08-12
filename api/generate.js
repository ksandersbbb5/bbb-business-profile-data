import * as cheerio from 'cheerio'

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

// ---- Utility functions ----
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  const chunks = []
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  const raw = Buffer.concat(chunks).toString('utf8') || '{}'
  try { return JSON.parse(raw) } catch { return {} }
}

function dedupeLines(list) {
  const seen = new Set()
  return (Array.isArray(list) ? list : (list || '').split('\n')).map(x=>x.trim()).filter(x=>x && !seen.has(x) && seen.add(x))
}

function titleCase(str) {
  return (str||'').split(',').map(s=>
    s.replace(/\w\S*/g, w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).trim()
  ).filter(Boolean).join(', ')
}

function normalizeProducts(raw) {
  if (!raw) return 'None'
  let items = raw.split(/[,;\n]+/).map(s=>s.trim()).filter(Boolean)
  items = dedupeLines(items)
  // Remove junky/very short or marketing phrases
  items = items.filter(x => x.length > 2 && !/^none$/i.test(x) && !/^additional offers?$/i.test(x))
  if (!items.length) return 'None'
  return titleCase(items.join(', '))
}

function normalizePhones(raw) {
  if (!raw) return 'None'
  let nums = raw.split(/[\n,;]+/).map(n=>n.trim()).filter(Boolean)
  nums = dedupeLines(nums)
  nums = nums.filter(n => /^\(\d{3}\) \d{3}-\d{4}( ext\. \d+)?$/.test(n))
  return nums.length ? nums.join('\n') : 'None'
}

function normalizeAddresses(raw) {
  if (!raw) return 'None'
  let blocks = raw.split(/\n{2,}/).map(s=>s.trim().replace(/\s{2,}/g,' ')).filter(Boolean)
  blocks = dedupeLines(blocks)
  blocks = blocks.map(b => {
    let lines = b.split('\n').map(l=>l.trim())
    // 2-line or 3-line? Always 3 lines
    if (lines.length === 3) return `${lines[0]}\n${lines[1]}\n${lines[2].replace(/^usa$/i,'USA')}`
    if (lines.length === 2) return `${lines[0]}\n${lines[1]}\nUSA`
    return b
  })
  // Filter obviously broken addresses
  blocks = blocks.filter(addr =>
    addr.match(/^\d/) && addr.match(/, [A-Z]{2} \d{5}/)
  )
  return blocks.length ? blocks.join('\n\n') : 'None'
}

function normalizeSocialUrls(raw) {
  if (!raw) return 'None'
  let lines = raw.split(/[\n,;]+/).map(x=>x.trim()).filter(Boolean)
  // Dedup and only allow non-root domain URLs per platform
  const rootDomains = [
    /^(https?:\/\/)?(www\.)?facebook\.com\/?$/i,
    /^(https?:\/\/)?(www\.)?instagram\.com\/?$/i,
    /^(https?:\/\/)?(www\.)?linkedin\.com\/?$/i,
    /^(https?:\/\/)?(www\.)?(x\.com|twitter\.com)\/?$/i,
    /^(https?:\/\/)?(www\.)?tiktok\.com\/?$/i,
    /^(https?:\/\/)?(www\.)?youtube\.com\/?$/i,
    /^(https?:\/\/)?(www\.)?vimeo\.com\/?$/i,
    /^(https?:\/\/)?(www\.)?flickr\.com\/?$/i,
    /^(https?:\/\/)?(www\.)?foursquare\.com\/?$/i,
    /^(https?:\/\/)?(www\.)?threads\.com\/?$/i,
    /^(https?:\/\/)?(www\.)?tumblr\.com\/?$/i
  ]
  const platformMap = {
    facebook: [],
    instagram: [],
    linkedin: [],
    x: [],
    tiktok: [],
    youtube: [],
    vimeo: [],
    flickr: [],
    foursquare: [],
    threads: [],
    tumblr: []
  }
  for (let line of lines) {
    // Skip root domain only
    if (rootDomains.some(r=>r.test(line))) continue
    // Platform grouping for deduplication
    if (/facebook\.com/i.test(line)) platformMap.facebook.push(line)
    else if (/instagram\.com/i.test(line)) platformMap.instagram.push(line)
    else if (/linkedin\.com/i.test(line)) platformMap.linkedin.push(line)
    else if (/x\.com|twitter\.com/i.test(line)) platformMap.x.push(line)
    else if (/tiktok\.com/i.test(line)) platformMap.tiktok.push(line)
    else if (/youtube\.com/i.test(line)) platformMap.youtube.push(line)
    else if (/vimeo\.com/i.test(line)) platformMap.vimeo.push(line)
    else if (/flickr\.com/i.test(line)) platformMap.flickr.push(line)
    else if (/foursquare\.com/i.test(line)) platformMap.foursquare.push(line)
    else if (/threads\.com/i.test(line)) platformMap.threads.push(line)
    else if (/tumblr\.com/i.test(line)) platformMap.tumblr.push(line)
  }
  let result = []
  for (let plat in platformMap) {
    if (platformMap[plat].length) {
      // One per unique URL per platform (you can allow more by removing [0])
      result.push(...dedupeLines(platformMap[plat]))
    }
  }
  return result.length ? result.join('\n') : 'None'
}

function normalizeEmails(raw) {
  if (!raw || /^none$/i.test(raw.trim())) return 'None'
  let lines = raw.split(/[,;\n]+/).map(l=>l.trim().toLowerCase()).filter(Boolean)
  lines = lines.filter(email => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email))
  lines = dedupeLines(lines)
  return lines.length ? lines.join('\n') : 'None'
}

function normalizeLicenseBlocks(raw) {
  if (!raw) return 'None'
  let blocks = raw.split(/\n{2,}/).map(b=>b.trim()).filter(Boolean)
  blocks = dedupeLines(blocks)
  blocks = blocks.map(block => {
    let lines = []
    let lic = { number: 'None', authority: 'None', type: 'None', status: 'None', expiration: 'None' }
    block.split('\n').forEach(line => {
      let [label, ...rest] = line.split(':')
      if (/number/i.test(label)) lic.number = rest.join(':').trim() || 'None'
      else if (/authority/i.test(label)) lic.authority = rest.join(':').trim() || 'None'
      else if (/type/i.test(label)) lic.type = rest.join(':').trim() || 'None'
      else if (/status/i.test(label)) lic.status = rest.join(':').trim() || 'None'
      else if (/expiration/i.test(label)) lic.expiration = rest.join(':').trim() || 'None'
    })
    lines.push(`License Number: ${lic.number}`)
    lines.push(`Issuing Authority: ${lic.authority}`)
    lines.push(`License Type: ${lic.type}`)
    lines.push(`Status: ${lic.status}`)
    lines.push(`Expiration Date: ${lic.expiration}`)
    return lines.join('\n')
  })
  return blocks.length ? blocks.join('\n\n') : 'None'
}

// ---- OpenAI prompt construction ----

const systemPrompt = `
You are a BBB data extraction assistant. Your job is to strictly extract information from business websites for BBB business profiles.

NEVER make up information. If you do not find a data point, output "None" (without quotes). Do not infer or invent data.

OUTPUT FORMAT: Only output valid data extracted from the provided website content for each field below.

1) Business Description: Factual description of the business and its offerings. Do NOT include a company history, or promotional language.
2) Client Base: residential, commercial, residential and commercial, government, non-profit.
3) Owner Demographic: Use only these, case-insensitive, exact matches: Asian American Owned, Black/African American Owned, African American Owned, Black Owned, Disabled Owned, Employee Owned Owned, Family Owned, Family-Owned, First Responder Owned, Hispanic Owned, Indigenous Owned, LBGTQ Owned, Middle Eastern Owned, Minority Owned, Native American Owned, Pacific Owned, Veteran Owned, Woman Owned. If not an exact match, return None.
4) Products and Services: List categories as a comma-separated list, Title Case (first letter of each word). Separate each with a comma and space. No numbering or bulleting. If not found, output "None".
5) Hours of Operation: Output hours for each day, e.g.
Monday: 09:00 AM - 05:00 PM
Tuesday: 09:00 AM - 05:00 PM
... through Sunday. If not found for ALL SEVEN DAYS, output None.
6) Addresses: For each, output 3 lines:
123 Main St, Suite 400
Boston, MA 02108
USA
Do not include PO Boxes, email addresses, or partial addresses.
If none found, output None.
7) Phone Numbers: U.S. phone numbers only, formatted (123) 456-7890 [ext. NNNN if present]. List one per row. If not found, output None.
8) Social Media URLs: Only output URLs with an actual path (not just facebook.com/). List one per platform, one per row, deduplicated. If not found, output None.
9) License Numbers: For each, output as follows. If any item is not found, show "None" for that item:
License Number: [value]
Issuing Authority: [value]
License Type: [value]
Status: [value]
Expiration Date: [value]
If no valid licenses, output None.
10) BBB Seal on Website: If you find an image with "bbb" or "accredited" in filename, or the phrase "BBB Accredited" on the site (but NOT phrases like "Site managed by BBB"), output: "FOUND    It appears the BBB Accredited Business Seal IS on this website or the website uses the text BBB Accredited."  
If not, output: "NOT FOUND    It appears the BBB Accredited Business Seal is NOT on this website." (and instruct UI to display this line in red).
11) Email Addresses: Output one valid email address per row, deduplicated. If not found, output None.
12) Methods of Payment: Extract as a comma-separated list, using ONLY: ACH, Amazon Payments, American Express, Apply Pay, Balance Adjustment, Bitcoin, Cash, Certified Check, China UnionPay, Coupon, Credit Card, Debit Car, Discover, Electronic Check, Financing, Google Pay, Invoice, MasterCard, Masterpass, Money Order, PayPal, Samsung Pay, Store Card, Venmo, Visa, Western Union, Wire Transfer, Zelle. If not found, output None.
13) Service Area: List counties, cities, states, or zip codes served. If not found, output None.

DELIMITER: Use this exact separator string between sections:
====

YOUR RESPONSE: For each data point, output ONLY the value, in order, no labels or extra text, separated by the delimiter.
`.trim()

// ---- Main API handler ----

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

  while (queue.length && visited.size < 25) {
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
          if (abs.origin !== start.origin) return
          if (abs.pathname.split('/').filter(Boolean).length <= 1 && !visited.has(abs.href)) {
            if (queue.length < 25) queue.push(abs.href)
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

    // Compose a prompt with strict delimiter
    const userPrompt = `WEBSITE: ${parsed.href}\n\nCONTENT:\n${corpus}\n\nStrictly follow the output format and delimiter.`

    let aiRaw = await callOpenAI(systemPrompt, userPrompt)

    // Split the AI output using the DELIMITER and assign each value to a key
    const sections = aiRaw.split(/={4,}/).map(s=>s.trim())
    const [
      description,
      clientBase,
      ownerDemo,
      products,
      hours,
      addresses,
      phones,
      socials,
      licenses,
      bbbSeal,
      emails,
      payments,
      serviceArea
    ] = [...sections, ...Array(13).fill('')].slice(0,13)

    // Normalize each output
    const payload = {
      url: parsed.href,
      description: description || 'None',
      clientBase: (clientBase || 'None').toLowerCase(),
      ownerDemographic: ownerDemo || 'None',
      products: normalizeProducts(products),
      hours: (hours && /^monday:/i.test(hours.trim())) ? hours.trim().replace(/\s*\.\s*$/, '') : 'None',
      addresses: normalizeAddresses(addresses),
      phoneNumbers: normalizePhones(phones),
      socialMediaUrls: normalizeSocialUrls(socials),
      licenseNumbers: normalizeLicenseBlocks(licenses),
      bbbSeal: bbbSeal || 'NOT FOUND    It appears the BBB Accredited Business Seal is NOT on this website.',
      emailAddresses: normalizeEmails(emails),
      paymentMethods: payments ? titleCase(payments) : 'None',
      serviceArea: serviceArea || 'None'
    }

    res.setHeader('Content-Type', 'application/json')
    return res.status(200).send(JSON.stringify(payload))
  } catch (err) {
    const code = err.statusCode || 500
    return res.status(code).send(err.message || 'Internal Server Error')
  }
}
