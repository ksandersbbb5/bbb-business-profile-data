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

  // Helper to safely render newlines (for addresses, emails, phone, etc)
  function renderMultiline(text) {
    if (!text || text === 'None') return <span style={{ color: '#888' }}>None</span>
    return text.split('\n').map((line, i) =>
      <React.Fragment key={i}>
        {line}
        <br />
      </React.Fragment>
    )
  }

  // Helper to render 3-line addresses, separated by blank line
  function renderAddresses(text) {
    if (!text || text === 'None') return <span style={{ color: '#888' }}>None</span>
    return text.split('\n\n').map((addr, i) =>
      <span key={i} style={{ display: 'block', marginBottom: 12 }}>
        {addr.split('\n').map((line, j) =>
          <React.Fragment key={j}>
            {line}
            <br />
          </React.Fragment>
        )}
      </span>
    )
  }

  // Helper to render License Numbers in multi-line blocks
  function renderLicenseNumbers(text) {
    if (!text || text === 'None') return <span style={{ color: '#888' }}>None</span>
    return text.split('\n\n').map((block, i) =>
      <span key={i} style={{ display: 'block', marginBottom: 12 }}>
        {block.split('\n').map((line, j) =>
          <React.Fragment key={j}>
            {line}
            <br />
          </React.Fragment>
        )}
      </span>
    )
  }

  return (
    <div
      style={{
        maxWidth: 860,
        margin: '40px auto',
        padding: '0 16px',
        fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto'
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <img
          src="/bbb-logo.png"
          alt="BBB logo"
          style={{ height: 40, width: 40, objectFit: 'contain' }}
        />
        <div>
          <h1 style={{ fontSize: 28, margin: 0 }}>Obtain Information from Business Website for their BBB B</h1>
          <p style={{ color: '#444', margin: 0 }}>This will generate the text of the BBB Business Profile Description Overview, also known as About This Business. It will also generate data for Owner Demographic, Social Media URLs, Hours of Operation, Phone Number(s), Address for the business, License Information, Methods of Payment, and Service Area from the information on their website.</p>
        </div>
      </div>

      {/* Form */}
      <UrlForm
        onSubmit={handleSubmit}
        loading={loading}
        value={url}
        onChange={setUrl}
        inputRef={inputRef}
        generateBtnStyle={{
          background: '#00965E',
          color: '#fff',
          border: 'none',
          borderRadius: 8,
          padding: '8px 16px',
          fontFamily: 'Arial',
          fontWeight: 600,
          fontSize: 16,
          cursor: 'pointer',
        }}
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
        <div style={{ marginTop: 32, borderTop: '1px solid #ddd', paddingTop: 24, fontFamily: 'Arial' }}>
          <div style={{ marginBottom: 16 }}>
            <strong>Website URL:</strong><br />
            <span>{result.url}</span>
          </div>

          <div style={{ marginBottom: 16 }}>
            <strong>Business Description:</strong>
            <p style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
              {(result.description && result.clientBase)
                ? `${result.description} The business provides services to ${result.clientBase} customers.`
                : (result.description || <span style={{ color: '#888' }}>None</span>)
              }
            </p>
          </div>

          <div style={{ marginBottom: 16 }}>
            <strong>Client Base:</strong><br />
            <span>{result.clientBase || <span style={{ color: '#888' }}>None</span>}</span>
          </div>

          <div style={{ marginBottom: 16 }}>
            <strong>Owner Demographic:</strong><br />
            <span>{result.ownerDemographic || <span style={{ color: '#888' }}>None</span>}</span>
          </div>

          <div style={{ marginBottom: 16 }}>
            <strong>Products and Services:</strong><br />
            <span>{result.products || <span style={{ color: '#888' }}>None</span>}</span>
          </div>

          <div style={{ marginBottom: 16 }}>
            <strong>Hours of Operation:</strong><br />
            {renderMultiline(result.hours)}
          </div>

          <div style={{ marginBottom: 16 }}>
            <strong>Address(es):</strong><br />
            {renderAddresses(result.addresses)}
          </div>

          <div style={{ marginBottom: 16 }}>
            <strong>Phone Number(s):</strong><br />
            {renderMultiline(result.phoneNumbers)}
          </div>

          <div style={{ marginBottom: 16 }}>
            <strong>Social Media URLs:</strong><br />
            {renderMultiline(result.socialMediaUrls)}
          </div>

          <div style={{ marginBottom: 16 }}>
            <strong>License Number(s):</strong><br />
            {renderLicenseNumbers(result.licenseNumbers)}
          </div>

          <div style={{ marginBottom: 16 }}>
            <strong>BBB Seal on Website:</strong><br />
            {result.bbbSeal.startsWith('NOT FOUND')
              ? <span style={{ color: 'red' }}>{result.bbbSeal}</span>
              : result.bbbSeal
            }
          </div>

          <div style={{ marginBottom: 16 }}>
            <strong>Email Addresses:</strong><br />
            {renderMultiline(result.emailAddresses)}
          </div>

          <div style={{ marginBottom: 16 }}>
            <strong>Methods of Payment:</strong><br />
            <span>{result.paymentMethods || <span style={{ color: '#888' }}>None</span>}</span>
          </div>

          <div style={{ marginBottom: 16 }}>
            <strong>Service Area:</strong><br />
            <span>{result.serviceArea || <span style={{ color: '#888' }}>None</span>}</span>
          </div>
        </div>
      )}
    </div>
  )
}
