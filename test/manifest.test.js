import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import ExcelJS from 'exceljs';
import { parseQrPayload, verifyExportWorkbook } from '../manifest.js';

async function makeWorkbook(orderName = 'Veg Meals', mutateVisible = false) {
  const pair = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  const payload = {
    schemaVersion: 1, exportId: 'c6e3ae7c-2665-4c52-a2ca-9897c7b4ae3a', exportVersion: 1,
    sessionId: 'b3f0a8ac-7b9d-4cb7-8d71-2274a18cb8b2', sessionDate: '2026-10-25', generatedAt: '2026-10-25T08:00:00.000Z',
    orders: [{ orderId: '8195f9b7-61a9-4b3d-b79b-2f3df983c1b1', ticketHash: 'a'.repeat(64), customerName: 'Test Customer', customerPhone: '9999999999', totalPaise: 8500, paidAt: '2026-10-25T07:55:00.000Z', items: [{ name: orderName, quantity: 1, unitPricePaise: 8500 }] }]
  };
  const payloadJson = JSON.stringify(payload);
  const signature = sign(null, Buffer.from(payloadJson), pair.privateKey).toString('base64');
  const orders = [['Order ID', 'Customer Name', 'Phone', 'Items', 'Total (INR)', 'Paid At (UTC)', 'Ticket Hash'], [payload.orders[0].orderId, 'Test Customer', '9999999999', `${orderName} x 1`, mutateVisible ? '999.00' : '85.00', payload.orders[0].paidAt, payload.orders[0].ticketHash]];
  const chunks = payloadJson.match(/.{1,20000}/gs) || [''];
  const manifest = [['key', 'value'], ['schemaVersion', '1'], ['algorithm', 'Ed25519'], ['exportId', payload.exportId], ['payloadChunkCount', String(chunks.length)], ...chunks.map((c, i) => [`payloadChunk${String(i + 1).padStart(4, '0')}`, c]), ['signatureBase64', signature]];
  const wb = new ExcelJS.Workbook();
  const ordersSheet = wb.addWorksheet('Orders');
  orders.forEach((row) => ordersSheet.addRow(row));
  const manifestSheet = wb.addWorksheet('Verifier Manifest');
  manifest.forEach((row) => manifestSheet.addRow(row));
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), publicKey: pair.publicKey };
}

test('signed export workbook verifies and returns the manifest', async () => {
  const { buffer, publicKey } = await makeWorkbook();
  const result = await verifyExportWorkbook(buffer, publicKey);
  assert.equal(result.orderCount, 1);
  assert.equal(result.payload.orders[0].customerName, 'Test Customer');
});

test('visible spreadsheet edits are detected despite valid manifest signature', async () => {
  const { buffer, publicKey } = await makeWorkbook('Veg Meals', true);
  await assert.rejects(() => verifyExportWorkbook(buffer, publicKey), /does not match the digitally signed manifest/i);
});

test('QR parser rejects a malformed QR payload', () => {
  assert.throws(() => parseQrPayload('hello'), /not a valid canteen ticket/i);
});
