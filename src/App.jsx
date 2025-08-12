{result && (
  <div
    style={{
      marginTop: 32,
      borderTop: '1px solid #ddd',
      paddingTop: 24,
      fontFamily: 'Arial, system-ui, -apple-system, Segoe UI, Roboto, Arial'
    }}
  >
    {/* Time Taken (if you implemented timing logic) */}
    {result.timeTaken && (
      <div style={{ marginBottom: 20, fontSize: 15, color: '#555' }}>
        <strong>Time to Generate:</strong>
        <div>{result.timeTaken}</div>
      </div>
    )}

    {/* Each Data Point */}
    <div style={{ marginBottom: 20 }}>
      <strong>Website URL:</strong>
      <div>{result.url}</div>
    </div>

    <div style={{ marginBottom: 20 }}>
      <strong>Business Description:</strong>
      <div>{result.description}</div>
    </div>

    <div style={{ marginBottom: 20 }}>
      <strong>Client Base:</strong>
      <div>{result.clientBase}</div>
    </div>

    <div style={{ marginBottom: 20 }}>
      <strong>Owner Demographic:</strong>
      <div>{result.ownerDemographic}</div>
    </div>

    <div style={{ marginBottom: 20 }}>
      <strong>Products and Services:</strong>
      <div>{result.productsAndServices}</div>
    </div>

    <div style={{ marginBottom: 20 }}>
      <strong>Hours of Operation:</strong>
      <pre style={{
        fontFamily: 'Arial, monospace',
        fontSize: 15,
        margin: 0,
        whiteSpace: 'pre-line'
      }}>{result.hoursOfOperation}</pre>
    </div>

    <div style={{ marginBottom: 20 }}>
      <strong>Address(es):</strong>
      <pre style={{
        fontFamily: 'Arial, monospace',
        fontSize: 15,
        margin: 0,
        whiteSpace: 'pre-line'
      }}>{result.addresses}</pre>
    </div>

    <div style={{ marginBottom: 20 }}>
      <strong>Phone Number(s):</strong>
      <pre style={{
        fontFamily: 'Arial, monospace',
        fontSize: 15,
        margin: 0,
        whiteSpace: 'pre-line'
      }}>{result.phoneNumbers}</pre>
    </div>

    <div style={{ marginBottom: 20 }}>
      <strong>Social Media URLs:</strong>
      <pre style={{
        fontFamily: 'Arial, monospace',
        fontSize: 15,
        margin: 0,
        whiteSpace: 'pre-line'
      }}>{result.socialMediaUrls}</pre>
    </div>

    <div style={{ marginBottom: 20 }}>
      <strong>License Number(s):</strong>
      <pre style={{
        fontFamily: 'Arial, monospace',
        fontSize: 15,
        margin: 0,
        whiteSpace: 'pre-line'
      }}>{result.licenseNumbers}</pre>
    </div>

    <div style={{ marginBottom: 20 }}>
      <strong>Email Addresses:</strong>
      <pre style={{
        fontFamily: 'Arial, monospace',
        fontSize: 15,
        margin: 0,
        whiteSpace: 'pre-line'
      }}>{result.emailAddresses}</pre>
    </div>

    <div style={{ marginBottom: 20 }}>
      <strong>Methods of Payment:</strong>
      <div>{result.methodsOfPayment}</div>
    </div>

    <div style={{ marginBottom: 20 }}>
      <strong>BBB Seal on Website:</strong>
      <div>{result.bbbSeal}</div>
    </div>

    <div style={{ marginBottom: 20 }}>
      <strong>Service Area:</strong>
      <div>{result.serviceArea}</div>
    </div>

    <div style={{ marginBottom: 20 }}>
      <strong>Refund and Exchange Policy:</strong>
      <div>{result.refundAndExchangePolicy}</div>
    </div>
  </div>
)}
