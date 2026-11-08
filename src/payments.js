import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const dir = join(process.cwd(), 'data');
const keyPath = join(dir, 'payments.key');
const file = join(dir, 'payments.enc');
function key() { mkdirSync(dir, { recursive: true }); if (!existsSync(keyPath)) { if (existsSync(file)) throw new Error('Falta la clave de pagos; no se puede leer el registro.'); writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); } return readFileSync(keyPath); }
function read() { if (!existsSync(file)) return {}; const payload = JSON.parse(readFileSync(file, 'utf8')); const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(payload.iv, 'base64')); decipher.setAuthTag(Buffer.from(payload.tag, 'base64')); return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString()); }
function write(data) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv); const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]); writeFileSync(file, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }), { mode: 0o600 }); }
export function getPayment(guild, user, type) { return read()[guild]?.[user]?.[type] || null; }
export function savePayment(guild, user, type, value) { const data = read(); data[guild] ||= {}; data[guild][user] ||= {}; data[guild][user][type] = value; write(data); }
export function aliasOwner(guild, type, alias) { const entries = Object.entries(read()[guild] || {}); return entries.find(([, methods]) => methods[type]?.alias?.toLowerCase() === alias.toLowerCase())?.[0] || null; }
