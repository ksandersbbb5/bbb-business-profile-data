import React, { useCallback } from 'react'

export default function UrlForm({ onSubmit, loading, value, onChange, inputRef }) {
  const handleSubmit = useCallback(e => {
    e.preventDefault()
    if (value && !loading) {
      onSubmit(value.trim())
    }
  }, [onSubmit, value, loading])

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        marginBottom: 10,
        fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto, Arial'
      }}
      autoComplete="off"
    >
      <input
        ref={inputRef}
        type="url"
        name="website"
        placeholder="Enter business website URL (e.g., https://example.com)"
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={loading}
        style={{
          flex: 1,
          padding: '12px 14px',
          border: '1.5px solid #c4c4c4',
          borderRadius: 8,
          fontSize: 17,
          fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto, Arial',
          outline: 'none'
        }}
        required
        autoFocus
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <button
        type="submit"
        disabled={loading || !value}
        style={{
          padding: '12px 22px',
          borderRadius: 8,
          border: 'none',
          fontWeight: 600,
          fontSize: 17,
          background: '#00965E',
          color: '#fff',
          cursor: loading || !value ? 'not-allowed' : 'pointer',
          transition: 'background 0.15s',
          fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto, Arial'
        }}
      >
        {loading ? 'Generating…' : 'Generate'}
      </button>
    </form>
  )
}
