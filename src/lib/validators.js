export function isSingleValidUrl(input) {
  if (!input) return { valid: false, message: 'Please enter a website URL.' }
  if (/[\s,;]/.test(input)) return { valid: false, message: 'Enter a single URL (no spaces or commas).' }
  try {
    const u = new URL(input)
    if (!/^https?:$/.test(u.protocol)) return { valid: false, message: 'URL must start with http:// or https://'}
    return { valid: true }
  } catch {
    return { valid: false, message: 'Please enter a valid URL.' }
  }
}
