import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyExportWorkbook, parseQrPayload, sha256, signSync, safeEqualText, getRootDir } from './manifest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = getRootDir();
dotenv.config({ path: path.resolve(rootDir, '.env') });
const resolveRootPath = (value, fallback) => path.isAbsolute(value || '') ? value : path.resolve(rootDir, value || fallback);
const port = Number(process.env.OFFLINE_PORT || 4000);
const dbPath = resolveRootPath(process.env.OFFLINE_DATABASE_PATH, 'apps/offline-verifier/data/offline.sqlite');
const stationId = process.env.STATION_ID || 'canteen-main';
const syncSecret = process.env.OFFLINE_SYNC_SECRET || 'local-only-change-this-offline-sync-secret';
const cloudApiBaseUrl = (process.env.CLOUD_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
function transaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}
db.exec(`
CREATE TABLE IF NOT EXISTS imported_sessions (
  session_id TEXT PRIMARY KEY,
  session_date TEXT NOT NULL,
  latest_export_id TEXT NOT NULL,
  export_version INTEGER NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS offline_orders (
  session_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  ticket_hash TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL DEFAULT '',
  total_paise INTEGER NOT NULL,
  paid_at TEXT NOT NULL,
  items_json TEXT NOT NULL,
  served_at TEXT,
  served_station TEXT,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (session_id, order_id),
  UNIQUE (session_id, ticket_hash)
);
CREATE INDEX IF NOT EXISTS idx_offline_orders_served ON offline_orders(session_id, served_at);
CREATE TABLE IF NOT EXISTS offline_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  ticket_hash TEXT NOT NULL,
  served_at TEXT NOT NULL,
  station_id TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE (session_id, order_id)
);
`);

class HttpError extends Error { constructor(status, message, details) { super(message); this.status = status; this.details = details; } }
const ensure = (condition, status, message, details) => { if (!condition) throw new HttpError(status, message, details); };
const app = express();
app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

app.get('/api/status', (_req, res, next) => {
  try {
    const sessions = db.prepare(`SELECT s.session_id AS sessionId, s.session_date AS sessionDate, s.latest_export_id AS exportId,
      s.export_version AS exportVersion, s.imported_at AS importedAt,
      COUNT(o.order_id) AS orderCount,
      SUM(CASE WHEN o.served_at IS NOT NULL THEN 1 ELSE 0 END) AS servedCount
      FROM imported_sessions s LEFT JOIN offline_orders o ON o.session_id=s.session_id
      GROUP BY s.session_id ORDER BY s.session_date DESC`).all();
    res.json({ ok: true, stationId, sessions: sessions.map((s) => ({ ...s, orderCount: Number(s.orderCount || 0), servedCount: Number(s.servedCount || 0) })) });
  } catch (e) { next(e); }
});

app.post('/api/import', upload.single('file'), async (req, res, next) => {
  try {
    ensure(req.file, 400, 'Choose a signed .xlsx export file.');
    const { payload, orderCount } = await verifyExportWorkbook(req.file.buffer);
    const now = new Date().toISOString();
    const importTransaction = () => transaction(() => {
      for (const order of payload.orders) {
        const existing = db.prepare('SELECT ticket_hash FROM offline_orders WHERE session_id=? AND order_id=?').get(payload.sessionId, order.orderId);
        if (existing && existing.ticket_hash !== order.ticketHash) throw new HttpError(409, `Ticket hash changed for previously imported order ${order.orderId}. Import stopped to protect the redemption history.`);
        const hashCollision = db.prepare('SELECT order_id FROM offline_orders WHERE session_id=? AND ticket_hash=? AND order_id<>?').get(payload.sessionId, order.ticketHash, order.orderId);
        if (hashCollision) throw new HttpError(409, 'Two orders use the same ticket hash; the export was rejected.');
        db.prepare(`INSERT INTO offline_orders
          (session_id,order_id,ticket_hash,customer_name,customer_phone,total_paise,paid_at,items_json,imported_at)
          VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(session_id,order_id) DO UPDATE SET
            customer_name=excluded.customer_name, customer_phone=excluded.customer_phone,
            total_paise=excluded.total_paise, paid_at=excluded.paid_at,
            items_json=excluded.items_json, imported_at=excluded.imported_at`)
          .run(payload.sessionId, order.orderId, order.ticketHash, order.customerName, order.customerPhone || '', order.totalPaise, order.paidAt, JSON.stringify(order.items), now);
      }
      db.prepare(`INSERT INTO imported_sessions (session_id,session_date,latest_export_id,export_version,imported_at)
        VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
        session_date=excluded.session_date, latest_export_id=excluded.latest_export_id,
        export_version=MAX(imported_sessions.export_version, excluded.export_version), imported_at=excluded.imported_at`)
        .run(payload.sessionId, payload.sessionDate, payload.exportId, payload.exportVersion || 1, now);
    });
    importTransaction();
    const counts = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN served_at IS NOT NULL THEN 1 ELSE 0 END) AS served
      FROM offline_orders WHERE session_id=?`).get(payload.sessionId);
    res.json({ ok: true, sessionId: payload.sessionId, sessionDate: payload.sessionDate, exportId: payload.exportId, importedCount: orderCount, totalOrdersInLocalSession: Number(counts.total || 0), servedCount: Number(counts.served || 0), message: `Signed export verified (Batch v${payload.exportVersion || 1}). ${orderCount} order(s) added/checked; total session orders: ${Number(counts.total || 0)}.` });
  } catch (error) { next(error); }
});

app.get('/api/sessions/:sessionId/orders', (req, res, next) => {
  try {
    const filter = req.query.state;
    ensure(['all', 'served', 'unserved', undefined].includes(filter), 400, 'Invalid order filter.');
    let where = 'session_id=?';
    if (filter === 'served') where += ' AND served_at IS NOT NULL';
    if (filter === 'unserved') where += ' AND served_at IS NULL';
    const orders = db.prepare(`SELECT order_id AS orderId, customer_name AS customerName, customer_phone AS customerPhone,
      total_paise AS totalPaise, paid_at AS paidAt, served_at AS servedAt, served_station AS servedStation, items_json AS itemsJson
      FROM offline_orders WHERE ${where} ORDER BY paid_at, order_id`).all(req.params.sessionId);
    res.json({ orders: orders.map((o) => ({ ...o, totalPaise: Number(o.totalPaise), items: JSON.parse(o.itemsJson), itemsJson: undefined })) });
  } catch (error) { next(error); }
});

app.post('/api/scan', (req, res, next) => {
  try {
    const { qrPayload, orderReference, sessionId } = req.body || {};
    const input = String(orderReference || qrPayload || '').trim();
    ensure(input.length > 0, 400, 'Enter an order reference or scan a QR ticket.');

    const result = transaction(() => {
      let order;
      if (input.startsWith('CANTEEN|v1|')) {
        let parsed;
        try { parsed = parseQrPayload(input); } catch (e) { throw new HttpError(400, e.message); }
        order = db.prepare(`SELECT * FROM offline_orders WHERE session_id=? AND order_id=?`).get(parsed.sessionId, parsed.orderId);
        if (!order) throw new HttpError(404, 'Order is not in the imported paid-order list. Check that the correct day/session export was imported.');
        if (!safeEqualText(order.ticket_hash, sha256(parsed.ticketCode))) throw new HttpError(403, 'Ticket QR does not match the signed export. Do not serve this order.');
      } else {
        const cleanRef = input.replace(/^#/, '').trim().toLowerCase();
        ensure(cleanRef.length >= 4, 400, 'Order reference must be at least 4 characters.');
        let query = 'SELECT * FROM offline_orders WHERE LOWER(order_id) LIKE ?';
        const params = [`${cleanRef}%`];
        if (sessionId) {
          query += ' AND session_id = ?';
          params.push(sessionId);
        }
        query += ' ORDER BY paid_at DESC LIMIT 5';
        const matching = db.prepare(query).all(...params);
        if (!matching.length) {
          throw new HttpError(404, `No paid order found matching reference #${cleanRef.toUpperCase()}. Confirm reference from customer receipt.`);
        }
        if (matching.length > 1) {
          throw new HttpError(409, `Multiple orders match reference #${cleanRef.toUpperCase()}. Enter more characters.`);
        }
        order = matching[0];
      }

      if (order.served_at) {
        throw new HttpError(409, `DUPLICATE_SCAN: Order #${order.order_id.slice(0, 8).toUpperCase()} for ${order.customer_name} has already been served.`, {
          servedAt: order.served_at,
          stationId: order.served_station,
          order: {
            sessionId: order.session_id,
            orderId: order.order_id,
            customerName: order.customer_name,
            customerPhone: order.customer_phone,
            totalPaise: Number(order.total_paise),
            servedAt: order.served_at,
            stationId: order.served_station,
            items: JSON.parse(order.items_json)
          }
        });
      }
      const servedAt = new Date().toISOString();
      const update = db.prepare(`UPDATE offline_orders SET served_at=?, served_station=?
        WHERE session_id=? AND order_id=? AND served_at IS NULL`)
        .run(servedAt, stationId, order.session_id, order.order_id);
      if (update.changes !== 1) throw new HttpError(409, 'DUPLICATE_SCAN: This ticket has already been served.');
      db.prepare(`INSERT INTO offline_redemptions (session_id,order_id,ticket_hash,served_at,station_id)
        VALUES (?,?,?,?,?) ON CONFLICT(session_id,order_id) DO NOTHING`)
        .run(order.session_id, order.order_id, order.ticket_hash, servedAt, stationId);
      return { ...order, served_at: servedAt, served_station: stationId };
    });
    res.json({ ok: true, result: 'accepted', message: 'Ticket valid. Marked as served.', token: result.order_id.slice(0, 8).toUpperCase(), order: {
      sessionId: result.session_id, orderId: result.order_id, customerName: result.customer_name, customerPhone: result.customer_phone,
      totalPaise: Number(result.total_paise), servedAt: result.served_at, stationId: result.served_station, items: JSON.parse(result.items_json)
    } });
  } catch (error) { next(error); }
});

app.get('/api/redemptions/pending-sync', (_req, res, next) => {
  try {
    const records = db.prepare('SELECT session_id AS sessionId, order_id AS orderId, ticket_hash AS ticketHash, served_at AS servedAt, station_id AS stationId FROM offline_redemptions WHERE synced_at IS NULL ORDER BY id').all();
    res.json({ records });
  } catch (e) { next(e); }
});

app.post('/api/sync', async (_req, res, next) => {
  try {
    const records = db.prepare('SELECT session_id AS sessionId, order_id AS orderId, ticket_hash AS ticketHash, served_at AS servedAt, station_id AS stationId FROM offline_redemptions WHERE synced_at IS NULL ORDER BY id').all();
    if (!records.length) return res.json({ ok: true, synced: 0, message: 'No pending redemption records to sync.' });
    const updateSync = db.prepare('UPDATE offline_redemptions SET synced_at=? WHERE session_id=? AND order_id=? AND synced_at IS NULL');
    let synced = 0;
    // Keep each request comfortably below Express's JSON-body limit. A partial
    // failure leaves only later batches pending; already-accepted batches stay synced.
    for (let offset = 0; offset < records.length; offset += 500) {
      const batch = records.slice(offset, offset + 500);
      const signature = signSync(batch, syncSecret);
      const response = await fetch(`${cloudApiBaseUrl}/api/offline-sync/redemptions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-offline-signature': signature }, body: JSON.stringify({ records: batch }), signal: AbortSignal.timeout(15000)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new HttpError(502, result.error || `Cloud sync failed with status ${response.status}. ${synced} record(s) were synced; unsent local records remain queued.`);
      const ids = batch.map((r) => [r.sessionId, r.orderId]);
      transaction(() => { const stampedAt = new Date().toISOString(); for (const [sid, oid] of ids) updateSync.run(stampedAt, sid, oid); });
      synced += batch.length;
    }
    res.json({ ok: true, synced, message: `Synced ${synced} redemption record(s) to the online server.` });
  } catch (error) { next(error); }
});

// In production, Express serves the built offline-verifier UI from this same local service.
const distPath = path.resolve(here, 'dist');
app.use(express.static(distPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const indexFile = path.join(distPath, 'index.html');
  if (existsSync(indexFile)) {
    return res.sendFile(indexFile, (error) => { if (error) next(error); });
  }
  if (process.env.NODE_ENV !== 'production') {
    return res.status(200).send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Offline Verifier</title>
          <meta http-equiv="refresh" content="2;url=http://localhost:4001" />
          <style>body{font-family:system-ui,sans-serif;padding:3rem;text-align:center;line-height:1.6;color:#333;}</style>
        </head>
        <body>
          <h2>Offline Verifier Development Server</h2>
          <p>No production bundle found in <code>dist/</code>.</p>
          <p>If you're using the Vite dev server, redirecting to <a href="http://localhost:4001">http://localhost:4001</a>...</p>
          <p><small>Or run <code>npm run build</code> in <code>apps/offline-verifier</code> to serve the compiled UI directly from this port (4000).</small></p>
        </body>
      </html>
    `);
  }
  next();
});
app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Export workbook is too large (maximum 20 MB).' });
  console.error(err);
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Offline verifier error.' : (err?.message || 'Offline verifier error.') });
});

const server = app.listen(port, () => {
  console.log(`Offline verifier server listening on http://localhost:${port}`);
  console.log(`Persistent redemption database: ${dbPath}`);
});
const shutdown = () => { server.close(() => { db.close(); process.exit(0); }); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
