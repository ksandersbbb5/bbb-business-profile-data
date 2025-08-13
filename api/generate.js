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

// ====== PATCH: Always fetch fallback slugs! ======
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

  // === PATCH: Always try fallback slugs, not just on thin corpus ===
  for (const slug of FALLBACK_SLUGS) {
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
    .replace(/([^\n])(\nLicense Number: )/g, '$1\n\n$2') // Ensure blank line before each license number
    .replace(/(Expiration Date: .*)\n(?!\n)/g, '$1\n\n') // PATCH: blank line after each Expiration Date
    .trim()
}

// ... (rest of your code is unchanged below this point) ...

// -- Insert the rest of your unchanged code from your latest version here, starting at JSON-LD harvesters, Email, Phones, etc --

// ====== JSON-LD harvesters ======
function harvestFromJsonLd(pages) {
  // (your unchanged function)
}

// ====== Email ======
function extractEmails(text) {
  // (your unchanged function)
}

// ====== Phones ======
function isValidNanp(area, exch, line) { /* ... */ }
function extractPhones(text) { /* ... */ }

// ====== Addresses, Social, BBB, Hours, etc ======
// (copy your unchanged functions exactly as they are!)

/* ... */

// ====== Handler ======
export default async function handler(req, res) {
  // (your handler function exactly as you shared, no changes needed here)
}
