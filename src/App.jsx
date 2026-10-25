import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserQRCodeReader } from '@zxing/browser';

const API_BASE = (import.meta.env.VITE_OFFLINE_API_BASE_URL ?? '').replace(/\/$/, '');
async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || `Request failed (${response.status})`);
    err.details = data.details;
    err.status = response.status;
    throw err;
  }
  return data;
}

const money = (paise) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(paise || 0) / 100);

function playScanAudio(type = 'success') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    if (type === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } else {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(300, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(160, ctx.currentTime + 0.22);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    }
  } catch {}
}

function formatReceipt(order) {
  if (!order) return null;
  const d = new Date(order.servedAt || Date.now());
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const datePart = `${yyyy}${mm}${dd}`;
  const shortId = order.orderId ? order.orderId.replace(/-/g, '').slice(0, 6).toUpperCase() : '000000';
  const orderNumber = order.orderId?.startsWith('CN-') ? order.orderId : `CN-${datePart}-${shortId}`;

  const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
  const timeFormatted = `${dateStr}, ${timeStr}`;

  const customerName = order.customerName || 'Customer';
  const items = Array.isArray(order.items) ? order.items : [];
  const totalRupees = Math.round(Number(order.totalPaise || 0) / 100);

  const lines = [
    '           CANTEEN ORDER',
    '------------------------------------',
    `Order:  ${orderNumber}`,
    `Time:   ${timeFormatted}`,
    `Name:   ${customerName}`,
    '------------------------------------',
    ...items.map((i) => `${i.name} x${i.quantity}`),
    '------------------------------------',
    `TOTAL: Rs. ${totalRupees}`,
    '------------------------------------',
    'Status: SERVED',
    'Thank you!'
  ];

  return {
    orderNumber,
    timeFormatted,
    customerName,
    items,
    totalRupees,
    formattedText: lines.join('\n')
  };
}

function Header() {
  return (
    <header className="offline-topbar">
      <a className="offline-brand" href="/">
        <span className="offline-logo">✓</span>
        <span>Canteen Verifier<small>OFFLINE PICKUP STATION</small></span>
      </a>
      <span className="local-badge"><i />LOCAL MODE</span>
    </header>
  );
}

export default function App() {
  const [status, setStatus] = useState({ sessions: [] });
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [qrPayload, setQrPayload] = useState('');
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState(null);
  const [orderList, setOrderList] = useState([]);
  const [filter, setFilter] = useState('unserved');
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraFlash, setCameraFlash] = useState(false);
  const [videoDevices, setVideoDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');

  const [autoPrint, setAutoPrint] = useState(() => {
    const saved = localStorage.getItem('canteenAutoPrint');
    return saved === null ? true : saved === 'true';
  });

  const autoPrintRef = useRef(autoPrint);
  useEffect(() => {
    autoPrintRef.current = autoPrint;
  }, [autoPrint]);

  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const readerRef = useRef(null);
  const fileInputRef = useRef(null);
  const inputRef = useRef(null);
  const lastScanRef = useRef({ text: '', timestamp: 0 });
  const isProcessingRef = useRef(false);

  const receipt = useMemo(() => formatReceipt(result?.order), [result]);

  const refreshStatus = useCallback(async (preferredSession = '') => {
    try {
      const data = await api('/api/status');
      setStatus(data);
      const nextId = preferredSession || selectedSessionId;
      const stillExists = data.sessions.some((session) => session.sessionId === nextId);
      const chosen = stillExists ? nextId : (data.sessions[0]?.sessionId || '');
      setSelectedSessionId(chosen);
      return chosen;
    } catch (error) {
      setMessage({ type: 'error', text: `Could not reach the local verifier: ${error.message}` });
      return '';
    }
  }, [selectedSessionId]);

  const refreshOrders = useCallback(async (sessionId = selectedSessionId, state = filter) => {
    if (!sessionId) { setOrderList([]); return; }
    try {
      const data = await api(`/api/sessions/${sessionId}/orders?state=${state}`);
      setOrderList(data.orders);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    }
  }, [selectedSessionId, filter]);

  useEffect(() => { refreshStatus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { refreshOrders(); }, [selectedSessionId, filter, status.sessions.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const scanTicket = useCallback(async (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) { setMessage({ type: 'error', text: 'Scan a QR ticket or enter order reference.' }); return; }
    setScanning(true); setMessage(null);
    try {
      const data = await api('/api/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ qrPayload: trimmed, sessionId: selectedSessionId })
      });
      setResult(data);
      setSelectedSessionId(data.order.sessionId);
      setMessage({ type: 'success', text: data.message });
      setQrPayload('');
      playScanAudio('success');

      // Auto print token immediately upon successful verification
      if (autoPrintRef.current) {
        setTimeout(() => {
          try {
            window.print();
          } catch (e) {
            console.warn('Auto-print error:', e);
          }
        }, 220);
      }

      await refreshStatus(data.order.sessionId);
      await refreshOrders(data.order.sessionId, filter);
      setTimeout(() => inputRef.current?.focus(), 100);
    } catch (error) {
      const duplicate = error.message.includes('DUPLICATE_SCAN') || error.message.toLowerCase().includes('already been served');
      setMessage({
        type: duplicate ? 'duplicate' : 'error',
        text: duplicate ? (error.message.replace(/^DUPLICATE_SCAN:\s*/i, '') + ' (Do not issue order again)') : error.message
      });
      playScanAudio('error');
      if (duplicate && error.details?.order) {
        setResult({ order: error.details.order });
      }
      setQrPayload('');
      setTimeout(() => inputRef.current?.focus(), 100);
    } finally {
      setScanning(false);
    }
  }, [filter, refreshOrders, refreshStatus, selectedSessionId]);

  const startCamera = useCallback(async (preferredDeviceId = selectedDeviceId) => {
    setMessage(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access is unavailable in this browser. Use a USB QR scanner or paste the QR payload.');
      }

      try { controlsRef.current?.stop(); } catch {}
      controlsRef.current = null;

      let chosenDeviceId = preferredDeviceId;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter((d) => d.kind === 'videoinput');
        setVideoDevices(videoInputs);
        if (!chosenDeviceId && videoInputs.length > 0) {
          const rearCam = videoInputs.find((d) => /back|rear|environment/i.test(d.label));
          chosenDeviceId = (rearCam || videoInputs[0]).deviceId;
          setSelectedDeviceId(chosenDeviceId);
        }
      } catch {}

      const hints = new Map([[3, true]]); // 3 = DecodeHintType.TRY_HARDER
      const reader = new BrowserQRCodeReader(hints, {
        delayBetweenScanAttempts: 40,
        delayBetweenScanSuccess: 250
      });
      readerRef.current = reader;

      const constraints = {
        video: {
          ...(chosenDeviceId ? { deviceId: { exact: chosenDeviceId } } : { facingMode: { ideal: 'environment' } }),
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }
      };

      controlsRef.current = await reader.decodeFromConstraints(constraints, videoRef.current, (decodeResult) => {
        if (decodeResult) {
          const text = decodeResult.getText()?.trim();
          if (!text) return;
          const now = Date.now();
          if (isProcessingRef.current) return;
          if (lastScanRef.current.text === text && (now - lastScanRef.current.timestamp) < 3500) return;

          lastScanRef.current = { text, timestamp: now };
          isProcessingRef.current = true;

          setCameraFlash(true);
          setTimeout(() => setCameraFlash(false), 350);

          scanTicket(text).finally(() => {
            isProcessingRef.current = false;
          });
        }
      });

      setCameraOn(true);
    } catch (error) {
      setMessage({ type: 'error', text: `${error.message} Camera access generally requires localhost or HTTPS.` });
      setCameraOn(false);
    }
  }, [scanTicket, selectedDeviceId]);

  const stopCamera = useCallback(() => {
    try { controlsRef.current?.stop(); } catch {}
    controlsRef.current = null;
    setCameraOn(false);
  }, []);

  useEffect(() => {
    startCamera();
    return () => {
      try { controlsRef.current?.stop(); } catch {}
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleDeviceChange(e) {
    const newId = e.target.value;
    setSelectedDeviceId(newId);
    startCamera(newId);
  }

  async function importWorkbook(event) {
    event.preventDefault();
    if (!selectedFile) { setMessage({ type: 'error', text: 'Choose the signed Excel export first.' }); return; }
    setImporting(true); setMessage(null); setResult(null);
    const form = new FormData(); form.append('file', selectedFile);
    try {
      const data = await api('/api/import', { method: 'POST', body: form });
      setMessage({ type: 'success', text: data.message });
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      const sessionId = await refreshStatus(data.sessionId);
      await refreshOrders(sessionId, filter);
    } catch (error) { setMessage({ type: 'error', text: error.message }); }
    finally { setImporting(false); }
  }

  async function syncRedemptions() {
    setSyncing(true); setMessage(null);
    try { const data = await api('/api/sync', { method: 'POST' }); setMessage({ type: 'success', text: data.message }); await refreshStatus(); }
    catch (error) { setMessage({ type: 'error', text: `Sync did not finish; local records are preserved. ${error.message}` }); }
    finally { setSyncing(false); }
  }

  const selectedSession = status.sessions.find((session) => session.sessionId === selectedSessionId);
  const totalOrders = selectedSession?.orderCount || 0;
  const servedOrders = selectedSession?.servedCount || 0;

  return (
    <div className="offline-app">
      <Header />
      <main className="offline-main">
        <section className="offline-intro">
          <div>
            <p className="offline-eyebrow">INTERNET NOT REQUIRED TO SERVE</p>
            <h1>Verify. Serve. Done.</h1>
            <p>Import the signed order export, then scan each customer's QR ticket. The camera runs continuously and auto-prints the token upon serving.</p>
          </div>
          <div className="offline-status-orb"><span>✓</span><small>LOCAL<br />DATABASE</small></div>
        </section>

        {message && (
          <div className={`offline-message ${message.type}`} role="status">
            <span>{message.type === 'success' ? '✓' : message.type === 'duplicate' ? '!' : '⚠'}</span>
            <p>{message.text}</p>
            <button onClick={() => setMessage(null)}>×</button>
          </div>
        )}

        <div className="offline-grid">
          <section className="offline-card import-panel">
            <div className="offline-card-title">
              <div><p className="offline-eyebrow">STEP 1</p><h2>Import daily order file</h2></div>
              <span className="step-number">01</span>
            </div>
            <p className="offline-muted">Choose the .xlsx file downloaded from the cloud admin. The verifier checks the Ed25519 signature and compares the visible sheet with the signed data.</p>
            <form onSubmit={importWorkbook} className="import-form">
              <label className="file-drop" htmlFor="order-export">
                <span className="file-icon">⇧</span>
                <b>{selectedFile?.name || 'Choose Excel export'}</b>
                <small>{selectedFile ? `${(selectedFile.size / 1024).toFixed(1)} KB selected` : 'Signed .xlsx file · max 20 MB'}</small>
                <input ref={fileInputRef} id="order-export" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setSelectedFile(e.target.files?.[0] || null)} />
              </label>
              <button className="offline-button offline-primary" disabled={importing || !selectedFile}>{importing ? 'Verifying file…' : 'Verify & import export'}</button>
            </form>
            <div className="integrity-note">
              <span>⊙</span>
              <p><b>Signature verification is required.</b><br />Modified files, unsigned workbooks, and exports from an untrusted key are rejected.</p>
            </div>
            <div className="session-summary">
              <div>
                <span>Imported session</span>
                <b>{selectedSession?.sessionDate || 'No session imported'}</b>
                <small>{selectedSession ? `Export version ${selectedSession.exportVersion}` : 'Import an export to begin'}</small>
              </div>
              <div className="summary-counts">
                <div><b>{totalOrders}</b><small>Paid orders</small></div>
                <div><b>{servedOrders}</b><small>Served</small></div>
              </div>
            </div>
          </section>

          <section className="offline-card scan-panel">
            <div className="offline-card-title">
              <div><p className="offline-eyebrow">STEP 2</p><h2>Scan pickup ticket</h2></div>
              <div className="scanner-status-indicator">
                <span className={`status-dot ${cameraOn ? 'active' : ''}`} />
                <b>{cameraOn ? 'SCANNER LIVE' : 'CAMERA PAUSED'}</b>
              </div>
            </div>
            <p className="offline-muted">Camera continuously auto-scans QR tickets. The order is verified atomically and token is printed automatically.</p>

            <div className="scan-input-wrap">
              <input
                ref={inputRef}
                value={qrPayload}
                onChange={(e) => setQrPayload(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); scanTicket(qrPayload); } }}
                placeholder="Scan QR or enter 8-digit Order Reference (e.g. 6FAE89B1)"
                autoComplete="off"
                spellCheck="false"
              />
              <button className="offline-button offline-primary" disabled={scanning || !qrPayload.trim()} onClick={() => scanTicket(qrPayload)}>
                {scanning ? 'Checking…' : 'Verify & Serve'}
              </button>
            </div>

            <div className={`camera-wrap ${cameraFlash ? 'flash' : ''}`}>
              <video ref={videoRef} className={cameraOn ? 'camera-video active' : 'camera-video'} muted playsInline />
              
              {cameraOn && (
                <>
                  <div className="camera-live-badge">
                    <span className="live-dot" />
                    <b>LIVE CAMERA ACTIVE</b>
                  </div>
                  <div className="scanner-overlay">
                    <div className="scanner-target">
                      <span className="corner c-tl" />
                      <span className="corner c-tr" />
                      <span className="corner c-bl" />
                      <span className="corner c-br" />
                      <div className="scan-laser" />
                    </div>
                    <p className="scanner-hint">Hold ticket inside target box · Scans automatically</p>
                  </div>
                </>
              )}

              <div className={`camera-placeholder ${cameraOn ? 'hidden' : ''}`}>
                <div className="scan-corners">
                  <i /><i /><i /><i />
                  <span>📷</span>
                </div>
                <b>Camera is paused</b>
                <small>Click "Resume camera scanner" to turn the live scanner back on.</small>
              </div>
            </div>

            <div className="camera-controls-bar">
              <div className="camera-actions">
                {cameraOn ? (
                  <button className="offline-button offline-secondary" onClick={stopCamera}>Pause camera</button>
                ) : (
                  <button className="offline-button offline-primary" onClick={() => startCamera()}>Resume camera scanner</button>
                )}
                <button className="offline-button offline-secondary" onClick={() => inputRef.current?.focus()}>Focus manual input</button>
              </div>
              {videoDevices.length > 1 && (
                <select className="camera-select" value={selectedDeviceId} onChange={handleDeviceChange} aria-label="Select camera">
                  {videoDevices.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {result && receipt && (
              <div className="served-receipt-wrap">
                <div className="receipt-actions-header no-print">
                  <div className="receipt-status-badge">
                    <span className="badge-check">✓</span>
                    <div>
                      <b>ORDER SERVED & TOKEN GENERATED</b>
                      <small>Camera stays open for the next customer</small>
                    </div>
                  </div>
                  <div className="receipt-controls">
                    <label className="autoprint-toggle" title="Automatically print token when a ticket is verified">
                      <input
                        type="checkbox"
                        checked={autoPrint}
                        onChange={(e) => {
                          const val = e.target.checked;
                          setAutoPrint(val);
                          localStorage.setItem('canteenAutoPrint', String(val));
                        }}
                      />
                      <span>Auto-print on scan</span>
                    </label>
                    <button type="button" className="offline-button offline-primary" onClick={() => window.print()}>
                      🖨 Print token
                    </button>
                    <button type="button" className="offline-button offline-secondary" onClick={() => setResult(null)}>
                      Clear
                    </button>
                  </div>
                </div>

                <div className="thermal-slip-container" id="thermal-slip">
                  <pre className="thermal-slip-text">{receipt.formattedText}</pre>
                </div>
              </div>
            )}
          </section>
        </div>

        <section className="offline-card history-panel">
          <div className="offline-card-title">
            <div><p className="offline-eyebrow">LOCAL REDEMPTION RECORD</p><h2>Session orders</h2></div>
            <div className="history-controls">
              <select aria-label="Imported session" value={selectedSessionId} onChange={(e) => setSelectedSessionId(e.target.value)}>
                <option value="">Select session</option>
                {status.sessions.map((session) => <option key={session.sessionId} value={session.sessionId}>{session.sessionDate} · v{session.exportVersion}</option>)}
              </select>
              <select aria-label="Order status filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="unserved">Awaiting pickup</option>
                <option value="served">Served</option>
                <option value="all">All orders</option>
              </select>
            </div>
          </div>
          <div className="offline-table-wrap">
            <table className="offline-table">
              <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Served at</th></tr></thead>
              <tbody>
                {orderList.map((order) => (
                  <tr key={order.orderId}>
                    <td><b>#{order.orderId.slice(0, 8).toUpperCase()}</b></td>
                    <td>{order.customerName}<small>{order.customerPhone}</small></td>
                    <td>{order.items.map((item) => `${item.name} × ${item.quantity}`).join(', ')}</td>
                    <td>{money(order.totalPaise)}</td>
                    <td><span className={`offline-pill ${order.servedAt ? 'served' : 'waiting'}`}>{order.servedAt ? 'Served' : 'Waiting'}</span></td>
                    <td>
                      {order.servedAt ? (
                        <div className="table-action-cell">
                          <span>{new Date(order.servedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          <button
                            type="button"
                            className="reprint-token-btn"
                            onClick={() => setResult({ order })}
                            title="View receipt and reprint token"
                          >
                            Slip
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="offline-button offline-primary mini-serve-btn"
                          onClick={() => scanTicket(order.orderId.slice(0, 8).toUpperCase())}
                          title="Serve this order manually by reference"
                        >
                          Serve
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!orderList.length && <div className="offline-empty">No orders match this filter.</div>}
          </div>
        </section>

        <section className="sync-panel">
          <div className="sync-icon">⟳</div>
          <div className="sync-copy">
            <b>When internet returns</b>
            <p>Sync the offline redemption log to the cloud for recordkeeping. Sync is idempotent and does not delete the local history.</p>
          </div>
          <button className="offline-button offline-secondary" onClick={syncRedemptions} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync redemption log'}
          </button>
        </section>

        <footer className="offline-footer">
          <span>Local workstation database · SQLite</span>
          <span>Keep this computer powered on while other scanners are connected.</span>
          <span>{status.stationId || 'Local station'}</span>
        </footer>
      </main>
    </div>
  );
}
