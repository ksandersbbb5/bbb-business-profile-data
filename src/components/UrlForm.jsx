import React, { useState, useRef } from 'react'
import UrlForm from './components/UrlForm'

function OutputBlock({ label, value, isHtml, extraStyle }) {
  if (!value || value === 'None') return null
  return (
    <div style={{ marginBottom: 18, fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto, Arial', ...extraStyle }}>
      <strong>{label}</strong><br />
      {isHtml
        ? <span dangerouslySetInnerHTML={{ __html: value }} />
        : <span style={{ whiteSpace: 'pre-line' }}>{value}</span>
      }
    </div>
  )
}

export default function App() {
  const [url, setUrl] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)
  const [elapsed, setElapsed] = useState(null)

  const handleSubmit = async (submittedUrl) => {
    const useUrl = (submittedUrl || url || '').trim()
    setError('')
    setResult(null)
    setElapsed(null)
    setLoading(true)
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: useUrl })
      })
      if (!res.ok) {
        const text = await res.text()
        if (res.status === 400 || res.status === 422) {
          throw new Error(text || 'Please check the website URL and try again.')
        } else {
          console.error('Server error:', res.status, text)
          throw new Error('We couldn’t generate a description right now. Please try another URL or try again later.')
        }
      }
      const data = await res.json()
      setResult(data)
      setElapsed(data.elapsed)
    } catch (e) {
      setError(e.message || 'Something went wrong. Please try again later.')
    } finally {
      setLoading(false)
    }
  }

  const handleReset = () => {
    setUrl('')
    setResult(null)
    setError('')
    setElapsed(null)
    if (inputRef.current) inputRef.current.focus()
  }

  function formatElapsed(ms) {
    if (!ms) return null
    const mins = Math.floor(ms / 60000)
    const secs = Math.round((ms % 60000) / 1000)
    return `${mins > 0 ? `${mins} min${mins > 1 ? 's' : ''} ` : ''}${secs} sec`
  }

  // Output formatting helpers
  function displayBusinessDescription() {
    if (!result?.description || !result?.clientBase) return null
    return (
      <OutputBlock
        label="Business Description:"
        value={`${result.description} The business provides services to ${result.clientBase} customers.`}
      />
    )
  }

  function displayAddresses() {
    if (!result?.addresses || result.addresses === 'None') return null
    // Ensure blank row after each full address block (triple-line format)
    const parts = result.addresses.split(/\n{3,}/g)
    return (
      <div style={{ marginBottom: 18, fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto, Arial' }}>
        <strong>Address(es):</strong><br />
        {parts.map((block, idx) => (
          <span key={idx}>
            {block.trim().split('\n').map((line, i) =>
              <span key={i}>{line}<br /></span>
            )}
            <br />
          </span>
        ))}
      </div>
    )
  }

  function displayPhones() {
    if (!result?.phones || result.phones === 'None') return null
    return (
      <div style={{ marginBottom: 18, fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto, Arial' }}>
        <strong>Phone Number(s):</strong><br />
        {result.phones.split('\n').map((num, idx) =>
          <span key={idx}>{num.trim()}<br /></span>
        )}
      </div>
    )
  }

  function displayLicenseNumbers() {
    if (!result?.licenseNumbers || result.licenseNumbers === 'None') return null
    const licenses = result.licenseNumbers.split(/\n\s*\n/g)
    return (
      <div style={{ marginBottom: 18, fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto, Arial' }}>
        <strong>License Number(s):</strong><br />
        {licenses.map((block, idx) =>
          <span key={idx}>
            {block.trim().split('\n').map((line, i) =>
              <span key={i}>{line}<br /></span>
            )}
            <br />
          </span>
        )}
      </div>
    )
  }

  function displayEmails() {
    if (!result?.emails || result.emails === 'None') return null
    return (
      <div style={{ marginBottom: 18, fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto, Arial' }}>
        <strong>Email Addresses:</strong><br />
        {result.emails.split('\n').map((email, idx) =>
          <span key={idx}>{email.trim()}<br /></span>
        )}
      </div>
    )
  }

  function displaySocialMedia() {
    if (!result?.socialMedia || result.socialMedia === 'None') return null
    const lines = Array.from(new Set(result.socialMedia.split('\n').map(s => s.trim()).filter(Boolean)))
    return (
      <div style={{ marginBottom: 18, fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto, Arial' }}>
        <strong>Social Media URLs:</strong><br />
        {lines.map((line, idx) =>
          <span key={idx}>{line}<br /></span>
        )}
      </div>
    )
  }

  function displayBbbSeal() {
    if (!result?.bbbSeal) return null
    // allow raw HTML for red "NOT FOUND" if present
    return (
      <OutputBlock label="BBB Seal on Website:" value={result.bbbSeal} isHtml />
    )
  }

  return (
    <div style={{ maxWidth: 900, margin: '40px auto', padding: '0 16px', fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto, Arial' }}>
      {/* Header with BBB logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <img
          src="/bbb-logo.png"
          alt="BBB logo"
          style={{ height: 40, width: 40, objectFit: 'contain' }}
        />
        <div>
          <h1 style={{ fontSize: 28, margin: 0, fontFamily: 'Arial' }}>Obtain Information from Businesses Website for their BBB Business Profile</h1>
          <p style={{ color: '#444', margin: 0, fontFamily: 'Arial' }}>
            This tool generates the BBB Business Profile Description and additional data points from the business's website.
          </p>
        </div>
      </div>

      {/* Form */}
      <UrlForm
        onSubmit={handleSubmit}
        loading={loading}
        value={url}
        onChange={setUrl}
        inputRef={inputRef}
      />

      {/* Actions row */}
      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          onClick={handleReset}
          disabled={loading}
          style={{
            background: '#ddd', color: '#222', border: 'none',
            padding: '7px 18px', borderRadius: 6, cursor: 'pointer', fontFamily: 'Arial'
          }}>
          Reset
        </button>
      </div>

      {/* Results */}
      {error && <div style={{ margin: '30px 0', color: '#d20000', fontSize: 18, fontFamily: 'Arial' }}>{error}</div>}

      {result && (
        <div style={{
          marginTop: 28, background: '#fcfcfc', borderRadius: 16, boxShadow: '0 2px 16px 0 #0002',
          padding: '24px 28px', fontSize: 17, fontFamily: 'Arial', lineHeight: 1.7
        }}>
          {/* Elapsed time */}
          {elapsed &&
            <div style={{ marginBottom: 20, color: '#222', fontWeight: 600, fontFamily: 'Arial' }}>
              Generated in {formatElapsed(elapsed)}
            </div>
          }
          <OutputBlock label="Website URL:" value={result.url} />
          {displayBusinessDescription()}
          <OutputBlock label="Owner Demographic:" value={result.ownerDemographic} />
          <OutputBlock label="Products and Services:" value={result.productsServices} />
          <OutputBlock label="Hours of Operation:" value={result.hours} />
          {displayAddresses()}
          {displayPhones()}
          {displaySocialMedia()}
          {displayLicenseNumbers()}
          {displayEmails()}
          <OutputBlock label="Methods of Payment:" value={result.paymentMethods} />
          {displayBbbSeal()}
          <OutputBlock label="Service Area:" value={result.serviceArea} />
          <OutputBlock label="Refund and Exchange Policy:" value={result.refundExchangePolicy} />
        </div>
      )}
    </div>
  )
}
