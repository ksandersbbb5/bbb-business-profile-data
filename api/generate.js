// api/generate.js
import * as cheerio from 'cheerio'

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

// --- helpers ---
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

/* ---------------- Owner Demographic (exact match only) ---------------- */
const OWNER_CATEGORIES = [
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

// Case-insensitive exact phrase match; any non-exact content returns 'None'
function detectOwnerDemographic(text = '') {
  for (const label of OWNER_CATEGORIES) {
    const escaped = label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
    const re = new RegExp(`\\b${escaped}\\b`, 'i')
    if (re.test(text)) return label
  }
  return 'None'
}
/* --------------------------------------------------------------------- */

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

    // NEW: detect Owner Demographic from the scraped corpus (exact match only)
    const ownerDemographic = detectOwnerDemographic(corpus)

    res.setHeader('Content-Type', 'application/json')
    return res.status(200).send(JSON.stringify({
      url: parsed.href,
      description,
      clientBase,
      ownerDemographic
    }))
  } catch (err) {
    const code = err.statusCode || 500
    return res.status(code).send(err.message || 'Internal Server Error')
  }
}
