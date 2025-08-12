import React, { useState, useRef } from 'react'
import UrlForm from './components/UrlForm'

export default function App() {
  const [url, setUrl] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [startTime, setStartTime] = useState(null)
  const inputRef = useRef(null)

  // Helper for timing
  const computeTimeTaken = (start) => {
    if (!start) return null
    const diff = Math.floor((Date.now() - start) / 1000)
    const min = Math.floor(diff / 60)
    const sec = diff % 60
    return `${min} minute${min !== 1 ? 's' : ''} ${sec} second${sec !== 1 ? 's' : ''}`
  }

  const handleSubmit = async (submittedUrl) => {
    const useUrl = (submittedUrl || url || '').trim()
    setError('')
    setResult(null)
    setLoading(true)
    setStartTime(Date.now())
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
      // Add timing
      data.timeTaken = computeTimeTaken(startTime)
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
    setStartTime(null)
    if (inputRef.current) inputRef.current.focus()
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
          <h1 style={{ fontSize: 28, margin: 0, fontFamily: 'Arial' }}>Obtain Information from Businesses Website for their BBB B</h1>
          <p style={{ color: '#444', margin: 0, fontFamily: 'Arial' }}>
            This will generate the text of the BBB Business Profile Description Overview, also known as About This Business.  
            It will also generate data for Owner Demographic, Social Media URLs, Hours of Operation, Phone Number(s), Address, License Information, Refund and Exchange Policy, and more, from the information on their website.
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

      {/* Errors */}
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
          {/* Time Taken */}
          {result.timeTaken && (
            <div style={{ marginBottom: 20, fontSize: 16, color: '#444' }}>
              <strong>Time to Generate:</strong>
              <div style={{ marginTop: 2 }}>{result.timeTaken}</div>
            </div>
          )}

          {[
            { label: "Website URL:", key: "url" },
            { label: "Business Description:", key: "description" },
            { label: "Client Base:", key: "clientBase" },
            { label: "Owner Demographic:", key: "ownerDemographic" },
            { label: "Products and Services:", key: "productsAndServices" },
            { label: "Hours of Operation:", key: "hoursOfOperation", pre: true },
            { label: "Address(es):", key: "addresses", pre: true },
            { label: "Phone Number(s):", key: "phoneNumbers", pre: true },
            { label: "Social Media URLs:", key: "socialMediaUrls", pre: true },
            { label: "License Number(s):", key: "licenseNumbers", pre: true },
            { label: "Email Addresses:", key: "emailAddresses", pre: true },
            { label: "Methods of Payment:", key: "methodsOfPayment" },
            { label: "BBB Seal on Website:", key: "bbbSeal", style: result.bbbSeal?.toLowerCase().includes('not found')
              ? { color: 'red' } : {}
            },
            { label: "Service Area:", key: "serviceArea" },
            { label: "Refund and Exchange Policy:", key: "refundAndExchangePolicy" },
          ].map((item, idx) => {
            const value = result[item.key]
            if (typeof value === 'undefined' || value === null || value === '') return null
            return (
              <div key={item.key} style={{ marginBottom: 22, ...(item.style || {}) }}>
                <strong style={{ fontSize: 17, display: 'block', fontFamily: 'Arial' }}>{item.label}</strong>
                {item.pre ? (
                  <pre style={{
                    fontFamily: 'Arial, monospace',
                    fontSize: 15,
                    margin: 0,
                    whiteSpace: 'pre-line'
                  }}>{value}</pre>
                ) : (
                  <div style={{ fontFamily: 'Arial', fontSize: 15, marginTop: 2 }}>{value}</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
