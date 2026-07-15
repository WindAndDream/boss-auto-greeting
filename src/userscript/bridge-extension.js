/* BOSS QQ Assistant bridge extension. Kept separate so upstream can be updated cleanly. */
(function () {
  'use strict';
  const SETTINGS_KEY = '__boss_qq_bridge_settings__';
  const SENT_KEY = '__boss_qq_bridge_sent__';
  const defaults = { url: 'http://127.0.0.1:17861', token: '', enabled: true };
  const settings = Object.assign({}, defaults, safeJson(localStorage.getItem(SETTINGS_KEY), {}));
  let sent = new Set(safeJson(localStorage.getItem(SENT_KEY), []));

  function safeJson(value, fallback) { try { return JSON.parse(value || '') || fallback; } catch { return fallback; } }
  function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  function remember(id) { sent.add(id); if (sent.size > 2000) sent = new Set([...sent].slice(-1500)); localStorage.setItem(SENT_KEY, JSON.stringify([...sent])); }
  function request(method, pathname, body) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method, url: `${settings.url.replace(/\/$/, '')}${pathname}`,
      headers: Object.assign({ Accept: 'application/json' }, settings.token ? { Authorization: `Bearer ${settings.token}` } : {}, body ? { 'Content-Type': 'application/json' } : {}),
      data: body ? JSON.stringify(body) : undefined,
      timeout: 8000,
      onload: response => { let data={}; try { data=JSON.parse(response.responseText || '{}'); } catch {} response.status >= 200 && response.status < 300 ? resolve(data) : reject(new Error(data.error || `HTTP ${response.status}`)); },
      onerror: () => reject(new Error('无法连接本地桥接服务')),
      ontimeout: () => reject(new Error('本地桥接服务响应超时')),
    }));
  }
  function getAllRecords() {
    return new Promise(resolve => {
      const open=indexedDB.open('ZhipinAutoGreetingDB', 1);
      open.onerror=()=>resolve([]);
      open.onsuccess=()=>{ const db=open.result; if(!db.objectStoreNames.contains('jobRecords')) return resolve([]); const req=db.transaction('jobRecords','readonly').objectStore('jobRecords').getAll(); req.onsuccess=()=>resolve(req.result||[]); req.onerror=()=>resolve([]); };
    });
  }
  function toEvent(record) { return { type: 'greeting.sent', status: '问候已发送', company: record.company || record.brandName || '', jobTitle: record.jobName || record.jobTitle || '', salary: record.salary || '', jobUrl: record.jobUrl || record.pageUrl || '', message: record.messagePreview || '' }; }
  async function syncRecords() {
    if (!settings.enabled || !settings.token) return;
    const records=(await getAllRecords()).filter(r=>r && r.status==='sent' && !sent.has(r.id)).sort((a,b)=>String(a.sentAt||'').localeCompare(String(b.sentAt||'')));
    for(const record of records){ try { await request('POST','/api/v1/events',toEvent(record)); remember(record.id); const status=await request('GET','/api/v1/status'); if(status.todayCount>=status.state.dailyLimit){ emergencyStop('已达到本日问候上限'); break; } } catch(error) { if(error.message==='daily_limit_reached') emergencyStop('已达到本日问候上限'); break; } }
  }
  async function syncControl() {
    if (!settings.enabled || !settings.token) return;
    try { const status=await request('GET','/api/v1/status'); if(!status.state.enabled) stopOnce('任务已由 QQ 或本地状态暂停'); else if(status.todayCount>=status.state.dailyLimit) stopOnce('已达到本日问候上限'); } catch {}
  }
  function stopOnce(reason) { if(sessionStorage.getItem('__boss_qq_last_stop__')===reason)return; sessionStorage.setItem('__boss_qq_last_stop__',reason); emergencyStop(reason); }
  function emergencyStop(reason) {
    const button=document.querySelector('#zhipin-auto-greeting-root [data-action="stop"], #zhipin-auto-greeting-root [data-action="emergencyStop"]');
    if(button && !button.disabled) button.click();
    request('POST','/api/v1/events',{type:'system.stopped',status:'已自动停止',reason,jobUrl:location.href}).catch(()=>{});
  }
  function safetyCheck() {
    const text=(document.body?.innerText||'').slice(0,12000);
    const reason=/验证码|安全验证|完成验证/.test(text)?'检测到验证码或安全验证':(/登录|扫码登录/.test(text)&&/请.*登录|登录后/.test(text)?'BOSS 登录状态可能已失效':'');
    if(reason && settings.enabled && sessionStorage.getItem('__boss_qq_last_stop__')!==reason){ sessionStorage.setItem('__boss_qq_last_stop__',reason); emergencyStop(reason); }
  }
  function mount() {
    const root=document.querySelector('#zhipin-auto-greeting-root .za-panel'); if(!root || document.getElementById('boss-qq-bridge-panel')) return;
    const section=document.createElement('section'); section.className='za-section'; section.id='boss-qq-bridge-panel';
    section.innerHTML=`<h3>QQ 通知桥接</h3><label>桥接地址<input data-bridge="url" value="${escapeHtml(settings.url)}"></label><label>桥接令牌<input data-bridge="token" type="password" placeholder="config/config.json 中的 token"></label><div class="za-inline"><button type="button" data-bridge-action="save">保存</button><button type="button" data-bridge-action="test">测试连接</button></div><small data-bridge-status>尚未连接</small>`;
    section.querySelector('[data-bridge="token"]').value=settings.token;
    section.addEventListener('click',async event=>{ const action=event.target?.dataset?.bridgeAction; if(!action)return; const status=section.querySelector('[data-bridge-status]'); settings.url=section.querySelector('[data-bridge="url"]').value.trim()||defaults.url; settings.token=section.querySelector('[data-bridge="token"]').value.trim(); saveSettings(); if(action==='save'){status.textContent='已保存';return;} status.textContent='连接中…'; try{const result=await request('GET','/api/v1/status');status.textContent=`连接正常，今日 ${result.todayCount}/${result.state.dailyLimit}`;}catch(error){status.textContent=`连接失败：${error.message}`;}});
    root.insertBefore(section,root.lastElementChild);
  }
  function escapeHtml(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  setInterval(()=>{mount();syncRecords();syncControl();safetyCheck();},5000);
})();
