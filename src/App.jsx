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

  return (
    <div style={{
      maxWidth: 900,
      margin: '40px auto',
      padding: '0 16px',
      fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto, Arial'
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <img
          src="/bbb-logo.png"
          alt="BBB logo"
          style={{ height: 44, width: 44, objectFit: 'contain' }}
        />
        <div>
         <h1 style={{ fontSize: 28, margin: 0 }}>Obtain Information from Businesses Website for their BBB Business Profile</h1>
          <p style={{ color: '#444', margin: 0 }}>
            This tool generates a BBB Business Profile Description Overview, Owner Demographic, Social Media URLs, Hours of Operation, Phone Number(s), Address, Licensing, Email, Payment Methods, Service Area, and BBB Seal status from the business website.
          </p>
        </div>
      </div>

      {/* URL Form */}
      <UrlForm
        onSubmit={handleSubmit}
        loading={loading}
        value={url}
        onChange={setUrl}
        inputRef={inputRef}
      />

      {/* Start Again */}
      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          onClick={handleReset}
          disabled={loading && !error}
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #bbb', background: '#f7f7f7', cursor: 'pointer' }}
        >
          Start Again
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div style={{ color: 'red', marginTop: 18 }}>{error}</div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ marginTop: 16 }}>Processing…</div>
      )}

      {/* Results */}
      {result && (
        <div style={{
          marginTop: 36,
          borderTop: '1px solid #ddd',
          paddingTop: 28,
          fontSize: 17,
          lineHeight: 1.5,
          fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto, Arial'
        }}>
          <div style={{ marginBottom: 15 }}>
            <strong>Website URL:</strong>
            <br /><span>{result.url}</span>
          </div>
          <div style={{ marginBottom: 15 }}>
            <strong>Business Description:</strong>
            <p style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
              {result.description
                ? `${result.description} The business provides services to ${result.clientBase} customers.`
                : ''}
            </p>
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong>Owner Demographic:</strong>
            <br /><span>{result.ownerDemographic}</span>
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong>Products and Services:</strong>
            <br /><span>{result.productsAndServices}</span>
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong>Hours of Operation:</strong>
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{result.hoursOfOperation || 'None'}</pre>
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong>Address(es):</strong>
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{result.addresses || 'None'}</pre>
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong>Phone Number(s):</strong>
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{result.phoneNumbers || 'None'}</pre>
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong>Social Media URLs:</strong>
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{result.socialMediaUrls || 'None'}</pre>
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong>License Number(s):</strong>
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{result.licenseNumbers || 'None'}</pre>
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong>Email Addresses:</strong>
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{result.emailAddresses || 'None'}</pre>
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong>Methods of Payment:</strong>
            <br /><span>{result.methodsOfPayment || 'None'}</span>
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong>BBB Seal on Website:</strong>
            <br />
            {/* If NOT FOUND, show in red, else default */}
            {result.bbbSeal && result.bbbSeal.startsWith('NOT FOUND') ? (
              <span style={{ color: 'red' }}>{result.bbbSeal}</span>
            ) : (
              <span dangerouslySetInnerHTML={{ __html: result.bbbSeal || '' }} />
            )}
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong>Service Area:</strong>
            <br /><span>{result.serviceArea || 'None'}</span>
          </div>
        </div>
      )}
    </div>
  )
}
