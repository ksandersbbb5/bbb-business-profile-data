import React, { useState } from 'react';

export default function UrlForm({ onSubmit, loading, value, onChange, inputRef }) {
  const [touched, setTouched] = useState(false);

  const handleChange = (e) => {
    onChange(e.target.value);
    setTouched(true);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (value.trim()) {
      onSubmit(value.trim());
    } else {
      setTouched(true);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{
      display: 'flex',
      gap: 12,
      marginTop: 0,
      marginBottom: 0,
      alignItems: 'center',
      fontFamily: 'Arial, sans-serif'
    }}>
      <label htmlFor="website-url" style={{ fontWeight: 500 }}>
        Website URL:
      </label>
      <input
        id="website-url"
        ref={inputRef}
        type="url"
        placeholder="https://example.com/"
        value={value}
        onChange={handleChange}
        disabled={loading}
        required
        style={{
          flex: 1,
          padding: '8px 10px',
          fontSize: 16,
          border: '1px solid #bbb',
          borderRadius: 8,
          fontFamily: 'Arial, sans-serif'
        }}
        autoComplete="off"
      />
      <button
        type="submit"
        disabled={loading || !value.trim()}
        style={{
          background: '#00965E',
          color: '#fff',
          fontWeight: 600,
          border: 'none',
          borderRadius: 8,
          padding: '8px 18px',
          fontSize: 16,
          cursor: loading ? 'not-allowed' : 'pointer',
          fontFamily: 'Arial, sans-serif',
          boxShadow: loading ? 'none' : '0 1px 3px rgba(0,0,0,0.08)'
        }}
      >
        {loading ? 'Generating…' : 'Generate'}
      </button>
      {touched && !value.trim() && (
        <span style={{ color: 'red', marginLeft: 8, fontFamily: 'Arial, sans-serif', fontSize: 14 }}>
          Please enter a valid URL
        </span>
      )}
    </form>
  );
}
