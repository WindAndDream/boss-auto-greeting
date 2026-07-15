import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'config.json'), 'utf8'));
const astrbotHeaders = { Authorization: `Bearer ${config.astrbot.apiKey}` };
const botsResponse = await fetch(`${config.astrbot.baseUrl}/im/bots`, { headers: astrbotHeaders, signal: AbortSignal.timeout(8000) });
const botsPayload = await botsResponse.json();
const botIds = botsPayload?.data?.bot_ids || [];
if (botsPayload.status !== 'ok' || botIds.length !== 1) throw new Error(`Expected one running IM bot; found ${botIds.length}.`);

const log = fs.readFileSync(path.join(os.homedir(), '.astrbot', 'logs', 'backend.log'), 'utf8');
const sessions = [...log.matchAll(/qq_official[^\r\n]*?([A-F0-9]{32}):/g)];
if (!sessions.length) throw new Error('No recent QQ official private session was found. Send the bot a message and retry.');
const umo = `${botIds[0]}:FriendMessage:${sessions.at(-1)[1]}`;
const bridgeBase = `http://${config.bridge.host}:${config.bridge.port}`;
const bridgeHeaders = { Authorization: `Bearer ${config.bridge.token}`, 'Content-Type': 'application/json' };
const bindResponse = await fetch(`${bridgeBase}/api/v1/bind`, { method: 'POST', headers: bridgeHeaders, body: JSON.stringify({ umo }), signal: AbortSignal.timeout(5000) });
const bindPayload = await bindResponse.json();
if (!bindResponse.ok || !bindPayload.bound) throw new Error(bindPayload.error || 'Binding failed.');
console.log('QQ notification target bound successfully.');

if (process.argv.includes('--test')) {
  const eventResponse = await fetch(`${bridgeBase}/api/v1/events`, { method: 'POST', headers: bridgeHeaders, body: JSON.stringify({ type: 'system.test', status: '联调成功', reason: '本地桥接、AstrBot 和 QQ 通知链路已连通。' }), signal: AbortSignal.timeout(15000) });
  const eventPayload = await eventResponse.json();
  if (!eventResponse.ok || !eventPayload.delivery?.sent) throw new Error(eventPayload.delivery?.reason || eventPayload.error || 'Test notification failed.');
  console.log('QQ test notification sent successfully.');
}
