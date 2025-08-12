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
        // Preserve helpful validation errors; friendlify everything else
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

  return (
    <div style={{ maxWidth: 860, margin: '40px auto', padding: '0 16px', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial' }}>
      {/* Header with BBB logo top-left */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <img
          src="/bbb-logo.png"
          alt="BBB logo"
          style={{ height: 40, width: 40, objectFit: 'contain' }}
        />
        <div>
          <h1 style={{ fontSize: 28, margin: 0 }}>Obtain Information from Businesses Website for their BBB Business Profile</h1>
          <p style={{ color: '#444', margin: 0 }}>
            This will generate the text of the BBB Business Profile Description Overview, also known as About This Business. 
            It will also generate data for Owner Demographic, Products and Services, Hours of Operation, Address(es), 
            Phone Number(s), Social Media URLs, License Number(s), Email Addresses, Methods of Payment, BBB Seal, and Service Area from the information on their website.
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
            cursor: 'pointer'
          }}
        >
          Start Again
        </button>
      </div>

      {/* Errors */}
      {error && (
        <div style={{ color: 'red', marginTop: 16 }}>{error}</div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ marginTop: 16 }}>Processing…</div>
      )}

      {/* Results */}
      {result && (
        <div style={{ marginTop: 32, borderTop: '1px solid #ddd', paddingTop: 24 }}>
          <div style={{ marginBottom: 16 }}>
            <strong>Website URL:</strong><br />
            <span>{result.url}</span>
          </div>
          <div style={{ marginBottom: 16 }}>
            <strong>Business Description:</strong>
            <p style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
              {result.description} {`The business provides services to ${result.clientBase} customers.`}
            </p>
          </div>
          <div style={{ marginBottom: 16 }}>
            <strong>Client Base:</strong><br />
            <span>{result.clientBase}</span>
          </div>
          <div style={{ marginBottom: 16 }}>
            <strong>Owner Demographic:</strong><br />
            <span>{result.ownerDemographic}</span>
          </div>
          <div style={{ marginBottom: 16 }}>
            <strong>Products and Services:</strong><br />
            <span>{result.productsAndServices}</span>
          </div>
          <div style={{ marginBottom: 16 }}>
            <strong>Hours of Operation:</strong><br />
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{result.hoursOfOperation}</pre>
          </div>
          <div style={{ marginBottom: 16 }}>
            <strong>Address(es):</strong><br />
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{result.addresses}</pre>
          </div>
          <div style={{ marginBottom: 16 }}>
            <strong>Phone Number(s):</strong><br />
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{result.phoneNumbers}</pre>
          </div>
          <div style={{ marginBottom: 16 }}>
            <strong>Social Media URLs:</strong><br />
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{result.socialMediaUrls}</pre>
          </div>
          <div style={{ marginBottom: 16 }}>
            <strong>License Number(s):</strong><br />
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{result.licenseNumbers}</pre>
          </div>
          <div style={{ marginBottom: 16 }}>
            <strong>Email Addresses:</strong><br />
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{result.emails}</pre>
          </div>
          <div style={{ marginBottom: 16 }}>
            <strong>Methods of Payment:</strong><br />
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{result.paymentMethods}</pre>
          </div>
          <div style={{ marginBottom: 16 }}>
            <strong>BBB Seal on Website:</strong><br />
            <span dangerouslySetInnerHTML={{ __html: result.bbbSeal }} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <strong>Service Area:</strong><br />
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{result.serviceArea}</pre>
          </div>
        </div>
      )}
    </div>
  )
}
