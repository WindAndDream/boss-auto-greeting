/*
 * 平台弹窗处理的浏览器侧测试。
 * 由 run-dialog-tests.mjs 在本地 file:// 测试页中加载：
 *   1. 页面先设置 window.__ZHIPIN_AUTO_GREETING_TEST_HOOK__，主脚本据此暴露弹窗函数；
 *   2. 本文件构造与 BOSS 页面结构一致的弹窗 DOM，验证识别、按钮选择与点击行为。
 */
(function () {
  'use strict';

  const api = window.__zhipinAutoGreetingTestApi;
  const stage = document.getElementById('test-stage');
  const results = [];

  function assert(name, condition, detail) {
    results.push({
      name,
      ok: Boolean(condition),
      detail: detail == null ? '' : String(detail),
    });
  }

  function render(html) {
    stage.innerHTML = html;
    return stage.firstElementChild;
  }

  function clearStage() {
    stage.innerHTML = '';
  }

  // 给弹窗内所有 button 记录 click，方便断言脚本真正点了哪个按钮。
  function trackClicks(root, clicks) {
    root.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => clicks.push(api.getDialogButtonLabel(button)));
    });
  }

  try {
    assert('测试钩子已暴露', Boolean(api), api ? 'ok' : 'window.__zhipinAutoGreetingTestApi 缺失');

    if (!api) {
      throw new Error('测试钩子缺失，主脚本可能未成功执行');
    }

    // 1. 复刻 issue #10 的“已向BOSS发送消息”弹窗；必须点“留在本页”，不能进聊天页重发。
    let popup = render(`
      <div class="boss-popup__wrapper" role="dialog">
        <div class="boss-popup__title">已向BOSS发送消息</div>
        <div class="boss-popup__content">HR您好，我具备全栈与AI工程落地能力，拿过算法竞赛奖...</div>
        <div class="boss-popup__hint">如需修改打招呼内容，请在【消息通知-设置招呼语】页面修改</div>
        <div class="boss-popup__footer">
          <button type="button" class="btn btn-outline">留在本页</button>
          <button type="button" class="btn btn-primary">继续沟通</button>
        </div>
        <button type="button" class="boss-popup__close" aria-label="关闭">×</button>
      </div>
    `);
    let clicks = [];
    trackClicks(popup, clicks);

    const detected = api.findBossPlatformDialog();
    assert('识别“已向BOSS发送消息”弹窗', detected && detected.kind === 'greeting_sent', detected && detected.kind);
    assert(
      '主动作选择“留在本页”',
      detected && detected.actionButton && api.getDialogButtonLabel(detected.actionButton) === '留在本页',
      detected && detected.actionButton && api.getDialogButtonLabel(detected.actionButton),
    );

    api.resetDialogThrottle();
    const handled = api.inspectBossPlatformDialog({ dismissSoft: true });
    assert('处理时返回 greeting_sent', handled && handled.kind === 'greeting_sent', handled && handled.kind);
    assert('自动点击“留在本页”', clicks.includes('留在本页'), clicks.join(','));
    assert('绝不点击“继续沟通”', !clicks.includes('继续沟通'), clicks.join(','));

    // 2. 招呼语预览很长时，弹窗文本可能接近 500 字，仍应被识别。
    clearStage();
    const longPreview = '我具备全栈与AI工程落地能力，'.repeat(35);
    render(`
      <div class="boss-popup__wrapper" role="dialog">
        <div class="boss-popup__title">已向BOSS发送消息</div>
        <div class="boss-popup__content">${longPreview}</div>
        <div class="boss-popup__hint">如需修改打招呼内容，请在【消息通知-设置招呼语】页面修改</div>
        <button type="button">留在本页</button>
      </div>
    `);
    const longDialog = api.findBossPlatformDialog();
    assert('长招呼语预览仍能识别', longDialog && longDialog.kind === 'greeting_sent', longDialog && longDialog.kind);

    // 3. 没有“留在本页”时退回关闭按钮；即使“继续沟通”在 DOM 里，也绝不点它。
    clearStage();
    popup = render(`
      <div class="boss-popup__wrapper" role="dialog">
        <div class="boss-popup__title">已向BOSS发送消息</div>
        <div class="boss-popup__content">HR您好，我对这个岗位比较感兴趣...</div>
        <button type="button" class="btn btn-primary">继续沟通</button>
        <button type="button" class="boss-popup__close" aria-label="关闭">×</button>
      </div>
    `);
    clicks = [];
    trackClicks(popup, clicks);
    api.resetDialogThrottle();
    const closeFallback = api.inspectBossPlatformDialog({ dismissSoft: true });
    assert(
      '缺少留在按钮时退回关闭',
      closeFallback && closeFallback.kind === 'greeting_sent' && clicks.length === 1 && !clicks.includes('继续沟通'),
      clicks.join(','),
    );

    // 4. 同一条弹窗在 900ms 节流窗口内不应重复点击。
    clearStage();
    popup = render(`
      <div class="boss-popup__wrapper" role="dialog">
        <div class="boss-popup__title">已向BOSS发送消息</div>
        <div class="boss-popup__content">HR您好，我具备全栈与AI工程落地能力...</div>
        <button type="button">留在本页</button>
        <button type="button">继续沟通</button>
      </div>
    `);
    api.resetDialogThrottle();
    clicks = [];
    trackClicks(popup, clicks);
    api.inspectBossPlatformDialog({ dismissSoft: true });
    const clicksAfterFirst = clicks.length;
    api.inspectBossPlatformDialog({ dismissSoft: true });
    assert('节流窗口内不重复点击', clicksAfterFirst === 1 && clicks.length === 1, clicks.join(','));

    // 5. “留在此页”等同“留在本页”。
    clearStage();
    popup = render(`
      <div class="dialog-wrap">
        <p>已向BOSS发送消息，请选择留在此页</p>
        <button type="button">留在此页</button>
        <button type="button">继续沟通</button>
      </div>
    `);
    clicks = [];
    trackClicks(popup, clicks);
    api.resetDialogThrottle();
    api.inspectBossPlatformDialog({ dismissSoft: true });
    assert('兼容“留在此页”文案', clicks.includes('留在此页'), clicks.join(','));

    // 6. 原有沟通次数软提醒仍点击“确定”。
    clearStage();
    popup = render(`
      <div class="dialog-wrap">
        <p>温馨提示：您今天已与 12 位BOSS沟通，还剩 3 次沟通机会</p>
        <button type="button">取消</button>
        <button type="button">确定</button>
      </div>
    `);
    clicks = [];
    trackClicks(popup, clicks);
    api.resetDialogThrottle();
    const soft = api.inspectBossPlatformDialog({ dismissSoft: true });
    assert('识别次数软提醒', soft && soft.kind === 'soft_reminder', soft && soft.kind);
    assert('软提醒点击“确定”', clicks.includes('确定'), clicks.join(','));

    // 7. 硬限制只返回结果，交给调用方暂停，不应误点按钮。
    clearStage();
    popup = render(`
      <div class="dialog-wrap">
        <p>今日沟通次数已用完，无法继续沟通</p>
        <button type="button">确定</button>
      </div>
    `);
    clicks = [];
    trackClicks(popup, clicks);
    api.resetDialogThrottle();
    const hard = api.inspectBossPlatformDialog({ dismissSoft: true });
    assert('识别沟通次数硬限制', hard && hard.kind === 'hard_limit', hard && hard.kind);
    assert('硬限制不点击按钮', clicks.length === 0, clicks.join(','));

    // 8. 同屏同时出现硬限制和“已向BOSS发送消息”时，硬限制优先，不能继续沟通。
    clearStage();
    render(`
      <div class="dialog-wrap"><p>今日沟通次数已用完，无法继续沟通</p><button type="button">确定</button></div>
      <div class="boss-popup__wrapper">
        <p>已向BOSS发送消息，请留在本页</p>
        <button type="button">留在本页</button>
        <button type="button">继续沟通</button>
      </div>
    `);
    const combined = api.findBossPlatformDialog();
    assert('硬限制优先于招呼语弹窗', combined && combined.kind === 'hard_limit', combined && combined.kind);

    // 9. 普通页面内容不能被误判成平台弹窗。
    clearStage();
    render('<div class="job-detail">已向BOSS发送消息，请勿重复沟通</div>');
    api.resetDialogThrottle();
    assert('普通页面内容不误判', api.findBossPlatformDialog() === null, '应返回 null');
  } catch (error) {
    results.push({ name: '测试执行异常', ok: false, detail: error && error.stack || String(error) });
  }

  if (window.__dialogTestErrors && window.__dialogTestErrors.length) {
    results.push({ name: '页面脚本异常', ok: false, detail: window.__dialogTestErrors.join(' | ') });
  }

  const payload = btoa(encodeURIComponent(JSON.stringify(results)));
  document.title = `RESULT:${payload}`;
  const output = document.getElementById('test-output');
  if (output) output.textContent = JSON.stringify(results, null, 2);
})();
