import React from 'react';

export default function UrlForm({ url, setUrl, loading, onSubmit, inputRef }) {
  // Handles both click and Enter key
  function handleSubmit(e) {
    e.preventDefault();
    if (!url || loading) return;
    onSubmit(url);
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: 'flex',
        gap: 12,
        margin: '24px 0',
        fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto',
        alignItems: 'center'
      }}
      aria-label="BBB Business Website Data Form"
    >
      <label htmlFor="bbb-url-input" style={{ fontSize: 17, fontWeight: 500 }}>
        Website URL:
      </label>
      <input
        id="bbb-url-input"
        type="url"
        ref={inputRef}
        value={url}
        required
        pattern="https?://.+"
        placeholder="https://www.example.com/"
        onChange={e => setUrl(e.target.value)}
        style={{
          flex: 1,
          padding: '10px 13px',
          fontSize: 17,
          borderRadius: 8,
          border: '1.3px solid #bbb',
          outline: 'none',
          fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto'
        }}
        autoFocus
        autoComplete="off"
      />
      <button
        type="submit"
        style={{
          background: '#00965E',
          color: 'white',
          fontSize: 17,
          borderRadius: 8,
          border: 'none',
          padding: '10px 22px',
          cursor: loading ? 'not-allowed' : 'pointer',
          fontWeight: 600,
          minWidth: 120,
          fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto',
          boxShadow: loading ? 'none' : '0 2px 7px rgba(0,0,0,0.06)'
        }}
        disabled={loading}
      >
        {loading ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Spinner /> Generating...
          </span>
        ) : (
          'Generate'
        )}
      </button>
    </form>
  );
}

// Simple inline spinner
function Spinner() {
  return (
    <svg
      width="18" height="18" viewBox="0 0 38 38"
      xmlns="http://www.w3.org/2000/svg"
      stroke="#fff"
      style={{ marginRight: 4, display: 'inline-block', verticalAlign: 'middle' }}
    >
      <g fill="none" fillRule="evenodd">
        <g transform="translate(1 1)" strokeWidth="3">
          <circle stroke="#fff" strokeOpacity=".2" cx="18" cy="18" r="18" />
          <path d="M36 18c0-9.94-8.06-18-18-18">
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 18 18"
              to="360 18 18"
              dur="0.8s"
              repeatCount="indefinite" />
          </path>
        </g>
      </g>
    </svg>
  );
}
