import React, { useState, useRef } from 'react'
import UrlForm from './components/UrlForm'

function renderMultiline(text) {
  if (!text || text === 'None') return <span style={{ color: '#888' }}>None</span>
  return text.split('\n').map((line, i) => <React.Fragment key={i}>{line}<br /></React.Fragment>)
}

function renderAddresses(text) {
  if (!text || text === 'None') return <span style={{ color: '#888' }}>None</span>
  const blocks = text.split(/\n{2,}/g)
  return blocks.map((addr, i) =>
    <span key={i} style={{ display: 'block', marginBottom: 16 }}>
      {addr.split('\n').map((line, j) =>
        <React.Fragment key={j}>
          {line}
          <br />
        </React.Fragment>
      )}
      {i !== blocks.length - 1 && <br />}
    </span>
  )
}

function renderPhones(text) {
  if (!text || text === 'None') return <span style={{ color: '#888' }}>None</span>
  return text.split('\n').map((line, i) =>
    <React.Fragment key={i}>{line}<br /></React.Fragment>
  )
}

function renderLicenses(text) {
  if (!text || text === 'None') return <span style={{ color: '#888' }}>None</span>
  const blocks = text.split(/\n{2,}/g)
  return blocks.map((block, i) => (
    <span key={i} style={{ display: 'block', marginBottom: 16 }}>
      {block.split('\n').map((line, j) => (
        <React.Fragment key={j}>{line}<br /></React.Fragment>
      ))}
      {i !== blocks.length - 1 && <br />}
    </span>
  ))
}

function renderSocialUrls(text) {
  if (!text || text === 'None') return <span style={{ color: '#888' }}>None</span>
  // Deduplicate and format
  const lines = Array.from(new Set(text.split('\n').filter(Boolean)))
  return lines.map((line, i) => (
    <React.Fragment key={i}>{line}<br /></React.Fragment>
  ))
}

function renderEmails(text) {
  if (!text || text === 'None') return <span style={{ color: '#888' }}>None</span>
  return text.split('\n').map((line, i) => (
    <React.Fragment key={i}>{line}<br /></React.Fragment>
  ))
}

function renderBbbSeal(text) {
  if (!text) return null
  if (/NOT FOUND/i.test(text)) {
    return <span style={{ color: 'red', fontWeight: 500 }}>{text}</span>
  }
  return <span>{text}</span>
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

  return (
    <div style={{ maxWidth: 860, margin: '40px auto', padding: '0 16px', fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto' }}>
      {/* Header with BBB logo top-left */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <img
          src="/bbb-logo.png"
          alt="BBB logo"
          style={{ height: 40, width: 40, objectFit: 'contain' }}
        />
        <div>
         <h1 style={{ fontSize: 28, margin: 0 }}>Obtain Information from Businesses Website for their BBB Business Profile</h1>
          <p style={{ color: '#444', margin: 0 }}>Generates a complete BBB Business Profile data set for any business website including description, hours, phone, addresses, social media, and more.</p>
        </div>
      </div>
      {/* Form */}
      <UrlForm url={url} setUrl={setUrl} loading={loading} onSubmit={handleSubmit} inputRef={inputRef} />
      {/* Output */}
      {error && <div style={{ color: 'red', margin: '24px 0 0 0', fontSize: 17, fontFamily: 'Arial' }}>{error}</div>}
      {result &&
        <div style={{
          border: '1.5px solid #ccc',
          margin: '32px 0 24px 0',
          borderRadius: 12,
          padding: 28,
          background: '#fafcfa',
          fontFamily: 'Arial'
        }}>
          <div style={{ marginBottom: 8, fontSize: 16 }}>
            <b>Website URL:</b><br />{result.url}
          </div>
          <div style={{ marginBottom: 8, fontSize: 16 }}>
            <b>Business Description:</b><br />
            {result.description
              ? <span>{result.description} The business provides services to {result.clientBase || 'None'} customers.</span>
              : <span style={{ color: '#888' }}>None</span>
            }
          </div>
          <div style={{ marginBottom: 8, fontSize: 16 }}>
            <b>Client Base:</b><br />{result.clientBase || <span style={{ color: '#888' }}>None</span>}
          </div>
          <div style={{ marginBottom: 8, fontSize: 16 }}>
            <b>Owner Demographic:</b><br />{result.ownerDemographic || <span style={{ color: '#888' }}>None</span>}
          </div>
          <div style={{ marginBottom: 8, fontSize: 16 }}>
            <b>Products and Services:</b><br />{result.productsServices || <span style={{ color: '#888' }}>None</span>}
          </div>
          <div style={{ marginBottom: 8, fontSize: 16 }}>
            <b>Hours of Operation:</b><br />{renderMultiline(result.hours)}
          </div>
          <div style={{ marginBottom: 8, fontSize: 16 }}>
            <b>Address(es):</b><br />{renderAddresses(result.addresses)}
          </div>
          <div style={{ marginBottom: 8, fontSize: 16 }}>
            <b>Phone Number(s):</b><br />{renderPhones(result.phones)}
          </div>
          <div style={{ marginBottom: 8, fontSize: 16 }}>
            <b>Social Media URLs:</b><br />{renderSocialUrls(result.socialUrls)}
          </div>
          <div style={{ marginBottom: 8, fontSize: 16 }}>
            <b>License Number(s):</b><br />{renderLicenses(result.licenses)}
          </div>
          <div style={{ marginBottom: 8, fontSize: 16 }}>
            <b>BBB Seal on Website:</b><br />{renderBbbSeal(result.bbbSeal)}
          </div>
          <div style={{ marginBottom: 8, fontSize: 16 }}>
            <b>Email Addresses:</b><br />{renderEmails(result.emails)}
          </div>
          <div style={{ marginBottom: 8, fontSize: 16 }}>
            <b>Methods of Payment:</b><br />{result.paymentMethods || <span style={{ color: '#888' }}>None</span>}
          </div>
          <div style={{ marginBottom: 8, fontSize: 16 }}>
            <b>Service Area:</b><br />{result.serviceArea || <span style={{ color: '#888' }}>None</span>}
          </div>
        </div>
      }
    </div>
  )
}
