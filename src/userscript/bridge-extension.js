/* BOSS QQ Assistant bridge extension. Kept separate so upstream can be updated cleanly. */
(function () {
  'use strict';
  const SETTINGS_KEY = '__boss_qq_bridge_settings__';
  const SENT_KEY = '__boss_qq_bridge_sent__';
  const REPLY_SEEN_KEY = '__boss_qq_reply_seen__';
  const defaults = { url: 'http://127.0.0.1:17861', token: '', enabled: true, stopTime: '18:00' };
  const settings = Object.assign({}, defaults, safeJson(localStorage.getItem(SETTINGS_KEY), {}));
  if (!settings.token && defaults.token) {
    settings.token = defaults.token;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }
  let sent = new Set(safeJson(localStorage.getItem(SENT_KEY), []));
  let replySeen = new Set(safeJson(localStorage.getItem(REPLY_SEEN_KEY), []));
  let replyMonitorReady = false;

  function safeJson(value, fallback) { try { return JSON.parse(value || '') || fallback; } catch { return fallback; } }
  function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  function remember(id) { sent.add(id); if (sent.size > 2000) sent = new Set([...sent].slice(-1500)); localStorage.setItem(SENT_KEY, JSON.stringify([...sent])); }
  function rememberReply(id) { replySeen.add(id); if (replySeen.size > 1200) replySeen = new Set([...replySeen].slice(-900)); localStorage.setItem(REPLY_SEEN_KEY, JSON.stringify([...replySeen])); }
  function normalizeReplyText(value) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240); }
  function fingerprint(value) { let hash=2166136261; for(const char of String(value)){hash^=char.codePointAt(0);hash=Math.imul(hash,16777619);} return (hash>>>0).toString(36); }
  function isValidStopTime(value) { return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')); }
  function isStopTimeReached(value) {
    if (!isValidStopTime(value)) return false;
    const now = new Date();
    const current = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return current >= value;
  }
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
    for(const record of records){ try { await request('POST','/api/v1/events',toEvent(record)); remember(record.id); } catch { break; } }
  }
  async function syncControl() {
    if (!settings.enabled || !settings.token) return;
    if (isStopTimeReached(settings.stopTime)) {
      stopOnce(`已到计划停止时间 ${settings.stopTime}`);
      return;
    }
    try {
      const status=await request('GET','/api/v1/status');
      if (isValidStopTime(status.state?.stopTime) && settings.stopTime !== status.state.stopTime) {
        settings.stopTime=status.state.stopTime;
        saveSettings();
        const input=document.querySelector('#boss-qq-bridge-panel [data-bridge="stopTime"]');
        if(input) input.value=settings.stopTime;
      }
      if(!status.state.enabled) stopOnce('任务已由 QQ 或本地状态暂停');
      else if(status.scheduledStopReached) stopOnce(`已到计划停止时间 ${status.state.stopTime}`);
    } catch {}
  }
  function currentConversationContext() {
    const selected=document.querySelector('.user-list-content li.selected, .user-list-content li.active, .user-list li.selected, .user-list li.active, .chat-user li.selected, .chat-user li.active, .friend-content.selected, .friend-content.active, .friend-content-warp.selected, .friend-content-warp.active');
    return normalizeReplyText(selected?.innerText || selected?.textContent || document.title).slice(0,120);
  }
  async function sendReplyAlert(id, message, context) {
    if(replySeen.has(id)) return;
    rememberReply(id);
    try {
      await request('POST','/api/v1/events',{type:'reply.received',status:'HR 有新回复',company:context,message,reason:`回复内容：${message}`,jobUrl:location.href});
    } catch {
      replySeen.delete(id);
      localStorage.setItem(REPLY_SEEN_KEY, JSON.stringify([...replySeen]));
    }
  }
  function scanHrReplies() {
    if(!settings.enabled || !settings.token) return;
    const context=currentConversationContext();
    const incoming=Array.from(document.querySelectorAll([
      '.chat-record .item-friend',
      '.chat-message-list .item-friend',
      '.chat-message .item-friend',
      '.chat-record .message-item.friend',
      '.chat-record .message-item.other',
      '.chat-record .message-item.received',
      '.chat-message-list .message-item.friend',
      '.chat-message-list .message-item.other',
      '.chat-message-list .message-item.received',
    ].join(',')));
    const activeReplies=incoming.map(node=>{
      const message=normalizeReplyText(node.innerText || node.textContent);
      const stable=node.getAttribute('data-id') || node.getAttribute('data-message-id') || node.id || message;
      return {id:`active:${fingerprint(`${context}|${stable}|${message}`)}`,message};
    }).filter(item=>item.message.length>0);
    if(!replyMonitorReady){activeReplies.forEach(item=>rememberReply(item.id));replyMonitorReady=true;}
    else activeReplies.filter(item=>!replySeen.has(item.id)).forEach(item=>sendReplyAlert(item.id,item.message,context));

    const conversations=Array.from(document.querySelectorAll('.user-list-content li, .user-list li, .chat-user li, .friend-content, .friend-content-warp'));
    conversations.filter(item=>item.matches('.unread, [class*="unread"]') || item.querySelector('.unread, [class*="unread"], .badge, [class*="badge"]') || /未读/.test(item.innerText || '')).forEach(item=>{
      const message=normalizeReplyText(item.innerText || item.textContent);
      if(!message) return;
      const id=`unread:${fingerprint(message)}`;
      if(!replySeen.has(id)) sendReplyAlert(id,message,message.slice(0,120));
    });
  }
  function stopOnce(reason) {
    const button=document.querySelector('#zhipin-auto-greeting-root [data-action="stop"], #zhipin-auto-greeting-root [data-action="emergencyStop"]');
    if(!button || button.disabled || sessionStorage.getItem('__boss_qq_last_stop__')===reason) return;
    sessionStorage.setItem('__boss_qq_last_stop__',reason);
    button.click();
    request('POST','/api/v1/events',{type:'system.stopped',status:'已自动停止',reason,jobUrl:location.href}).catch(()=>{});
  }
  function safetyCheck() {
    const text=(document.body?.innerText||'').slice(0,12000);
    const reason=/验证码|安全验证|完成验证/.test(text)?'检测到验证码或安全验证':(/登录|扫码登录/.test(text)&&/请\s*登录|登录后/.test(text)?'BOSS 登录状态可能已失效':'');
    if(reason) stopOnce(reason);
  }
  function applyStatus(section, result) {
    if (isValidStopTime(result.state?.stopTime)) {
      settings.stopTime=result.state.stopTime;
      saveSettings();
      section.querySelector('[data-bridge="stopTime"]').value=settings.stopTime;
    }
    section.querySelector('[data-bridge-status]').textContent=`连接正常；今日已投递 ${result.todayCount} 条，每 20 条通知；${result.state.enabled ? '运行许可开启' : '已暂停'}；${result.state.stopTime} 停止`;
  }
  function mount() {
    const root=document.querySelector('#zhipin-auto-greeting-root .za-panel'); if(!root || document.getElementById('boss-qq-bridge-panel')) return;
    const section=document.createElement('section'); section.className='za-section'; section.id='boss-qq-bridge-panel';
    section.innerHTML=`<h3>QQ 通知桥接</h3><label>桥接地址<input data-bridge="url" value="${escapeHtml(settings.url)}"></label><label>桥接令牌<input data-bridge="token" type="password" placeholder="自动读取本机配置"></label><label>每日停止时间<input data-bridge="stopTime" type="time" step="60" value="${escapeHtml(settings.stopTime)}"></label><p class="za-hint">沟通数量不设上限；每完成 20 条向 QQ 汇报一次；检测到 HR 新回复时立即特别提醒，没有回复时保持静默。</p><div class="za-inline"><button type="button" data-bridge-action="save">保存</button><button type="button" data-bridge-action="test">测试连接</button></div><small data-bridge-status>正在读取状态…</small>`;
    section.querySelector('[data-bridge="token"]').value=settings.token;
    section.addEventListener('click',async event=>{
      const action=event.target?.dataset?.bridgeAction; if(!action)return;
      const status=section.querySelector('[data-bridge-status]');
      settings.url=section.querySelector('[data-bridge="url"]').value.trim()||defaults.url;
      settings.token=section.querySelector('[data-bridge="token"]').value.trim();
      settings.stopTime=section.querySelector('[data-bridge="stopTime"]').value.trim();
      if(!isValidStopTime(settings.stopTime)){status.textContent='请选择有效的停止时间';return;}
      saveSettings(); status.textContent=action==='save'?'正在保存…':'连接中…';
      try { await request('POST','/api/v1/control',{stopTime:settings.stopTime}); const result=await request('GET','/api/v1/status'); applyStatus(section,result); }
      catch(error){status.textContent=`连接失败：${error.message}`;}
    });
    root.insertBefore(section,root.lastElementChild);
    if(settings.token) request('GET','/api/v1/status').then(result=>applyStatus(section,result)).catch(error=>{section.querySelector('[data-bridge-status]').textContent=`连接失败：${error.message}`;});
  }
  function escapeHtml(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  setInterval(()=>{mount();syncRecords();syncControl();scanHrReplies();safetyCheck();},5000);
})();
