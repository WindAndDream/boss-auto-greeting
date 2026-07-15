import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = path.join(root, 'config', 'config.json');
const dataFile = path.join(root, 'bridge', 'data', 'records.json');
const exampleFile = path.join(root, 'config', 'config.example.json');

function json(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }
function ensureConfig() {
  const example = json(exampleFile, {}); const config = json(configFile, null);
  if (config) return config;
  example.bridge.token = crypto.randomBytes(24).toString('hex');
  write(configFile, example); return example;
}
const config = ensureConfig();
const store = json(dataFile, { records: [], binding: { umo: '', updatedAt: 0 }, state: { enabled: true, dailyLimit: 20, updatedAt: 0 } });
store.binding ||= { umo: '', updatedAt: 0 };
store.state = { enabled: Boolean(config.automation?.enabled), dailyLimit: Number(config.automation?.dailyLimit || 20), ...store.state };
function persist() { write(dataFile, store); }
function reply(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise((resolve, reject) => { let body=''; req.on('data', c => { body += c; if (body.length > 1_000_000) reject(new Error('payload too large')); }); req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('invalid JSON')); } }); }); }
function authorized(req) {
  const value = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const actual = Buffer.from(value); const expected = Buffer.from(String(config.bridge.token || ''));
  return actual.length === expected.length && expected.length > 0 && crypto.timingSafeEqual(actual, expected);
}
function localDay(value = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value); }
function todayCount() { const day = localDay(); return store.records.filter(r => r.type === 'greeting.sent' && localDay(new Date(r.createdAt)) === day).length; }
function csv(rows) { const columns = ['createdAt','type','status','company','jobTitle','salary','jobUrl','reason','message']; const quote = v => `"${String(v ?? '').replaceAll('"','""')}"`; return `\ufeff${[columns.join(','), ...rows.map(r => columns.map(k => quote(r[k])).join(','))].join('\r\n')}`; }
async function notify(event) {
  const a = config.astrbot || {}; const umo = store.binding.umo || a.umo;
  if (!a.apiKey || !umo) return { sent: false, reason: 'AstrBot API Key 或 QQ 绑定目标未配置，事件已本地保存。' };
  const content = ['【BOSS 求职助手】', `类型：${event.type}`, event.jobTitle && `岗位：${event.jobTitle}`, event.company && `公司：${event.company}`, event.status && `结果：${event.status}`, event.reason && `原因：${event.reason}`].filter(Boolean).join('\n');
  const response = await fetch(`${String(a.baseUrl).replace(/\/$/, '')}/im/message`, { method: 'POST', headers: { 'content-type':'application/json', authorization:`Bearer ${a.apiKey}` }, body: JSON.stringify({ umo, message:content }), signal: AbortSignal.timeout(10_000) });
  const payload = await response.json().catch(() => ({}));
  const sent = response.ok && payload.status === 'ok';
  return { sent, status: response.status, reason: sent ? '' : String(payload.message || 'AstrBot 未接受消息') };
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return reply(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok:true, astrbotConfigured:Boolean(config.astrbot?.apiKey), bound:Boolean(store.binding.umo || config.astrbot?.umo), state:store.state, todayCount:todayCount() });
  if (!authorized(req)) return reply(res, 401, { error:'unauthorized' });
  try {
    if (req.method === 'GET' && url.pathname === '/api/v1/status') return reply(res, 200, { state:store.state, bound:Boolean(store.binding.umo || config.astrbot?.umo), todayCount:todayCount(), total:store.records.length });
    if (req.method === 'POST' && url.pathname === '/api/v1/bind') { const b=await readBody(req); const umo=String(b.umo||'').trim(); if(!/^[^:]+:[^:]+:.+$/.test(umo)) return reply(res,400,{error:'invalid_umo'}); store.binding={umo,updatedAt:Date.now()}; persist(); return reply(res,200,{bound:true}); }
    if (req.method === 'POST' && url.pathname === '/api/v1/control') { const b=await readBody(req); if (typeof b.enabled === 'boolean') store.state.enabled=b.enabled; if (Number.isFinite(Number(b.dailyLimit))) store.state.dailyLimit=Math.max(1,Math.min(100,Number(b.dailyLimit))); store.state.updatedAt=Date.now(); persist(); return reply(res,200,{state:store.state}); }
    if (req.method === 'POST' && url.pathname === '/api/v1/events') { const b=await readBody(req); const event={ id:crypto.randomUUID(), createdAt:new Date().toISOString(), type:String(b.type||'unknown'), status:String(b.status||''), company:String(b.company||''), jobTitle:String(b.jobTitle||''), salary:String(b.salary||''), jobUrl:String(b.jobUrl||''), reason:String(b.reason||''), message:String(b.message||'') }; if(event.type==='greeting.sent' && todayCount()>=store.state.dailyLimit) return reply(res,429,{error:'daily_limit_reached'}); store.records.unshift(event); store.records.splice(5000); persist(); let delivery={sent:false}; if (/^(greeting\.|system\.|reply\.)/.test(event.type)) { try { delivery=await notify(event); } catch(error) { delivery={sent:false,reason:error.message}; } } return reply(res,201,{event,delivery}); }
    if (req.method === 'GET' && url.pathname === '/api/v1/records') { const status=url.searchParams.get('status'); const rows=status?store.records.filter(r=>r.status===status):store.records; return reply(res,200,{records:rows}); }
    if (req.method === 'GET' && url.pathname === '/api/v1/export.csv') { res.writeHead(200, {'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="boss-records.csv"'}); return res.end(csv(store.records)); }
    return reply(res,404,{error:'not_found'});
  } catch(error) { return reply(res,400,{error:error.message}); }
});
server.listen(config.bridge.port, config.bridge.host, () => console.log(`BOSS bridge listening on http://${config.bridge.host}:${config.bridge.port}`));
