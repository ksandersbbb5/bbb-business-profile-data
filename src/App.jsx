import React, { useState, useRef } from 'react'
import UrlForm from './components/UrlForm'

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000)
  const min = Math.floor(seconds / 60)
  const sec = seconds % 60
  return `${min > 0 ? `${min} minute${min !== 1 ? 's' : ''} ` : ''}${sec} second${sec !== 1 ? 's' : ''}`
}

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

  // Helper for rendering BBB Seal in red if NOT FOUND
  function renderWithBBBSealHighlight(text) {
    const sealIndex = text.indexOf('BBB Seal on Website:')
    if (sealIndex === -1) return text

    // Get all lines as array
    const lines = text.split('\n')
    return lines.map((line, idx) => {
      if (line.startsWith('NOT FOUND') || line.includes('NOT FOUND')) {
        return (
          <div key={idx} style={{ color: 'red', fontWeight: 600 }}>{line}</div>
        )
      }
      return <div key={idx}>{line}</div>
    })
  }

  // For output, preserve line breaks and ensure Arial
  function renderOutput(outputText) {
    if (!outputText) return null
    // If result is from backend (with color-instruction for NOT FOUND), handle line by line
    return (
      <div
        style={{
          fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto',
          fontSize: 17,
          lineHeight: 1.7,
          background: '#fff',
          border: '1px solid #e3e3e3',
          borderRadius: 12,
          padding: '24px 20px',
          marginTop: 16,
          whiteSpace: 'pre-line'
        }}
      >
        {renderWithBBBSealHighlight(outputText)}
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 900, margin: '40px auto', padding: '0 16px', fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto, Arial' }}>
      {/* Header with BBB logo top-left */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <img
          src="/bbb-logo.png"
          alt="BBB logo"
          style={{ height: 40, width: 40, objectFit: 'contain' }}
        />
        <div>
         <h1 style={{ fontSize: 28, margin: 0, fontFamily: 'Arial, sans-serif' }}>
           Obtain Information from Business Website for BBB Business Profile
         </h1>
          <p style={{ color: '#444', margin: 0, fontFamily: 'Arial, sans-serif' }}>
            This will generate the text of the BBB Business Profile Description Overview ("About This Business").
            Also extracts Owner Demographic, Products/Services, Social Media URLs, Hours, Phone, Address, License, Payment Methods, BBB Seal, Service Area, Refund/Exchange Policy, and more from the business website.
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
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #bbb', background: '#f7f7f7', cursor: 'pointer', fontFamily: 'Arial' }}
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
        <div style={{ marginTop: 32 }}>
          {/* Time taken */}
          <div style={{ fontWeight: 500, fontSize: 18, marginBottom: 16, fontFamily: 'Arial' }}>
            ⏱️ Generated in {formatDuration(result.duration || 0)}
          </div>
          {/* Output */}
          {renderOutput(result.output)}
        </div>
      )}
    </div>
  )
}
