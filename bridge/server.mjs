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
function normalizeStopTime(value) { const text=String(value || '').trim(); return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : ''; }
function ensureConfig() {
  const example = json(exampleFile, {}); const config = json(configFile, null);
  if (config) return config;
  example.bridge.token = crypto.randomBytes(24).toString('hex');
  write(configFile, example); return example;
}

const config = ensureConfig();
const store = json(dataFile, { records: [], binding: { umo: '', updatedAt: 0 }, state: {} });
store.binding ||= { umo: '', updatedAt: 0 };
const persistedState = store.state || {};
store.state = {
  enabled: typeof persistedState.enabled === 'boolean' ? persistedState.enabled : Boolean(config.automation?.enabled),
  stopTime: normalizeStopTime(persistedState.stopTime || config.automation?.stopTime) || '18:00',
  notifyEvery: 20,
  updatedAt: Number(persistedState.updatedAt || 0),
};

function persist() { write(dataFile, store); }
function reply(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise((resolve, reject) => { let body=''; req.on('data', c => { body += c; if (body.length > 1_000_000) reject(new Error('payload too large')); }); req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('invalid JSON')); } }); }); }
function authorized(req) {
  const value = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const actual = Buffer.from(value); const expected = Buffer.from(String(config.bridge.token || ''));
  return actual.length === expected.length && expected.length > 0 && crypto.timingSafeEqual(actual, expected);
}
function localDay(value = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value); }
function localTime(value = new Date()) { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(value); }
function todayCount() { const day = localDay(); return store.records.filter(r => r.type === 'greeting.sent' && localDay(new Date(r.createdAt)) === day).length; }
function scheduledStopReached() { return Boolean(store.state.stopTime && localTime() >= store.state.stopTime); }
function csv(rows) { const columns = ['createdAt','type','status','company','jobTitle','salary','jobUrl','reason','message']; const quote = v => `"${String(v ?? '').replaceAll('"','""')}"`; return `\ufeff${[columns.join(','), ...rows.map(r => columns.map(k => quote(r[k])).join(','))].join('\r\n')}`; }

async function notify(event) {
  const a = config.astrbot || {}; const umo = store.binding.umo || a.umo;
  if (!a.apiKey || !umo) return { sent: false, reason: 'AstrBot API Key 或 QQ 绑定目标未配置，事件已在本地保存。' };
  const title = event.type === 'reply.received' ? '【⚠️ HR 回复特别提醒】' : '【BOSS 求职助手】';
  const content = [title, `类型：${event.type}`, event.jobTitle && `岗位：${event.jobTitle}`, event.company && `会话：${event.company}`, event.status && `结果：${event.status}`, event.message && `回复：${event.message}`, event.reason && event.type !== 'reply.received' && `原因：${event.reason}`].filter(Boolean).join('\n');
  const response = await fetch(`${String(a.baseUrl).replace(/\/$/, '')}/im/message`, { method: 'POST', headers: { 'content-type':'application/json', authorization:`Bearer ${a.apiKey}` }, body: JSON.stringify({ umo, message:content }), signal: AbortSignal.timeout(10_000) });
  const payload = await response.json().catch(() => ({}));
  const sent = response.ok && payload.status === 'ok';
  return { sent, status: response.status, reason: sent ? '' : String(payload.message || 'AstrBot 未接受消息') };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return reply(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  const statusBody = () => ({ state:store.state, bound:Boolean(store.binding.umo || config.astrbot?.umo), scheduledStopReached:scheduledStopReached(), todayCount:todayCount(), total:store.records.length });
  if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok:true, astrbotConfigured:Boolean(config.astrbot?.apiKey), ...statusBody() });
  if (!authorized(req)) return reply(res, 401, { error:'unauthorized' });
  try {
    if (req.method === 'GET' && url.pathname === '/api/v1/status') return reply(res, 200, statusBody());
    if (req.method === 'POST' && url.pathname === '/api/v1/bind') { const b=await readBody(req); const umo=String(b.umo||'').trim(); if(!/^[^:]+:[^:]+:.+$/.test(umo)) return reply(res,400,{error:'invalid_umo'}); store.binding={umo,updatedAt:Date.now()}; persist(); return reply(res,200,{bound:true}); }
    if (req.method === 'POST' && url.pathname === '/api/v1/control') { const b=await readBody(req); if (typeof b.enabled === 'boolean') store.state.enabled=b.enabled; if (Object.hasOwn(b,'stopTime')) { const stopTime=normalizeStopTime(b.stopTime); if(!stopTime) return reply(res,400,{error:'invalid_stop_time'}); store.state.stopTime=stopTime; } store.state.updatedAt=Date.now(); persist(); return reply(res,200,{state:store.state,scheduledStopReached:scheduledStopReached()}); }
    if (req.method === 'POST' && url.pathname === '/api/v1/events') {
      const b=await readBody(req);
      const event={ id:crypto.randomUUID(), createdAt:new Date().toISOString(), type:String(b.type||'unknown'), status:String(b.status||''), company:String(b.company||''), jobTitle:String(b.jobTitle||''), salary:String(b.salary||''), jobUrl:String(b.jobUrl||''), reason:String(b.reason||''), message:String(b.message||'') };
      store.records.unshift(event); store.records.splice(5000); persist();
      let delivery={sent:false,reason:'not_notifiable'};
      try {
        if(event.type==='greeting.sent'){
          const count=todayCount(); const remainder=count % store.state.notifyEvery;
          if(remainder===0) delivery=await notify({...event,type:'greeting.summary',status:`今日已投递 ${count} 条`,reason:`每 ${store.state.notifyEvery} 条汇报一次`});
          else delivery={sent:false,reason:'batch_pending',progress:remainder,nextAt:count + (store.state.notifyEvery - remainder)};
        } else if (/^(system\.|reply\.)/.test(event.type)) delivery=await notify(event);
      } catch(error) { delivery={sent:false,reason:error.message}; }
      return reply(res,201,{event,delivery});
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/records') { const status=url.searchParams.get('status'); const rows=status?store.records.filter(r=>r.status===status):store.records; return reply(res,200,{records:rows}); }
    if (req.method === 'GET' && url.pathname === '/api/v1/export.csv') { res.writeHead(200, {'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="boss-records.csv"'}); return res.end(csv(store.records)); }
    return reply(res,404,{error:'not_found'});
  } catch(error) { return reply(res,400,{error:error.message}); }
});
server.listen(config.bridge.port, config.bridge.host, () => console.log(`BOSS bridge listening on http://${config.bridge.host}:${config.bridge.port}`));
