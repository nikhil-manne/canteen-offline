import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, verify as cryptoVerify, createHmac, timingSafeEqual } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '../..');
const resolveRootPath = (value, fallback) => path.isAbsolute(value || '') ? value : path.resolve(rootDir, value || fallback);

export function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
export function parseQrPayload(value) {
  if (typeof value !== 'string') throw new Error('QR payload must be text');
  const [prefix, version, sessionId, orderId, ticketCode, ...extra] = value.trim().split('|');
  if (prefix !== 'CANTEEN' || version !== 'v1' || extra.length || !sessionId || !orderId || !ticketCode) throw new Error('This is not a valid canteen ticket QR.');
  if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !/^[0-9a-f-]{36}$/i.test(orderId) || !/^[A-Za-z0-9_-]{32,64}$/.test(ticketCode)) throw new Error('Ticket QR format is invalid.');
  return { sessionId, orderId, ticketCode };
}

export function readPublicKey() {
  if (process.env.EXPORT_PUBLIC_KEY_PEM_BASE64) return Buffer.from(process.env.EXPORT_PUBLIC_KEY_PEM_BASE64, 'base64').toString('utf8');
  if (process.env.EXPORT_PUBLIC_KEY_PEM) return process.env.EXPORT_PUBLIC_KEY_PEM.replace(/\\n/g, '\n');
  const keyPath = resolveRootPath(process.env.EXPORT_PUBLIC_KEY_PATH, 'apps/offline-verifier/.local-export-public.pem');
  return readFileSync(keyPath, 'utf8');
}

function verifySignature(payloadJson, signatureB64, publicKey) {
  try { return cryptoVerify(null, Buffer.from(payloadJson, 'utf8'), publicKey, Buffer.from(signatureB64, 'base64')); }
  catch { return false; }
}

function canonicalVisibleRows(payload) {
  const rows = [['Order ID', 'Customer Name', 'Phone', 'Items', 'Total (INR)', 'Paid At (UTC)', 'Ticket Hash']];
  for (const order of payload.orders) {
    const itemsSummary = order.items.map((item) => `${item.name} x ${item.quantity}`).join('; ');
    rows.push([order.orderId, order.customerName, order.customerPhone || '', itemsSummary, (order.totalPaise / 100).toFixed(2), order.paidAt, order.ticketHash]);
  }
  return rows;
}

export async function verifyExportWorkbook(buffer, publicKey = readPublicKey()) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const manifestSheet = workbook.getWorksheet('Verifier Manifest');
  const ordersSheet = workbook.getWorksheet('Orders');
  if (!manifestSheet || !ordersSheet) throw new Error('This workbook does not contain the required signed manifest and Orders sheet.');
  const pairs = new Map();
  manifestSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > 1) {
      const key = row.getCell(1).text;
      const value = row.getCell(2).text;
      if (key) pairs.set(key, value ?? '');
    }
  });
  if (pairs.get('schemaVersion') !== '1' || pairs.get('algorithm') !== 'Ed25519') throw new Error('The export format or signing algorithm is unsupported.');
  const chunkCount = Number(pairs.get('payloadChunkCount'));
  if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 200) throw new Error('The signed manifest chunk count is invalid.');
  let payloadJson = '';
  for (let i = 1; i <= chunkCount; i += 1) {
    const key = `payloadChunk${String(i).padStart(4, '0')}`;
    if (!pairs.has(key)) throw new Error(`The signed manifest is missing ${key}.`);
    payloadJson += pairs.get(key);
  }
  const signature = pairs.get('signatureBase64');
  if (!signature || !verifySignature(payloadJson, signature, publicKey)) throw new Error('Export signature check failed. Use an untouched export from the canteen admin system.');

  let payload;
  try { payload = JSON.parse(payloadJson); } catch { throw new Error('Signed manifest JSON is not valid.'); }
  if (payload.schemaVersion !== 1 || !payload.exportId || !payload.sessionId || !Array.isArray(payload.orders)) throw new Error('Signed manifest data is incomplete.');
  if (payload.orders.length > 10000) throw new Error('The export contains too many orders.');
  for (const order of payload.orders) {
    if (!order.orderId || !/^[a-f0-9]{64}$/i.test(order.ticketHash || '') || !order.customerName || !Number.isInteger(order.totalPaise) || !Array.isArray(order.items) || !order.paidAt) throw new Error('An order in the signed manifest is malformed.');
    if (order.items.some((item) => !item.name || !Number.isInteger(item.quantity) || item.quantity < 1 || !Number.isInteger(item.unitPricePaise) || item.unitPricePaise <= 0)) throw new Error(`The item list for order ${order.orderId} is malformed.`);
  }
  const expected = canonicalVisibleRows(payload).map((row) => row.map((cell) => String(cell)));
  const visible = [];
  ordersSheet.eachRow({ includeEmpty: true }, (row) => {
    visible.push(Array.from({ length: 7 }, (_, i) => String(row.getCell(i + 1).text ?? '')));
  });
  while (visible.length && visible.at(-1).every((cell) => cell === '')) visible.pop();
  if (JSON.stringify(visible) !== JSON.stringify(expected)) throw new Error('The Orders worksheet does not match the digitally signed manifest. The workbook may have been edited.');

  const seenOrders = new Set();
  for (const order of payload.orders) {
    if (seenOrders.has(order.orderId)) throw new Error(`Duplicate order id in export: ${order.orderId}`);
    seenOrders.add(order.orderId);
  }
  return { payload, signature, orderCount: payload.orders.length };
}

export function signSync(records, secret) {
  return createHmac('sha256', secret).update(JSON.stringify(records)).digest('hex');
}
export function safeEqualText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function getRootDir() { return rootDir; }
