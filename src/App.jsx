import React, { useState, useRef } from 'react'
import UrlForm from './components/UrlForm'

export default function App() {
  const [url, setUrl] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  const handleSubmit = async (submittedUrl) => {
    const useUrl = (submittedUrl || url || '').trim()
    setError('')
    setResult(null)
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
    if (inputRef.current) inputRef.current.focus()
  }

  const Block = ({ label, value, pre = false, style }) => {
    if (value === undefined || value === null || value === '') return null
    return (
      <div style={{ marginBottom: 22 }}>
        <strong style={{ fontSize: 17, display: 'block', fontFamily: 'Arial' }}>{label}</strong>
        {pre ? (
          <pre style={{
            fontFamily: 'Arial',
            fontSize: 15,
            margin: 0,
            whiteSpace: 'pre-line',
            ...(style || {})
          }}>{value}</pre>
        ) : (
          <div style={{ fontFamily: 'Arial', fontSize: 15, marginTop: 2, ...(style || {}) }}>{value}</div>
        )}
      </div>
    )
  }

  const SealBlock = ({ label, value }) => {
    const isNotFound = typeof value === 'string' && value.toLowerCase().startsWith('not found')
    return <Block label={label} value={value} pre={false} style={isNotFound ? { color: 'red' } : {}} />
  }

  // Compose the Lead Form display from whichever fields the API returns
  const renderLeadFormValue = (r) => {
    if (!r) return null
    if (r.leadForm && typeof r.leadForm === 'string' && r.leadForm.trim()) {
      return r.leadForm.trim()
    }
    const lines = []
    if (r.leadFormTitle && String(r.leadFormTitle).trim()) {
      lines.push(`Lead Form Title: ${String(r.leadFormTitle).trim()}`)
    }
    if (r.leadFormUrl && String(r.leadFormUrl).trim()) {
      lines.push(`Lead Form URL: ${String(r.leadFormUrl).trim()}`)
    }
    if (!lines.length) return 'None'
    return lines.join('\n')
  }

  return (
    <div style={{ maxWidth: 860, margin: '40px auto', padding: '0 16px', fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto' }}>
      {/* Header with BBB logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <img
          src="/bbb-logo.png"
          alt="BBB logo"
          style={{ height: 40, width: 40, objectFit: 'contain' }}
        />
        <div>
          <h1 style={{ fontSize: 28, margin: 0, fontFamily: 'Arial' }}>
            Obtain Information from Businesses Website for their BBB Business Profile
          </h1>
          <p style={{ color: '#444', margin: 0, fontFamily: 'Arial' }}>
            This tool generates the BBB Business Profile Description Overview and additional data points from the business website.
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

      {/* Actions */}
      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          onClick={handleReset}
          disabled={loading && !error}
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid #bbb',
            background: '#f7f7f7',
            cursor: 'pointer',
            fontFamily: 'Arial'
          }}
        >
          Start Again
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={{ color: 'red', marginTop: 16, fontFamily: 'Arial' }}>{error}</div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ marginTop: 16, fontFamily: 'Arial' }}>Processing…</div>
      )}

      {/* Results */}
      {result && (
        <div
          style={{
            marginTop: 32,
            borderTop: '1px solid #ddd',
            paddingTop: 24,
            fontFamily: 'Arial'
          }}
        >
          <Block label="Time to Generate:" value={result.timeTaken} />
          <Block label="Website URL:" value={result.url} />

          {/* The API already appends "The business provides services to <clientBase> customers." */}
          <Block label="Business Description:" value={result.description} />

          <Block label="Client Base:" value={result.clientBase} />
          <Block label="Owner Demographic:" value={result.ownerDemographic} />
          <Block label="Products and Services:" value={result.productsAndServices} />

          <Block label="Hours of Operation:" value={result.hoursOfOperation} pre />
          <Block label="Address(es):" value={result.addresses} pre />
          <Block label="Phone Number(s):" value={result.phoneNumbers} pre />
          <Block label="Email Addresses:" value={result.emailAddresses} pre />
          <Block label="Social Media URLs:" value={result.socialMediaUrls} pre />

          <Block label="License Number(s):" value={result.licenseNumbers} pre />
          <Block label="Methods of Payment:" value={result.methodsOfPayment} />

          <SealBlock label="BBB Seal on Website:" value={result.bbbSeal} />

          <Block label="Service Area:" value={result.serviceArea} />
          <Block label="Refund and Exchange Policy:" value={result.refundAndExchangePolicy} />

          {/* NEW: Lead Form - Custom RAQ */}
          <Block label="Lead Form - Custom RAQ:" value={renderLeadFormValue(result)} pre />
        </div>
      )}
    </div>
  )
}
