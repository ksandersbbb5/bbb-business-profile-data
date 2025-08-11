import React, { useState } from 'react'
import { isSingleValidUrl } from '../lib/validators'

export default function UrlForm({ onSubmit, loading, value, onChange, inputRef }) {
  const [clientError, setClientError] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    const trimmed = (value || '').trim()
    const { valid, message } = isSingleValidUrl(trimmed)
    if (!valid) {
      setClientError(message)
      return
    }
    setClientError('')
    onSubmit(trimmed)
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <label htmlFor="url" style={{ display: 'block', fontWeight: 600, marginBottom: 8 }}>
        The businesses website url
      </label>
      <input
        id="url"
        ref={inputRef}
        type="url"
        placeholder="https://www.example.com"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', padding: '12px 14px', border: '1px solid #bbb', borderRadius: 8 }}
        required
      />
      {clientError && (
        <div style={{ color: 'red', marginTop: 8 }}>{clientError}</div>
      )}
      <button
        type="submit"
        disabled={loading}
        style={{
          marginTop: 12,
          padding: '10px 14px',
          borderRadius: 8,
          border: 'none',
          background: '#00965E',
          color: '#fff',
          cursor: loading ? 'wait' : 'pointer'
        }}
      >
        {loading ? 'Generating…' : 'Generate'}
      </button>
    </form>
  )
}
