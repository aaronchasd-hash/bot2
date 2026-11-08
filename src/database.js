import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bicha.json');
const empty = () => ({ prefixes: {}, orders: {}, guildSettings: {} });
function read() { if (!existsSync(file)) return empty(); try { return { ...empty(), ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { return empty(); } }
function write(data) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data, null, 2)); }
export function getPrefix(guildId, fallback) { return read().prefixes[guildId] || fallback; }
export function setPrefix(guildId, prefix) { const data = read(); data.prefixes[guildId] = prefix; write(data); return prefix; }
export function getGuildSettings(guildId, defaults = {}) { return { ...defaults, ...(read().guildSettings[guildId] || {}) }; }
export function setGuildSettings(guildId, patch) { const data = read(); data.guildSettings[guildId] = { ...(data.guildSettings[guildId] || {}), ...patch }; write(data); return data.guildSettings[guildId]; }
export function saveOrder(order) { const data = read(); data.orders[order.id] = order; write(data); return order; }
export function findOrderByChannel(channelId) { return Object.values(read().orders).find((order) => order.channelId === channelId) || null; }
export function updateOrder(id, patch) { const data = read(); if (!data.orders[id]) return null; data.orders[id] = { ...data.orders[id], ...patch, updatedAt: new Date().toISOString() }; write(data); return data.orders[id]; }
export function openOrders(guildId) { return Object.values(read().orders).filter((order) => order.guildId === guildId && order.status !== 'closed'); }
