// ==UserScript==
// @name         BOSS直聘自动沟通助手
// @namespace    local.codex.zhipin
// @version      0.1.5
// @description  在 BOSS 直聘搜索结果页自动选择岗位、发送常用语或自定义问候语，并记录岗位数据。
// @match        https://www.zhipin.com/web/geek/jobs*
// @match        https://www.zhipin.com/web/geek/chat*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// ==/UserScript==

/*
 * 项目说明：
 * - 这是运行在 Tampermonkey / 篡改猴中的 BOSS 直聘自动打招呼脚本。
 * - 面板只在岗位列表页 `/web/geek/jobs` 和聊天页 `/web/geek/chat` 显示。
 * - 主流程：岗位列表选择岗位 -> 点击沟通按钮 -> 进入聊天页 -> 发送常用语或自定义文本 -> 返回岗位列表继续。
 * - 支持随机时间间隔、聊天/列表等待上限、已沟通跳过、岗位沟通记录导出与清理。
 * - 岗位记录存储在浏览器 IndexedDB，运行状态存储在 localStorage，用于跨页面跳转后恢复自动化。
 *
 * 维护定位：
 * - RunState：跨页面状态机的持久化，记录 list/chat/returning 阶段。
 * - JobRepository：接口岗位、详情页数据、DOM 卡片的归一化和匹配。
 * - Database / ContactedIndex：IndexedDB 存储和已沟通快速索引。
 * - UI：右侧控制面板、表单同步、状态提示、已沟通虚拟列表。
 * - FastReplyService / GreetingService：常用语、自定义文本、自定义接口和发送校验。
 * - Automation：自动点击岗位、进入聊天页、发送消息、返回列表的主流程。
 * - Exporter / RecordCleaner：岗位记录导出和清理。
 * - 文件后半部分：BOSS 页面 DOM 选择器、HTML 详情解析、点击/输入模拟、通用工具函数。
 */
(function () {
  'use strict';

  // 全局常量：集中维护脚本版本、存储 key、BOSS 接口特征和默认问候语。
  const APP = {
    name: 'BOSS自动沟通',
    version: '0.1.5',
    dbName: 'ZhipinAutoGreetingDB',
    dbVersion: 1,
    configKey: '__zhipin_auto_greeting_config__',
    runKey: '__zhipin_auto_greeting_run_state__',
    debugEnabledKey: '__zhipin_auto_greeting_debug_enabled__',
    debugEventsKey: '__zhipin_auto_greeting_debug_events__',
    maxDebugEvents: 300,
    jobListApiPattern: /\/wapi\/zpgeek\/(?:search\/joblist|pc\/(?:recommend|search)\/job\/list)\.json/i,
    jobDetailApiPattern: /\/wapi\/zpgeek\/job\/detail\.json/i,
    fastReplyUrl: '/wapi/zpchat/fastReply/userFastReplyList/get',
    sheetJsUrl: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
    defaultGreetingText: '您好，我对这个岗位比较感兴趣，希望可以进一步沟通，谢谢。',
    storageQuotaWarnRatio: 0.9,
  };

  // unsafeWindow 是篡改猴注入到页面真实环境的 window；优先用它才能拦截页面自己的 fetch/XHR/history。
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  // 提前保存原始 fetch，后续主动补拉岗位详情时可绕过脚本自己的 fetch 包装。
  const nativePageFetch = typeof pageWindow.fetch === 'function'
    ? pageWindow.fetch.bind(pageWindow)
    : null;
  // BOSS 页面或防调试脚本可能改写 history，这里保留原型上的 back/go 作为返回列表的兜底能力。
  const nativeHistoryNavigation = captureNativeHistoryNavigation();
  const BOSS_ACTIVE_BUILTIN_OPTIONS = [
    '在线',
    '刚刚活跃',
    '今日活跃',
    '3日内活跃',
    '本周活跃',
    '2周内活跃',
    '5月内活跃',
    '半年前活跃',
  ];
  const BOSS_ACTIVE_BUILTIN_KEYS = new Set(BOSS_ACTIVE_BUILTIN_OPTIONS.map((item) => normalizeBossActiveText(item)));
  const FEATURE_BLOCK_DEFINITIONS = [
    { id: 'greeting', title: '打招呼配置', defaultEnabled: true, readonly: true },
    { id: 'strategy', title: '运行策略', defaultEnabled: true, readonly: true },
    { id: 'companyFilter', title: '公司筛选', defaultEnabled: true },
    { id: 'companyBlacklist', title: '公司黑名单', defaultEnabled: true },
    { id: 'bossActive', title: 'Boss活跃度筛选', defaultEnabled: true },
    { id: 'export', title: '数据导出', defaultEnabled: true },
    { id: 'cleanup', title: '数据清理', defaultEnabled: true },
    { id: 'debugLog', title: '调试日志', defaultEnabled: false },
    { id: 'greetedList', title: '已沟通列表', defaultEnabled: true },
  ];
  const FEATURE_BLOCK_ID_SET = new Set(FEATURE_BLOCK_DEFINITIONS.map((item) => item.id));

  // 用户可在侧栏面板中修改的配置；保存到 localStorage 后会在下次打开页面时恢复。
  const DEFAULT_CONFIG = {
    // 面板和问候语来源。
    panelOpen: true,
    featurePanelOpen: false,
    featureBlocks: createDefaultFeatureBlocks(),
    greetingMode: 'fastReply',
    fastReplyIndex: 0,
    fastReplies: [],
    textSource: 'text',
    customText: APP.defaultGreetingText,
    // 自定义接口配置：可从外部接口生成问候语，支持参数/请求头/请求体模板。
    customApiUrl: '',
    customApiMethod: 'GET',
    customApiParams: '',
    customApiHeaders: '',
    customApiBody: '',
    customApiResponsePath: '',
    // 自动化策略：跳过已沟通、采集记录、返回列表后是否允许刷新、等待和重试。
    skipContacted: true,
    collectGreetedJobs: true,
    ignoreListRefresh: false,
    delayMin: 4,
    delayMax: 8,
    waitTimeout: 5,
    chatOpenRetries: 2,
    // 公司过滤和数据维护选项。
    companyFilterMode: 'partial',
    companyFilterValue: '',
    companyBlacklistMode: 'partial',
    companyBlacklistValue: '',
    companyBlacklistRules: [],
    bossActiveFilterValues: [],
    bossActiveCustomOptions: [],
    exportType: 'json',
    clearBeforeTime: '',
  };
  const CONFIG_FIELD_KEYS = Object.keys(DEFAULT_CONFIG);
  const CONFIG_FIELD_KEY_SET = new Set(CONFIG_FIELD_KEYS);
  const STRUCTURED_CONFIG_FIELD_KEYS = new Set(['customApiParams', 'customApiHeaders']);

  // 页面级运行时缓存，只在当前页面生命周期内有效；跨页面恢复依赖 RunState(localStorage)。
  const runtime = {
    // 岗位数据池和索引：由接口/详情页/DOM 多路数据共同填充。
    jobPool: [],
    jobByKey: new Map(),
    jobBySignature: new Map(),
    jobByLooseSignature: new Map(),
    jobDetailByKey: new Map(),
    latestJobDetail: null,
    cardJobMap: new WeakMap(),
    seenApiBatches: new Set(),
    jobListContextKey: '',
    jobListLastBatchKey: '',
    jobListUpdatedAt: 0,
    jobListResponseSerial: 0,
    jobListFirstPageSerial: 0,
    latestJobListResponse: null,
    latestFirstPageJobListResponse: null,
    latestJobListRequest: null,
    initialPageUrl: location.href,
    latestRouteUrl: location.href,
    debugEvents: [],
    // 已沟通 Set 是 IndexedDB 的内存投影，用于列表循环中快速判重。
    contactedJobKeys: new Set(),
    contactedIndexReady: false,
    // 自动化运行锁和停止标记，避免重复启动多个并发循环。
    automationLoopActive: false,
    stopRequested: false,
    statusLock: null,
    companyFilterEdited: false,
    configFormTouched: false,
    // 外部库、UI 和数据库连接缓存。
    xlsx: null,
    ui: null,
    db: null,
  };

  let config = loadConfig();

  cleanupLegacyDebugState();
  runtime.debugEvents = isDebugEnabled() ? loadStoredDebugEvents() : [];
  installDebugHelpers();
  rememberRouteUrl(location.href);
  // document-start 先拦截岗位相关接口，避免页面很早请求岗位列表时脚本拿不到接口数据。
  installNetworkInterceptors();

  // 在允许的页面挂载面板，并在刷新/跳转后尝试恢复未完成的自动化流程。
  function bootWhenReady() {
    if (runtime.ui) {
      setUiDisplayEnabled(isAllowedDisplayPage());
      return;
    }
    if (!isAllowedDisplayPage()) return;

    const mount = () => {
      if (runtime.ui || !document.body || !isAllowedDisplayPage()) return;
      Database.open().catch((error) => console.warn('[ZhipinAuto] IndexedDB 初始化失败', error));
      UI.mount();
      setUiDisplayEnabled(true);
      Automation.resumeIfNeeded('boot');
    };

    if (document.body) {
      mount();
      return;
    }

    document.addEventListener('DOMContentLoaded', mount, { once: true });
  }

  // 从 localStorage 恢复侧栏配置；解析失败时回退默认值，避免坏配置阻断脚本启动。
  function loadConfig() {
    try {
      const stored = JSON.parse(localStorage.getItem(APP.configKey) || '{}');
      return repairLoadedConfig(normalizeConfig(stored));
    } catch (_) {
      return normalizeConfig(DEFAULT_CONFIG);
    }
  }

  // 保存表单配置。这里会和当前配置合并，因此新增字段不需要迁移旧配置。
  function saveConfig(nextConfig) {
    config = normalizeConfig(Object.assign({}, config, nextConfig || {}));
    localStorage.setItem(APP.configKey, JSON.stringify(config));
  }

  // 归一化新增数组配置，兼容旧版本 localStorage 和手动编辑过的异常值。
  function normalizeConfig(source) {
    const raw = source || {};
    const next = {};
    CONFIG_FIELD_KEYS.forEach((key) => {
      next[key] = raw[key] === undefined ? DEFAULT_CONFIG[key] : raw[key];
    });
    next.companyFilterMode = getCompanyMatchMode(next.companyFilterMode);
    next.companyBlacklistMode = getCompanyMatchMode(next.companyBlacklistMode);
    next.companyBlacklistValue = normalizeText(next.companyBlacklistValue);
    next.companyBlacklistRules = normalizeCompanyBlacklistRules(next.companyBlacklistRules);
    next.bossActiveCustomOptions = normalizeBossActiveOptions(next.bossActiveCustomOptions)
      .filter((item) => !BOSS_ACTIVE_BUILTIN_KEYS.has(normalizeBossActiveText(item)));

    const availableKeys = new Set(getBossActiveFilterOptions(next.bossActiveCustomOptions)
      .map((item) => normalizeBossActiveText(item)));
    next.bossActiveFilterValues = normalizeBossActiveOptions(next.bossActiveFilterValues)
      .filter((item) => availableKeys.has(normalizeBossActiveText(item)));
    next.featurePanelOpen = Boolean(next.featurePanelOpen);
    next.featureBlocks = normalizeFeatureBlocks(next.featureBlocks);

    return next;
  }

  // 板块管理显示状态集中归一；只读板块始终开启，避免核心流程被隐藏到无法启动。
  function normalizeFeatureBlocks(source) {
    const raw = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    return FEATURE_BLOCK_DEFINITIONS.reduce((output, item) => {
      const defaultEnabled = item.readonly ? true : item.defaultEnabled !== false;
      output[item.id] = item.readonly
        ? true
        : raw[item.id] === undefined
          ? defaultEnabled
          : Boolean(raw[item.id]);
      return output;
    }, {});
  }

  // 默认值需要返回新对象，避免后续合并配置时共享同一份引用。
  function createDefaultFeatureBlocks() {
    return FEATURE_BLOCK_DEFINITIONS.reduce((output, item) => {
      output[item.id] = item.defaultEnabled !== false;
      return output;
    }, {});
  }

  // 公司匹配模式统一归一，避免旧配置或手动编辑的异常值影响过滤。
  function getCompanyMatchMode(mode) {
    return /^(?:exact|partial|regex)$/.test(String(mode || '')) ? String(mode) : 'partial';
  }

  // 黑名单列表中展示给用户看的匹配模式标签。
  function getCompanyMatchModeLabel(mode) {
    if (mode === 'exact') return '全量';
    if (mode === 'regex') return '正则';
    return '部分';
  }

  // 公司黑名单规则支持数组对象，也兼容用户手动写入的换行/逗号文本。
  function normalizeCompanyBlacklistRules(values) {
    const list = Array.isArray(values)
      ? values
      : String(values || '').split(/[\n,，]+/).map((value) => ({ mode: 'partial', value }));
    const seen = new Set();
    const output = [];

    list.forEach((item) => {
      const isObjectItem = item && typeof item === 'object';
      const mode = getCompanyMatchMode(isObjectItem ? item.mode : 'partial');
      const value = normalizeText(isObjectItem ? item.value : item);
      if (!value) return;

      const key = `${mode}:${value}`;
      if (seen.has(key)) return;
      seen.add(key);
      output.push({
        id: normalizeText(isObjectItem && item.id) || `black_${hashString(key)}`,
        mode,
        value,
      });
    });

    return output;
  }

  // 加载旧配置时清掉明显由浏览器自动填充/历史恢复写入的残留值。
  function repairLoadedConfig(source) {
    const next = Object.assign({}, source || {});
    STRUCTURED_CONFIG_FIELD_KEYS.forEach((key) => {
      if (!next[key] || isParsableKeyValueConfig(next[key])) return;
      next[key] = '';
    });
    if (next.customApiResponsePath && !isLikelyResponsePath(next.customApiResponsePath)) {
      next.customApiResponsePath = '';
    }
    return next;
  }

  // Boss 活跃度选项用清洗后的文本作为持久化值，避免 DOM 残留符号影响匹配。
  function normalizeBossActiveOptions(values) {
    const list = Array.isArray(values)
      ? values
      : String(values || '').split(/[\n,，、]+/);
    const seen = new Set();
    const output = [];

    list.forEach((item) => {
      const text = getBossActiveOptionLabel(item);
      const key = normalizeBossActiveText(text);
      if (!key || seen.has(key)) return;
      seen.add(key);
      output.push(text);
    });

    return output;
  }

  // 合并内置和自定义 Boss 活跃度选项，供下拉多选渲染使用。
  function getBossActiveFilterOptions(customOptions) {
    return BOSS_ACTIVE_BUILTIN_OPTIONS.concat(normalizeBossActiveOptions(customOptions || []));
  }

  // 将用户输入或 DOM 文本归一到展示标签；内置项保持原有中文文案。
  function getBossActiveOptionLabel(value) {
    const key = normalizeBossActiveText(value);
    if (!key) return '';
    return BOSS_ACTIVE_BUILTIN_OPTIONS.find((item) => normalizeBossActiveText(item) === key) || key;
  }

  // 当前配置中已选 Boss 活跃度的匹配 key，用于过滤岗位。
  function getSelectedBossActiveKeys() {
    return normalizeBossActiveOptions(config.bossActiveFilterValues)
      .map((item) => normalizeBossActiveText(item))
      .filter(Boolean);
  }

  // 判断用户是否启用了 Boss 活跃度过滤。
  function hasBossActiveFilter() {
    return getSelectedBossActiveKeys().length > 0;
  }

  // Tampermonkey 的 @match 负责第一层路由限制；这里再处理单页应用 history 跳转后的显示/隐藏。
  function isAllowedDisplayPage(href) {
    try {
      const url = new URL(href || location.href, location.href);
      if (url.origin !== 'https://www.zhipin.com') return false;
      const pathname = url.pathname.replace(/\/+$/, '');
      if (pathname === '/web/geek/chat') return true;
      return pathname === '/web/geek/jobs';
    } catch (_) {
      return false;
    }
  }

  // BOSS 会在聊天页加载后清掉 URL 查询参数；document-start 和 history 阶段先保留原始路由。
  function rememberRouteUrl(href) {
    try {
      if (!href) return;
      const url = new URL(href, location.href);
      if (!isAllowedDisplayPage(url.href)) return;
      runtime.latestRouteUrl = url.href;
    } catch (_) {}
  }

  // 只控制脚本面板显隐，不销毁 UI；SPA 路由切回来时可复用已有节点和状态。
  function setUiDisplayEnabled(enabled) {
    if (!runtime.ui || !runtime.ui.root) return;
    runtime.ui.root.style.display = enabled ? '' : 'none';
  }

  // 路由变化后的统一入口：允许页面挂载/恢复，不允许页面隐藏面板。
  function syncAllowedPageUi() {
    const allowed = isAllowedDisplayPage();
    setUiDisplayEnabled(allowed);
    if (allowed) bootWhenReady();
    return allowed;
  }

  // BOSS 页面是 SPA，岗位列表和聊天页切换时不一定重新加载脚本，所以要监听 history 路由变化。
  function installAllowedPageRouteWatcher() {
    const history = pageWindow.history;
    if (history && !history.__zhipinAutoGreetingRouteWatcherPatched) {
      ['pushState', 'replaceState'].forEach((method) => {
        const raw = history[method];
        if (typeof raw !== 'function') return;

        const wrapped = function routeAwareHistoryMethod() {
          rememberRouteUrl(arguments[2]);
          const result = raw.apply(this, arguments);
          setTimeout(syncAllowedPageUi, 0);
          return result;
        };

        maskNative(wrapped, raw);
        history[method] = wrapped;
      });

      try {
        Object.defineProperty(history, '__zhipinAutoGreetingRouteWatcherPatched', {
          configurable: true,
          value: true,
        });
      } catch (_) {
        history.__zhipinAutoGreetingRouteWatcherPatched = true;
      }
    }

    pageWindow.addEventListener('popstate', () => setTimeout(syncAllowedPageUi, 0));
    pageWindow.addEventListener('hashchange', () => setTimeout(syncAllowedPageUi, 0));
  }

  // 当前搜索词会作为公司过滤输入框的默认值，但用户手动编辑后不再自动覆盖。
  function getCurrentSearchQuery() {
    try {
      return normalizeText(new URL(location.href).searchParams.get('query'));
    } catch (_) {
      return '';
    }
  }

  // 运行中锁定大部分配置，导出格式/清理时间不参与自动化流程，允许继续修改。
  function isRuntimeLockExemptField(fieldName) {
    return /^(?:exportType|clearBeforeTime)$/.test(String(fieldName || ''));
  }

  // 清理早期版本遗留的 debug key，避免旧数据影响当前诊断状态。
  function cleanupLegacyDebugState() {
    localStorage.removeItem('__zhipin_auto_greeting_debug__');
  }

  // 调试事件需要跨 SPA 跳转和聊天页跳转保留，否则第一条新日志会覆盖上一页的诊断上下文。
  function loadStoredDebugEvents() {
    try {
      const events = JSON.parse(localStorage.getItem(APP.debugEventsKey) || '[]');
      return Array.isArray(events) ? events.slice(-APP.maxDebugEvents) : [];
    } catch (_) {
      return [];
    }
  }

  // 默认关闭结构化诊断日志；排查偶发问题时可通过 helper 或 localStorage 开启。
  function isDebugEnabled() {
    try {
      return localStorage.getItem(APP.debugEnabledKey) === '1' ||
        pageWindow.__ZHIPIN_AUTO_GREETING_DEBUG__ === true;
    } catch (_) {
      return false;
    }
  }

  // 暴露调试工具，排查时可在 DevTools 控制台开启、导出或清理结构化日志。
  function installDebugHelpers() {
    try {
      pageWindow.__zhipinAutoGreetingDebug = {
        version: APP.version,
        enabledKey: APP.debugEnabledKey,
        key: APP.debugEventsKey,
        enabled() {
          return isDebugEnabled();
        },
        enable() {
          localStorage.setItem(APP.debugEnabledKey, '1');
          runtime.debugEvents = loadStoredDebugEvents();
          if (runtime.ui) UI.renderDebugLogControls();
          return true;
        },
        disable() {
          localStorage.removeItem(APP.debugEnabledKey);
          if (runtime.ui) UI.renderDebugLogControls();
          return true;
        },
        dump() {
          return loadStoredDebugEvents();
        },
        text() {
          return JSON.stringify(loadStoredDebugEvents(), null, 2);
        },
        clear() {
          runtime.debugEvents = [];
          localStorage.removeItem(APP.debugEventsKey);
          if (runtime.ui) UI.renderDebugLogControls();
          return true;
        },
        copy() {
          const text = JSON.stringify(loadStoredDebugEvents(), null, 2);
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            return navigator.clipboard.writeText(text).then(() => text.length);
          }
          console.log(text);
          return text.length;
        },
      };
    } catch (_) {}
  }

  // 跨页面自动化状态：记录当前阶段、岗位游标、待发送岗位、返回列表地址和下一次运行时间。
  const RunState = {
    // 从 localStorage 读取运行状态，异常 JSON 直接视为空状态。
    load() {
      try {
        return JSON.parse(localStorage.getItem(APP.runKey) || 'null');
      } catch (_) {
        return null;
      }
    },
    // 持久化完整/局部运行状态，并自动合并最近更新时间。
    save(nextState) {
      const previous = this.load() || {};
      const merged = Object.assign({}, previous, nextState, { updatedAt: Date.now() });
      localStorage.setItem(APP.runKey, JSON.stringify(merged));
      return merged;
    },
    // 语义化别名：在流程中只更新少量字段时调用。
    patch(nextState) {
      return this.save(nextState);
    },
    // 停止自动化并保留停止原因，便于刷新后不再恢复。
    stop(reason) {
      const state = this.save({
        active: false,
        phase: 'stopped',
        pendingJob: null,
        pendingRawJob: null,
        nextRunAt: null,
        nextDelaySeconds: null,
        stopReason: reason || '已停止',
      });
      return state;
    },
    // 暂停自动化但保留现场，给用户确认后可以重新启动。
    pause(reason) {
      const state = this.save({
        active: false,
        phase: 'paused',
        nextRunAt: null,
        nextDelaySeconds: null,
        pauseReason: reason || '已暂停',
      });
      return state;
    },
    // 清掉跨页面状态，通常用于用户手动结束或重新开始前。
    clear() {
      localStorage.removeItem(APP.runKey);
    },
  };

  // 统一写调试事件；默认关闭，开启后才写内存/localStorage/控制台。
  function logDebugEvent(type, data, level) {
    try {
      if (!isDebugEnabled()) return;

      const event = {
        time: nowIso(),
        type,
        href: location.href,
        data: safeDebugValue(data, 0),
      };

      runtime.debugEvents.push(event);
      runtime.debugEvents = runtime.debugEvents.slice(-APP.maxDebugEvents);
      localStorage.setItem(APP.debugEventsKey, JSON.stringify(runtime.debugEvents));
      if (runtime.ui) UI.renderDebugLogControls();

      const method = level || (/error|timeout|unknown|missing|failed/i.test(type) ? 'warn' : 'info');
      const logger = console[method] || console.log;
      logger.call(console, `[ZhipinAuto][${type}]`, event);
    } catch (_) {}
  }

  // 调试日志会存入 localStorage，因此对大对象、HTML 文本和循环嵌套做裁剪。
  function safeDebugValue(value, depth) {
    const currentDepth = Number(depth || 0);
    if (value == null) return value;
    if (typeof value === 'string') return value.length > 800 ? `${value.slice(0, 800)}...` : value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (currentDepth >= 4) return '[depth-limit]';
    if (Array.isArray(value)) return value.slice(0, 12).map((item) => safeDebugValue(item, currentDepth + 1));
    if (typeof value !== 'object') return String(value);

    const output = {};
    Object.keys(value).slice(0, 50).forEach((key) => {
      if (/^(rawHtmlDetail|rawCompanyDetail|postDescription|companyIntroduce|businessScope)$/i.test(key)) {
        output[key] = summarizeLongText(value[key]);
        return;
      }
      if (/^(rawJob|rawDetail)$/i.test(key)) {
        output[key] = summarizeRawJob(value[key]);
        return;
      }
      output[key] = safeDebugValue(value[key], currentDepth + 1);
    });
    return output;
  }

  // 从原始接口岗位中抽取少量字段用于日志，避免把完整响应塞进 debug 事件。
  function summarizeRawJob(rawJob) {
    if (!rawJob || typeof rawJob !== 'object') return rawJob || null;
    return {
      jobName: pickFirstString(rawJob, ['jobName', 'jobTitle', 'positionName', 'name', 'title']),
      brandName: pickFirstString(rawJob, ['brandName', 'companyName', 'encryptBrandName', 'company']),
      salaryDesc: pickReadableSalary(rawJob, ['salaryDesc', 'salary', 'salaryName']),
      bossName: pickFirstString(rawJob, ['bossName', 'bossNickName', 'boss']),
      bossTitle: pickFirstString(rawJob, ['bossTitle', 'postDescription']),
      encryptJobId: pickFirstString(rawJob, ['encryptJobId', 'encryptId', 'jobId', 'job_id']),
      securityId: pickFirstString(rawJob, ['securityId']),
      lid: pickFirstString(rawJob, ['lid']),
      cityName: pickFirstString(rawJob, ['cityName', 'city']),
    };
  }

  // 将内部岗位对象裁剪成可读摘要，主要用于定位岗位匹配和详情合并问题。
  function summarizeJobForDebug(job) {
    if (!job) return null;
    return {
      jobKey: job.jobKey,
      id: job.id,
      jobName: job.jobName,
      company: job.company,
      salary: job.salary,
      bossName: job.bossName,
      bossTitle: job.bossTitle,
      bossActiveTimeDesc: getDisplayBossActiveTime(job),
      bossOnline: Boolean(job.bossOnline),
      encryptJobId: job.encryptJobId,
      securityId: job.securityId,
      lid: job.lid,
      source: job.source,
      sourceUrl: job.sourceUrl,
      detailSource: job.detailSource,
      detailSourceUrl: job.detailSourceUrl,
      domOnly: Boolean(job.domOnly),
      rawJob: summarizeRawJob(job.rawJob),
    };
  }

  // 说明等待详情阶段是否需要主动补拉接口，避免只有 true/false 看不出原因。
  function getJobDetailFetchDecision(job, detail, options) {
    const detailSalary = getReadableSalary(detail && detail.salary);
    const jobSalary = getDisplaySalary(job);
    const forceApiFetch = Boolean(options && options.forceApiFetch);

    if (!detail) {
      return {
        shouldFetch: true,
        reason: 'missing_detail',
        forceApiFetch,
        hasRawDetail: false,
        detailSalary,
        jobSalary,
      };
    }

    if (!forceApiFetch) {
      return {
        shouldFetch: false,
        reason: 'force_api_fetch_disabled',
        forceApiFetch,
        hasRawDetail: Boolean(detail.rawDetail),
        detailSalary,
        jobSalary,
      };
    }

    if (!detail.rawDetail) {
      return {
        shouldFetch: true,
        reason: 'missing_raw_detail',
        forceApiFetch,
        hasRawDetail: false,
        detailSalary,
        jobSalary,
      };
    }

    if (!detailSalary && !jobSalary) {
      return {
        shouldFetch: true,
        reason: 'missing_salary',
        forceApiFetch,
        hasRawDetail: true,
        detailSalary,
        jobSalary,
      };
    }

    return {
      shouldFetch: false,
      reason: 'detail_sufficient',
      forceApiFetch,
      hasRawDetail: true,
      detailSalary,
      jobSalary,
    };
  }

  // DOM 卡片摘要：用于排查“接口岗位”和“页面卡片”是否匹配错位。
  function summarizeDomInfoForDebug(domInfo) {
    if (!domInfo) return null;
    return {
      jobName: domInfo.jobName,
      company: domInfo.company,
      salary: domInfo.salary,
      city: domInfo.city,
      keys: domInfo.keys,
      signature: domInfo.signature,
      looseSignature: domInfo.looseSignature,
      text: summarizeLongText(domInfo.text),
    };
  }

  // 长文本字段只保留前 300 字，防止岗位描述/公司介绍撑爆 debug 事件。
  function summarizeLongText(value) {
    const text = normalizeTextPreserveLines(value);
    if (!text) return '';
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
  }

  // 聚合列表侧的核心状态，所有列表匹配异常日志都会带上这份快照。
  function getDebugListState() {
    return {
      poolSize: runtime.jobPool.length,
      contextKey: runtime.jobListContextKey,
      lastBatchKey: runtime.jobListLastBatchKey,
      responseSerial: runtime.jobListResponseSerial,
      firstPageSerial: runtime.jobListFirstPageSerial,
      latestJobListResponse: runtime.latestJobListResponse,
      latestFirstPageJobListResponse: runtime.latestFirstPageJobListResponse,
      latestJobListRequest: summarizeJobListRequest(runtime.latestJobListRequest),
      visibleCardCount: getJobCards().length,
    };
  }

  // 捕获岗位列表/详情接口响应，用接口数据补强 DOM 卡片信息，提升岗位匹配和记录质量。
  function installNetworkInterceptors() {
    const rawFetch = pageWindow.fetch;

    if (typeof rawFetch === 'function' && !rawFetch.__zhipinAutoGreetingPatched) {
      const wrappedFetch = function fetch(input, init) {
        const url = normalizeRequestUrl(input);
        const requestMeta = createFetchRequestMeta(input, init, url);
        rememberTrackedJobRequest(url, requestMeta);
        const result = rawFetch.apply(this, arguments);

        if (isTrackedJobApi(url)) {
          Promise.resolve(result)
            .then((response) => {
              try {
                response.clone().text().then((text) => ingestTrackedJobResponse(url, text, 'fetch', requestMeta));
              } catch (error) {
                console.warn('[ZhipinAuto] fetch 岗位响应读取失败', error);
              }
            })
            .catch(() => {});
        }

        return result;
      };

      maskNative(wrappedFetch, rawFetch);
      wrappedFetch.__zhipinAutoGreetingPatched = true;
      pageWindow.fetch = wrappedFetch;
    }

    const XHR = pageWindow.XMLHttpRequest;
    if (XHR && XHR.prototype && !XHR.prototype.__zhipinAutoGreetingPatched) {
      const rawOpen = XHR.prototype.open;
      const rawSend = XHR.prototype.send;
      const rawSetRequestHeader = XHR.prototype.setRequestHeader;

      XHR.prototype.open = function open(method, url) {
        this.__zhipinAutoGreetingUrl = normalizeRequestUrl(url);
        this.__zhipinAutoGreetingMethod = normalizeText(method || 'GET').toUpperCase() || 'GET';
        this.__zhipinAutoGreetingHeaders = {};
        return rawOpen.apply(this, arguments);
      };
      maskNative(XHR.prototype.open, rawOpen);

      if (typeof rawSetRequestHeader === 'function') {
        XHR.prototype.setRequestHeader = function setRequestHeader(name, value) {
          try {
            const key = normalizeText(name);
            if (key) {
              this.__zhipinAutoGreetingHeaders = this.__zhipinAutoGreetingHeaders || {};
              this.__zhipinAutoGreetingHeaders[key] = normalizeText(value);
            }
          } catch (_) {}
          return rawSetRequestHeader.apply(this, arguments);
        };
        maskNative(XHR.prototype.setRequestHeader, rawSetRequestHeader);
      }

      XHR.prototype.send = function send() {
        const url = this.__zhipinAutoGreetingUrl || '';
        const requestMeta = createXhrRequestMeta(this, arguments[0], url);
        rememberTrackedJobRequest(url, requestMeta);

        if (isTrackedJobApi(url)) {
          this.addEventListener('loadend', () => {
            try {
              let text = '';
              if (!this.responseType || this.responseType === 'text') {
                text = this.responseText || '';
              } else if (this.responseType === 'json') {
                text = JSON.stringify(this.response || {});
              }
              ingestTrackedJobResponse(url, text, 'xhr', requestMeta);
            } catch (error) {
              console.warn('[ZhipinAuto] XHR 岗位响应读取失败', error);
            }
          });
        }

        return rawSend.apply(this, arguments);
      };
      maskNative(XHR.prototype.send, rawSend);
      XHR.prototype.__zhipinAutoGreetingPatched = true;
    }
  }

  // 把 fetch/XMLHttpRequest 输入统一成绝对 URL，后面用正则判断是否是岗位接口。
  function normalizeRequestUrl(input) {
    try {
      if (!input) return '';
      if (typeof input === 'string') return new URL(input, location.href).href;
      if (input.url) return new URL(input.url, location.href).href;
      return String(input);
    } catch (_) {
      return String(input || '');
    }
  }

  function createFetchRequestMeta(input, init, url) {
    const request = input && typeof input === 'object' ? input : {};
    const requestInit = init || {};
    return {
      url,
      method: normalizeText(requestInit.method || request.method || 'GET').toUpperCase() || 'GET',
      headers: mergeHeadersToObject(request.headers, requestInit.headers),
      body: requestInit.body,
      source: 'fetch',
    };
  }

  function createXhrRequestMeta(xhr, body, url) {
    return {
      url,
      method: normalizeText(xhr && xhr.__zhipinAutoGreetingMethod || 'GET').toUpperCase() || 'GET',
      headers: Object.assign({}, xhr && xhr.__zhipinAutoGreetingHeaders || {}),
      body,
      source: 'xhr',
    };
  }

  function rememberTrackedJobRequest(url, requestMeta) {
    if (!APP.jobListApiPattern.test(url) || !requestMeta) return;
    runtime.latestJobListRequest = requestMeta;
  }

  function mergeHeadersToObject() {
    const output = {};
    Array.from(arguments).forEach((headers) => {
      headersToObject(headers).forEach(([key, value]) => {
        if (key) output[key] = value;
      });
    });
    return output;
  }

  function headersToObject(headers) {
    if (!headers) return [];
    try {
      if (typeof headers.forEach === 'function') {
        const rows = [];
        headers.forEach((value, key) => rows.push([normalizeText(key), normalizeText(value)]));
        return rows;
      }
      if (Array.isArray(headers)) {
        return headers.map((row) => [normalizeText(row && row[0]), normalizeText(row && row[1])]);
      }
      if (typeof headers === 'object') {
        return Object.keys(headers).map((key) => [normalizeText(key), normalizeText(headers[key])]);
      }
    } catch (_) {}
    return [];
  }

  function summarizeJobListRequest(requestMeta) {
    if (!requestMeta) return null;
    return {
      url: requestMeta.url,
      method: requestMeta.method || 'GET',
      hasBody: requestMeta.body !== undefined && requestMeta.body !== null,
      bodyType: getBodyType(requestMeta.body),
      replayable: isReplayableJobListRequest(requestMeta),
      source: requestMeta.source,
    };
  }

  function getBodyType(body) {
    if (body === undefined || body === null) return '';
    try {
      const rawType = Object.prototype.toString.call(body).match(/\[object ([^\]]+)\]/);
      return rawType && rawType[1] || typeof body;
    } catch (_) {
      return typeof body;
    }
  }

  function getLatestReplayableJobListRequest() {
    if (isReplayableJobListRequest(runtime.latestJobListRequest)) return runtime.latestJobListRequest;

    const latestUrl = findLatestJobListApiUrl();
    const fallback = latestUrl ? {
      url: latestUrl,
      method: 'GET',
      headers: {},
      body: undefined,
      source: 'performance',
    } : null;
    return isReplayableJobListRequest(fallback) ? fallback : null;
  }

  function isReplayableJobListRequest(requestMeta) {
    if (!requestMeta || !requestMeta.url) return false;

    const method = normalizeText(requestMeta.method || 'GET').toUpperCase();
    if (method && method !== 'GET' && method !== 'HEAD') {
      return requestMeta.body !== undefined && requestMeta.body !== null || hasMeaningfulJobListUrlParams(requestMeta.url);
    }

    return hasMeaningfulJobListUrlParams(requestMeta.url);
  }

  function hasMeaningfulJobListUrlParams(url) {
    try {
      const target = new URL(url, location.href);
      let meaningful = false;
      target.searchParams.forEach((value, key) => {
        if (!isVolatileJobListParam(key) && normalizeText(value)) meaningful = true;
      });
      return meaningful;
    } catch (_) {
      return false;
    }
  }

  function buildJobListFetchInit(requestMeta) {
    const method = normalizeText(requestMeta && requestMeta.method || 'GET').toUpperCase() || 'GET';
    const headers = Object.assign({ Accept: 'application/json, text/plain, */*' }, requestMeta && requestMeta.headers || {});
    const init = {
      method,
      credentials: 'include',
      headers,
    };

    if (method !== 'GET' && method !== 'HEAD' && requestMeta && requestMeta.body !== undefined && requestMeta.body !== null) {
      init.body = requestMeta.body;
    }
    return init;
  }

  // 保持包装函数的 toString 接近原始实现，降低页面检测 monkey patch 的概率。
  function maskNative(wrapper, original) {
    try {
      Object.defineProperty(wrapper, 'toString', {
        configurable: true,
        value() {
          return Function.prototype.toString.call(original);
        },
      });
    } catch (_) {}
  }

  // 保存 History 原型方法，返回列表时优先调用原生实现，减少被页面覆写影响。
  function captureNativeHistoryNavigation() {
    const history = pageWindow.history;
    const prototype = pageWindow.History && pageWindow.History.prototype;
    const nativeBack = prototype && prototype.back;
    const nativeGo = prototype && prototype.go;

    return {
      back() {
        if (typeof nativeBack === 'function') {
          nativeBack.call(history);
          return;
        }
        if (history && typeof history.back === 'function') history.back();
      },
      go(delta) {
        if (typeof nativeGo === 'function') {
          nativeGo.call(history, delta);
          return;
        }
        if (history && typeof history.go === 'function') history.go(delta);
      },
    };
  }

  // 本脚本只关心岗位列表和岗位详情接口，其它请求不解析也不触碰。
  function isTrackedJobApi(url) {
    return APP.jobListApiPattern.test(url) || APP.jobDetailApiPattern.test(url);
  }

  // 网络拦截入口：根据 URL 分发到列表或详情解析流程。
  function ingestTrackedJobResponse(url, text, source, requestMeta) {
    if (APP.jobListApiPattern.test(url)) {
      ingestJobListResponse(url, text, source, requestMeta);
      return;
    }

    if (APP.jobDetailApiPattern.test(url)) {
      ingestJobDetailResponse(url, text, source);
    }
  }

  // 对同一批岗位生成批次指纹，避免同一响应被 fetch/XHR 或缓存重复处理。
  function makeJobListBatchKey(jobs) {
    const key = (jobs || [])
      .slice(0, 8)
      .map((job) => pickFirstString(job, ['encryptJobId', 'jobId', 'securityId', 'lid', 'jobName', 'brandName']))
      .filter(Boolean)
      .join('|');

    if (key) return key;
    return `count:${(jobs || []).length}:${hashString(JSON.stringify(jobs || []).slice(0, 1200))}`;
  }

  // 去掉页码、时间戳、随机数等波动参数，得到“这次搜索条件”的稳定上下文 key。
  function makeJobListContextKey(url) {
    try {
      const target = new URL(url, location.href);
      const params = [];
      target.searchParams.forEach((value, key) => {
        if (isVolatileJobListParam(key)) return;
        params.push([key, normalizeText(value)]);
      });
      params.sort((left, right) => {
        const keyCompared = left[0].localeCompare(right[0]);
        return keyCompared || left[1].localeCompare(right[1]);
      });
      const search = params
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
      return `${target.origin}${target.pathname}?${search}`;
    } catch (_) {
      return `unknown:${normalizeText(url).split(/[?#]/)[0]}`;
    }
  }

  // BOSS 不同接口可能用 page/offset 等不同分页字段，这里统一解析为页码。
  function getJobListPageNumber(url) {
    try {
      const target = new URL(url, location.href);
      const pageKeys = ['page', 'pageNo', 'pageNum', 'pageIndex', 'current', 'currentPage'];
      for (const key of pageKeys) {
        const page = Number(target.searchParams.get(key));
        if (Number.isFinite(page) && page > 0) return page;
      }

      const offset = Number(target.searchParams.get('offset') || target.searchParams.get('start') || target.searchParams.get('startIndex'));
      const limit = Number(target.searchParams.get('limit') || target.searchParams.get('pageSize'));
      if (Number.isFinite(offset) && offset > 0 && Number.isFinite(limit) && limit > 0) {
        return Math.floor(offset / limit) + 1;
      }
    } catch (_) {}

    return 1;
  }

  // 这些参数会随请求变化，不应参与搜索上下文判断。
  function isVolatileJobListParam(name) {
    return /^(?:_|t|ts|time|timestamp|callback|cb|r|random|ka|lid|securityId|sessionId|sid|traceId|page|pageNo|pageNum|pageIndex|current|currentPage|pageSize|limit|offset|start|startIndex)$/i.test(String(name || ''));
  }

  // 处理岗位列表响应：解析岗位数组、重置/追加当前列表数据池、并尝试重绑 DOM 卡片。
  function ingestJobListResponse(url, text, source, requestMeta) {
    if (!text) return;

    try {
      const payload = JSON.parse(text);
      const jobs = JobRepository.extractJobList(payload);
      if (!jobs.length) return;

      const contextKey = makeJobListContextKey(url);
      const pageNumber = getJobListPageNumber(url);
      const batchKey = makeJobListBatchKey(jobs);
      const scopedBatchKey = `${contextKey}::${batchKey}`;
      const shouldReplaceScope = JobRepository.shouldReplaceJobListScope(contextKey, pageNumber);

      JobRepository.noteJobListResponse({
        url,
        source,
        contextKey,
        pageNumber,
        batchKey,
        jobCount: jobs.length,
      });
      logDebugEvent('job_list_response', {
        url,
        source,
        pageNumber,
        contextKey,
        batchKey,
        scopedBatchKey,
        shouldReplaceScope,
        jobCount: jobs.length,
        firstJobs: jobs.slice(0, 5).map(summarizeRawJob),
        request: summarizeJobListRequest(requestMeta),
        listState: getDebugListState(),
      });

      if (runtime.seenApiBatches.has(scopedBatchKey) && !shouldReplaceScope) return;

      if (shouldReplaceScope) {
        JobRepository.resetJobListScope(contextKey);
      } else if (!runtime.jobListContextKey) {
        runtime.jobListContextKey = contextKey;
      }

      runtime.seenApiBatches.add(scopedBatchKey);
      runtime.jobListLastBatchKey = batchKey;
      runtime.jobListUpdatedAt = Date.now();

      jobs.forEach((rawJob, index) => {
        const job = JobRepository.normalizeJob(rawJob, runtime.jobPool.length + index, {
          source,
          sourceUrl: url,
        });

        JobRepository.rememberListJob(job);
      });

      // 接口通常比 DOM 后到；捕获到接口数据后立即重绑卡片，优先使用接口里的明文薪资。
      if (document.querySelector('li.job-card-box')) {
        JobRepository.syncCards();
      }

      UI.setStatus(`已捕获当前列表 ${runtime.jobPool.length} 条岗位接口数据`, 'ok');
    } catch (error) {
      console.warn('[ZhipinAuto] 岗位接口解析失败', error);
    }
  }

  // 处理岗位详情响应：保存最新详情并合并到列表池；HTML/工商信息由当前岗位按需补抓。
  function ingestJobDetailResponse(url, text, source) {
    if (!text) return;

    try {
      const payload = JSON.parse(text);
      const detail = JobRepository.normalizeJobDetail(payload, {
        source,
        sourceUrl: url,
      });
      if (!detail) {
        logDebugEvent('job_detail_response_empty', {
          source,
          url,
          code: payload && payload.code,
          message: normalizeText(payload && payload.message),
          payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12) : [],
        }, 'warn');
        return;
      }

      JobRepository.rememberJobDetail(detail);
      const matched = JobRepository.applyDetailToPool(detail);
      logDebugEvent('job_detail_response_ingested', {
        source,
        url,
        detail: summarizeJobForDebug(detail),
        matched: summarizeJobForDebug(matched),
        listState: getDebugListState(),
      });
      if (matched && document.querySelector('li.job-card-box')) {
        JobRepository.syncCards();
      }

      if (detail.salary) {
        UI.setStatus(`已捕获岗位详情：${detail.jobName || '未知岗位'} / ${detail.salary}`, 'ok');
      }

      // HTML/工商信息只在当前岗位需要保存或发送前按需补抓。
      // 连续按活跃度跳过时如果为每个详情响应都并发补抓，会把后续真正沟通岗位的补全请求排队到超时。
    } catch (error) {
      console.warn('[ZhipinAuto] 岗位详情接口解析失败', error);
    }
  }

  // 后到的详情数据会反向补全已保存记录，避免早期 clicked/sent 记录字段不完整。
  function syncSavedRecordsWithJob(job, source) {
    if (!job) return;
    Database.enrichSavedRecords(job).then((updated) => {
      if (!updated) return;
      logDebugEvent('saved_records_enriched', {
        source,
        updated,
        job: summarizeJobForDebug(job),
      });
      if (runtime.ui) UI.refreshGreetedList();
    }).catch((error) => {
      logDebugEvent('saved_records_enrich_failed', {
        source,
        message: error && error.message || String(error),
        job: summarizeJobForDebug(job),
      }, 'warn');
    });
  }

  // 岗位仓库：负责从接口响应中提取岗位，并把左侧 DOM 卡片绑定到对应接口数据。
  // BOSS 列表卡片上的字段不完整，接口/详情页数据会在这里归一化后合并到同一份岗位对象。
  const JobRepository = {
    // 记录每一次岗位列表响应，用于判断列表是否刷新、是否回到第一页。
    noteJobListResponse(info) {
      const record = Object.assign({}, info || {}, {
        serial: runtime.jobListResponseSerial + 1,
        capturedAt: Date.now(),
      });

      runtime.jobListResponseSerial = record.serial;
      runtime.latestJobListResponse = record;

      if (Number(record.pageNumber || 1) <= 1) {
        runtime.jobListFirstPageSerial += 1;
        runtime.latestFirstPageJobListResponse = Object.assign({}, record, {
          firstPageSerial: runtime.jobListFirstPageSerial,
        });
      }

      return record;
    },

    // 搜索条件变化或重新请求第一页时，旧的岗位池不再可信，需要整体替换。
    shouldReplaceJobListScope(contextKey, pageNumber) {
      if (!runtime.jobListContextKey) return true;
      if (contextKey && contextKey !== runtime.jobListContextKey) return true;
      return Number(pageNumber || 1) <= 1;
    },

    // 清空当前列表池和索引，通常发生在搜索条件变化、第一页刷新或接口数据错位时。
    resetJobListScope(contextKey) {
      logDebugEvent('job_list_scope_reset', {
        nextContextKey: contextKey || '',
        previous: getDebugListState(),
      });
      runtime.jobPool = [];
      runtime.jobByKey = new Map();
      runtime.jobBySignature = new Map();
      runtime.jobByLooseSignature = new Map();
      runtime.jobDetailByKey = new Map();
      runtime.latestJobDetail = null;
      runtime.cardJobMap = new WeakMap();
      runtime.seenApiBatches.clear();
      runtime.jobListContextKey = contextKey || '';
      runtime.jobListLastBatchKey = '';
      runtime.jobListUpdatedAt = 0;
    },

    // 将列表接口中的岗位放入池中，并维护各种强/弱索引。
    rememberListJob(job) {
      runtime.jobPool.push(job);
      this.addJobToIndexes(job);
    },

    // 建立岗位多维索引：强 ID、岗位+公司+薪资签名、岗位+公司弱签名。
    addJobToIndexes(job) {
      if (!job) return;

      runtime.jobByKey.set(job.jobKey, job);

      if (isMeaningfulCompositeKey(job.signature)) {
        if (!runtime.jobBySignature.has(job.signature)) {
          runtime.jobBySignature.set(job.signature, []);
        }
        runtime.jobBySignature.get(job.signature).push(job);
      }

      if (isMeaningfulCompositeKey(job.looseSignature)) {
        if (!runtime.jobByLooseSignature.has(job.looseSignature)) {
          runtime.jobByLooseSignature.set(job.looseSignature, []);
        }
        runtime.jobByLooseSignature.get(job.looseSignature).push(job);
      }
    },

    // 在批量合并详情后重建索引，避免旧签名还指向旧对象。
    rebuildJobIndexes() {
      runtime.jobByKey = new Map();
      runtime.jobBySignature = new Map();
      runtime.jobByLooseSignature = new Map();
      runtime.jobPool.forEach((job) => this.addJobToIndexes(job));
    },

    // 从 BOSS 不同版本的列表响应中找到真正的岗位数组；直接字段优先，兜底递归扫描。
    extractJobList(payload) {
      const directCandidates = [
        payload && payload.zpData && payload.zpData.jobList,
        payload && payload.zpData && payload.zpData.data && payload.zpData.data.jobList,
        payload && payload.data && payload.data.jobList,
        payload && payload.jobList,
      ];

      for (const candidate of directCandidates) {
        if (Array.isArray(candidate) && candidate.length) return candidate;
      }

      const found = [];
      walkObject(payload, (value) => {
        if (found.length) return;
        if (!Array.isArray(value) || !value.length) return;
        const score = value.slice(0, 5).reduce((total, item) => {
          if (!item || typeof item !== 'object') return total;
          return total + [
            'jobName',
            'brandName',
            'salaryDesc',
            'encryptJobId',
            'bossName',
            'securityId',
          ].filter((key) => key in item).length;
        }, 0);

        if (score >= 3) found.push(value);
      });

      return found[0] || [];
    },

    // 将列表接口岗位归一化为脚本内部字段，后续 UI、存储、发送模板都依赖这份结构。
    normalizeJob(rawJob, orderIndex, meta) {
      const jobName = pickFirstString(rawJob, ['jobName', 'jobTitle', 'positionName', 'name', 'title']);
      const company = pickFirstString(rawJob, ['brandName', 'companyName', 'encryptBrandName', 'company']);
      const salary = pickReadableSalary(rawJob, ['salaryDesc', 'salary', 'salaryName']);
      const bossName = pickFirstString(rawJob, ['bossName', 'bossNickName', 'boss']);
      const bossTitle = pickFirstString(rawJob, ['bossTitle', 'postDescription']);
      const rawBossActiveTimeDesc = pickFirstString(rawJob, ['activeTimeDesc', 'bossActiveTimeDesc', 'bossActiveDesc', 'lastActiveTimeDesc']);
      const bossOnline = Boolean(rawJob.bossOnline) || normalizeBossActiveText(rawBossActiveTimeDesc) === '在线';
      const bossActiveTimeDesc = bossOnline ? '在线' : getBossActiveOptionLabel(rawBossActiveTimeDesc);
      const encryptJobId = pickFirstString(rawJob, ['encryptJobId', 'jobId', 'job_id']);
      const securityId = pickFirstString(rawJob, ['securityId']);
      const lid = pickFirstString(rawJob, ['lid']);
      const brandId = pickFirstString(rawJob, ['encryptBrandId', 'brandId']);
      const city = pickFirstString(rawJob, ['cityName', 'city']);
      const experience = pickFirstString(rawJob, ['jobExperience', 'experienceName', 'experience']);
      const degree = pickFirstString(rawJob, ['jobDegree', 'degreeName', 'degree']);

      const strongKey = encryptJobId || pickFirstString(rawJob, ['jobId']);
      const fallbackKey = [jobName, company, salary, bossName, lid, securityId].filter(Boolean).join('|');
      const jobKey = strongKey || `sig_${hashString(fallbackKey || JSON.stringify(rawJob).slice(0, 300))}`;

      return {
        id: `job_${hashString(jobKey)}`,
        jobKey,
        signature: makeSignature(jobName, company, salary),
        looseSignature: makeLooseSignature(jobName, company),
        orderIndex,
        jobName,
        salary,
        company,
        bossName,
        bossTitle,
        bossActiveTimeDesc,
        bossOnline,
        bossAvatar: pickFirstString(rawJob, ['bossAvatar']),
        bossCertificated: Boolean(rawJob.bossCert || rawJob.bossCertificated),
        city,
        experience,
        degree,
        companyLogo: pickFirstString(rawJob, ['brandLogo', 'companyLogo']),
        companyStage: pickFirstString(rawJob, ['brandStageName', 'stageName', 'companyStage']),
        companyScale: pickFirstString(rawJob, ['brandScaleName', 'scaleName', 'companyScale']),
        companyIndustry: pickFirstString(rawJob, ['brandIndustry', 'industryName', 'companyIndustry']),
        companyLabels: normalizeStringArray(rawJob.welfareList || rawJob.companyLabels),
        encryptJobId,
        securityId,
        lid,
        brandId,
        source: meta.source,
        sourceUrl: meta.sourceUrl,
        rawJob,
        capturedAt: nowIso(),
      };
    },

    // 将岗位详情接口归一化；详情页比列表多 Boss 活跃状态、地址、技能、公司介绍等字段。
    normalizeJobDetail(payload, meta) {
      const data = payload && (payload.zpData || payload.data || payload);
      if (!data || typeof data !== 'object') return null;

      const jobInfo = data.jobInfo || data.job || {};
      const bossInfo = data.bossInfo || {};
      const brandInfo = data.brandComInfo || data.brandInfo || data.companyInfo || {};

      const jobName = pickFirstString(jobInfo, ['jobName', 'jobTitle', 'name', 'title']);
      const positionName = pickFirstString(jobInfo, ['positionName']);
      const company = pickFirstString(brandInfo, ['brandName', 'customerBrandName', 'companyName']) ||
        pickFirstString(bossInfo, ['brandName']);
      const salary = pickReadableSalary(jobInfo, ['salaryDesc', 'salary', 'salaryName']) ||
        pickReadableSalary(data, ['salaryDesc', 'salary', 'salaryName']);
      const bossName = pickFirstString(bossInfo, ['name', 'bossName', 'bossNickName']);
      const bossTitle = pickFirstString(bossInfo, ['title', 'bossTitle']);
      const bossActiveTimeDesc = pickFirstString(bossInfo, [
        'activeTimeDesc',
        'bossActiveTimeDesc',
        'bossActiveDesc',
        'lastActiveTimeDesc',
        'onlineDesc',
      ]) || pickFirstString(data, ['activeTimeDesc', 'bossActiveTimeDesc', 'bossActiveDesc']);
      const bossOnline = Boolean(bossInfo.bossOnline) || normalizeBossActiveText(bossActiveTimeDesc) === '在线';
      const encryptJobId = pickFirstString(jobInfo, ['encryptId', 'encryptJobId', 'jobId', 'job_id']);
      const securityId = pickFirstString(data, ['securityId']) || pickFirstString(jobInfo, ['securityId']);
      const lid = pickFirstString(data, ['lid']) || pickFirstString(jobInfo, ['lid']);
      const city = pickFirstString(jobInfo, ['locationName', 'cityName', 'city']);
      const experience = pickFirstString(jobInfo, ['experienceName', 'jobExperience', 'experience']);
      const degree = pickFirstString(jobInfo, ['degreeName', 'jobDegree', 'degree']);
      const address = pickFirstString(jobInfo, ['address']);
      const postDescription = normalizeTextPreserveLines(jobInfo.postDescription);
      const companyIntroduce = normalizeTextPreserveLines(brandInfo.introduce);
      const companyLabels = normalizeStringArray(brandInfo.labels);
      const showSkills = normalizeStringArray(jobInfo.showSkills);
      const longitude = Number(jobInfo.longitude || 0) || null;
      const latitude = Number(jobInfo.latitude || 0) || null;
      const fallbackKey = [jobName, company, salary, bossName, lid, securityId].filter(Boolean).join('|');
      const jobKey = encryptJobId || pickFirstString(jobInfo, ['jobId']) || `sig_${hashString(fallbackKey || JSON.stringify(data).slice(0, 300))}`;

      const detail = {
        id: `job_${hashString(jobKey)}`,
        jobKey,
        signature: makeSignature(jobName, company, salary),
        looseSignature: makeLooseSignature(jobName, company),
        jobName,
        positionName,
        salary,
        company,
        bossName,
        bossTitle,
        bossActiveTimeDesc: bossOnline ? '在线' : getBossActiveOptionLabel(bossActiveTimeDesc),
        bossOnline,
        bossAvatar: pickFirstString(bossInfo, ['large', 'tiny']),
        bossCertificated: Boolean(bossInfo.certificated),
        city,
        experience,
        degree,
        encryptJobId,
        securityId,
        lid,
        address,
        longitude,
        latitude,
        staticMapUrl: pickFirstString(jobInfo, ['pcStaticMapUrl', 'staticMapUrl']),
        encryptAddressId: pickFirstString(jobInfo, ['encryptAddressId']),
        postDescription,
        recruitmentCountDesc: pickFirstString(jobInfo, ['recruitmentCountDesc']),
        positionCode: pickFirstString(jobInfo, ['position']),
        jobType: pickFirstString(jobInfo, ['jobType']),
        jobStatusDesc: pickFirstString(jobInfo, ['jobStatusDesc']),
        showSkills,
        companyLogo: pickFirstString(brandInfo, ['logo']),
        companyStage: pickFirstString(brandInfo, ['stageName', 'customerBrandStageName']),
        companyScale: pickFirstString(brandInfo, ['scaleName']),
        companyIndustry: pickFirstString(brandInfo, ['industryName']),
        companyIntroduce,
        companyLabels,
        brandId: pickFirstString(brandInfo, ['encryptBrandId']),
        rawDetail: data,
        detailSource: meta.source,
        detailSourceUrl: meta.sourceUrl,
        detailCapturedAt: nowIso(),
      };

      if (!detail.jobName && !detail.company && !detail.salary) return null;
      return detail;
    },

    // 缓存最新详情，并按多种 key 建索引，供聊天页恢复 pendingJob 或列表页合并使用。
    rememberJobDetail(detail) {
      getJobDetailKeys(detail).forEach((key) => runtime.jobDetailByKey.set(key, detail));
      if (detail.signature) runtime.jobDetailByKey.set(`signature:${detail.signature}`, detail);
      if (detail.looseSignature) runtime.jobDetailByKey.set(`loose:${detail.looseSignature}`, detail);
      runtime.latestJobDetail = detail;
      syncSavedRecordsWithJob(detail, detail.detailSource || detail.source || 'detail');
    },

    // 根据强 ID、签名或弱签名查找某个岗位对应的最新详情。
    getDetailForJob(job, options) {
      const reliableKeys = getReliableJobIdentityKeys(job);
      for (const key of reliableKeys) {
        const matched = runtime.jobDetailByKey.get(key);
        if (matched) return matched;
      }

      // 当前岗位带有 encryptJobId/securityId/lid 时，不再退回到岗位名+公司弱匹配。
      // 连续切换详情时，弱匹配容易命中上一张相似岗位的半成品详情。
      if (reliableKeys.length && !(options && options.allowWeakWithReliableKey)) return null;

      const signature = job && (job.signature || makeSignature(job.jobName, job.company, job.salary));
      const looseSignature = job && (job.looseSignature || makeLooseSignature(job.jobName, job.company));
      const signatureDetail = runtime.jobDetailByKey.get(`signature:${signature}`);
      if (signatureDetail && isWeakDetailCompatible(job, signatureDetail)) return signatureDetail;

      const looseDetail = runtime.jobDetailByKey.get(`loose:${looseSignature}`);
      if (looseDetail && isWeakDetailCompatible(job, looseDetail)) return looseDetail;

      return null;
    },

    // 判断是否需要主动补拉详情接口，避免复用缺薪资/缺 rawDetail 的半成品详情。
    shouldFetchJobDetail(job, detail, options) {
      return getJobDetailFetchDecision(job, detail, options).shouldFetch;
    },

    // 点击岗位卡片后等待详情接口/HTML 数据到达；超时则主动补抓接口。
    async waitForJobDetail(job, timeout, resourceStartedAt, options) {
      const detailOptions = options || {};
      const includeHtml = detailOptions.includeHtml !== false;
      const totalTimeout = Math.max(800, Number(timeout || 2200));
      const startedAt = Date.now();
      let detail = this.getDetailForJob(job);
      logDebugEvent('job_detail_wait_start', {
        job: summarizeJobForDebug(job),
        cachedDetail: summarizeJobForDebug(detail),
        timeout: totalTimeout,
        resourceStartedAt,
        options: detailOptions,
      });

      if (!detail) {
        try {
          detail = await waitFor(
            () => this.getDetailForJob(job),
            Math.min(1800, totalTimeout),
            '岗位详情接口',
          );
          logDebugEvent('job_detail_wait_initial_hit', {
            job: summarizeJobForDebug(job),
            detail: summarizeJobForDebug(detail),
            elapsedMs: Date.now() - startedAt,
          });
        } catch (error) {
          logDebugEvent('job_detail_wait_initial_timeout', {
            job: summarizeJobForDebug(job),
            message: error && error.message || String(error),
            elapsedMs: Date.now() - startedAt,
          }, 'warn');
        }
      }

      const fetchDecision = getJobDetailFetchDecision(job, detail, detailOptions);
      logDebugEvent('job_detail_fetch_decision', {
        job: summarizeJobForDebug(job),
        detail: summarizeJobForDebug(detail),
        decision: fetchDecision,
        resourceStartedAt,
        elapsedMs: Date.now() - startedAt,
      }, fetchDecision.shouldFetch ? 'warn' : 'info');

      // BOSS 页面会缓存原始 XHR 方法，导致后续切换岗位时响应偶尔绕过拦截器。
      // 此时用岗位列表中的 securityId/lid（或刚发生的详情资源 URL）主动补取一次。
      if (fetchDecision.shouldFetch) {
        detail = await this.fetchJobDetail(job, resourceStartedAt).catch((error) => {
          logDebugEvent('job_detail_active_fetch_failed', {
            job: summarizeJobForDebug(job),
            message: error && error.message || String(error),
            resourceStartedAt,
          }, 'warn');
          console.warn('[ZhipinAuto] 主动获取岗位详情失败', error);
          return detail || null;
        });
      }

      if (!detail && Date.now() - startedAt < totalTimeout) {
        try {
          detail = await waitFor(
            () => this.getDetailForJob(job),
            Math.min(1500, Math.max(300, totalTimeout - (Date.now() - startedAt))),
            '岗位详情接口',
          );
          logDebugEvent('job_detail_wait_late_hit', {
            job: summarizeJobForDebug(job),
            detail: summarizeJobForDebug(detail),
            elapsedMs: Date.now() - startedAt,
          });
        } catch (error) {
          logDebugEvent('job_detail_wait_late_timeout', {
            job: summarizeJobForDebug(job),
            message: error && error.message || String(error),
            elapsedMs: Date.now() - startedAt,
          }, 'warn');
        }
      }

      if (!includeHtml || !detail || detail.htmlCapturedAt) {
        logDebugEvent(detail ? 'job_detail_wait_finish' : 'job_detail_wait_missing', {
          job: summarizeJobForDebug(job),
          detail: summarizeJobForDebug(detail),
          includeHtml,
          elapsedMs: Date.now() - startedAt,
        }, detail ? 'info' : 'warn');
        return detail;
      }

      if (!detail.htmlFetchPending) {
        this.enrichDetailWithHtml(detail).catch((error) => {
          logDebugEvent('job_detail_html_enrich_failed', {
            detail: summarizeJobForDebug(detail),
            message: error && error.message || String(error),
          }, 'warn');
          console.warn('[ZhipinAuto] 岗位 HTML 详情解析失败', error);
        });
      }

      const remaining = Math.max(0, totalTimeout - (Date.now() - startedAt));
      if (remaining <= 100) return detail;

      try {
        const htmlDetail = await waitFor(() => {
          const latest = this.getDetailForJob(job);
          return latest && latest.htmlCapturedAt ? latest : null;
        }, Math.min(remaining, 1800), '岗位 HTML 详情');
        logDebugEvent('job_detail_html_wait_hit', {
          job: summarizeJobForDebug(job),
          detail: summarizeJobForDebug(htmlDetail),
          elapsedMs: Date.now() - startedAt,
        });
        return htmlDetail;
      } catch (error) {
        const fallbackDetail = this.getDetailForJob(job) || detail;
        logDebugEvent('job_detail_html_wait_timeout', {
          job: summarizeJobForDebug(job),
          detail: summarizeJobForDebug(fallbackDetail),
          message: error && error.message || String(error),
          elapsedMs: Date.now() - startedAt,
        }, 'warn');
        return fallbackDetail;
      }
    },

    // 主动请求岗位详情接口，用于 XHR 被页面缓存绕过或拦截器没拿到响应时的兜底。
    async fetchJobDetail(job, resourceStartedAt) {
      const fetcher = nativePageFetch || (typeof pageWindow.fetch === 'function' && pageWindow.fetch.bind(pageWindow));
      if (!fetcher) {
        logDebugEvent('job_detail_active_fetch_unavailable', {
          reason: 'missing_fetcher',
          job: summarizeJobForDebug(job),
        }, 'warn');
        return null;
      }
      const directUrl = buildJobDetailApiUrl(job);
      const latestUrl = findLatestJobDetailApiUrl(resourceStartedAt);
      const requestTargets = [];
      if (directUrl) requestTargets.push({ url: directUrl, direct: true });
      if (latestUrl && latestUrl !== directUrl) requestTargets.push({ url: latestUrl, direct: false });
      if (!requestTargets.length) {
        logDebugEvent('job_detail_active_fetch_unavailable', {
          reason: 'missing_request_targets',
          job: summarizeJobForDebug(job),
          requestIdentity: getJobDetailRequestIdentity(job),
          directUrl,
          latestUrl,
          resourceStartedAt,
        }, 'warn');
        return null;
      }

      const expectedJobId = normalizeText(job && job.encryptJobId);
      let lastError = null;
      logDebugEvent('job_detail_active_fetch_targets', {
        job: summarizeJobForDebug(job),
        requestIdentity: getJobDetailRequestIdentity(job),
        directUrl,
        latestUrl,
        resourceStartedAt,
        targets: requestTargets,
      });

      for (const target of requestTargets) {
        try {
          logDebugEvent('job_detail_active_fetch_request', {
            job: summarizeJobForDebug(job),
            target,
            expectedJobId,
          });
          const response = await fetcher(target.url, {
            credentials: 'include',
            headers: { Accept: 'application/json, text/plain, */*' },
          });
          logDebugEvent('job_detail_active_fetch_response', {
            target,
            status: response.status,
            ok: response.ok,
            redirected: response.redirected,
            responseUrl: response.url,
          }, response.ok ? 'info' : 'warn');
          if (!response.ok) throw new Error(`岗位详情请求失败：HTTP ${response.status}`);

          const payload = await response.json();
          logDebugEvent('job_detail_active_fetch_payload', {
            target,
            code: payload && payload.code,
            message: normalizeText(payload && payload.message),
            payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12) : [],
            hasData: Boolean(payload && (payload.zpData || payload.data)),
          }, Number(payload && payload.code) === 0 ? 'info' : 'warn');
          if (Number(payload && payload.code) !== 0) {
            throw new Error(`岗位详情请求失败：${normalizeText(payload && payload.message) || '未知错误'}`);
          }

          const detail = this.normalizeJobDetail(payload, {
            source: 'active-fetch',
            sourceUrl: target.url,
          });
          if (!detail) throw new Error('岗位详情响应为空');
          if (expectedJobId && detail.encryptJobId && detail.encryptJobId !== expectedJobId) {
            logDebugEvent('job_detail_active_fetch_expected_id_mismatch', {
              target,
              expectedJobId,
              detail: summarizeJobForDebug(detail),
            }, 'warn');
            throw new Error(`岗位详情不匹配：期望 ${expectedJobId}，实际 ${detail.encryptJobId}`);
          }
          const compatibility = getFetchedDetailCompatibilityReport(job, detail, { allowWeakWithReliableKey: target.direct });
          if (!compatibility.compatible) {
            logDebugEvent('job_detail_active_fetch_incompatible', {
              target,
              job: summarizeJobForDebug(job),
              detail: summarizeJobForDebug(detail),
              compatibility,
            }, 'warn');
            throw new Error(`岗位详情不匹配：${compatibility.reason || '响应内容不像当前岗位'}`);
          }

          this.rememberJobDetail(detail);
          const matched = this.applyDetailToPool(detail);
          logDebugEvent('job_detail_active_fetch_success', {
            target,
            detail: summarizeJobForDebug(detail),
            matched: summarizeJobForDebug(matched),
            compatibility,
          });
          return detail;
        } catch (error) {
          lastError = error;
          logDebugEvent('job_detail_active_fetch_target_failed', {
            target,
            job: summarizeJobForDebug(job),
            message: error && error.message || String(error),
          }, 'warn');
        }
      }

      throw lastError || new Error('岗位详情请求失败');
    },

    // 详情接口字段不完整时，额外抓岗位详情 HTML 和公司主页 HTML 补公司工商信息。
    async enrichDetailWithHtml(detail) {
      if (!detail || detail.htmlCapturedAt || detail.htmlFetchPending) return detail;

      const jobUrl = buildJobHtmlDetailUrl(detail);
      const companyUrl = buildCompanyHtmlUrl(detail);
      if (!jobUrl && !companyUrl) return detail;

      detail.htmlFetchPending = true;
      this.rememberJobDetail(detail);

      let merged = detail;
      let captured = false;
      let lastError = null;

      if (jobUrl) {
        try {
          const html = await fetchJobHtml(jobUrl);
          const htmlDetail = parseJobHtmlDetail(html, jobUrl);
          merged = mergeJobInfo(merged, htmlDetail);
          merged.htmlDetailUrl = jobUrl;
          merged.rawHtmlDetail = htmlDetail.rawHtmlDetail || null;
          captured = true;
        } catch (error) {
          lastError = error;
          console.warn('[ZhipinAuto] 岗位 HTML 详情解析失败', error);
        }
      }

      // 公司主页中的工商信息更完整，放在岗位详情之后合并以获得最高优先级。
      if (companyUrl) {
        try {
          const companyHtml = await fetchJobHtml(companyUrl);
          const companyDetail = parseCompanyBusinessHtml(companyHtml, companyUrl);
          merged = mergeJobInfo(merged, companyDetail);
          merged.companyDetailUrl = companyUrl;
          merged.companyDetailCapturedAt = nowIso();
          merged.rawCompanyDetail = companyDetail.rawCompanyDetail || null;
          captured = true;
        } catch (error) {
          lastError = error;
          console.warn('[ZhipinAuto] 公司工商信息解析失败', error);
        }
      }

      if (!captured) {
        detail.htmlFetchPending = false;
        this.rememberJobDetail(detail);
        throw lastError || new Error('岗位与公司 HTML 详情均获取失败');
      }

      merged.htmlFetchPending = false;
      merged.htmlCapturedAt = nowIso();
      this.rememberJobDetail(merged);
      this.applyDetailToPool(merged);

      if (merged.company || merged.salary) {
        UI.setStatus(`已补全岗位及公司详情：${merged.jobName || '未知岗位'} / ${merged.company || ''}`, 'ok');
      }

      return merged;
    },

    // 将详情合并回列表池中的对应岗位，保证后续存储和发送模板拿到最新字段。
    applyDetailToPool(detail) {
      let matched = null;
      const detailReliableKeys = new Set(getReliableJobIdentityKeys(detail));

      runtime.jobPool = runtime.jobPool.map((job) => {
        const jobReliableKeys = getReliableJobIdentityKeys(job);
        const keyMatched = jobReliableKeys.some((key) => detailReliableKeys.has(key));
        const allowCompositeFallback = !detailReliableKeys.size || !jobReliableKeys.length;
        const signatureMatched = allowCompositeFallback && detail.signature && detail.signature === job.signature;
        const looseMatched = allowCompositeFallback && detail.looseSignature && detail.looseSignature === job.looseSignature;

        if (!keyMatched && !signatureMatched && !looseMatched) return job;

        matched = mergeJobInfo(job, detail);
        return matched;
      });

      if (matched) this.rebuildJobIndexes();
      return matched;
    },

    // 把当前可见 DOM 卡片和接口岗位绑定到 WeakMap，自动化点击时从卡片反查岗位。
    syncCards() {
      const cards = getJobCards();
      const usedJobKeys = new Set();
      const allowIndexFallback = this.canUseIndexedFallback(cards);
      const incompleteSamples = [];
      let incompleteCount = 0;

      cards.forEach((card, index) => {
        const domInfo = extractCardInfo(card);
        let job = this.findApiJobForCard(domInfo, index, usedJobKeys, { allowIndexFallback });
        const matchedFromApi = Boolean(job);

        job = job
          ? this.mergeDomInfo(job, domInfo)
          : this.normalizeDomOnlyJob(card, index);

        usedJobKeys.add(job.jobKey);
        runtime.cardJobMap.set(card, job);
        card.dataset.zhipinAutoJobKey = job.jobKey;

        if (!matchedFromApi || !job.jobName || !job.company) {
          incompleteCount += 1;
          if (incompleteSamples.length < 6) {
            incompleteSamples.push({
              index,
              matchedFromApi,
              domInfo: summarizeDomInfoForDebug(domInfo),
              job: summarizeJobForDebug(job),
            });
          }
        }
      });

      if (incompleteCount) {
        logDebugEvent('sync_cards_incomplete_summary', {
          cardCount: cards.length,
          incompleteCount,
          allowIndexFallback,
          samples: incompleteSamples,
          listState: getDebugListState(),
        }, 'warn');
      }

      return cards;
    },

    // 判断是否可以按列表顺序匹配 DOM 和接口数据；只有前几个样本足够相似才允许。
    canUseIndexedFallback(cards) {
      if (!runtime.jobPool.length || !cards.length) return false;

      const sampleCount = Math.min(cards.length, runtime.jobPool.length, 5);
      let comparable = 0;
      let matched = 0;

      for (let index = 0; index < sampleCount; index += 1) {
        const result = this.cardLooksLikeJob(extractCardInfo(cards[index]), runtime.jobPool[index]);
        if (!result.comparable) continue;
        comparable += 1;
        if (result.matched) matched += 1;
      }

      if (comparable < 2) return false;
      return matched >= Math.ceil(comparable * 0.6);
    },

    // 样本比对函数：用岗位名/公司/薪资判断 DOM 卡片和接口岗位是否像同一条记录。
    cardLooksLikeJob(domInfo, job) {
      if (!domInfo || !job) return { comparable: false, matched: false };

      const domKeys = new Set((domInfo.keys || []).map(normalizeText).filter(Boolean));
      const jobKeys = getJobStrongIdentityKeys(job);
      if (domKeys.size && jobKeys.length) {
        return {
          comparable: true,
          matched: jobKeys.some((key) => domKeys.has(key)),
        };
      }

      const domLooseSignature = domInfo.looseSignature;
      const jobLooseSignature = job.looseSignature || makeLooseSignature(job.jobName, job.company);
      if (isMeaningfulCompositeKey(domLooseSignature) && isMeaningfulCompositeKey(jobLooseSignature)) {
        return {
          comparable: true,
          matched: domLooseSignature === jobLooseSignature,
        };
      }

      const domSignature = domInfo.signature;
      const jobSignature = job.signature || makeSignature(job.jobName, job.company, job.salary);
      if (isMeaningfulCompositeKey(domSignature) && isMeaningfulCompositeKey(jobSignature)) {
        return {
          comparable: true,
          matched: domSignature === jobSignature,
        };
      }

      return { comparable: false, matched: false };
    },

    // 当前接口池是否能服务当前可见卡片；如果搜索/刷新导致错位，会触发重置。
    isJobPoolUsableForCards(cards) {
      const visibleCards = cards || getJobCards();
      if (!visibleCards.length) return true;
      if (this.canUseIndexedFallback(visibleCards)) return true;

      const samples = visibleCards.slice(0, 5);
      return samples.some((card, index) => {
        const matched = this.findApiJobForCard(
          extractCardInfo(card),
          index,
          new Set(),
          { allowIndexFallback: false },
        );
        return Boolean(matched);
      });
    },

    // 列表自动化启动前等待接口数据；等不到时尝试主动补拉最近的岗位列表接口。
    async waitForApiData(timeout) {
      if (runtime.jobPool.length) {
        if (this.isJobPoolUsableForCards()) return true;

        this.resetJobListScope('');
      }

      try {
        await waitFor(() => runtime.jobPool.length > 0, timeout || 1800, '岗位接口数据');
        if (this.isJobPoolUsableForCards()) return true;
        this.resetJobListScope('');
      } catch (_) {}

      const fetched = await this.fetchLatestJobList().catch((error) => {
        logDebugEvent('job_list_active_fetch_failed', {
          message: error && error.message || String(error),
          latestUrl: findLatestJobListApiUrl(),
        }, 'warn');
        console.warn('[ZhipinAuto] 主动获取岗位列表失败', error);
        return false;
      });
      if (fetched && this.isJobPoolUsableForCards()) return true;

      return false;
    },

    // 根据 performance 记录中的最近列表 URL 主动补抓岗位列表，作为网络拦截失败兜底。
    async fetchLatestJobList() {
      const fetcher = nativePageFetch || (typeof pageWindow.fetch === 'function' && pageWindow.fetch.bind(pageWindow));
      const request = getLatestReplayableJobListRequest();
      if (!request || !fetcher) {
        logDebugEvent('job_list_active_fetch_skipped', {
          reason: !fetcher ? 'missing_fetcher' : 'missing_replayable_request',
          latestUrl: findLatestJobListApiUrl(),
          latestRequest: summarizeJobListRequest(runtime.latestJobListRequest),
        }, 'warn');
        return false;
      }

      logDebugEvent('job_list_active_fetch_request', {
        request: summarizeJobListRequest(request),
      });
      const response = await fetcher(request.url, buildJobListFetchInit(request));
      if (!response.ok) throw new Error(`岗位列表请求失败：HTTP ${response.status}`);

      const payload = await response.json();
      if (Number(payload && payload.code) !== 0) {
        throw new Error(`岗位列表请求失败：${normalizeText(payload && payload.message) || '未知错误'}`);
      }

      ingestJobListResponse(request.url, JSON.stringify(payload), 'active-fetch', request);
      return runtime.jobPool.length > 0;
    },

    // DOM 卡片匹配接口岗位的核心逻辑：强 key -> 完整签名 -> 弱签名 -> 顺序兜底。
    findApiJobForCard(domInfo, index, usedJobKeys, options) {
      // 优先用岗位 id/securityId/lid 这类强标识；没有强标识时再降级到签名和顺序。
      for (const key of domInfo.keys) {
        const matched = runtime.jobPool.find((item) => {
          if (usedJobKeys.has(item.jobKey)) return false;
          return key && (
            item.jobKey === key ||
            item.encryptJobId === key ||
            item.securityId === key ||
            item.lid === key ||
            String(item.rawJob && item.rawJob.jobId || '') === key
          );
        });
        if (matched) return matched;
      }

      if (isMeaningfulCompositeKey(domInfo.signature)) {
        const signatureMatches = runtime.jobBySignature.get(domInfo.signature) || [];
        const matched = signatureMatches.find((item) => !usedJobKeys.has(item.jobKey));
        if (matched) return matched;
      }

      if (isMeaningfulCompositeKey(domInfo.looseSignature)) {
        // DOM 中薪资可能是字体加密字符，所以这里增加“岗位名 + 公司”的弱签名匹配。
        const looseMatches = runtime.jobByLooseSignature.get(domInfo.looseSignature) || [];
        const matched = looseMatches.find((item) => !usedJobKeys.has(item.jobKey));
        if (matched) return matched;
      }

      if (!options || !options.allowIndexFallback) return null;

      const indexed = runtime.jobPool[index];
      if (indexed && !usedJobKeys.has(indexed.jobKey)) return indexed;
      return null;
    },

    // DOM 中可读字段作为补充，但薪资如果是 BOSS 私有字体字符，会优先保留接口明文。
    mergeDomInfo(job, domInfo) {
      const merged = Object.assign({}, job);
      const domSalary = getReadableSalary(domInfo.salary);

      if (!merged.jobName && domInfo.jobName) merged.jobName = domInfo.jobName;
      if (!merged.company && domInfo.company) merged.company = domInfo.company;
      if (!merged.city && domInfo.city) merged.city = domInfo.city;
      if ((!merged.salary || isEncryptedSalary(merged.salary)) && domSalary) merged.salary = domSalary;

      merged.signature = makeSignature(merged.jobName, merged.company, merged.salary);
      merged.looseSignature = makeLooseSignature(merged.jobName, merged.company);
      return merged;
    },

    // 当接口数据暂时不可用时，用 DOM 卡片构造临时岗位，保证流程仍可定位和记录。
    normalizeDomOnlyJob(card, index) {
      const domInfo = extractCardInfo(card);
      const fallback = {
        jobName: domInfo.jobName,
        brandName: domInfo.company,
        salaryDesc: domInfo.salary,
        encryptJobId: domInfo.keys[0] || '',
        cityName: domInfo.city,
      };
      const job = this.normalizeJob(fallback, index, {
        source: 'dom',
        sourceUrl: location.href,
      });
      job.domOnly = true;
      return job;
    },
  };

  // IndexedDB 只保存结构化岗位记录：
  // - jobRecords：点击、跳过、发送等完整岗位记录。
  // - greetedJobs：已沟通索引，启动时用于快速跳过重复岗位。
  // UI 的虚拟列表、导出、按时间清理都从这里读取。
  const Database = {
    // 打开或创建 IndexedDB。版本升级时只创建缺失的 object store 和索引。
    open() {
      if (runtime.db) return Promise.resolve(runtime.db);

      return new Promise((resolve, reject) => {
        const request = indexedDB.open(APP.dbName, APP.dbVersion);

        request.onupgradeneeded = () => {
          const db = request.result;

          if (!db.objectStoreNames.contains('jobRecords')) {
            const store = db.createObjectStore('jobRecords', { keyPath: 'id' });
            store.createIndex('jobKey', 'jobKey', { unique: false });
            store.createIndex('status', 'status', { unique: false });
            store.createIndex('company', 'company', { unique: false });
            store.createIndex('jobName', 'jobName', { unique: false });
            store.createIndex('createdAt', 'createdAt', { unique: false });
            store.createIndex('updatedAt', 'updatedAt', { unique: false });
            store.createIndex('sentAt', 'sentAt', { unique: false });
          }

          if (!db.objectStoreNames.contains('greetedJobs')) {
            const store = db.createObjectStore('greetedJobs', { keyPath: 'id' });
            store.createIndex('jobKey', 'jobKey', { unique: false });
            store.createIndex('company', 'company', { unique: false });
            store.createIndex('jobName', 'jobName', { unique: false });
            store.createIndex('sentAt', 'sentAt', { unique: false });
          }

          if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings', { keyPath: 'key' });
          }
        };

        request.onsuccess = () => {
          runtime.db = request.result;
          resolve(runtime.db);
        };

        request.onerror = () => reject(request.error);
      });
    },

    // IndexedDB 事务包装器，所有基础读写都从这里统一处理成功/失败。
    withStore(storeName, mode, callback) {
      return this.open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;

        try {
          result = callback(store);
        } catch (error) {
          reject(error);
          return;
        }

        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      }));
    },

    // 写入单条记录，供岗位记录和已沟通投影共用。
    put(storeName, value) {
      return this.withStore(storeName, 'readwrite', (store) => store.put(value));
    },

    // 通过主键读取单条记录。
    get(storeName, id) {
      return this.open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      }));
    },

    // 读取整个 store，导出、清理前统计、虚拟列表刷新都会调用。
    getAll(storeName) {
      return this.open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      }));
    },

    // 统计 store 条数，用于清理后校验和提示。
    count(storeName) {
      return this.open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).count();
        request.onsuccess = () => resolve(Number(request.result || 0));
        request.onerror = () => reject(request.error);
      }));
    },

    // 清空指定 store，并返回删除前数量。
    clearStore(storeName) {
      return this.open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        let count = 0;

        const countRequest = store.count();
        countRequest.onsuccess = () => {
          count = Number(countRequest.result || 0);
          store.clear();
        };
        countRequest.onerror = () => reject(countRequest.error);

        tx.oncomplete = () => resolve(count);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      }));
    },

    // 游标遍历删除符合条件的记录，用于“按沟通时间清理”。
    deleteWhere(storeName, predicate) {
      return this.open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.openCursor();
        let deleted = 0;
        let predicateError = null;

        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          let shouldDelete = false;

          try {
            shouldDelete = Boolean(predicate(cursor.value));
          } catch (error) {
            predicateError = error;
            tx.abort();
            return;
          }

          if (!shouldDelete) {
            cursor.continue();
            return;
          }

          const deleteRequest = cursor.delete();
          deleteRequest.onsuccess = () => {
            deleted += 1;
            cursor.continue();
          };
          deleteRequest.onerror = () => {
            predicateError = deleteRequest.error;
            tx.abort();
          };
        };

        request.onerror = () => reject(request.error);
        tx.oncomplete = () => resolve(deleted);
        tx.onerror = () => reject(predicateError || tx.error);
        tx.onabort = () => reject(predicateError || tx.error || new Error('IndexedDB transaction aborted'));
      }));
    },

    // 写入前检查浏览器存储配额，接近上限时提前阻止继续采集。
    async ensureStorageAvailable() {
      const estimate = await getStorageEstimate();
      if (!estimate || !estimate.quota) return;

      const ratio = estimate.usage / estimate.quota;
      if (ratio >= APP.storageQuotaWarnRatio) {
        throw createStorageQuotaError(estimate);
      }
    },

    // 保存岗位沟通记录。patch 用来区分 clicked/sent/skipped 等不同阶段。
    async saveJobRecord(job, patch) {
      await this.ensureStorageAvailable();

      const time = nowIso();
      const id = job.id || `job_${hashString(job.jobKey || `${job.jobName}|${job.company}`)}`;
      const existing = await this.get('jobRecords', id).catch(() => null);
      const record = Object.assign({
        companyFullName: '',
        legalRepresentative: '',
        establishedDate: '',
        companyType: '',
        manageState: '',
        registeredCapital: '',
        registeredAddress: '',
        businessTerm: '',
        businessRegion: '',
        unifiedSocialCreditCode: '',
        approvalDate: '',
        formerName: '',
        registrationAuthority: '',
        businessIndustry: '',
        businessScope: '',
        businessInfo: {},
      }, existing || {}, compactObject(flattenJob(job)), patch || {}, {
        id,
        jobKey: job.jobKey,
        rawJob: job.rawJob || (existing && existing.rawJob) || null,
        rawDetail: job.rawDetail || (existing && existing.rawDetail) || null,
        rawHtmlDetail: job.rawHtmlDetail || (existing && existing.rawHtmlDetail) || null,
        rawCompanyDetail: job.rawCompanyDetail || (existing && existing.rawCompanyDetail) || null,
        updatedAt: time,
      });

      record.createdAt = record.createdAt || time;
      try {
        await this.put('jobRecords', record);

        if (isContactedRecord(record)) {
          ContactedIndex.add(record);
        }

        if (record.status === 'sent' && config.collectGreetedJobs) {
          const greetedRecord = Object.assign({}, record);
          delete greetedRecord.rawJob;
          delete greetedRecord.rawDetail;
          delete greetedRecord.rawHtmlDetail;
          delete greetedRecord.rawCompanyDetail;
          await this.put('greetedJobs', greetedRecord);
        }
      } catch (error) {
        if (isStorageQuotaError(error)) {
          throw createStorageQuotaError(await getStorageEstimate(), error);
        }
        throw error;
      }

      return record;
    },

    // 详情后到时，按岗位 ID 回填 jobRecords/greetedJobs 中已存在的记录。
    async enrichSavedRecords(job) {
      if (!job) return 0;
      await this.ensureStorageAvailable();

      const flat = compactObject(flattenJob(job));
      const ids = Array.from(new Set([
        flat.id,
        job.id,
        job.jobKey ? `job_${hashString(job.jobKey)}` : '',
      ].map(normalizeText).filter(Boolean)));
      if (!ids.length) return 0;

      const now = nowIso();
      let updated = 0;
      for (const storeName of ['jobRecords', 'greetedJobs']) {
        for (const id of ids) {
          const existing = await this.get(storeName, id).catch(() => null);
          if (!existing) continue;

          const next = Object.assign({}, existing, flat, {
            id: existing.id,
            jobKey: existing.jobKey || job.jobKey,
            updatedAt: now,
          });

          if (storeName === 'jobRecords') {
            next.rawJob = job.rawJob || existing.rawJob || null;
            next.rawDetail = job.rawDetail || existing.rawDetail || null;
            next.rawHtmlDetail = job.rawHtmlDetail || existing.rawHtmlDetail || null;
            next.rawCompanyDetail = job.rawCompanyDetail || existing.rawCompanyDetail || null;
          }

          await this.put(storeName, next);
          updated += 1;
        }
      }

      return updated;
    },
  };

  // 已沟通索引：用 Set 存岗位强 ID，避免每个岗位都扫 IndexedDB 或依赖页面按钮文本。
  // 页面上的“继续沟通”文案只能作为兜底判断，本地记录才是跨刷新、跨会话的主要依据。
  const ContactedIndex = {
    // 首次使用前从 IndexedDB 重建内存索引。
    async ensureReady() {
      if (runtime.contactedIndexReady) return runtime.contactedJobKeys;
      return this.rebuild();
    },

    // 从 jobRecords 和 greetedJobs 两个 store 汇总已沟通 key。
    async rebuild() {
      runtime.contactedJobKeys.clear();

      const rows = await Database.getAll('jobRecords');
      rows.forEach((record) => {
        if (isContactedRecord(record)) this.add(record);
      });

      // greetedJobs 是 sent 记录的投影；单独读取是为了兼容旧版本只写入 greetedJobs 的情况。
      const greetedRows = await Database.getAll('greetedJobs').catch(() => []);
      greetedRows.forEach((record) => this.add(record));

      runtime.contactedIndexReady = true;
      return runtime.contactedJobKeys;
    },

    // 将某个岗位的所有可判重 key 加入内存 Set。
    add(job) {
      getContactedKeys(job).forEach((key) => runtime.contactedJobKeys.add(key));
    },

    // 判断岗位是否已沟通过；列表循环跳过重复岗位时调用。
    has(job) {
      const keys = getContactedKeys(job);
      return keys.length > 0 && keys.some((key) => runtime.contactedJobKeys.has(key));
    },

    // 清理 IndexedDB 后同步清空内存索引。
    reset() {
      runtime.contactedJobKeys.clear();
      runtime.contactedIndexReady = false;
    },
  };

  // 侧栏 UI：只负责配置收集、状态展示、记录列表渲染和按钮事件分发。
  // 自动选择岗位、发送消息、返回列表等业务动作放在 Service/Automation 中，避免 UI 直接驱动复杂流程。
  const UI = {
    // 创建侧边面板 DOM、注入样式、初始化表单和虚拟列表。
    mount() {
      injectStyle();

      const root = document.createElement('div');
      root.id = 'zhipin-auto-greeting-root';
      root.dataset.version = APP.version;
      root.innerHTML = `
        <button class="za-toggle" type="button" title="显示/隐藏 BOSS自动沟通">沟通</button>
        <aside class="za-panel" aria-label="BOSS自动沟通控制台">
          <header class="za-header">
            <div class="za-header-title">
              <strong>BOSS自动沟通</strong>
              <span class="za-subtitle">岗位问候自动化</span>
            </div>
            <div class="za-header-actions">
              <button class="za-feature-button" type="button" data-action="toggleFeaturePanel" aria-expanded="false" title="板块管理">
                板块管理
              </button>
              <button class="za-icon-btn" type="button" data-action="toggle" title="收起">×</button>
            </div>
          </header>

          <div class="za-feature-panel" data-role="featurePanel" hidden>
            <div class="za-feature-panel-head">
              <strong>板块管理</strong>
              <button class="za-feature-panel-close" type="button" data-action="closeFeaturePanel" title="关闭板块管理" aria-label="关闭板块管理">×</button>
            </div>
            <div class="za-feature-list" data-role="featureBlockList"></div>
          </div>

          <div class="za-status" data-role="status">等待启动</div>

          <section class="za-section" data-feature-section="greeting">
            <h3>打招呼配置</h3>
            <div class="za-radio-row">
              <label><input type="radio" name="za-greeting-mode" value="fastReply"> 常用语</label>
              <label><input type="radio" name="za-greeting-mode" value="customText"> 自定义文本</label>
            </div>

            <div class="za-mode-block" data-mode-block="fastReply">
              <input data-field="fastReplyIndex" type="hidden">
              <div class="za-fast-reply-control">
                <button class="za-fast-reply-trigger" type="button" data-action="toggleFastReplyPicker" aria-expanded="false" aria-haspopup="dialog">
                  <span data-role="fastReplyTriggerText">选择常用语</span>
                  <span class="za-fast-reply-arrow">▾</span>
                </button>
                <button type="button" data-action="refreshFastReplies">刷新</button>
              </div>
              <div class="za-fast-reply-preview" data-role="fastReplyPreview"></div>
              <p class="za-hint" data-role="fastReplyHint">常用语会作为文本注入聊天框，接口失败时使用默认问候语。</p>
            </div>

            <div class="za-fast-reply-backdrop" data-role="fastReplyBackdrop" hidden>
              <div class="za-fast-reply-dialog" role="dialog" aria-modal="true" aria-label="选择常用语">
                <div class="za-fast-reply-head">
                  <div>
                    <strong>选择常用语</strong>
                    <span data-role="fastReplyCount">0 条</span>
                  </div>
                  <button class="za-icon-btn" type="button" data-action="closeFastReplyPicker" title="关闭">×</button>
                </div>
                <div class="za-fast-reply-search">
                  <input data-role="fastReplySearch" type="search" autocomplete="off" spellcheck="false" placeholder="搜索常用语内容">
                  <button type="button" data-action="clearFastReplySearch">清空</button>
                </div>
                <div class="za-fast-reply-list" data-role="fastReplyList"></div>
              </div>
            </div>

            <div class="za-mode-block" data-mode-block="customText">
              <div class="za-segment" aria-label="自定义文本来源">
                <label><input type="radio" name="za-text-source" value="text"> 手动输入</label>
                <label><input type="radio" name="za-text-source" value="api"> 接口返回</label>
              </div>

              <div class="za-source-block" data-text-source-block="text">
                <label class="za-label">问候文本</label>
                <textarea data-field="customText" rows="4" placeholder="支持 {jobName}、{company}、{salary}、{bossName} 等占位符"></textarea>
              </div>

              <div class="za-source-block za-api-panel" data-text-source-block="api">
                <div class="za-api-endpoint">
                  <label>接口地址
                    <input data-field="customApiUrl" type="url" placeholder="https://example.com/greeting?job={jobName}">
                  </label>
                  <label class="za-api-method">方法
                    <select data-field="customApiMethod">
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                      <option value="PUT">PUT</option>
                      <option value="PATCH">PATCH</option>
                    </select>
                  </label>
                </div>
                <label>URL 参数
                  <textarea data-field="customApiParams" rows="3" placeholder='JSON 对象或每行 key=value，例如：&#10;scene=boss&#10;job={jobName}'></textarea>
                </label>
                <label>请求头
                  <textarea data-field="customApiHeaders" rows="3" placeholder='JSON 对象或每行 key=value，例如：&#10;Authorization=Bearer xxx&#10;X-Source=zhipin'></textarea>
                </label>
                <label>请求体
                  <textarea data-field="customApiBody" rows="4" placeholder='POST/PUT/PATCH 可用；留空时发送默认岗位 JSON。支持 {jobName}、{company} 等占位符。'></textarea>
                </label>
                <label>返回文本路径
                  <input data-field="customApiResponsePath" type="text" placeholder="例如 data.text；留空则自动识别 message/text/content">
                </label>
                <p class="za-hint">参数、请求头和请求体都支持 JSON 对象，也支持每行 key=value。</p>
              </div>
            </div>
          </section>

          <section class="za-section" data-feature-section="strategy">
            <h3>运行策略</h3>
            <label class="za-check"><input data-field="skipContacted" type="checkbox"> 跳过已沟通 HR</label>
            <label class="za-check"><input data-field="collectGreetedJobs" type="checkbox"> 收集已打招呼岗位信息</label>
            <label class="za-check"><input data-field="ignoreListRefresh" type="checkbox"> 无视列表刷新</label>
            <div class="za-grid-2">
              <label>最小间隔(秒)<input data-field="delayMin" type="number" min="1" step="1"></label>
              <label>最大间隔(秒)<input data-field="delayMax" type="number" min="1" step="1"></label>
              <label>等待上限(秒)<input data-field="waitTimeout" type="number" min="2" step="1"></label>
              <label>聊天重试次数<input data-field="chatOpenRetries" type="number" min="0" step="1"></label>
            </div>
          </section>

          <section class="za-section" data-feature-section="companyFilter">
            <h3>公司筛选</h3>
            <div class="za-inline">
              <select data-field="companyFilterMode">
                <option value="exact">全量匹配</option>
                <option value="partial">部分匹配</option>
                <option value="regex">正则匹配</option>
              </select>
              <input data-field="companyFilterValue" type="text" autocomplete="off" spellcheck="false" placeholder="留空则不过滤">
            </div>
          </section>

          <section class="za-section" data-feature-section="companyBlacklist">
            <h3>公司黑名单</h3>
            <div class="za-inline">
              <select data-field="companyBlacklistMode">
                <option value="exact">全量匹配</option>
                <option value="partial">部分匹配</option>
                <option value="regex">正则匹配</option>
              </select>
              <input data-field="companyBlacklistValue" type="text" autocomplete="off" spellcheck="false" placeholder="输入公司黑名单">
              <button type="button" data-action="addCompanyBlacklistRule">添加</button>
            </div>
            <div class="za-multi-dropdown" data-role="companyBlacklistDropdown">
              <button class="za-multi-trigger" type="button" data-action="toggleCompanyBlacklistDropdown" aria-expanded="false">
                <span data-role="companyBlacklistDropdownText">查看已添加黑名单</span>
                <span class="za-multi-arrow">⌄</span>
              </button>
              <div class="za-multi-menu" data-role="companyBlacklistOptionMenu" hidden></div>
            </div>
            <div class="za-inline za-blacklist-actions" data-role="companyBlacklistActions">
              <button type="button" data-action="removeCompanyBlacklistRule">删除选中</button>
              <button type="button" class="za-danger-soft" data-action="clearCompanyBlacklistRules">全部删除</button>
            </div>
            <p class="za-hint">任意黑名单命中都会在沟通前跳过该公司。</p>
          </section>

          <section class="za-section" data-feature-section="bossActive">
            <h3>Boss活跃度筛选</h3>
            <div class="za-selected-area" data-role="bossActiveSelectedList"></div>
            <div class="za-multi-dropdown" data-role="bossActiveDropdown">
              <button class="za-multi-trigger" type="button" data-action="toggleBossActiveDropdown" aria-expanded="false">
                <span data-role="bossActiveDropdownText">选择 Boss 活跃度</span>
                <span class="za-multi-arrow">⌄</span>
              </button>
              <div class="za-multi-menu" data-role="bossActiveOptionMenu" hidden></div>
            </div>
            <div class="za-inline za-boss-active-add">
              <input data-role="bossActiveCustomInput" data-lock-field="bossActiveCustomInput" type="text" autocomplete="off" spellcheck="false" placeholder="添加自定义活跃度">
              <button type="button" data-action="addBossActiveOption">添加</button>
            </div>
            <div class="za-option-chips" data-role="bossActiveCustomList"></div>
            <p class="za-hint">不选择代表不过滤；内置选项固定，自定义选项可删除。</p>
          </section>

          <section class="za-section" data-feature-section="export">
            <h3>数据导出</h3>
            <div class="za-inline">
              <select data-field="exportType">
                <option value="json">JSON</option>
                <option value="xlsx">Excel</option>
              </select>
              <button type="button" data-action="export">导出岗位记录</button>
            </div>
          </section>

          <section class="za-section" data-feature-section="cleanup">
            <h3>数据清理</h3>
            <label class="za-cleanup-time">删除此时间前的记录
              <input data-field="clearBeforeTime" type="datetime-local">
            </label>
            <div class="za-inline">
              <button type="button" data-action="clearRecordsByTime">按时间删除</button>
              <button type="button" class="za-danger-soft" data-action="clearAllRecords">删除所有记录</button>
            </div>
            <p class="za-hint">按时间删除会使用发送时间，未发送记录使用点击或更新时间。</p>
          </section>

          <section class="za-section" data-feature-section="debugLog">
            <h3>调试日志</h3>
            <label class="za-check"><input data-role="debugLogEnabled" type="checkbox"> 记录诊断日志</label>
            <div class="za-inline">
              <button type="button" data-action="exportDebugLogs">导出日志</button>
              <button type="button" class="za-danger-soft" data-action="clearDebugLogs">清除日志</button>
            </div>
            <p class="za-hint" data-role="debugLogStatus">日志 0 条</p>
          </section>

          <section class="za-section za-list-section" data-feature-section="greetedList">
            <h3>已沟通列表</h3>
            <div class="za-list-viewport" data-role="listViewport">
              <div class="za-list-spacer" data-role="listSpacer"></div>
              <div class="za-list-items" data-role="listItems"></div>
            </div>
          </section>

          <footer class="za-footer">
            <button type="button" class="za-primary" data-action="start">启动</button>
            <button type="button" class="za-danger" data-action="stop">停止</button>
          </footer>
        </aside>
      `;

      document.body.appendChild(root);
      runtime.ui = {
        root,
        panel: root.querySelector('.za-panel'),
        toggle: root.querySelector('.za-toggle'),
        status: root.querySelector('[data-role="status"]'),
        featurePanel: root.querySelector('[data-role="featurePanel"]'),
        featureButton: root.querySelector('[data-action="toggleFeaturePanel"]'),
        featureBlockList: root.querySelector('[data-role="featureBlockList"]'),
        fastReplyInput: root.querySelector('[data-field="fastReplyIndex"]'),
        fastReplyTrigger: root.querySelector('[data-action="toggleFastReplyPicker"]'),
        fastReplyTriggerText: root.querySelector('[data-role="fastReplyTriggerText"]'),
        fastReplyPreview: root.querySelector('[data-role="fastReplyPreview"]'),
        fastReplyHint: root.querySelector('[data-role="fastReplyHint"]'),
        fastReplyBackdrop: root.querySelector('[data-role="fastReplyBackdrop"]'),
        fastReplyCount: root.querySelector('[data-role="fastReplyCount"]'),
        fastReplySearch: root.querySelector('[data-role="fastReplySearch"]'),
        fastReplyList: root.querySelector('[data-role="fastReplyList"]'),
        bossActiveDropdown: root.querySelector('[data-role="bossActiveDropdown"]'),
        bossActiveDropdownText: root.querySelector('[data-role="bossActiveDropdownText"]'),
        bossActiveSelectedList: root.querySelector('[data-role="bossActiveSelectedList"]'),
        bossActiveOptionMenu: root.querySelector('[data-role="bossActiveOptionMenu"]'),
        bossActiveCustomInput: root.querySelector('[data-role="bossActiveCustomInput"]'),
        bossActiveCustomList: root.querySelector('[data-role="bossActiveCustomList"]'),
        companyBlacklistDropdown: root.querySelector('[data-role="companyBlacklistDropdown"]'),
        companyBlacklistDropdownText: root.querySelector('[data-role="companyBlacklistDropdownText"]'),
        companyBlacklistOptionMenu: root.querySelector('[data-role="companyBlacklistOptionMenu"]'),
        companyBlacklistRemoveButton: root.querySelector('[data-action="removeCompanyBlacklistRule"]'),
        companyBlacklistClearButton: root.querySelector('[data-action="clearCompanyBlacklistRules"]'),
        companyBlacklistSelectedIds: new Set(),
        debugLogEnabled: root.querySelector('[data-role="debugLogEnabled"]'),
        debugLogStatus: root.querySelector('[data-role="debugLogStatus"]'),
        listViewport: root.querySelector('[data-role="listViewport"]'),
        listSpacer: root.querySelector('[data-role="listSpacer"]'),
        listItems: root.querySelector('[data-role="listItems"]'),
        greetedRows: [],
        rowHeight: 66,
      };

      this.prepareConfigFields();
      this.renderFeatureBlockControls();
      this.bindEvents();
      this.applyConfigToForm();
      this.renderDebugLogControls();
      this.renderFastReplyOptions();
      this.renderCompanyBlacklistRules();
      this.renderBossActiveFilterOptions();
      this.setFeaturePanelOpen(config.featurePanelOpen);
      this.setPanelOpen(config.panelOpen);
      this.scheduleConfigReapply();
      this.refreshGreetedList();

      if (!config.fastReplies || !config.fastReplies.length) {
        setTimeout(() => FastReplyService.refresh(false), 500);
      }
    },

    // 给脚本自己的配置控件设置独立字段名，并关闭浏览器自动填充/历史恢复。
    prepareConfigFields() {
      const root = runtime.ui.root;
      root.querySelectorAll('[data-field]').forEach((field) => {
        const key = field.dataset.field;
        if (!CONFIG_FIELD_KEY_SET.has(key)) return;
        field.setAttribute('autocomplete', 'off');
        field.setAttribute('autocorrect', 'off');
        field.setAttribute('autocapitalize', 'off');
        if (field.matches('input, textarea')) field.setAttribute('spellcheck', 'false');
        if (field.matches('input, textarea, select') && !field.name) {
          field.name = `zhipin-auto-${key}`;
        }
      });
    },

    // 部分浏览器会在 DOM 插入后异步恢复旧表单值；用户未触碰前用配置值覆盖回去。
    scheduleConfigReapply() {
      [0, 120, 600].forEach((delay) => {
        setTimeout(() => {
          if (!runtime.ui || runtime.configFormTouched) return;
          this.applyConfigToForm();
          this.renderFastReplyOptions();
        }, delay);
      });
    },

    // 绑定面板按钮和表单事件；按钮只分发到对应 Service/Automation。
    bindEvents() {
      const root = runtime.ui.root;

      ['pointerdown', 'keydown', 'paste', 'drop'].forEach((eventName) => {
        root.addEventListener(eventName, (event) => this.noteConfigFieldInteraction(event), true);
      });

      root.addEventListener('click', (event) => {
        const eventTarget = event.target && event.target.nodeType === 1
          ? event.target
          : event.target && event.target.parentElement;

        if (eventTarget && eventTarget.dataset && eventTarget.dataset.role === 'fastReplyBackdrop') {
          this.setFastReplyPickerOpen(false);
          return;
        }

        const target = eventTarget && eventTarget.closest('[data-action], .za-toggle');
        if (!target) return;

        const action = target.dataset.action || 'toggle';
        if (action === 'toggleFeaturePanel') {
          this.setFastReplyPickerOpen(false);
          this.setBossActiveDropdownOpen(false);
          this.setCompanyBlacklistDropdownOpen(false);
          this.setFeaturePanelOpen(!this.isFeaturePanelOpen());
          return;
        }
        if (action === 'closeFeaturePanel') {
          this.setFeaturePanelOpen(false);
          return;
        }
        if (action === 'toggleFeatureBlock') {
          this.toggleFeatureBlock(target.dataset.featureId);
          return;
        }
        if (action === 'toggleFastReplyPicker') {
          this.setFeaturePanelOpen(false);
          this.setBossActiveDropdownOpen(false);
          this.setCompanyBlacklistDropdownOpen(false);
          this.setFastReplyPickerOpen(!this.isFastReplyPickerOpen());
          return;
        }
        if (action === 'closeFastReplyPicker') {
          this.setFastReplyPickerOpen(false);
          return;
        }
        if (action === 'selectFastReply') {
          this.selectFastReply(target.dataset.index);
          return;
        }
        if (action === 'clearFastReplySearch') {
          this.setFastReplySearch('');
          return;
        }
        if (action === 'toggleBossActiveDropdown') {
          this.setFeaturePanelOpen(false);
          this.setFastReplyPickerOpen(false);
          this.setCompanyBlacklistDropdownOpen(false);
          this.setBossActiveDropdownOpen(!this.isBossActiveDropdownOpen());
          return;
        }
        if (action === 'toggleCompanyBlacklistDropdown') {
          this.setFeaturePanelOpen(false);
          this.setFastReplyPickerOpen(false);
          this.setBossActiveDropdownOpen(false);
          this.setCompanyBlacklistDropdownOpen(!this.isCompanyBlacklistDropdownOpen());
          return;
        }
        if (action !== 'stop') this.unlockStatus();
        if (action === 'toggle') this.setPanelOpen(!config.panelOpen);
        if (action === 'refreshFastReplies') FastReplyService.refresh(true);
        if (action === 'start') Automation.start();
        if (action === 'stop') Automation.stop('已停止', { manual: true });
        if (action === 'export') Exporter.exportRecords();
        if (action === 'exportDebugLogs') DebugLogService.exportLogs();
        if (action === 'clearRecordsByTime') RecordCleaner.clearByTime();
        if (action === 'clearAllRecords') RecordCleaner.clearAll();
        if (action === 'clearDebugLogs') DebugLogService.clearLogs();
        if (action === 'addCompanyBlacklistRule') this.addCompanyBlacklistRule();
        if (action === 'removeCompanyBlacklistRule') this.removeCompanyBlacklistRule(target.dataset.id);
        if (action === 'clearCompanyBlacklistRules') this.clearCompanyBlacklistRules();
        if (action === 'addBossActiveOption') this.addBossActiveCustomOption();
        if (action === 'deleteBossActiveOption') this.deleteBossActiveCustomOption(target.dataset.value);
        if (action === 'removeBossActiveSelection') this.removeBossActiveSelection(target.dataset.value);
        if (action !== 'toggleBossActiveDropdown' && !target.closest('[data-role="bossActiveDropdown"]')) {
          this.setBossActiveDropdownOpen(false);
        }
        if (
          action !== 'toggleCompanyBlacklistDropdown' &&
          !target.closest('[data-role="companyBlacklistDropdown"]') &&
          !target.closest('[data-role="companyBlacklistActions"]')
        ) {
          this.setCompanyBlacklistDropdownOpen(false);
        }
      });

      root.addEventListener('input', (event) => {
        if (event.target && event.target.dataset && event.target.dataset.role === 'fastReplySearch') {
          this.renderFastReplyPickerList();
          return;
        }
        if (this.shouldIgnoreConfigFieldEvent(event)) return;
        this.noteCompanyFilterEdit(event);
        this.saveFormToConfig({ event });
      });
      root.addEventListener('change', (event) => {
        if (event.target && event.target.dataset && event.target.dataset.role === 'debugLogEnabled') {
          DebugLogService.setEnabled(event.target.checked);
          return;
        }
        if (this.shouldIgnoreConfigFieldEvent(event)) return;
        this.noteCompanyFilterEdit(event);
        if (event.target && event.target.dataset && event.target.dataset.role === 'companyBlacklistRuleOption') {
          this.setCompanyBlacklistRuleSelected(event.target.value, event.target.checked, true);
          return;
        }
        if (event.target && event.target.dataset && event.target.dataset.role === 'bossActiveOption') {
          this.setBossActiveOptionSelected(event.target.value, event.target.checked, true);
          return;
        }
        this.saveFormToConfig({ event });
        this.applyModeVisibility();
      });

      root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && this.isFeaturePanelOpen()) {
          event.preventDefault();
          event.stopPropagation();
          this.setFeaturePanelOpen(false);
          return;
        }
        if (event.key === 'Escape' && this.isFastReplyPickerOpen()) {
          event.preventDefault();
          event.stopPropagation();
          this.setFastReplyPickerOpen(false);
          return;
        }
        if (event.key === 'Escape' && this.isCompanyBlacklistDropdownOpen()) {
          event.preventDefault();
          event.stopPropagation();
          this.setCompanyBlacklistDropdownOpen(false);
          return;
        }
        if (event.key === 'Escape' && this.isBossActiveDropdownOpen()) {
          event.preventDefault();
          event.stopPropagation();
          this.setBossActiveDropdownOpen(false);
          return;
        }

        if (event.key === 'Enter' && event.target && event.target.dataset && event.target.dataset.role === 'fastReplySearch') {
          const firstOption = runtime.ui.fastReplyList && runtime.ui.fastReplyList.querySelector('[data-action="selectFastReply"]');
          if (firstOption) {
            event.preventDefault();
            this.selectFastReply(firstOption.dataset.index);
          }
          return;
        }

        if (event.key !== 'Enter') return;
        if (event.target && event.target.dataset && event.target.dataset.field === 'companyBlacklistValue') {
          event.preventDefault();
          this.addCompanyBlacklistRule();
          return;
        }
        if (!event.target || !event.target.dataset || event.target.dataset.role !== 'bossActiveCustomInput') return;
        event.preventDefault();
        this.addBossActiveCustomOption();
      });

      runtime.ui.listViewport.addEventListener('scroll', () => this.renderVirtualList());

      pageWindow.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (this.isFeaturePanelOpen()) {
          this.setFeaturePanelOpen(false);
          return;
        }
        if (this.isFastReplyPickerOpen()) {
          this.setFastReplyPickerOpen(false);
          return;
        }
        if (this.isCompanyBlacklistDropdownOpen()) {
          this.setCompanyBlacklistDropdownOpen(false);
          return;
        }
        if (this.isBossActiveDropdownOpen()) {
          this.setBossActiveDropdownOpen(false);
          return;
        }
        Automation.stop('已停止', { manual: true });
      });

      pageWindow.addEventListener('click', (event) => {
        if (!runtime.ui || !runtime.ui.root || this.isEventFromUiRoot(event)) return;
        this.setFeaturePanelOpen(false);
        this.setFastReplyPickerOpen(false);
        this.setCompanyBlacklistDropdownOpen(false);
        this.setBossActiveDropdownOpen(false);
      });
    },

    // 记录用户真实触碰过配置控件，用于区分浏览器自动填充事件。
    noteConfigFieldInteraction(event) {
      const field = this.getConfigFieldFromTarget(event && event.target);
      if (!field) return;
      field.dataset.userTouched = 'true';
      runtime.configFormTouched = true;
    },

    // 拦截浏览器自动恢复的旧表单值，避免覆盖 localStorage 中的真实配置。
    shouldIgnoreConfigFieldEvent(event) {
      const field = this.getConfigFieldFromTarget(event && event.target);
      if (!field) return false;

      const key = field.dataset.field;
      if (!CONFIG_FIELD_KEY_SET.has(key)) return true;

      const hasUserSignal = field.dataset.userTouched === 'true' || document.activeElement === field || event.isTrusted === false;
      if (hasUserSignal) return false;

      this.restoreConfigFieldValue(field);
      logDebugEvent('ignored_config_autofill_event', {
        field: key,
        value: summarizeLongText(this.readConfigFieldValue(field)),
      }, 'warn');
      return true;
    },

    // 从任意事件目标向上查找脚本配置字段，并排除面板外元素。
    getConfigFieldFromTarget(target) {
      const root = runtime.ui && runtime.ui.root;
      if (!root || !target || !target.closest) return null;
      const field = target.closest('[data-field]');
      return field && root.contains(field) ? field : null;
    },

    // 判断事件是否起源于脚本 UI。composedPath 可覆盖点击后 DOM 被重绘移除的场景。
    isEventFromUiRoot(event) {
      const root = runtime.ui && runtime.ui.root;
      if (!root || !event) return false;
      const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
      if (path && path.includes(root)) return true;
      return Boolean(event.target && root.contains(event.target));
    },

    // 判断事件目标是否是问候模式/文本来源的单选项。
    isModeInput(target) {
      return Boolean(target && target.matches && target.matches('input[name="za-greeting-mode"], input[name="za-text-source"]'));
    },

    // 读取配置字段的 JS 值，统一处理 checkbox 和 number。
    readConfigFieldValue(field) {
      if (!field) return '';
      if (field.type === 'checkbox') return Boolean(field.checked);
      if (field.type === 'number') return Number(field.value || 0);
      return field.value;
    },

    // 将配置值写回表单字段，避免各处重复处理 checkbox/空值。
    setConfigFieldValue(field, value) {
      if (!field) return;
      if (field.type === 'checkbox') {
        field.checked = Boolean(value);
      } else {
        field.value = value == null ? '' : value;
      }
    },

    // 自动填充事件被忽略时，把字段恢复到当前配置值。
    restoreConfigFieldValue(field) {
      const key = field && field.dataset && field.dataset.field;
      if (!CONFIG_FIELD_KEY_SET.has(key)) return;
      this.setConfigFieldValue(field, config[key]);
    },

    // 判断板块管理选择区是否展开。
    isFeaturePanelOpen() {
      return Boolean(runtime.ui && runtime.ui.featurePanel && !runtime.ui.featurePanel.hidden);
    },

    // 展开/收起板块管理选择区；展开状态持久化，方便刷新后保持用户的工作上下文。
    setFeaturePanelOpen(open) {
      if (!runtime.ui || !runtime.ui.featurePanel) return;
      saveConfig({ featurePanelOpen: Boolean(open) });
      runtime.ui.featurePanel.hidden = !config.featurePanelOpen;
      runtime.ui.root.classList.toggle('za-feature-open', config.featurePanelOpen);
      if (runtime.ui.featureButton) {
        runtime.ui.featureButton.setAttribute('aria-expanded', config.featurePanelOpen ? 'true' : 'false');
      }
    },

    // 根据板块元数据渲染开关按钮；新增板块只需要补 FEATURE_BLOCK_DEFINITIONS。
    renderFeatureBlockControls() {
      if (!runtime.ui || !runtime.ui.featureBlockList) return;

      const blocks = normalizeFeatureBlocks(config.featureBlocks);
      runtime.ui.featureBlockList.innerHTML = FEATURE_BLOCK_DEFINITIONS.map((item) => {
        const enabled = blocks[item.id];
        const enabledClass = enabled ? ' za-enabled' : '';
        const readonlyClass = item.readonly ? ' za-readonly' : '';
        const stateText = item.readonly ? '固定' : enabled ? '开启' : '关闭';
        const disabled = item.readonly ? ' disabled' : '';
        const title = item.readonly
          ? `${item.title}固定开启`
          : `${enabled ? '关闭' : '开启'}${item.title}`;
        return `
          <button type="button" class="za-feature-switch${enabledClass}${readonlyClass}" data-action="toggleFeatureBlock" data-feature-id="${escapeHtml(item.id)}" aria-pressed="${enabled ? 'true' : 'false'}" title="${escapeHtml(title)}"${disabled}>
            <span>${escapeHtml(item.title)}</span>
            <span class="za-feature-state">${escapeHtml(stateText)}</span>
          </button>
        `;
      }).join('');
    },

    // 切换单个板块的显示状态，只读板块不允许关闭。
    toggleFeatureBlock(featureId) {
      const id = normalizeText(featureId);
      if (!FEATURE_BLOCK_ID_SET.has(id)) return;

      const definition = FEATURE_BLOCK_DEFINITIONS.find((item) => item.id === id);
      if (!definition || definition.readonly) return;

      const nextBlocks = normalizeFeatureBlocks(config.featureBlocks);
      nextBlocks[id] = !nextBlocks[id];
      saveConfig({ featureBlocks: nextBlocks });
      this.renderFeatureBlockControls();
      this.applyFeatureBlockVisibility();
    },

    // 把板块管理开关应用到实际 section；隐藏只影响面板展示，不清空已有配置。
    applyFeatureBlockVisibility() {
      if (!runtime.ui || !runtime.ui.root) return;

      const blocks = normalizeFeatureBlocks(config.featureBlocks);
      runtime.ui.root.querySelectorAll('[data-feature-section]').forEach((section) => {
        const id = section.dataset.featureSection;
        section.hidden = !blocks[id];
      });

      if (!blocks.companyBlacklist) this.setCompanyBlacklistDropdownOpen(false);
      if (!blocks.bossActive) this.setBossActiveDropdownOpen(false);
    },

    // 展开/收起面板并持久化到配置。
    setPanelOpen(open) {
      if (!open) {
        this.setFeaturePanelOpen(false);
        this.setFastReplyPickerOpen(false);
      }
      saveConfig({ panelOpen: Boolean(open) });
      runtime.ui.root.classList.toggle('za-open', config.panelOpen);
    },

    // 将配置写回表单控件，页面刷新或首次挂载时调用。
    applyConfigToForm() {
      const root = runtime.ui.root;
      this.clearAutoSyncedCompanyFilter();

      root.querySelectorAll('input[name="za-greeting-mode"]').forEach((input) => {
        input.checked = input.value === config.greetingMode;
      });
      root.querySelectorAll('input[name="za-text-source"]').forEach((input) => {
        input.checked = input.value === config.textSource;
      });

      for (const field of root.querySelectorAll('[data-field]')) {
        const key = field.dataset.field;
        if (key === 'fastReplyIndex') continue;
        this.setConfigFieldValue(field, config[key]);
      }

      this.applyModeVisibility();
      this.renderFeatureBlockControls();
      this.applyFeatureBlockVisibility();
      this.renderDebugLogControls();
      this.renderCompanyBlacklistRules();
      this.renderBossActiveFilterOptions();
    },

    // 调试日志不属于运行配置，单独同步本地开关和日志条数。
    renderDebugLogControls() {
      if (!runtime.ui) return;
      if (runtime.ui.debugLogEnabled) {
        runtime.ui.debugLogEnabled.checked = isDebugEnabled();
      }
      if (runtime.ui.debugLogStatus) {
        const count = loadStoredDebugEvents().length;
        runtime.ui.debugLogStatus.textContent = `日志 ${count} 条`;
      }
    },

    // 从表单读取配置并保存；运行中会跳过被锁定的字段。
    saveFormToConfig(options) {
      const root = runtime.ui.root;
      const next = {};
      const eventTarget = options && options.event && options.event.target;
      const eventField = this.getConfigFieldFromTarget(eventTarget);
      const selectedMode = root.querySelector('input[name="za-greeting-mode"]:checked');
      if (selectedMode) next.greetingMode = selectedMode.value;
      const selectedTextSource = root.querySelector('input[name="za-text-source"]:checked');
      if (selectedTextSource) next.textSource = selectedTextSource.value;

      if (eventTarget && !eventField && !this.isModeInput(eventTarget)) {
        return;
      }

      if (eventField) {
        const key = eventField.dataset.field;
        if (!CONFIG_FIELD_KEY_SET.has(key)) return;
        if (key === 'companyFilterValue' && !this.shouldSaveCompanyFilterValue(eventField, eventTarget)) {
          delete next.companyFilterValue;
        } else {
          next[key] = this.readConfigFieldValue(eventField);
        }
      } else if (!eventTarget) {
        // 无事件来源时只刷新模式开关，不把浏览器可能恢复的隐藏字段值写回配置。
        const changedKeys = Object.keys(next).filter((key) => next[key] !== config[key]);
        if (!changedKeys.length) return;
      }

      if (Object.prototype.hasOwnProperty.call(next, 'fastReplyIndex')) {
        next.fastReplyIndex = Number(next.fastReplyIndex || 0);
      }
      saveConfig(next);
    },

    // 标记公司过滤输入框是否被用户手动编辑，避免被搜索词自动覆盖。
    noteCompanyFilterEdit(event) {
      const target = event && event.target;
      if (target && target.dataset && target.dataset.field === 'companyFilterValue') {
        runtime.companyFilterEdited = true;
        target.dataset.userEdited = 'true';
      }
    },

    // 判断公司过滤值是否应该写入配置，区分自动同步和用户输入。
    shouldSaveCompanyFilterValue(field, eventTarget) {
      if (!field) return false;
      if (runtime.companyFilterEdited || field.dataset.userEdited === 'true') return true;
      if (eventTarget === field) return true;
      return normalizeText(field.value) !== normalizeText(getCurrentSearchQuery());
    },

    // 用户切换过滤模式时，如果过滤值只是自动同步的搜索词，则清空。
    clearAutoSyncedCompanyFilter() {
      const query = normalizeText(getCurrentSearchQuery());
      if (!query || !config.companyFilterValue) return;
      if (normalizeText(config.companyFilterValue) !== query) return;

      saveConfig({ companyFilterValue: '' });
    },

    // 根据问候语模式/自定义文本来源，显示或隐藏对应配置块。
    applyModeVisibility() {
      const root = runtime.ui.root;
      root.querySelectorAll('[data-mode-block]').forEach((block) => {
        block.hidden = block.dataset.modeBlock !== config.greetingMode;
      });

      root.querySelectorAll('[data-text-source-block]').forEach((block) => {
        block.hidden = block.dataset.textSourceBlock !== config.textSource;
      });
      if (config.greetingMode !== 'fastReply') this.setFastReplyPickerOpen(false);
    },

    // 渲染常用语选择入口和预览；弹层列表用普通 DOM 承载长文本，避免原生 select 撑宽面板。
    renderFastReplyOptions() {
      if (!runtime.ui) return;

      const replies = config.fastReplies || [];
      const selectedIndex = this.getSafeFastReplyIndex(replies);
      const selected = replies[selectedIndex];
      const selectedText = replies.length
        ? normalizeMessageText((selected && selected.text) || `常用语 ${selectedIndex + 1}`)
        : APP.defaultGreetingText;

      if (runtime.ui.fastReplyInput) {
        runtime.ui.fastReplyInput.value = String(selectedIndex);
      }
      if (runtime.ui.fastReplyTriggerText) {
        runtime.ui.fastReplyTriggerText.textContent = replies.length
          ? `已选 常用语 ${selectedIndex + 1}`
          : '未获取常用语';
      }
      if (runtime.ui.fastReplyTrigger) {
        const running = runtime.ui.root.classList.contains('za-running');
        runtime.ui.fastReplyTrigger.disabled = running || !replies.length;
        runtime.ui.fastReplyTrigger.setAttribute('aria-expanded', this.isFastReplyPickerOpen() ? 'true' : 'false');
      }
      if (runtime.ui.fastReplyPreview) {
        runtime.ui.fastReplyPreview.textContent = selectedText;
        runtime.ui.fastReplyPreview.dataset.empty = replies.length ? 'false' : 'true';
      }

      runtime.ui.fastReplyHint.textContent = replies.length
        ? `已获取 ${replies.length} 条常用语；发送时会把所选文本直接注入聊天框。`
        : '获取常用语失败或未刷新时，会把默认问候语直接注入聊天框。';
      this.renderFastReplyPickerList();
    },

    // 计算常用语安全索引，防止刷新后缓存数量变化造成越界。
    getSafeFastReplyIndex(replies) {
      const total = Array.isArray(replies) ? replies.length : 0;
      if (!total) return 0;

      const index = Number(config.fastReplyIndex || 0);
      if (!Number.isFinite(index)) return 0;
      return Math.min(Math.max(Math.floor(index), 0), total - 1);
    },

    // 渲染常用语弹层列表，并按搜索词过滤候选项。
    renderFastReplyPickerList() {
      if (!runtime.ui || !runtime.ui.fastReplyList) return;

      const replies = config.fastReplies || [];
      const selectedIndex = this.getSafeFastReplyIndex(replies);
      const keyword = normalizeText(runtime.ui.fastReplySearch && runtime.ui.fastReplySearch.value).toLowerCase();
      const matchedReplies = replies
        .map((item, index) => ({
          index,
          text: normalizeMessageText((item && item.text) || `常用语 ${index + 1}`),
        }))
        .filter((item) => !keyword || item.text.toLowerCase().includes(keyword));

      if (runtime.ui.fastReplyCount) {
        runtime.ui.fastReplyCount.textContent = keyword
          ? `${matchedReplies.length}/${replies.length} 条`
          : `${replies.length} 条`;
      }

      runtime.ui.fastReplyList.innerHTML = matchedReplies.length
        ? matchedReplies.map((item) => {
            const selectedClass = item.index === selectedIndex ? ' za-selected' : '';
            const selectedLabel = item.index === selectedIndex ? '<span class="za-fast-reply-selected-mark">当前选中</span>' : '';
            return `
              <button type="button" class="za-fast-reply-option${selectedClass}" data-action="selectFastReply" data-index="${item.index}" aria-pressed="${item.index === selectedIndex ? 'true' : 'false'}">
                <span class="za-fast-reply-option-meta">常用语 ${item.index + 1}${selectedLabel}</span>
                <span class="za-fast-reply-option-text">${escapeHtml(item.text)}</span>
              </button>
            `;
          }).join('')
        : `<div class="za-fast-reply-empty">${replies.length ? '没有匹配的常用语' : '暂无常用语，请先刷新'}</div>`;
    },

    // 判断常用语选择弹层是否打开。
    isFastReplyPickerOpen() {
      return Boolean(runtime.ui && runtime.ui.fastReplyBackdrop && !runtime.ui.fastReplyBackdrop.hidden);
    },

    // 打开/关闭常用语选择弹层，并在关闭时清空搜索框。
    setFastReplyPickerOpen(open) {
      if (!runtime.ui || !runtime.ui.fastReplyBackdrop) return;

      const replies = config.fastReplies || [];
      const trigger = runtime.ui.fastReplyTrigger;
      const shouldOpen = Boolean(open && replies.length && !(trigger && trigger.disabled));
      runtime.ui.fastReplyBackdrop.hidden = !shouldOpen;
      runtime.ui.root.classList.toggle('za-fast-reply-open', shouldOpen);
      if (trigger) trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');

      if (shouldOpen) {
        this.renderFastReplyPickerList();
        setTimeout(() => {
          if (this.isFastReplyPickerOpen() && runtime.ui.fastReplySearch) runtime.ui.fastReplySearch.focus();
        }, 0);
        return;
      }

      if (runtime.ui.fastReplySearch && runtime.ui.fastReplySearch.value) {
        runtime.ui.fastReplySearch.value = '';
        this.renderFastReplyPickerList();
      }
    },

    // 更新常用语搜索词并重新渲染弹层列表。
    setFastReplySearch(value) {
      if (!runtime.ui || !runtime.ui.fastReplySearch) return;
      runtime.ui.fastReplySearch.value = value || '';
      this.renderFastReplyPickerList();
      runtime.ui.fastReplySearch.focus();
    },

    // 选择某条常用语并持久化索引。
    selectFastReply(index) {
      const replies = config.fastReplies || [];
      const nextIndex = Number(index);
      if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= replies.length) return;

      saveConfig({ fastReplyIndex: nextIndex });
      this.renderFastReplyOptions();
      this.setFastReplyPickerOpen(false);
    },

    // 渲染公司黑名单下拉多选，每条规则展示匹配模式，便于区分全量/部分/正则。
    renderCompanyBlacklistRules() {
      if (!runtime.ui || !runtime.ui.companyBlacklistOptionMenu) return;

      const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
      const selectedIds = this.getCompanyBlacklistSelectedIds(rules);
      const running = runtime.ui.root.classList.contains('za-running');
      runtime.ui.companyBlacklistOptionMenu.innerHTML = rules.length
        ? rules.map((rule) => {
            const checked = selectedIds.has(rule.id) ? ' checked' : '';
            const disabled = running ? ' disabled' : '';
            return `
              <div class="za-multi-option za-blacklist-option">
                <label class="za-blacklist-option-label">
                  <input data-role="companyBlacklistRuleOption" type="checkbox" value="${escapeHtml(rule.id)}"${checked}${disabled}>
                  <span title="${escapeHtml(rule.value)}">[${escapeHtml(getCompanyMatchModeLabel(rule.mode))}] ${escapeHtml(rule.value)}</span>
                </label>
                <button class="za-blacklist-delete" type="button" data-action="removeCompanyBlacklistRule" data-id="${escapeHtml(rule.id)}" title="删除该黑名单"${disabled}>×</button>
              </div>
            `;
          }).join('')
        : '<div class="za-empty-text">暂无公司黑名单</div>';

      if (runtime.ui.companyBlacklistDropdownText) {
        runtime.ui.companyBlacklistDropdownText.textContent = rules.length
          ? selectedIds.size
            ? `已选 ${selectedIds.size}/${rules.length} 条`
            : `已添加 ${rules.length} 条`
          : '暂无公司黑名单';
      }

      const trigger = runtime.ui.companyBlacklistDropdown &&
        runtime.ui.companyBlacklistDropdown.querySelector('[data-action="toggleCompanyBlacklistDropdown"]');
      if (trigger) {
        trigger.disabled = running || !rules.length;
        trigger.setAttribute('aria-expanded', this.isCompanyBlacklistDropdownOpen() ? 'true' : 'false');
      }
      runtime.ui.companyBlacklistOptionMenu.querySelectorAll('input[data-role="companyBlacklistRuleOption"]').forEach((input) => {
        input.disabled = running;
      });
      if (runtime.ui.companyBlacklistRemoveButton) {
        runtime.ui.companyBlacklistRemoveButton.disabled = running || !selectedIds.size;
      }
      if (runtime.ui.companyBlacklistClearButton) {
        runtime.ui.companyBlacklistClearButton.disabled = running || !rules.length;
      }
      if (!rules.length) this.setCompanyBlacklistDropdownOpen(false);
    },

    // 获取当前用于删除的黑名单勾选项，并清掉已不存在的规则 ID。
    getCompanyBlacklistSelectedIds(rules) {
      const availableIds = new Set((rules || normalizeCompanyBlacklistRules(config.companyBlacklistRules)).map((rule) => rule.id));
      const selectedIds = runtime.ui.companyBlacklistSelectedIds instanceof Set
        ? runtime.ui.companyBlacklistSelectedIds
        : new Set();
      Array.from(selectedIds).forEach((id) => {
        if (!availableIds.has(id)) selectedIds.delete(id);
      });
      runtime.ui.companyBlacklistSelectedIds = selectedIds;
      return selectedIds;
    },

    // 判断公司黑名单下拉是否打开。
    isCompanyBlacklistDropdownOpen() {
      return Boolean(runtime.ui && runtime.ui.companyBlacklistOptionMenu && !runtime.ui.companyBlacklistOptionMenu.hidden);
    },

    // 打开/关闭公司黑名单下拉，并同步 aria 状态。
    setCompanyBlacklistDropdownOpen(open) {
      if (!runtime.ui || !runtime.ui.companyBlacklistOptionMenu || !runtime.ui.companyBlacklistDropdown) return;
      const trigger = runtime.ui.companyBlacklistDropdown.querySelector('[data-action="toggleCompanyBlacklistDropdown"]');
      const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
      const shouldOpen = Boolean(open && rules.length && !(trigger && trigger.disabled));
      runtime.ui.companyBlacklistOptionMenu.hidden = !shouldOpen;
      runtime.ui.companyBlacklistDropdown.classList.toggle('za-open', shouldOpen);
      if (trigger) trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    },

    // 勾选或取消某个黑名单规则，仅影响“删除选中”的临时选择状态。
    setCompanyBlacklistRuleSelected(id, selected, keepDropdownOpen) {
      const key = normalizeText(id);
      if (!key || !runtime.ui) return;

      const selectedIds = this.getCompanyBlacklistSelectedIds();
      if (selected) {
        selectedIds.add(key);
      } else {
        selectedIds.delete(key);
      }
      this.renderCompanyBlacklistRules();
      this.setCompanyBlacklistDropdownOpen(Boolean(keepDropdownOpen));
    },

    // 添加公司黑名单规则，保存前校验正则并按“模式+文本”去重。
    addCompanyBlacklistRule() {
      const root = runtime.ui && runtime.ui.root;
      if (!root) return;

      const modeField = root.querySelector('[data-field="companyBlacklistMode"]');
      const valueField = root.querySelector('[data-field="companyBlacklistValue"]');
      const mode = getCompanyMatchMode(modeField && modeField.value);
      const value = normalizeText(valueField && valueField.value);
      if (!value) {
        UI.setStatus('请输入公司黑名单文本', 'warn');
        return;
      }
      if (mode === 'regex') {
        try {
          new RegExp(value);
        } catch (error) {
          UI.setStatus(`公司黑名单正则无效：${error.message}`, 'error');
          return;
        }
      }

      const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
      const exists = rules.some((rule) => rule.mode === mode && rule.value === value);
      if (exists) {
        UI.setStatus('该公司黑名单已存在', 'warn');
        if (valueField) valueField.value = '';
        saveConfig({ companyBlacklistMode: mode, companyBlacklistValue: '' });
        return;
      }

      const key = `${mode}:${value}`;
      const nextRule = {
        id: `black_${hashString(`${key}:${Date.now()}`)}`,
        mode,
        value,
      };
      saveConfig({
        companyBlacklistMode: mode,
        companyBlacklistValue: '',
        companyBlacklistRules: rules.concat(nextRule),
      });
      if (valueField) valueField.value = '';
      this.renderCompanyBlacklistRules();
      UI.setStatus(`已添加公司黑名单：${getCompanyMatchModeLabel(mode)} / ${value}`, 'ok');
    },

    // 删除当前勾选的公司黑名单规则，支持一次删除多条。
    removeCompanyBlacklistRule(id) {
      const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
      const selectedIds = id
        ? new Set([normalizeText(id)].filter(Boolean))
        : new Set(this.getCompanyBlacklistSelectedIds(rules));
      if (!selectedIds.size) {
        UI.setStatus('请选择要移除的公司黑名单', 'warn');
        return;
      }

      const nextRules = rules.filter((rule) => !selectedIds.has(rule.id));
      if (nextRules.length === rules.length) return;

      if (id) {
        this.getCompanyBlacklistSelectedIds(rules).delete(normalizeText(id));
      } else {
        runtime.ui.companyBlacklistSelectedIds = new Set();
      }
      saveConfig({ companyBlacklistRules: nextRules });
      this.renderCompanyBlacklistRules();
      this.setCompanyBlacklistDropdownOpen(Boolean(nextRules.length));
      UI.setStatus(`已删除 ${rules.length - nextRules.length} 条公司黑名单`, 'ok');
    },

    // 删除全部公司黑名单规则。
    async clearCompanyBlacklistRules() {
      const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
      if (!rules.length) {
        UI.setStatus('暂无公司黑名单可删除', 'warn');
        return;
      }

      let confirmed = false;
      try {
        confirmed = await askConfirm(`确定删除全部 ${rules.length} 条公司黑名单吗？`);
      } catch (error) {
        UI.setStatus(error.message || '无法打开确认弹窗', 'error');
        return;
      }
      if (!confirmed) return;

      runtime.ui.companyBlacklistSelectedIds = new Set();
      saveConfig({ companyBlacklistRules: [] });
      this.renderCompanyBlacklistRules();
      this.setCompanyBlacklistDropdownOpen(false);
      UI.setStatus('已删除全部公司黑名单', 'ok');
    },

    // 渲染 Boss 活跃度下拉多选、已选标签和自定义选项标签。
    renderBossActiveFilterOptions() {
      if (!runtime.ui || !runtime.ui.bossActiveOptionMenu) return;

      const selectedKeys = new Set(getSelectedBossActiveKeys());
      const selectedOptions = normalizeBossActiveOptions(config.bossActiveFilterValues);
      const options = getBossActiveFilterOptions(config.bossActiveCustomOptions);
      runtime.ui.bossActiveOptionMenu.innerHTML = options.map((item) => {
        const checked = selectedKeys.has(normalizeBossActiveText(item)) ? ' checked' : '';
        return `
          <label class="za-multi-option">
            <input data-role="bossActiveOption" type="checkbox" value="${escapeHtml(item)}"${checked}>
            <span>${escapeHtml(item)}</span>
          </label>
        `;
      }).join('');

      runtime.ui.bossActiveDropdownText.textContent = selectedOptions.length
        ? `已选 ${selectedOptions.length} 项`
        : '选择 Boss 活跃度';
      runtime.ui.bossActiveSelectedList.innerHTML = selectedOptions.length
        ? selectedOptions.map((item) => `
          <span class="za-selected-chip">
            <span>${escapeHtml(item)}</span>
            <button type="button" data-action="removeBossActiveSelection" data-value="${escapeHtml(item)}" title="移除该活跃度">×</button>
          </span>
        `).join('')
        : '<span class="za-empty-text">未选择，默认不过滤 Boss 活跃度</span>';

      const customOptions = normalizeBossActiveOptions(config.bossActiveCustomOptions);
      runtime.ui.bossActiveCustomList.innerHTML = customOptions.length
        ? customOptions.map((item) => `
          <span class="za-option-chip">
            <span>${escapeHtml(item)}</span>
            <button type="button" data-action="deleteBossActiveOption" data-value="${escapeHtml(item)}" title="删除自定义活跃度">×</button>
          </span>
        `).join('')
        : '<span class="za-empty-text">暂无自定义选项</span>';
    },

    // 判断 Boss 活跃度下拉是否打开。
    isBossActiveDropdownOpen() {
      return Boolean(runtime.ui && runtime.ui.bossActiveOptionMenu && !runtime.ui.bossActiveOptionMenu.hidden);
    },

    // 打开/关闭 Boss 活跃度下拉，并同步 aria 状态。
    setBossActiveDropdownOpen(open) {
      if (!runtime.ui || !runtime.ui.bossActiveOptionMenu || !runtime.ui.bossActiveDropdown) return;
      const trigger = runtime.ui.bossActiveDropdown.querySelector('[data-action="toggleBossActiveDropdown"]');
      const shouldOpen = Boolean(open && !(trigger && trigger.disabled));
      runtime.ui.bossActiveOptionMenu.hidden = !shouldOpen;
      runtime.ui.bossActiveDropdown.classList.toggle('za-open', shouldOpen);
      if (trigger) trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    },

    // 勾选或取消某个 Boss 活跃度选项，并保存到配置。
    setBossActiveOptionSelected(value, selected, keepDropdownOpen) {
      const key = normalizeBossActiveText(value);
      if (!key) return;

      const selectedOptions = normalizeBossActiveOptions(config.bossActiveFilterValues);
      const exists = selectedOptions.some((item) => normalizeBossActiveText(item) === key);
      let nextOptions = selectedOptions;
      if (selected && !exists) {
        nextOptions = selectedOptions.concat(getBossActiveOptionLabel(value));
      } else if (!selected) {
        nextOptions = selectedOptions.filter((item) => normalizeBossActiveText(item) !== key);
      }

      saveConfig({ bossActiveFilterValues: nextOptions });
      this.renderBossActiveFilterOptions();
      this.setBossActiveDropdownOpen(Boolean(keepDropdownOpen));
    },

    // 从已选列表中移除某个 Boss 活跃度。
    removeBossActiveSelection(value) {
      this.setBossActiveOptionSelected(value, false);
    },

    // 添加自定义 Boss 活跃度选项，去重后写入配置。
    addBossActiveCustomOption() {
      if (!runtime.ui || !runtime.ui.bossActiveCustomInput) return;
      const input = runtime.ui.bossActiveCustomInput;
      const text = getBossActiveOptionLabel(input.value);
      const key = normalizeBossActiveText(text);
      if (!key) {
        UI.setStatus('请输入 Boss 活跃度文本', 'warn');
        return;
      }
      if (BOSS_ACTIVE_BUILTIN_KEYS.has(key)) {
        UI.setStatus('该活跃度已是内置选项', 'warn');
        input.value = '';
        return;
      }

      const customOptions = normalizeBossActiveOptions(config.bossActiveCustomOptions);
      if (customOptions.some((item) => normalizeBossActiveText(item) === key)) {
        UI.setStatus('该自定义活跃度已存在', 'warn');
        input.value = '';
        return;
      }

      saveConfig({ bossActiveCustomOptions: customOptions.concat(text) });
      input.value = '';
      this.renderBossActiveFilterOptions();
      UI.setStatus(`已添加自定义活跃度：${text}`, 'ok');
    },

    // 删除自定义 Boss 活跃度，并同步清理已选过滤值。
    deleteBossActiveCustomOption(value) {
      const key = normalizeBossActiveText(value);
      if (!key || BOSS_ACTIVE_BUILTIN_KEYS.has(key)) return;

      const customOptions = normalizeBossActiveOptions(config.bossActiveCustomOptions)
        .filter((item) => normalizeBossActiveText(item) !== key);
      const selectedOptions = normalizeBossActiveOptions(config.bossActiveFilterValues)
        .filter((item) => normalizeBossActiveText(item) !== key);
      saveConfig({
        bossActiveCustomOptions: customOptions,
        bossActiveFilterValues: selectedOptions,
      });
      this.renderBossActiveFilterOptions();
    },

    // 更新面板状态条；被 lockStatus 锁定时，普通状态不会覆盖关键错误/暂停提示。
    setStatus(message, type, options) {
      if (!runtime.ui) return;
      if (runtime.statusLock && !(options && options.force)) return;
      runtime.ui.status.textContent = message || '';
      runtime.ui.status.dataset.type = type || 'info';
    },

    // 锁定状态提示，通常用于 fatal/pause，避免后续异步任务覆盖真正停机原因。
    lockStatus(message, type) {
      runtime.statusLock = {
        message: message || '',
        type: type || 'info',
        lockedAt: Date.now(),
      };
      this.setStatus(runtime.statusLock.message, runtime.statusLock.type, { force: true });
    },

    // 手动操作或重新启动前解除状态锁。
    unlockStatus() {
      runtime.statusLock = null;
    },

    // 切换运行态：禁用启动按钮、启用停止按钮，并锁定会影响流程的配置项。
    setRunning(running) {
      if (!runtime.ui) return;
      runtime.ui.root.classList.toggle('za-running', Boolean(running));
      const start = runtime.ui.root.querySelector('[data-action="start"]');
      const stop = runtime.ui.root.querySelector('[data-action="stop"]');
      if (start) start.disabled = Boolean(running);
      if (stop) stop.disabled = !running;
      this.setRuntimeConfigLocked(Boolean(running));
    },

    // 运行中锁定配置，防止正在循环时更改等待时间、问候语来源等关键参数。
    setRuntimeConfigLocked(locked) {
      const root = runtime.ui.root;
      if (locked) {
        this.setFastReplyPickerOpen(false);
        this.setCompanyBlacklistDropdownOpen(false);
        this.setBossActiveDropdownOpen(false);
      }

      root.querySelectorAll('[data-field]').forEach((field) => {
        if (isRuntimeLockExemptField(field.dataset.field)) return;
        field.disabled = locked;
      });

      root.querySelectorAll('input[name="za-greeting-mode"], input[name="za-text-source"]').forEach((field) => {
        field.disabled = locked;
      });

      root.querySelectorAll('[data-lock-field], [data-role="companyBlacklistRuleOption"], [data-role="bossActiveOption"], [data-action="toggleCompanyBlacklistDropdown"], [data-action="toggleBossActiveDropdown"], [data-action="removeBossActiveSelection"]').forEach((field) => {
        field.disabled = locked;
      });

      const refreshFastReplies = root.querySelector('[data-action="refreshFastReplies"]');
      if (refreshFastReplies) refreshFastReplies.disabled = locked;

      if (runtime.ui.fastReplyTrigger) {
        runtime.ui.fastReplyTrigger.disabled = Boolean(locked || !(config.fastReplies || []).length);
        runtime.ui.fastReplyTrigger.setAttribute('aria-expanded', 'false');
      }
      root.querySelectorAll('[data-role="fastReplySearch"], [data-action="clearFastReplySearch"]').forEach((field) => {
        field.disabled = locked;
      });

      root.querySelectorAll('[data-action="addCompanyBlacklistRule"], [data-action="removeCompanyBlacklistRule"], [data-action="clearCompanyBlacklistRules"], [data-action="addBossActiveOption"], [data-action="deleteBossActiveOption"]').forEach((button) => {
        button.disabled = locked;
      });
      this.renderCompanyBlacklistRules();
    },

    // 从 IndexedDB 读取已沟通记录并刷新虚拟列表。
    async refreshGreetedList(options) {
      try {
        const rows = await loadGreetedRows();
        runtime.ui.greetedRows = rows;
        if (options && options.scrollTop && runtime.ui.listViewport) {
          runtime.ui.listViewport.scrollTop = 0;
        }
        this.renderVirtualList();
      } catch (error) {
        console.warn('[ZhipinAuto] 读取已沟通列表失败', error);
      }
    },

    // 发送成功后把最新记录插入/更新到 UI 列表，不必全量重读 IndexedDB。
    upsertGreetedRecord(record) {
      if (!runtime.ui || !isContactedRecord(record)) return;

      const rows = runtime.ui.greetedRows || [];
      const index = rows.findIndex((item) => item.id === record.id);
      if (index >= 0) {
        rows[index] = Object.assign({}, rows[index], record);
      } else {
        rows.unshift(record);
      }

      runtime.ui.greetedRows = sortGreetedRows(rows);
      if (runtime.ui.listViewport) runtime.ui.listViewport.scrollTop = 0;
      this.renderVirtualList();
    },

    // 虚拟列表渲染：只生成当前视口附近的行，避免记录很多时拖慢页面。
    renderVirtualList() {
      if (!runtime.ui) return;

      const viewport = runtime.ui.listViewport;
      const rows = runtime.ui.greetedRows || [];
      const rowHeight = runtime.ui.rowHeight;
      const start = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 2);
      const visibleCount = Math.ceil(viewport.clientHeight / rowHeight) + 5;
      const end = Math.min(rows.length, start + visibleCount);

      runtime.ui.listSpacer.style.height = `${rows.length * rowHeight}px`;
      runtime.ui.listItems.innerHTML = rows.slice(start, end).map((row, offset) => {
        const top = (start + offset) * rowHeight;
        const salary = getDisplaySalary(row) || '-';
        return `
          <div class="za-list-row" style="transform: translateY(${top}px)">
            <strong>${escapeHtml(row.jobName || '未知岗位')}</strong>
            <span>${escapeHtml(salary)} · ${escapeHtml(getDisplayCompany(row) || '未知公司')}</span>
          </div>
        `;
      }).join('');
    },
  };

  // 读取已沟通列表：优先使用 jobRecords 中的 sent/skipped 记录，再兼容 greetedJobs 旧投影。
  async function loadGreetedRows() {
    const [jobRows, greetedRows] = await Promise.all([
      Database.getAll('jobRecords').catch(() => []),
      Database.getAll('greetedJobs').catch(() => []),
    ]);
    const byId = new Map();

    jobRows.filter((record) => record && record.status === 'sent').forEach((record) => {
      byId.set(record.id, record);
    });
    greetedRows.filter(Boolean).forEach((record) => {
      byId.set(record.id, Object.assign({}, byId.get(record.id) || {}, record));
    });

    return sortGreetedRows(Array.from(byId.values()));
  }

  // 已沟通列表按沟通时间倒序展示，时间缺失时再按更新时间/创建时间兜底。
  function sortGreetedRows(rows) {
    return Array.from(rows || []).sort((a, b) => {
      const left = String(b.sentAt || b.updatedAt || b.clickedAt || '');
      const right = String(a.sentAt || a.updatedAt || a.clickedAt || '');
      return left.localeCompare(right);
    });
  }

  // 常用语接口：读取 BOSS 聊天侧的常用语列表。
  // 获取失败时不阻塞自动化流程，后续会退回默认问候语文本。
  const FastReplyService = {
    // 调用 BOSS 常用语接口并写入配置，UI 下拉框随之刷新。
    async refresh(showStatus) {
      if (showStatus) UI.setStatus('正在获取常用语...', 'info');

      try {
        const url = `${APP.fastReplyUrl}?_=${Date.now()}`;
        const response = await fetch(url, {
          credentials: 'include',
          headers: { accept: 'application/json, text/plain, */*' },
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const replies = this.extractReplies(payload);
        if (!replies.length) throw new Error('接口中没有识别到常用语');

        saveConfig({
          fastReplies: replies,
          fastReplyIndex: Math.min(config.fastReplyIndex || 0, replies.length - 1),
        });
        UI.renderFastReplyOptions();
        UI.setStatus(`常用语获取成功：${replies.length} 条`, 'ok');
      } catch (error) {
        saveConfig({ fastReplies: [] });
        UI.renderFastReplyOptions();
        UI.setStatus(`获取常用语失败，将使用默认问候语文本：${error.message}`, 'warn');
      }
    },

    // 从不稳定的接口结构中递归提取文本，去重后作为可选常用语。
    extractReplies(payload) {
      const replies = [];
      const seen = new Set();
      const textKeys = ['content', 'text', 'replyContent', 'sentence', 'sentenceContent', 'message', 'word'];

      walkObject(payload, (value) => {
        if (typeof value === 'string') return;

        if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string') {
              addReply(item);
              continue;
            }

            if (!item || typeof item !== 'object') continue;
            for (const key of textKeys) {
              if (typeof item[key] === 'string') {
                addReply(item[key], item.id || item.fastReplyId || item.replyId);
                break;
              }
            }
          }
        }
      });

      function addReply(text, id) {
        const normalized = normalizeText(text);
        if (!normalized || normalized.length > 500 || seen.has(normalized)) return;
        seen.add(normalized);
        replies.push({ id: id || hashString(normalized), text: normalized });
      }

      return replies.slice(0, 100);
    },
  };

  // 发送服务：常用语、自定义文本、自定义接口返回文本都会先解析为最终文案，
  // 再统一注入聊天输入框并触发发送，发送后会校验聊天记录中是否出现新消息。
  const GreetingService = {
    // 根据当前配置解析最终问候语，并走统一发送流程。
    async sendCurrent(job) {
      const resolved = config.greetingMode === 'fastReply'
        ? await this.resolveFastReplyText(job)
        : {
            messageType: 'customText',
            text: await this.resolveCustomText(job),
          };

      return this.sendText(resolved.text, job, resolved.messageType);
    },

    // 常用语模式：优先使用已缓存常用语，缺失时刷新接口，最后退回默认问候语。
    async resolveFastReplyText(job) {
      if (config.greetingMode === 'fastReply') {
        const selected = (config.fastReplies || [])[config.fastReplyIndex || 0];

        if (selected && selected.text) {
          return {
            messageType: 'fastReplyText',
            text: interpolateText(selected.text, job),
          };
        }

        try {
          await FastReplyService.refresh(false);
        } catch (_) {}

        const refreshed = (config.fastReplies || [])[config.fastReplyIndex || 0] || (config.fastReplies || [])[0];
        return {
          messageType: 'fastReplyText',
          text: interpolateText((refreshed && refreshed.text) || config.customText || APP.defaultGreetingText, job),
        };
      }

      return {
        messageType: 'customText',
        text: await this.resolveCustomText(job),
      };
    },

    // 自定义模式：可以直接使用文本模板，也可以请求外部 API 生成文本。
    async resolveCustomText(job) {
      if (config.textSource !== 'api') {
        return interpolateText(config.customText, job);
      }

      if (!config.customApiUrl) throw new Error('自定义文本接口为空');

      const payload = {
        job: flattenJob(job),
        location: location.href,
        time: nowIso(),
      };
      const text = await requestExternalText(config.customApiUrl, config.customApiMethod, payload);
      return interpolateText(text, job);
    },

    // 等待聊天页可用、写入消息、触发发送，并确认聊天记录中出现新消息。
    async sendText(text, job, messageType) {
      const finalText = normalizeMessageText(text);
      if (!finalText) throw new Error('问候语文本为空');

      await waitForChatReady(job);
      const beforeSend = await sendChatTextByEnter(finalText);
      await waitForMessageSent(finalText, beforeSend);

      return {
        messageType: messageType || 'customText',
        messagePreview: finalText.slice(0, 120),
      };
    },
  };

  // 自动化状态机：list -> chat -> returning -> list。
  // list：遍历岗位卡片并点击沟通；chat：在聊天页发送问候；returning：发送后回到岗位列表。
  // BOSS 的沟通按钮会触发页面跳转，状态必须写入 localStorage，脚本重载后才能继续。
  const Automation = {
    // 手动点击“开始”后的入口：校验配置、初始化存储和索引，然后进入列表循环。
    async start() {
      if (runtime.automationLoopActive) return;

      UI.unlockStatus();
      UI.saveFormToConfig();
      const validation = validateConfig();
      if (validation) {
        this.fatal(validation);
        return;
      }

      UI.setRunning(true);
      UI.setStatus('正在准备自动沟通...', 'info');

      try {
        await Database.open();
        await Database.ensureStorageAvailable();
        await ContactedIndex.ensureReady();
        JobRepository.syncCards();
      } catch (error) {
        this.fatal(error.message || String(error));
        return;
      }

      const startIndex = findSelectedCardIndex();
      // 启动时从当前选中的岗位附近开始，避免用户已经手动滚动/选择后又从第一页第一个岗位重跑。
      RunState.save({
        active: true,
        phase: 'list',
        cursorIndex: Math.max(0, startIndex),
        sentCount: 0,
        processedKeys: [],
        pendingJob: null,
        nextRunAt: null,
        nextDelaySeconds: null,
        pendingRawJob: null,
        chatButtonText: '',
        listUrl: location.href,
        returnAttempts: 0,
        returnStartedAt: null,
        stopReason: '',
        pauseReason: '',
        listSnapshot: createJobListSnapshot(),
        chatOpenRetryCount: 0,
        startedAt: nowIso(),
      });

      runtime.stopRequested = false;
      this.runListLoop('start');
    },

    // 停止自动化：写入 RunState，并解锁 UI。
    stop(reason, options) {
      runtime.stopRequested = true;
      runtime.automationLoopActive = false;
      RunState.stop(reason || '已停止');
      UI.setRunning(false);
      if (options && options.manual) {
        UI.lockStatus('已停止', 'warn');
      } else {
        UI.unlockStatus();
        UI.setStatus(reason || '已停止', 'warn');
      }
    },

    // 暂停自动化：保留当前状态给用户判断，但不再自动继续。
    pause(reason) {
      runtime.stopRequested = true;
      runtime.automationLoopActive = false;
      UI.unlockStatus();
      RunState.pause(reason || '已暂停');
      UI.setRunning(false);
      UI.setStatus(reason || '已暂停', 'warn');
    },

    // 页面加载、pageshow 或路由切换时调用，根据 RunState 恢复 list/chat/returning 阶段。
    async resumeIfNeeded(reason) {
      const state = RunState.load();
      if (!state || !state.active || runtime.automationLoopActive) return;

      // 页面跳转或刷新后先恢复 IndexedDB 和已沟通索引，再根据 phase 继续对应阶段。
      try {
        await Database.open();
        await Database.ensureStorageAvailable();
        await ContactedIndex.ensureReady();
      } catch (error) {
        this.fatal(error.message || String(error));
        return;
      }
      runtime.stopRequested = false;
      UI.setRunning(true);

      if (state.phase === 'returning') {
        runtime.automationLoopActive = true;
        UI.setStatus('正在恢复返回岗位列表...', 'info');
        try {
          await this.completeReturnToList(state, reason || 'returning');
        } catch (error) {
          runtime.automationLoopActive = false;
          this.fatal(error.message || String(error));
        }
        return;
      }

      if ((state.phase === 'chat' || isChatPage()) && state.pendingJob) {
        this.continueFromChat(reason);
        return;
      }

      if (state.phase === 'chat' && !state.pendingJob) {
        this.fatal('运行状态缺少待沟通岗位，请重新启动脚本');
        return;
      }

      this.runListLoop(reason);
    },

    // 列表页主循环：按 cursorIndex 处理岗位卡片，直到停止或列表结束。
    async runListLoop(reason) {
      if (runtime.automationLoopActive) return;

      runtime.automationLoopActive = true;
      UI.setRunning(true);
      UI.setStatus(`自动沟通运行中：${reason || 'list'}`, 'info');

      try {
        // 列表页先等 DOM 卡片和接口数据都就绪，DOM 负责点击，接口数据负责准确记录岗位字段。
        await waitForElement('li.job-card-box', getWaitTimeout(), '岗位列表');
        await JobRepository.waitForApiData(1800);
        JobRepository.syncCards();

        while (!runtime.stopRequested) {
          const state = RunState.load();
          if (!state || !state.active) break;

          const processed = await this.processNextCard(state);
          if (processed === 'navigating') return;
          if (processed === 'done') {
            this.stop('没有更多符合条件的岗位');
            break;
          }

          const waitMs = randomDelayMs(config.delayMin, config.delayMax);
          await waitWithStatusCountdown(Date.now() + waitMs, (remainingSeconds) => `等待 ${remainingSeconds} 秒后继续...`);
        }
      } catch (error) {
        this.fatal(error.message || String(error));
      } finally {
        runtime.automationLoopActive = false;
        const state = RunState.load();
        UI.setRunning(Boolean(state && state.active && !runtime.stopRequested));
      }
    },

    // 处理当前游标岗位：等待列表数据、跳过过滤项/已沟通项，或点击沟通进入聊天。
    async processNextCard(state) {
      let cursorIndex = Number(state.cursorIndex || 0);
      if (!runtime.jobPool.length) {
        await JobRepository.waitForApiData(1200);
      }
      let cards = JobRepository.syncCards();

      // 当前已加载卡片不够时向下滚动，等待 BOSS 懒加载更多岗位。
      while (cursorIndex >= cards.length) {
        const loaded = await scrollAndWaitForMore(cards.length);
        cards = JobRepository.syncCards();
        if (!loaded && cursorIndex >= cards.length) return 'done';
      }

      while (cursorIndex < cards.length) {
        const card = cards[cursorIndex];
        const job = runtime.cardJobMap.get(card) || JobRepository.normalizeDomOnlyJob(card, cursorIndex);
        const domInfo = extractCardInfo(card);
        logDebugEvent('process_card', {
          cursorIndex,
          job: summarizeJobForDebug(job),
          domInfo: summarizeDomInfoForDebug(domInfo),
          listState: getDebugListState(),
        });

        // 公司筛选、黑名单和已沟通跳过都在点击沟通前完成，减少无意义的详情页/聊天页跳转。
        if (!companyMatches(job.company || domInfo.company)) {
          cursorIndex += 1;
          RunState.patch({ cursorIndex });
          continue;
        }

        const blacklistDecision = findCompanyBlacklistMatch(job, domInfo.company);
        if (blacklistDecision) {
          await this.skipCompanyBlacklist(job, cursorIndex, blacklistDecision);
          cursorIndex += 1;
          continue;
        }

        if (config.skipContacted && ContactedIndex.has(job)) {
          UI.setStatus(`本地记录已沟通，跳过：${job.jobName || ''} / ${job.company || ''}`, 'warn');
          await Database.saveJobRecord(job, {
            status: 'skipped_local_contacted',
            listIndex: cursorIndex,
            skippedAt: nowIso(),
            pageUrl: location.href,
          });
          cursorIndex += 1;
          RunState.patch({ cursorIndex });
          scrollAhead(cursorIndex);
          continue;
        }

        return this.communicateWithCard(card, job, cursorIndex);
      }

      return 'done';
    },

    // 公司黑名单命中时记录跳过原因并推进游标；该状态不会加入已沟通判重集合。
    async skipCompanyBlacklist(job, cursorIndex, decision) {
      const rule = decision && decision.rule || {};
      const matchedCompany = normalizeText(decision && decision.company) || getDisplayCompany(job) || '未知公司';
      const modeLabel = getCompanyMatchModeLabel(rule.mode);
      UI.setStatus(`公司黑名单命中，跳过：${matchedCompany}`, 'warn');
      logDebugEvent('skip_company_blacklist', {
        cursorIndex,
        matchedCompany,
        rule: {
          mode: rule.mode,
          modeLabel,
          value: rule.value,
        },
        job: summarizeJobForDebug(job),
      }, 'warn');
      await Database.saveJobRecord(job, {
        status: 'skipped_blacklist',
        listIndex: cursorIndex,
        skippedAt: nowIso(),
        skipReason: 'company_blacklist',
        blacklistMode: rule.mode,
        blacklistModeLabel: modeLabel,
        blacklistValue: rule.value,
        blacklistMatchedCompany: matchedCompany,
        pageUrl: location.href,
      });
      RunState.patch({ cursorIndex: cursorIndex + 1 });
      scrollAhead(cursorIndex + 1);
      return 'processed';
    },

    // 单个岗位的沟通流程：选中卡片、补详情、保存 clicked、点击沟通按钮。
    async communicateWithCard(card, job, cursorIndex) {
      UI.setStatus(`选择岗位：${job.jobName || '未知岗位'} / ${job.company || '未知公司'}`, 'info');
      logDebugEvent('communicate_start', {
        cursorIndex,
        job: summarizeJobForDebug(job),
        domInfo: summarizeDomInfoForDebug(extractCardInfo(card)),
        runState: RunState.load(),
        listState: getDebugListState(),
      });

      card.scrollIntoView({ block: 'center', inline: 'nearest' });
      const detailResourceStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
      // 先点岗位卡片让右侧详情刷新，再从详情接口/DOM 里补充岗位信息。
      clickElement(card);
      await sleep(700);

      const chatButton = await waitFor(() => findChatButton(job), getWaitTimeout(), '当前岗位沟通按钮');
      const buttonText = normalizeText(chatButton.innerText || chatButton.textContent || '');
      logDebugEvent('chat_button_found', {
        cursorIndex,
        buttonText,
        buttonHref: chatButton.getAttribute('href'),
        buttonKa: chatButton.getAttribute('ka'),
        job: summarizeJobForDebug(job),
      });
      const apiDetail = await JobRepository.waitForJobDetail(
        job,
        Math.min(3200, getWaitTimeout() * 1000),
        detailResourceStartedAt,
        { includeHtml: false, forceApiFetch: true },
      );
      const domDetail = extractDetailInfo();
      job = mergeJobInfo(job, apiDetail || domDetail);
      if (apiDetail && !getDisplayBossActiveTime(job) && domDetail.bossActiveTimeDesc) {
        job = mergeJobInfo(job, {
          bossActiveTimeDesc: domDetail.bossActiveTimeDesc,
          bossOnline: domDetail.bossOnline,
        });
      }
      job = await enrichBossActiveInfoForFilter(job);
      logDebugEvent('job_detail_merged_before_chat', {
        cursorIndex,
        job: summarizeJobForDebug(job),
        apiDetail: summarizeJobForDebug(apiDetail),
        domDetail: summarizeJobForDebug(domDetail),
      });

      const blacklistDecision = findCompanyBlacklistMatch(job);
      if (blacklistDecision) {
        return this.skipCompanyBlacklist(job, cursorIndex, blacklistDecision);
      }

      const activeDecision = bossActiveMatches(job);
      if (!activeDecision.matched) {
        const activeText = activeDecision.activeText || '未识别';
        UI.setStatus(`Boss活跃度不匹配，跳过：${activeText}`, 'warn');
        logDebugEvent('skip_boss_active_filter', {
          cursorIndex,
          activeText,
          selectedText: activeDecision.selectedText,
          job: summarizeJobForDebug(job),
        }, 'warn');
        await Database.saveJobRecord(job, {
          status: 'skipped_boss_active',
          listIndex: cursorIndex,
          skippedAt: nowIso(),
          skipReason: 'boss_active_filter',
          bossActiveFilterValues: normalizeBossActiveOptions(config.bossActiveFilterValues),
          pageUrl: location.href,
        });
        RunState.patch({ cursorIndex: cursorIndex + 1 });
        scrollAhead(cursorIndex + 1);
        return 'processed';
      }

      const fullDetail = await JobRepository.waitForJobDetail(
        job,
        Math.min(8000, Math.max(4500, getWaitTimeout() * 1000)),
        detailResourceStartedAt,
        { includeHtml: true, forceApiFetch: true },
      );
      if (fullDetail) {
        job = mergeJobInfo(job, fullDetail);
      }
      logDebugEvent('job_detail_completed_before_chat', {
        cursorIndex,
        job: summarizeJobForDebug(job),
        fullDetail: summarizeJobForDebug(fullDetail),
      });

      await Database.saveJobRecord(job, {
        status: 'clicked',
        listIndex: cursorIndex,
        clickedAt: nowIso(),
        pageUrl: location.href,
      });

      if (/继续沟通/.test(buttonText) && config.skipContacted) {
        UI.setStatus(`跳过已沟通：${job.jobName || ''} / ${job.company || ''}`, 'warn');
        await Database.saveJobRecord(job, {
          status: 'skipped_contacted',
          chatButtonText: buttonText,
          skippedAt: nowIso(),
          pageUrl: location.href,
        });
        RunState.patch({ cursorIndex: cursorIndex + 1 });
        scrollAhead(cursorIndex + 1);
        return 'processed';
      }

      // 点击沟通前先保存 pendingJob；聊天页加载后会从 localStorage 取出它并继续发送。
      RunState.patch({
        active: true,
        phase: 'chat',
        cursorIndex,
        pendingJob: flattenJob(job),
        pendingRawJob: job.rawJob || null,
        chatButtonText: buttonText,
        listUrl: location.href,
        listSnapshot: createJobListSnapshot(),
        chatOpenRetryCount: 0,
      });

      clickElement(chatButton);
      logDebugEvent('chat_button_clicked', {
        cursorIndex,
        job: summarizeJobForDebug(job),
        chatButtonText: buttonText,
        listUrl: location.href,
      });
      UI.setStatus('已进入聊天页，等待发送...', 'info');

      await sleep(1200);
      if (isChatPage()) {
        const latestState = RunState.load();
        if (latestState && latestState.active && latestState.phase === 'chat' && latestState.pendingJob) {
          runtime.automationLoopActive = false;
          setTimeout(() => this.continueFromChat('same-page'), 0);
        } else {
          logDebugEvent('same_page_continue_skipped', {
            reason: 'state_not_chat',
            latestState,
            clickedJob: summarizeJobForDebug(job),
          });
        }
      }

      return 'navigating';
    },

    // 聊天页续跑：从 RunState 恢复 pendingJob，发送问候语，写 sent 记录，再进入 returning。
    async continueFromChat(reason) {
      if (runtime.automationLoopActive) return;
      runtime.automationLoopActive = true;
      UI.setRunning(true);

      try {
        // 聊天页可能是新路由加载后的全新脚本实例，只能依赖 RunState 找回待发送岗位。
        const state = RunState.load();
        if (!state || !state.active) {
          runtime.automationLoopActive = false;
          UI.setRunning(false);
          logDebugEvent('continue_from_chat_ignored', { reason, state, cause: 'inactive' });
          return;
        }

        if (state.phase !== 'chat' || !state.pendingJob) {
          runtime.automationLoopActive = false;
          UI.setRunning(Boolean(state.active && !runtime.stopRequested));
          logDebugEvent('continue_from_chat_ignored', {
            reason,
            state,
            cause: 'not_chat_or_missing_pending_job',
          }, 'warn');
          return;
        }

        let pendingJob = revivePendingJob(state);
        const latestDetail = await JobRepository.waitForJobDetail(
          pendingJob,
          Math.min(8000, Math.max(4500, getWaitTimeout() * 1000)),
          0,
          { includeHtml: true, forceApiFetch: true },
        )
          .catch(() => JobRepository.getDetailForJob(pendingJob));
        if (latestDetail) {
          pendingJob = mergeJobInfo(pendingJob, latestDetail);
        }
        logDebugEvent('continue_from_chat', {
          reason,
          pendingJob: summarizeJobForDebug(pendingJob),
          runState: state,
          listState: getDebugListState(),
        });
        UI.setStatus(`聊天页发送中：${pendingJob.jobName || '未知岗位'}`, 'info');

        const sendResult = await this.sendCurrentWithChatOpenRetries(pendingJob, state);
        // 只有发送确认通过后才写入 sent，并同步更新已沟通列表。
        const sentRecord = await Database.saveJobRecord(pendingJob, {
          status: 'sent',
          sentAt: nowIso(),
          messageType: sendResult.messageType,
          messagePreview: sendResult.messagePreview,
          chatButtonText: state.chatButtonText,
          pageUrl: location.href,
        });
        UI.upsertGreetedRecord(sentRecord);

        const nextCursor = Number(state.cursorIndex || 0) + 1;
        const nextDelaySeconds = randomDelaySeconds(config.delayMin, config.delayMax);
        RunState.patch({
          phase: 'returning',
          cursorIndex: nextCursor,
          sentCount: Number(state.sentCount || 0) + 1,
          pendingJob: null,
          pendingRawJob: null,
          returnAttempts: 0,
          returnStartedAt: Date.now(),
          chatOpenRetryCount: 0,
          nextRunAt: Date.now() + nextDelaySeconds * 1000,
          nextDelaySeconds,
        });

        await UI.refreshGreetedList({ scrollTop: true });
        UI.setStatus('发送完成，正在返回岗位列表...', 'ok');
        await this.completeReturnToList(RunState.load(), reason || 'chat');
      } catch (error) {
        runtime.automationLoopActive = false;
        if (error && error.zhipinAutoPause) {
          this.pause(error.message || '已暂停');
        } else {
          this.fatal(error.message || String(error));
        }
      }
    },

    // 发送时如果聊天输入框渲染超时，可返回列表重新点击同一岗位进行有限重试。
    async sendCurrentWithChatOpenRetries(pendingJob, initialState) {
      const maxRetries = getChatOpenRetryLimit();
      let attempts = Math.max(0, Number(initialState && initialState.chatOpenRetryCount || 0));

      while (true) {
        try {
          return await GreetingService.sendCurrent(pendingJob);
        } catch (error) {
          logDebugEvent('send_current_error', {
            message: error && error.message || String(error),
            isChatRenderTimeout: isChatRenderTimeoutError(error),
            attempts,
            maxRetries,
            pendingJob: summarizeJobForDebug(pendingJob),
            runState: RunState.load(),
            listState: getDebugListState(),
          }, 'warn');

          if (!isChatRenderTimeoutError(error) || attempts >= maxRetries) {
            throw error;
          }

          // 聊天页偶发不渲染输入框时，回岗位列表重新点击同一个沟通按钮，而不是直接跳过该岗位。
          attempts += 1;
          const latestState = RunState.load() || initialState || {};
          RunState.patch({ chatOpenRetryCount: attempts });
          await this.retryOpenChatForPendingJob(latestState, pendingJob, attempts, maxRetries);
        }
      }
    },

    // 聊天页打不开时的重试：回到列表，重新定位原岗位卡片并再次点击沟通。
    async retryOpenChatForPendingJob(state, pendingJob, attempt, maxRetries) {
      UI.setStatus(`聊天界面渲染超时，正在重新点击沟通 ${attempt}/${maxRetries}`, 'warn');
      logDebugEvent('chat_open_retry_start', {
        attempt,
        maxRetries,
        pendingJob: summarizeJobForDebug(pendingJob),
        runState: state,
        listState: getDebugListState(),
      }, 'warn');

      await navigateToJobList(state && state.listUrl);
      await waitForVisibleJobList(Math.max(3000, getWaitTimeout() * 1000));
      await JobRepository.waitForApiData(Math.min(1800, getWaitTimeout() * 1000));
      const cards = JobRepository.syncCards();
      const card = findJobCardForRetry(pendingJob, cards, Number(state && state.cursorIndex || 0));

      if (!card) {
        logDebugEvent('chat_open_retry_card_missing', {
          attempt,
          pendingJob: summarizeJobForDebug(pendingJob),
          cursorIndex: Number(state && state.cursorIndex || 0),
          visibleCards: cards.slice(0, 8).map((item) => summarizeDomInfoForDebug(extractCardInfo(item))),
          listState: getDebugListState(),
        }, 'warn');
        throw new Error('聊天界面渲染 等待超时');
      }

      logDebugEvent('chat_open_retry_card_found', {
        attempt,
        pendingJob: summarizeJobForDebug(pendingJob),
        domInfo: summarizeDomInfoForDebug(extractCardInfo(card)),
      });

      card.scrollIntoView({ block: 'center', inline: 'nearest' });
      const detailResourceStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
      clickElement(card);
      await sleep(700);

      const chatButton = await waitFor(() => findChatButton(pendingJob), getWaitTimeout(), '当前岗位沟通按钮');
      const buttonText = normalizeText(chatButton.innerText || chatButton.textContent || '');
      logDebugEvent('chat_open_retry_button_found', {
        attempt,
        buttonText,
        buttonHref: chatButton.getAttribute('href'),
        buttonKa: chatButton.getAttribute('ka'),
        pendingJob: summarizeJobForDebug(pendingJob),
      });
      const apiDetail = await JobRepository.waitForJobDetail(
        pendingJob,
        Math.min(8000, Math.max(4500, getWaitTimeout() * 1000)),
        detailResourceStartedAt,
        { includeHtml: true, forceApiFetch: true },
      );
      const refreshedJob = mergeJobInfo(pendingJob, apiDetail || extractDetailInfo());

      RunState.patch({
        active: true,
        phase: 'chat',
        cursorIndex: Number(state && state.cursorIndex || 0),
        pendingJob: flattenJob(refreshedJob),
        pendingRawJob: refreshedJob.rawJob || pendingJob.rawJob || null,
        chatButtonText: buttonText,
        listUrl: location.href,
        listSnapshot: createJobListSnapshot(),
        chatOpenRetryCount: attempt,
      });

      clickElement(chatButton);
      logDebugEvent('chat_open_retry_clicked', {
        attempt,
        refreshedJob: summarizeJobForDebug(refreshedJob),
        chatButtonText: buttonText,
        listUrl: location.href,
      });
      await sleep(1000);
    },

    // 发送完成后的返回阶段：使用浏览器历史回到原列表，恢复游标并等待下一次间隔。
    async completeReturnToList(state, reason) {
      // 发送后只使用浏览器历史返回，保持原搜索结果页的滚动和已加载岗位，不主动 location.assign 刷新列表。
      const currentState = state || RunState.load() || {};
      const attempts = Number(currentState.returnAttempts || 0);
      const returnStartedAt = Number(currentState.returnStartedAt || Date.now());
      logDebugEvent('complete_return_start', {
        reason,
        attempts,
        returnStartedAt,
        hasVisibleJobCards: hasVisibleJobCards(),
        isJobListRoute: isJobListRoute(),
        isChatPage: isChatPage(),
        ignoreListRefresh: Boolean(config.ignoreListRefresh),
        state: currentState,
      });

      RunState.patch({ phase: 'returning', returnAttempts: attempts + 1, returnStartedAt });
      await navigateToJobList(currentState.listUrl);
      await waitForReturnedJobListRefresh(returnStartedAt);
      logDebugEvent('complete_return_list_visible', {
        reason,
        attempts: attempts + 1,
        listState: getDebugListState(),
        snapshot: createJobListSnapshot(),
      });

      const refreshDecision = this.detectReturnedListRefresh(currentState, returnStartedAt);
      let cursorIndex = Number((RunState.load() || currentState).cursorIndex || currentState.cursorIndex || 0);

      // 如果返回后列表刷新，原游标可能已经不可信；默认暂停，用户允许时才从顶部重新跑。
      if (refreshDecision.refreshed) {
        if (!config.ignoreListRefresh) {
          this.pause('岗位列表已刷新，脚本已暂停；请确认当前列表后重新启动');
          return;
        }

        cursorIndex = 0;
        scrollJobListToTop();
        await sleep(300);
        JobRepository.syncCards();
        UI.setStatus('检测到岗位列表刷新，已从顶部重新开始', 'warn');
      }

      const latestState = RunState.load() || currentState;
      if (!refreshDecision.refreshed) {
        cursorIndex = Number(latestState.cursorIndex || currentState.cursorIndex || 0);
      }
      RunState.patch({
        phase: 'list',
        cursorIndex,
        returnAttempts: 0,
        returnStartedAt: null,
        listSnapshot: createJobListSnapshot(),
      });

      runtime.automationLoopActive = false;
      if (cursorIndex <= 0) {
        scrollJobListToTop();
      } else {
        scrollAhead(cursorIndex);
      }
      await UI.refreshGreetedList({ scrollTop: true });
      await this.waitBeforeNextCommunication();
      this.runListLoop(`returned:${reason || 'chat'}`);
    },

    // 判断返回列表后是否发生了第一页刷新或搜索上下文变化，避免游标指向错误岗位。
    detectReturnedListRefresh(state, returnStartedAt) {
      const previous = state && state.listSnapshot || {};
      const current = createJobListSnapshot();
      const latestFirstPage = runtime.latestFirstPageJobListResponse || {};
      const firstPageAfterReturn = Boolean(
        latestFirstPage.capturedAt &&
        Number(latestFirstPage.capturedAt) >= Number(returnStartedAt || 0),
      );
      const contextChanged = Boolean(
        previous.contextKey &&
        current.contextKey &&
        previous.contextKey !== current.contextKey,
      );

      return {
        refreshed: firstPageAfterReturn || contextChanged,
        firstPageAfterReturn,
        contextChanged,
        previous,
        current,
      };
    },

    // 两次沟通之间的随机等待。
    async waitBeforeNextCommunication() {
      const state = RunState.load() || {};
      let nextRunAt = Number(state.nextRunAt || 0);
      let delaySeconds = Number(state.nextDelaySeconds || 0);
      if (!nextRunAt || nextRunAt <= Date.now()) {
        delaySeconds = randomDelaySeconds(config.delayMin, config.delayMax);
        nextRunAt = Date.now() + delaySeconds * 1000;
        RunState.patch({ nextRunAt, nextDelaySeconds: delaySeconds });
      }

      const completed = await waitWithStatusCountdown(nextRunAt, (remainingSeconds) => `已返回岗位列表，等待 ${remainingSeconds} 秒后继续沟通...`);
      if (!completed) return;

      RunState.patch({ nextRunAt: null, nextDelaySeconds: null });
    },

    // 统一停机入口：写停止状态、解锁 UI，并锁定错误提示。
    fatal(message) {
      if (runtime.statusLock) {
        runtime.stopRequested = true;
        runtime.automationLoopActive = false;
        RunState.stop(runtime.statusLock.message || '已停止');
        UI.setRunning(false);
        UI.setStatus(runtime.statusLock.message || '已停止', runtime.statusLock.type || 'warn', { force: true });
        return;
      }

      runtime.stopRequested = true;
      runtime.automationLoopActive = false;
      UI.unlockStatus();
      RunState.stop(message);
      UI.setRunning(false);
      UI.setStatus(message, 'error');
      setTimeout(() => alert(`[${APP.name}] ${message}`), 0);
    },
  };

  // 导出器：JSON/Excel 都在前端生成，下载时强制补扩展名，避免保存成无后缀 blob。
  const Exporter = {
    // 读取 jobRecords，转换为适合人工查看的字段名，再按配置导出 JSON 或 Excel。
    async exportRecords() {
      UI.saveFormToConfig();
      UI.setStatus('正在读取岗位记录...', 'info');
      const exportExtension = config.exportType === 'xlsx' ? 'xlsx' : 'json';
      const outputFileName = ensureFileExtension(
        `zhipin-job-records-${dateFileName()}`,
        exportExtension,
      );
      // 必须在用户点击事件尚有激活状态时调用，否则浏览器会拒绝文件选择器。
      const saveHandlePromise = requestSaveFileHandle(outputFileName, exportExtension);

      try {
        const rows = await Database.getAll('jobRecords');
        const normalizedRows = rows
          .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
          .map((row) => ({
            岗位名称: row.jobName || '',
            薪资: getDisplaySalary(row) || '',
            公司: getDisplayCompany(row) || '',
            完整公司名: row.companyFullName || '',
            公司简称: row.companyShortName || '',
            Boss: getDisplayText(row.bossName),
            Boss职位: getDisplayText(row.bossTitle),
            Boss活跃状态: row.bossActiveTimeDesc || '',
            城市: row.city || '',
            经验: row.experience || '',
            学历: row.degree || '',
            职位分类: row.positionName || '',
            工作地址: row.workAddress || row.address || '',
            经度: row.longitude || '',
            纬度: row.latitude || '',
            岗位描述: row.postDescription || '',
            技能标签: (row.showSkills || []).join('、'),
            招聘人数: row.recruitmentCountDesc || '',
            岗位状态: row.jobStatusDesc || '',
            公司阶段: row.companyStage || '',
            公司规模: row.companyScale || '',
            公司行业: row.companyIndustry || '',
            公司福利: (row.companyLabels || []).join('、'),
            公司简介: row.companyIntroduce || '',
            工商信息: row.businessInfo && Object.keys(row.businessInfo).length
              ? JSON.stringify(row.businessInfo)
              : '',
            法定代表人: row.legalRepresentative || '',
            成立日期: row.establishedDate || '',
            企业类型: row.companyType || '',
            经营状态: row.manageState || '',
            注册资本: row.registeredCapital || '',
            注册地址: row.registeredAddress || '',
            营业期限: row.businessTerm || '',
            所属地区: row.businessRegion || '',
            统一社会信用代码: row.unifiedSocialCreditCode || '',
            核准日期: row.approvalDate || '',
            曾用名: row.formerName || '',
            登记机关: row.registrationAuthority || '',
            工商所属行业: row.businessIndustry || '',
            经营范围: row.businessScope || '',
            消息预览: row.messagePreview || '',
            点击时间: row.clickedAt || '',
            发送时间: row.sentAt || '',
            更新时间: row.updatedAt || '',
          }));

        if (config.exportType === 'xlsx') {
          await this.exportXlsx(normalizedRows, outputFileName, saveHandlePromise);
          return;
        }

        const fileName = await downloadBlob(
          `\uFEFF${JSON.stringify(normalizedRows, null, 2)}`,
          outputFileName,
          'application/json;charset=utf-8',
          'json',
          saveHandlePromise,
        );
        UI.setStatus(`导出完成：${rows.length} 条记录，文件 ${fileName}`, 'ok');
      } catch (error) {
        if (error && error.zhipinAutoExportCancelled) {
          UI.setStatus('已取消导出', 'info');
          return;
        }
        Automation.fatal(`导出失败：${error.message}`);
      }
    },

    // Excel 导出懒加载 SheetJS，避免正常自动沟通流程额外加载大型库。
    async exportXlsx(rows, outputFileName, saveHandlePromise) {
      const XLSX = await loadSheetJs();
      const worksheet = XLSX.utils.json_to_sheet(rows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, '岗位记录');
      const data = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const fileName = await downloadBlob(
        data,
        outputFileName,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'xlsx',
        saveHandlePromise,
      );
      UI.setStatus(`Excel 导出完成：${rows.length} 条记录，文件 ${fileName}`, 'ok');
    },
  };

  // 调试日志用于排查偶发页面/接口问题，默认写入 localStorage 的短期环形缓冲。
  const DebugLogService = {
    setEnabled(enabled) {
      const shouldEnable = Boolean(enabled);
      try {
        if (shouldEnable) {
          localStorage.setItem(APP.debugEnabledKey, '1');
          runtime.debugEvents = loadStoredDebugEvents();
          logDebugEvent('debug_logging_enabled', { source: 'ui' });
          UI.setStatus('已开启诊断日志', 'ok');
        } else {
          localStorage.removeItem(APP.debugEnabledKey);
          UI.setStatus('已关闭诊断日志', 'info');
        }
      } catch (error) {
        UI.setStatus(`切换诊断日志失败：${error.message || error}`, 'warn');
      }
      UI.renderDebugLogControls();
    },

    async exportLogs() {
      const events = loadStoredDebugEvents();
      if (!events.length) {
        UI.setStatus('暂无诊断日志可导出', 'warn');
        UI.renderDebugLogControls();
        return;
      }

      const outputFileName = ensureFileExtension(`zhipin-debug-logs-${dateFileName()}`, 'json');
      const saveHandlePromise = requestSaveFileHandle(outputFileName, 'json');
      const payload = {
        app: APP.name,
        version: APP.version,
        exportedAt: nowIso(),
        href: location.href,
        debugEnabled: isDebugEnabled(),
        eventCount: events.length,
        events,
      };

      try {
        const fileName = await downloadBlob(
          `\uFEFF${JSON.stringify(payload, null, 2)}`,
          outputFileName,
          'application/json;charset=utf-8',
          'json',
          saveHandlePromise,
        );
        UI.setStatus(`诊断日志导出完成：${events.length} 条，文件 ${fileName}`, 'ok');
      } catch (error) {
        if (error && error.zhipinAutoExportCancelled) {
          UI.setStatus('已取消导出诊断日志', 'info');
          return;
        }
        UI.setStatus(`导出诊断日志失败：${error.message || error}`, 'warn');
      }
    },

    async clearLogs() {
      try {
        const count = loadStoredDebugEvents().length;
        if (!count) {
          UI.setStatus('暂无诊断日志可清除', 'info');
          UI.renderDebugLogControls();
          return;
        }
        if (!(await askConfirm(`确定清除 ${count} 条诊断日志吗？`))) return;

        runtime.debugEvents = [];
        localStorage.removeItem(APP.debugEventsKey);
        UI.renderDebugLogControls();
        UI.setStatus(`已清除 ${count} 条诊断日志`, 'ok');
      } catch (error) {
        UI.setStatus(`清除诊断日志失败：${error.message || error}`, 'warn');
      }
    },
  };

  // 数据清理：只清理脚本写入 IndexedDB 的岗位记录，不动用户登录态和页面缓存。
  const RecordCleaner = {
    // 清空全部岗位记录和已沟通投影，适合重新开始一轮采集前使用。
    async clearAll() {
      try {
        if (!(await askConfirm('确定删除所有岗位记录和已沟通列表吗？此操作不可恢复。'))) return;

        UI.setStatus('正在删除所有岗位记录...', 'info');
        const jobCount = await Database.clearStore('jobRecords');
        const greetedCount = await Database.clearStore('greetedJobs');
        const remainingJobs = await Database.count('jobRecords');
        const remainingGreeted = await Database.count('greetedJobs');
        if (remainingJobs || remainingGreeted) {
          throw new Error(`删除后仍剩余 ${remainingJobs} 条岗位记录、${remainingGreeted} 条已沟通记录`);
        }

        ContactedIndex.reset();
        await UI.refreshGreetedList();
        runtime.ui.greetedRows = [];
        UI.renderVirtualList();
        UI.setStatus(`已删除 ${jobCount} 条岗位记录、${greetedCount} 条已沟通记录`, 'ok');
      } catch (error) {
        Automation.fatal(`清理数据失败：${error.message || error}`);
      }
    },

    // 按沟通时间删除旧记录，保留最近沟通过的岗位。
    async clearByTime() {
      try {
        UI.saveFormToConfig();
        const cutoff = parseDateTimeLocal(config.clearBeforeTime);
        if (!cutoff) {
          UI.setStatus('请选择要删除的截止沟通时间', 'warn');
          return;
        }

        const label = formatLocalDateTime(cutoff);
        if (!(await askConfirm(`确定删除 ${label} 之前的岗位记录和已沟通记录吗？此操作不可恢复。`))) return;

        UI.setStatus(`正在删除 ${label} 之前的记录...`, 'info');
        const shouldDelete = (record) => {
          const time = getRecordCommunicationTime(record);
          return time && Date.parse(time) <= cutoff.getTime();
        };
        const jobCount = await Database.deleteWhere('jobRecords', shouldDelete);
        const greetedCount = await Database.deleteWhere('greetedJobs', shouldDelete);
        await ContactedIndex.rebuild();
        await UI.refreshGreetedList();
        UI.setStatus(`已删除 ${jobCount} 条岗位记录、${greetedCount} 条已沟通记录`, 'ok');
      } catch (error) {
        Automation.fatal(`按时间清理失败：${error.message || error}`);
      }
    },
  };

  // 懒加载 SheetJS，并放到隔离 sandbox 中执行，避免污染 BOSS 页面全局变量。
  async function loadSheetJs() {
    if (runtime.xlsx) return runtime.xlsx;

    UI.setStatus('正在加载 Excel 导出模块...', 'info');
    const code = await fetchText(APP.sheetJsUrl).catch((error) => {
      console.warn('[ZhipinAuto] 页面 fetch 加载 SheetJS 失败，降级使用 GM_xmlhttpRequest', error);
      return gmGetText(APP.sheetJsUrl);
    });
    const sandbox = {};
    const loader = new Function('sandbox', `
      const window = sandbox;
      const self = sandbox;
      const global = sandbox;
      const globalThis = sandbox;
      ${code}
      return sandbox.XLSX || (typeof XLSX !== 'undefined' ? XLSX : null);
    `);
    const XLSX = loader(sandbox);
    if (!XLSX || !XLSX.utils) throw new Error('SheetJS 加载失败');
    runtime.xlsx = XLSX;
    return XLSX;
  }

  // 普通跨域文本请求，主要用于拉取 SheetJS CDN 脚本。
  async function fetchText(url) {
    const response = await fetch(url, {
      cache: 'force-cache',
      credentials: 'omit',
      mode: 'cors',
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }

  // 抓取同源岗位/公司 HTML；页面 fetch 失败时用 GM_xmlhttpRequest 兜底。
  async function fetchJobHtml(url) {
    try {
      const response = await fetch(url, {
        cache: 'force-cache',
        credentials: 'include',
        mode: 'same-origin',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    } catch (error) {
      console.warn('[ZhipinAuto] 页面 fetch 加载岗位 HTML 失败，降级使用 GM_xmlhttpRequest', error);
      return gmGetText(url);
    }
  }

  // Tampermonkey 网络兜底，用于跨域 CDN 或同源 fetch 被页面策略影响时。
  function gmGetText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 30000,
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.responseText);
          } else {
            reject(new Error(`HTTP ${response.status}`));
          }
        },
        onerror() {
          reject(new Error('网络请求失败'));
        },
        ontimeout() {
          reject(new Error('网络请求超时'));
        },
      });
    });
  }

  // 给侧栏配置留两个入口：严格 JSON 对象，或者更适合手填的每行 key=value。
  function parseKeyValueConfig(text, label) {
    const source = String(text || '').trim();
    if (!source) return {};

    try {
      const parsed = JSON.parse(source);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${label} 必须是 JSON 对象`);
      }
      return parsed;
    } catch (jsonError) {
      const lines = source.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      const output = {};

      for (const line of lines) {
        const match = line.match(/^([^:=\s][^:=]*)\s*[:=]\s*([\s\S]*)$/);
        if (!match) {
          throw new Error(`${label} 格式错误，请填写 JSON 对象或每行 key=value`);
        }
        output[match[1].trim()] = match[2].trim();
      }

      return output;
    }
  }

  // 校验 key=value/JSON 配置是否能解析，启动前用于提前提示用户。
  function isParsableKeyValueConfig(text) {
    try {
      parseKeyValueConfig(text, '配置');
      return true;
    } catch (_) {
      return false;
    }
  }

  // 判断自定义接口 responsePath 是否像合法路径，避免把大段配置误填到路径框。
  function isLikelyResponsePath(path) {
    const value = String(path || '').trim();
    if (!value) return true;
    if (value.length > 120 || /[\s=:：,，。！？!？]/.test(value)) return false;
    return /^[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)|(?:\.\d+)|(?:\[\d+\]))*$/.test(value);
  }

  // 请求体配置支持 JSON 或 key=value，最终在发送前做岗位字段插值。
  function parseRequestBodyConfig(text, label) {
    const source = String(text || '').trim();
    if (!source) return {};

    try {
      return JSON.parse(source);
    } catch (_) {
      if (/^[^:=\s][^:=]*\s*[:=]/m.test(source)) {
        return parseKeyValueConfig(source, label);
      }
      return source;
    }
  }

  // 对对象/数组/字符串递归执行 {field} 模板替换，用于自定义接口参数和请求体。
  function interpolateStructuredValue(value, job) {
    if (typeof value === 'string') return interpolateText(value, job);
    if (Array.isArray(value)) return value.map((item) => interpolateStructuredValue(item, job));
    if (value && typeof value === 'object') {
      return Object.keys(value).reduce((output, key) => {
        output[key] = interpolateStructuredValue(value[key], job);
        return output;
      }, {});
    }
    return value;
  }

  // GET/HEAD 自定义接口把配置参数拼到 URL 查询串中。
  function appendQueryParams(url, params) {
    const target = new URL(url, location.href);
    Object.keys(params || {}).forEach((key) => {
      const value = params[key];
      if (value == null || value === '') return;

      if (Array.isArray(value)) {
        value.forEach((item) => target.searchParams.append(key, String(item)));
      } else {
        target.searchParams.set(key, String(value));
      }
    });
    return target.href;
  }

  // 请求头配置归一化，过滤空 key，避免 fetch 抛无意义错误。
  function normalizeHeaderMap(headers) {
    return Object.keys(headers || {}).reduce((output, key) => {
      const value = headers[key];
      if (value != null && value !== '') output[key] = String(value);
      return output;
    }, {});
  }

  // 从自定义接口 JSON 中按 a.b.0.c 形式取值，用于 responsePath 配置。
  function getValueByPath(source, path) {
    const keys = String(path || '')
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .map((key) => key.trim())
      .filter(Boolean);

    return keys.reduce((target, key) => (target == null ? undefined : target[key]), source);
  }

  // 请求外部接口生成问候语。接口可用岗位数据、当前页面地址和时间做上下文。
  async function requestExternalText(url, method, payload) {
    const requestMethod = String(method || 'GET').toUpperCase();
    const headers = normalizeHeaderMap(interpolateStructuredValue(parseKeyValueConfig(config.customApiHeaders, '请求头'), payload.job || {}));
    const params = interpolateStructuredValue(parseKeyValueConfig(config.customApiParams, 'URL 参数'), payload.job || {});
    const requestUrl = appendQueryParams(interpolateText(url, payload.job || {}), params);
    const requestBody = buildCustomApiBody(requestMethod, payload, headers);

    const responseText = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: requestMethod,
        url: requestUrl,
        headers: Object.keys(headers).length ? headers : undefined,
        data: requestBody,
        timeout: 30000,
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.responseText || '');
          } else {
            reject(new Error(`接口返回 HTTP ${response.status}`));
          }
        },
        onerror() {
          reject(new Error('自定义文本接口请求失败'));
        },
        ontimeout() {
          reject(new Error('自定义文本接口超时'));
        },
      });
    });

    try {
      const json = JSON.parse(responseText);
      return extractMessageFromJson(json, config.customApiResponsePath);
    } catch (_) {
      return responseText;
    }
  }

  // 根据请求方法和 Content-Type 构造请求体；GET/HEAD 不带 body。
  function buildCustomApiBody(method, payload, headers) {
    if (method === 'GET' || method === 'HEAD') return undefined;

    const bodySource = String(config.customApiBody || '').trim();
    const hasContentType = Object.keys(headers || {}).some((key) => key.toLowerCase() === 'content-type');

    if (!bodySource) {
      if (!hasContentType) headers['Content-Type'] = 'application/json';
      return JSON.stringify(payload);
    }

    const parsed = parseRequestBodyConfig(bodySource, '请求体');
    const value = interpolateStructuredValue(parsed, payload.job || {});
    if (typeof value === 'string') return value;

    if (!hasContentType) headers['Content-Type'] = 'application/json';
    return JSON.stringify(value);
  }

  // 从外部接口响应中提取最终问候语文本，支持显式路径和常见字段名兜底。
  function extractMessageFromJson(json, responsePath) {
    if (responsePath) {
      const selected = getValueByPath(json, responsePath);
      if (selected == null || selected === '') {
        throw new Error(`接口返回中未找到路径：${responsePath}`);
      }
      return typeof selected === 'string' ? selected : JSON.stringify(selected);
    }

    const directPaths = [
      ['message'],
      ['text'],
      ['content'],
      ['data', 'message'],
      ['data', 'text'],
      ['data', 'content'],
      ['data', 'greeting'],
    ];

    for (const path of directPaths) {
      const value = path.reduce((target, key) => target && target[key], json);
      if (typeof value === 'string' && value.trim()) return value;
    }

    let first = '';
    walkObject(json, (value) => {
      if (!first && typeof value === 'string' && value.trim().length >= 2) {
        first = value;
      }
    });
    return first;
  }

  // 岗位列表页左侧卡片选择器，自动化遍历岗位从这里开始。
  function getJobCards() {
    return Array.from(document.querySelectorAll('li.job-card-box')).filter(isVisible);
  }

  // 启动时尽量从当前选中的卡片继续，减少用户手动定位后的重复扫描。
  function findSelectedCardIndex() {
    const cards = getJobCards();
    const selected = cards.findIndex((card) => {
      const className = String(card.className || '');
      return /active|selected|cur|current/.test(className);
    });
    return selected >= 0 ? selected : 0;
  }

  // 从 DOM 卡片提取岗位名、公司、薪资、城市和可用于匹配的 key。
  function extractCardInfo(card) {
    const text = normalizeText(card.innerText || card.textContent || '');
    const salary = normalizeText((card.querySelector('.job-salary, .salary, [class*="salary"]') || {}).textContent || '');
    const jobName = cleanDomJobName(readFirstElementText(card, [
      'a.job-name',
      '.job-name a',
      '.job-name',
      'a[class*="job-name"]',
      '.job-title a',
      '.job-title',
      '[class*="job-name"]',
    ]), salary);
    const company = normalizeText((card.querySelector('.boss-name, .company-name, .company-text') || {}).textContent || '');
    const city = normalizeText((card.querySelector('.company-location, [class*="location"]') || {}).textContent || '');
    const keys = [];

    for (const element of [card].concat(Array.from(card.querySelectorAll('a, [data-jobid], [data-job-id], [data-id], [data-lid], [data-securityid], [data-security-id]')))) {
      for (const attr of ['data-jobid', 'data-job-id', 'data-id', 'data-lid', 'data-securityid', 'data-security-id']) {
        const value = element.getAttribute && element.getAttribute(attr);
        if (value) keys.push(value);
      }

      const href = element.getAttribute && element.getAttribute('href');
      if (href) {
        const detailMatch = href.match(/\/job_detail\/([A-Za-z0-9_~-]+)(?:\.html)?/);
        if (detailMatch && detailMatch[1]) keys.push(detailMatch[1]);

        const matches = href.match(/(?:jobId=|encryptJobId=|securityId=)([A-Za-z0-9_~-]+)/g) || [];
        matches.forEach((match) => {
          const value = match.split(/[=/]/).pop();
          if (value) keys.push(value);
        });
      }
    }

    const fallbackLines = text.split(/\s+/).filter(Boolean);
    return {
      text,
      jobName: jobName || fallbackLines[0] || '',
      salary,
      company,
      city,
      keys: Array.from(new Set(keys.map(String))),
      signature: makeSignature(jobName || fallbackLines[0] || '', company, salary),
      looseSignature: makeLooseSignature(jobName || fallbackLines[0] || '', company),
    };
  }

  // 按选择器列表读取第一个非空文本，用来兼容 BOSS 多版 DOM 结构。
  function readFirstElementText(root, selectors) {
    for (const selector of selectors || []) {
      const element = root && root.querySelector && root.querySelector(selector);
      const text = normalizeText(element && (element.innerText || element.textContent));
      if (text) return text;
    }
    return '';
  }

  // DOM 中岗位名有时会拼接薪资，这里剥离薪资后再做签名匹配。
  function cleanDomJobName(jobName, salary) {
    let text = normalizeText(jobName);
    const salaryText = normalizeText(salary);
    if (salaryText) text = normalizeText(text.replace(salaryText, ''));
    text = text.replace(/[\uE000-\uF8FF][\uE000-\uF8FF\d.,+\-~Kk万年月薪\/·]*$/g, '');
    return normalizeText(text);
  }

  // 从详情 DOM/HTML 中读取 Boss 活跃度；在线标签和普通活跃时间位于不同节点。
  function extractBossActiveInfoFromRoot(root, hiddenClasses, options) {
    const container = root && root.querySelector
      ? (root.querySelector('.job-detail-body') || root)
      : null;
    if (!container) return {};

    const visibleOnly = !(options && options.visibleOnly === false);
    const onlineElement = findBossActiveElement(container, '.boss-online-tag', visibleOnly);
    if (onlineElement) {
      return {
        bossActiveTimeDesc: cleanBossActiveElementText(onlineElement, hiddenClasses) || '在线',
        bossOnline: true,
      };
    }

    const activeElement = findBossActiveElement(container, '.boss-active-time', visibleOnly);
    const activeText = cleanBossActiveElementText(activeElement, hiddenClasses);
    if (!activeText) return {};

    return {
      bossActiveTimeDesc: activeText,
      bossOnline: normalizeBossActiveText(activeText) === '在线',
    };
  }

  // 在指定根节点中查找活跃度元素，可按调用场景选择是否要求可见。
  function findBossActiveElement(root, selector, visibleOnly) {
    return Array.from(root ? root.querySelectorAll(selector) : [])
      .find((element) => !visibleOnly || isVisible(element));
  }

  // 清洗活跃度节点文本，移除图标/隐藏节点后归一成可匹配标签。
  function cleanBossActiveElementText(element, hiddenClasses) {
    if (!element) return '';

    const clone = element.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, iframe, svg, i, #zhipin-auto-greeting-root').forEach((item) => item.remove());
    const text = hiddenClasses
      ? cleanElementText(clone, hiddenClasses)
      : normalizeText(clone.textContent || clone.innerText || element.getAttribute('title') || element.getAttribute('aria-label') || '');
    return getBossActiveOptionLabel(text);
  }

  // 从右侧岗位详情 DOM 读取可见信息，作为详情接口缺失时的补充。
  function extractDetailInfo() {
    const root = Array.from(document.querySelectorAll('.job-detail-box'))
      .find((element) => isVisible(element));
    if (!root) return {};

    const detail = {};
    const jobName = normalizeText((root.querySelector('.job-detail-header .job-name') || {}).textContent || '');
    const salary = getReadableSalary((root.querySelector('.job-detail-header .job-salary') || {}).textContent || '');
    if (jobName) detail.jobName = jobName;
    if (salary) detail.salary = salary;

    const bossRoot = root.querySelector('.job-boss-info');
    if (bossRoot) {
      const nameElement = bossRoot.querySelector('h2.name');
      if (nameElement) {
        const clone = nameElement.cloneNode(true);
        clone.querySelectorAll('i, .boss-online-tag, .boss-active-time').forEach((item) => item.remove());
        detail.bossName = normalizeText(clone.textContent || '');
      }

      const attr = normalizeText((bossRoot.querySelector('.boss-info-attr') || {}).textContent || '');
      const parts = attr.split('·').map(normalizeText).filter(Boolean);
      if (parts[0]) detail.company = parts[0];
      if (parts.length > 1) detail.bossTitle = parts[parts.length - 1];
    }

    const bossActiveInfo = extractBossActiveInfoFromRoot(root);
    if (bossActiveInfo.bossActiveTimeDesc) detail.bossActiveTimeDesc = bossActiveInfo.bossActiveTimeDesc;
    if (bossActiveInfo.bossOnline) detail.bossOnline = true;

    const tags = Array.from(root.querySelectorAll('.job-detail-header .tag-list li'))
      .map((element) => normalizeText(element.textContent || ''))
      .filter(Boolean);
    if (tags[0]) detail.city = tags[0];
    if (tags[1]) detail.experience = tags[1];
    if (tags[2]) detail.degree = tags[2];

    const address = normalizeText((root.querySelector('.job-address-desc') || {}).textContent || '');
    if (address) detail.address = address;

    return detail;
  }

  // 根据岗位 key 组装详情接口 URL，用于主动补拉详情。
  function getJobDetailRequestIdentity(job) {
    const rawJob = job && job.rawJob || {};
    const rawDetail = job && job.rawDetail || {};
    const rawJobInfo = rawDetail.jobInfo || {};
    const identity = {
      encryptJobId: normalizeText(job && (
        job.encryptJobId ||
        rawJob.encryptJobId ||
        rawJob.encryptId ||
        rawJob.jobId ||
        rawJob.job_id ||
        rawJobInfo.encryptJobId ||
        rawJobInfo.encryptId ||
        rawJobInfo.jobId ||
        rawJobInfo.job_id
      )),
      securityId: normalizeText(job && (job.securityId || rawJob.securityId || rawDetail.securityId || rawJobInfo.securityId)),
      lid: normalizeText(job && (job.lid || rawJob.lid || rawDetail.lid || rawJobInfo.lid)),
    };

    getRouteJobDetailIdentities().some((routeIdentity) => {
      if (!isRouteIdentityCompatible(identity, routeIdentity)) return false;
      if (!identity.encryptJobId && routeIdentity.encryptJobId) identity.encryptJobId = routeIdentity.encryptJobId;
      if (!identity.securityId && routeIdentity.securityId) identity.securityId = routeIdentity.securityId;
      if (!identity.lid && routeIdentity.lid) identity.lid = routeIdentity.lid;
      return Boolean(identity.securityId && identity.lid);
    });

    return identity;
  }

  function buildJobDetailApiUrl(job) {
    const identity = getJobDetailRequestIdentity(job);
    const securityId = identity.securityId;
    const lid = identity.lid;
    if (!securityId || !lid) return '';

    const url = new URL('/wapi/zpgeek/job/detail.json', location.origin);
    url.searchParams.set('securityId', securityId);
    url.searchParams.set('lid', lid);
    url.searchParams.set('_', String(Date.now()));
    return url.href;
  }

  function getRouteJobDetailIdentities() {
    return [
      runtime.latestRouteUrl,
      runtime.initialPageUrl,
      location.href,
    ]
      .map(parseJobDetailIdentityFromUrl)
      .filter(Boolean);
  }

  function parseJobDetailIdentityFromUrl(href) {
    try {
      if (!href) return null;
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return null;

      const pathname = url.pathname.replace(/\/+$/, '');
      const detailMatch = pathname.match(/\/job_detail\/([A-Za-z0-9_~-]+)(?:\.html)?$/);
      const encryptJobId = normalizeText(
        url.searchParams.get('jobId') ||
        url.searchParams.get('encryptJobId') ||
        url.searchParams.get('encryptId') ||
        (detailMatch && detailMatch[1])
      );
      const securityId = normalizeText(url.searchParams.get('securityId'));
      const lid = normalizeText(url.searchParams.get('lid'));
      if (!encryptJobId && !securityId && !lid) return null;

      return { encryptJobId, securityId, lid, href: url.href };
    } catch (_) {
      return null;
    }
  }

  function isRouteIdentityCompatible(jobIdentity, routeIdentity) {
    if (!routeIdentity) return false;
    const jobId = normalizeText(jobIdentity && jobIdentity.encryptJobId);
    const routeJobId = normalizeText(routeIdentity.encryptJobId);
    if (jobId && routeJobId && jobId !== routeJobId) return false;
    return true;
  }

  // 从 performance 资源记录里找最近一次列表接口，主动补抓时使用。
  function findLatestJobListApiUrl() {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return '';

    const entries = performance.getEntriesByType('resource')
      .filter((entry) => APP.jobListApiPattern.test(entry.name))
      .sort((a, b) => b.startTime - a.startTime);
    return entries.length ? entries[0].name : '';
  }

  // 从 performance 资源记录里找点击岗位后出现的详情接口。
  function findLatestJobDetailApiUrl(resourceStartedAt) {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return '';

    const minimumStart = Math.max(0, Number(resourceStartedAt || 0) - 100);
    const entries = performance.getEntriesByType('resource')
      .filter((entry) => APP.jobDetailApiPattern.test(entry.name) && entry.startTime >= minimumStart)
      .sort((a, b) => b.startTime - a.startTime);
    return entries.length ? entries[0].name : '';
  }

  // 根据详情字段拼出岗位 HTML 页面地址，用于补抓描述和公司信息。
  function buildJobHtmlDetailUrl(detail) {
    const encryptJobId = normalizeText(detail && detail.encryptJobId);
    const securityId = normalizeText(detail && detail.securityId);
    if (!encryptJobId || !securityId) return '';

    const url = new URL(`/job_detail/${encodeURIComponent(encryptJobId)}.html`, location.origin);
    url.searchParams.set('securityId', securityId);
    url.searchParams.set('ka', `company_more_job_${encryptJobId}`);
    return url.href;
  }

  // 根据详情字段拼出公司主页地址，用于补抓工商信息。
  function buildCompanyHtmlUrl(detail) {
    const rawDetail = detail && detail.rawDetail || {};
    const brandInfo = rawDetail.brandComInfo || rawDetail.brandInfo || rawDetail.companyInfo || {};
    const brandId = normalizeText(detail && detail.brandId) ||
      normalizeText(detail && detail.rawJob && detail.rawJob.encryptBrandId) ||
      normalizeText(brandInfo.encryptBrandId);
    if (!brandId) return '';

    return new URL(`/gongsi/${encodeURIComponent(brandId)}.html`, location.origin).href;
  }

  // 解析岗位详情 HTML，提取接口没有给全的岗位描述、地址、公司链接等。
  function parseJobHtmlDetail(html, sourceUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(html || ''), 'text/html');
    const hiddenClasses = getHtmlHiddenClassNames(doc);
    const businessInfo = extractBusinessInfo(doc, hiddenClasses);
    const jobInfo = extractInlineJobInfo(html);
    const bossInfo = parseBossHtmlInfo(doc, hiddenClasses);
    const sideCompany = parseSideCompanyInfo(doc, hiddenClasses);
    const mapElement = doc.querySelector('.company-address .job-location-map, .job-location-map');
    const mapPoint = parseMapPoint(mapElement && mapElement.getAttribute('data-lat'));
    const companyFullName = businessInfo['公司名称'] || businessInfo['企业名称'] || '';
    const companyShortName = normalizeText(jobInfo.company) ||
      firstTextFromSelectors(doc, [
        '.sider-company .company-info a[title]',
        '.sider-company .company-info a:last-child',
        '.smallbanner .detail-op .info',
      ], hiddenClasses);

    const postDescriptionElement = doc.querySelector('.job-detail .job-keyword-list + .job-sec-text') ||
      Array.from(doc.querySelectorAll('.job-detail > .job-detail-section .job-sec-text'))
        .find((element) => /岗位|职责|任职|要求|经验|开发|工作/.test(cleanElementText(element, hiddenClasses)));
    const companyIntroduceElement = doc.querySelector('.job-detail-company .company-info-box .job-sec-text');
    const addressElement = doc.querySelector('.company-address .location-address') ||
      doc.querySelector('.job-location .location-address');
    const htmlSalary = firstTextFromSelectors(doc, [
      '.job-primary .salary',
      '.smallbanner .salary',
      '.smallbanner .badge',
      '.job-banner .salary',
      'span.salary',
    ], hiddenClasses);

    const detail = {
      jobName: textFromSelector(doc, '.job-primary .name h1, .smallbanner .job-title', hiddenClasses) ||
        normalizeText(jobInfo.job_name),
      salary: getReadableSalary(htmlSalary || jobInfo.job_salary),
      company: companyFullName || companyShortName,
      companyShortName,
      companyFullName,
      city: textFromSelector(doc, '.job-primary .text-city', hiddenClasses),
      experience: textFromSelector(doc, '.job-primary .text-experiece, .job-primary .text-experience', hiddenClasses),
      degree: textFromSelector(doc, '.job-primary .text-degree', hiddenClasses),
      showSkills: textsFromSelector(doc, '.job-keyword-list li', hiddenClasses),
      companyLabels: textsFromSelector(doc, '.job-primary .tag-container-new > .job-tags:not(.tag-all) span', hiddenClasses)
        .concat(textsFromSelector(doc, '.smallbanner .tag-container-new > .job-tags:not(.tag-all) span', hiddenClasses)),
      postDescription: cleanElementText(postDescriptionElement, hiddenClasses),
      bossName: bossInfo.bossName,
      bossTitle: bossInfo.bossTitle,
      bossActiveTimeDesc: bossInfo.bossActiveTimeDesc,
      bossOnline: bossInfo.bossOnline,
      address: cleanElementText(addressElement, hiddenClasses),
      workAddress: cleanElementText(addressElement, hiddenClasses),
      longitude: mapPoint && mapPoint.longitude,
      latitude: mapPoint && mapPoint.latitude,
      encryptAddressId: mapElement && normalizeText(mapElement.getAttribute('data-addressid')),
      companyIntroduce: cleanElementText(companyIntroduceElement, hiddenClasses),
      businessInfo,
      legalRepresentative: businessInfo['法定代表人'] || businessInfo['法人'] || '',
      establishedDate: businessInfo['成立日期'] || businessInfo['成立时间'] || '',
      companyType: businessInfo['企业类型'] || businessInfo['公司类型'] || '',
      manageState: businessInfo['经营状态'] || businessInfo['登记状态'] || '',
      registeredCapital: businessInfo['注册资金'] || businessInfo['注册资本'] || '',
      companyStage: sideCompany.companyStage,
      companyScale: sideCompany.companyScale,
      companyIndustry: sideCompany.companyIndustry,
      htmlDetailUrl: sourceUrl,
      htmlCapturedAt: nowIso(),
      rawHtmlDetail: {
        title: normalizeText((doc.querySelector('title') || {}).textContent || ''),
        metaDescription: getMetaContent(doc, 'description'),
      },
    };

    detail.companyLabels = Array.from(new Set(detail.companyLabels.filter(Boolean)));
    detail.showSkills = Array.from(new Set(detail.showSkills.filter(Boolean)));
    return compactObject(detail);
  }

  // 解析公司主页 HTML 中的工商信息，最终会合并进岗位记录并导出。
  function parseCompanyBusinessHtml(html, sourceUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(html || ''), 'text/html');
    const hiddenClasses = getHtmlHiddenClassNames(doc);
    const businessInfo = extractBusinessInfo(doc, hiddenClasses);
    const companyFullName = businessInfo['企业名称'] || businessInfo['公司名称'] || '';

    return compactObject({
      company: companyFullName,
      companyFullName,
      businessInfo,
      legalRepresentative: businessInfo['法定代表人'] || businessInfo['法人'] || '',
      establishedDate: businessInfo['成立时间'] || businessInfo['成立日期'] || '',
      companyType: businessInfo['企业类型'] || businessInfo['公司类型'] || '',
      manageState: businessInfo['经营状态'] || businessInfo['登记状态'] || '',
      registeredCapital: businessInfo['注册资本'] || businessInfo['注册资金'] || '',
      registeredAddress: businessInfo['注册地址'] || '',
      businessTerm: businessInfo['营业期限'] || '',
      businessRegion: businessInfo['所属地区'] || '',
      unifiedSocialCreditCode: businessInfo['统一社会信用代码'] || '',
      approvalDate: businessInfo['核准日期'] || '',
      formerName: businessInfo['曾用名'] || '',
      registrationAuthority: businessInfo['登记机关'] || '',
      businessIndustry: businessInfo['所属行业'] || '',
      businessScope: businessInfo['经营范围'] || '',
      companyDetailUrl: sourceUrl,
      companyDetailCapturedAt: nowIso(),
      rawCompanyDetail: {
        title: normalizeText((doc.querySelector('title') || {}).textContent || ''),
        metaDescription: getMetaContent(doc, 'description'),
      },
    });
  }

  // 从页面内联 JSON/脚本片段中兜底提取岗位信息。
  function extractInlineJobInfo(html) {
    const match = String(html || '').match(/var\s+_jobInfo\s*=\s*(\{[\s\S]*?\});/);
    if (!match) return {};

    try {
      const source = match[1]
        .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
        .replace(/'/g, '"');
      return JSON.parse(source);
    } catch (_) {
      return {};
    }
  }

  // BOSS HTML 里可能有隐藏节点；先收集隐藏 class，后续提取文本时跳过。
  function getHtmlHiddenClassNames(doc) {
    const hidden = new Set();
    const styles = Array.from(doc.querySelectorAll('style'))
      .map((style) => style.textContent || '')
      .join('\n');
    const pattern = /\.([A-Za-z_-][\w-]*)\s*\{([^}]*)\}/g;
    let match = pattern.exec(styles);

    while (match) {
      const body = match[2];
      if (/display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|width\s*:\s*0\.?1?px|height\s*:\s*0\.?1?px/i.test(body)) {
        hidden.add(match[1]);
      }
      match = pattern.exec(styles);
    }

    return hidden;
  }

  // 读取单个选择器文本，并过滤隐藏节点内容。
  function textFromSelector(root, selector, hiddenClasses) {
    return cleanElementText(root && root.querySelector(selector), hiddenClasses);
  }

  // 多选择器兜底读取第一个非空文本。
  function firstTextFromSelectors(root, selectors, hiddenClasses) {
    for (const selector of selectors) {
      const candidates = Array.from(root ? root.querySelectorAll(selector) : []);
      for (const candidate of candidates) {
        const text = cleanElementText(candidate, hiddenClasses);
        if (text) return text.replace(/\s*查看所有职位.*/g, '').trim();
      }
    }
    return '';
  }

  // 读取同类节点的文本列表，例如技能标签、福利标签。
  function textsFromSelector(root, selector, hiddenClasses) {
    return Array.from(root ? root.querySelectorAll(selector) : [])
      .map((element) => cleanElementText(element, hiddenClasses))
      .filter(Boolean);
  }

  // 克隆节点后移除隐藏子节点，避免把页面埋点/SEO 文本误采进记录。
  function cleanElementText(element, hiddenClasses) {
    if (!element) return '';

    const clone = element.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, iframe, svg, #zhipin-auto-greeting-root').forEach((item) => item.remove());
    clone.querySelectorAll('*').forEach((item) => {
      const style = String(item.getAttribute('style') || '');
      const hiddenByStyle = /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
      const hiddenByClass = Array.from(item.classList || []).some((className) => hiddenClasses && hiddenClasses.has(className));
      if (hiddenByStyle || hiddenByClass || item.hidden) item.remove();
    });
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    return normalizeTextPreserveLines(clone.textContent || '');
  }

  // 从公司页中识别“法人/注册资本/经营范围”等工商字段。
  function extractBusinessInfo(doc, hiddenClasses) {
    const output = {};
    doc.querySelectorAll([
      '.business-info-box .level-list li',
      '.company-business .business-detail li',
    ].join(',')).forEach((item) => {
      const labelElement = item.querySelector('.t, span');
      const label = cleanElementText(labelElement, hiddenClasses).replace(/[：:]$/, '');
      if (!label) return;

      const clone = item.cloneNode(true);
      const clonedLabel = clone.querySelector('.t, span');
      if (clonedLabel) clonedLabel.remove();
      const value = cleanElementText(clone, hiddenClasses);
      if (value) output[label] = value;
    });
    return output;
  }

  // 从岗位 HTML 中解析 Boss 姓名、职位、活跃状态等聊天前有用字段。
  function parseBossHtmlInfo(doc, hiddenClasses) {
    const nameElement = doc.querySelector('.job-boss-info h2.name');
    let bossName = '';
    if (nameElement) {
      const clone = nameElement.cloneNode(true);
      clone.querySelectorAll('i, .boss-online-tag, .boss-active-time').forEach((item) => item.remove());
      bossName = cleanElementText(clone, hiddenClasses);
    }

    const attr = textFromSelector(doc, '.job-boss-info .boss-info-attr', hiddenClasses);
    const parts = attr.split('·').map(normalizeText).filter(Boolean);
    const bossActiveInfo = extractBossActiveInfoFromRoot(doc, hiddenClasses, { visibleOnly: false });
    return {
      bossName,
      bossTitle: parts.length > 1 ? parts[parts.length - 1] : '',
      bossActiveTimeDesc: bossActiveInfo.bossActiveTimeDesc,
      bossOnline: Boolean(bossActiveInfo.bossOnline),
    };
  }

  // 从岗位详情侧栏读取公司简称、阶段、规模等补充信息。
  function parseSideCompanyInfo(doc, hiddenClasses) {
    const side = doc.querySelector('.sider-company');
    const rows = Array.from(side ? side.querySelectorAll('p') : [])
      .map((row) => cleanElementText(row, hiddenClasses))
      .filter((text) => text && text !== '公司基本信息');

    return {
      companyStage: rows[0] || '',
      companyScale: rows[1] || '',
      companyIndustry: rows[2] || '',
    };
  }

  // 解析地图坐标字符串，导出时拆成经纬度字段。
  function parseMapPoint(value) {
    const parts = String(value || '').split(',').map((item) => Number(item));
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
    return {
      longitude: parts[0],
      latitude: parts[1],
    };
  }

  // 读取 HTML meta 内容，作为标题/描述等兜底来源。
  function getMetaContent(doc, name) {
    const element = doc.querySelector(`meta[name="${name}"]`);
    return normalizeText(element && element.getAttribute('content'));
  }

  // 合并岗位信息：后到的详情字段覆盖空值或更低质量字段，保留原始 raw 数据。
  function mergeJobInfo(job, detail) {
    if (!detail || !Object.keys(detail).length) return job;

    const merged = Object.assign({}, job);
    const readableDetailSalary = getReadableSalary(detail.salary);

    for (const key of ['jobName', 'company', 'bossName', 'bossTitle', 'city', 'experience', 'degree']) {
      if (detail[key] && (!merged[key] || merged.domOnly)) {
        merged[key] = detail[key];
      }
    }

    if (detail.company && merged.company !== detail.company) {
      merged.company = detail.company;
    }
    if (detail.bossName) merged.bossName = detail.bossName;
    if (detail.bossTitle) merged.bossTitle = detail.bossTitle;
    if (detail.jobName && (!merged.jobName || merged.domOnly)) merged.jobName = detail.jobName;
    if (readableDetailSalary) {
      merged.salary = readableDetailSalary;
    }

    [
      'positionName',
      'bossActiveTimeDesc',
      'bossOnline',
      'bossAvatar',
      'bossCertificated',
      'address',
      'longitude',
      'latitude',
      'staticMapUrl',
      'encryptAddressId',
      'postDescription',
      'recruitmentCountDesc',
      'positionCode',
      'jobType',
      'jobStatusDesc',
      'showSkills',
      'companyLogo',
      'companyFullName',
      'companyShortName',
      'companyStage',
      'companyScale',
      'companyIndustry',
      'companyIntroduce',
      'companyLabels',
      'businessInfo',
      'legalRepresentative',
      'establishedDate',
      'companyType',
      'manageState',
      'registeredCapital',
      'registeredAddress',
      'businessTerm',
      'businessRegion',
      'unifiedSocialCreditCode',
      'approvalDate',
      'formerName',
      'registrationAuthority',
      'businessIndustry',
      'businessScope',
      'brandId',
      'detailSource',
      'detailSourceUrl',
      'detailCapturedAt',
      'workAddress',
      'htmlDetailUrl',
      'htmlCapturedAt',
      'companyDetailUrl',
      'companyDetailCapturedAt',
    ].forEach((key) => {
      if (detail[key] !== undefined && detail[key] !== null && detail[key] !== '') {
        merged[key] = Array.isArray(detail[key])
          ? detail[key].slice()
          : (typeof detail[key] === 'object' ? Object.assign({}, detail[key]) : detail[key]);
      }
    });

    if (detail.encryptJobId) merged.encryptJobId = detail.encryptJobId;
    if (detail.securityId) merged.securityId = detail.securityId;
    if (detail.lid) merged.lid = detail.lid;
    if (detail.rawDetail) merged.rawDetail = detail.rawDetail;
    if (detail.rawHtmlDetail) merged.rawHtmlDetail = detail.rawHtmlDetail;
    if (detail.rawCompanyDetail) merged.rawCompanyDetail = detail.rawCompanyDetail;

    merged.signature = makeSignature(merged.jobName, merged.company, merged.salary);
    merged.looseSignature = makeLooseSignature(merged.jobName, merged.company);
    merged.rawJob = Object.assign({}, merged.rawJob || {}, {
      jobName: merged.jobName,
      brandName: merged.company,
      salaryDesc: merged.salary,
      bossName: merged.bossName,
      bossTitle: merged.bossTitle,
      positionName: merged.positionName,
      address: merged.address,
      postDescription: merged.postDescription,
      showSkills: merged.showSkills,
      brandComInfo: {
        stageName: merged.companyStage,
        scaleName: merged.companyScale,
        industryName: merged.companyIndustry,
        introduce: merged.companyIntroduce,
        labels: merged.companyLabels,
      },
    });

    return merged;
  }

  // 在岗位详情页查找“立即沟通/继续沟通”按钮，点击它会进入聊天页。
  function findChatButton(job) {
    const candidates = Array.from(document.querySelectorAll('a.op-btn.op-btn-chat'))
      .filter((element) => isVisible(element) && /立即沟通|继续沟通/.test(normalizeText(element.innerText || element.textContent || '')));
    const encryptJobId = normalizeText(job && job.encryptJobId);
    if (!encryptJobId) return candidates[0] || null;

    return candidates.find((element) => {
      const identityText = [
        element.getAttribute('ka'),
        element.getAttribute('href'),
        element.getAttribute('data-jobid'),
        element.getAttribute('data-job-id'),
      ].filter(Boolean).join('|');
      return identityText.includes(encryptJobId);
    }) || null;
  }

  // 聊天页常用语按钮定位，当前发送流程主要使用文本注入，这里保留给兼容判断。
  function findCommonPhraseButton() {
    const selectors = [
      'div[aria-label="常用语"]',
      '[aria-label="常用语"]',
      '.btn-dict',
      '[class*="btn-dict"]',
    ];

    for (const selector of selectors) {
      const element = Array.from(document.querySelectorAll(selector)).find((item) => !isOwnUiElement(item) && isVisible(item));
      if (element) return element;
    }

    return Array.from(document.querySelectorAll('button, div, span, a'))
      .find((element) => !isOwnUiElement(element) && isVisible(element) && /常用语/.test(normalizeText(element.innerText || element.textContent || element.getAttribute('aria-label') || '')));
  }

  // 定位聊天输入框。BOSS 可能使用 contenteditable div，也可能包在不同容器里。
  function findChatInput() {
    const selectors = [
      '#chat-input.chat-input[contenteditable="true"]',
      '#chat-input.chat-input',
      '.chat-input[contenteditable="true"]',
      '[contenteditable="true"].chat-input',
      '.chat-input',
      '[class*="chat-input"]',
      'textarea',
      '[contenteditable="true"]',
    ];

    for (const selector of selectors) {
      const element = Array.from(document.querySelectorAll(selector))
        .find((item) => !isOwnUiElement(item) && isVisible(item));
      if (element) return element;
    }

    return null;
  }

  // 定位聊天页发送按钮；Enter 发送失败时会作为兜底点击。
  function findSendButton() {
    const selectors = [
      'button.btn-send',
      '.chat-op button',
      '.chat-op [class*="send"]',
      'button[class*="send"]',
    ];

    for (const selector of selectors) {
      const found = Array.from(document.querySelectorAll(selector)).find((element) => {
        const text = normalizeText(element.innerText || element.textContent || element.getAttribute('aria-label') || '');
        const className = String(element.className || '');
        return !isOwnUiElement(element) &&
          isVisible(element) &&
          !element.disabled &&
          !/(disabled|unable)/i.test(className) &&
          (/发送/.test(text) || /send/i.test(className));
      });
      if (found) return found;
    }

    return Array.from(document.querySelectorAll('button, a, div, span')).find((element) => {
      const text = normalizeText(element.innerText || element.textContent || element.getAttribute('aria-label') || '');
      const className = String(element.className || '');
      return !isOwnUiElement(element) &&
        isVisible(element) &&
        !element.disabled &&
        !/(disabled|unable)/i.test(className) &&
        text === '发送';
    });
  }

  // 判断节点是否属于脚本面板，发送校验和点击查找时要排除自己的 UI。
  function isOwnUiElement(element) {
    return Boolean(element && element.closest && element.closest('#zhipin-auto-greeting-root'));
  }

  // 判断聊天页左侧会话列表是否渲染完成。
  function hasConversationList() {
    return Array.from(document.querySelectorAll('.user-list-content li, .user-list li, .chat-user li'))
      .some((element) => isVisible(element) && normalizeText(element.innerText || element.textContent || '').length > 4);
  }

  // 在聊天页左侧会话列表中确认当前会话是否对应 pendingJob。
  function findSelectedConversationForJob(job) {
    if (!job) return null;

    const bossName = normalizeText(job.bossName);
    const company = normalizeText(job.company);
    const jobName = normalizeText(job.jobName);
    const selectors = [
      '.user-list-content li.selected',
      '.user-list-content li.active',
      '.user-list-content li.cur',
      '.user-list li.selected',
      '.user-list li.active',
      '.user-list li.cur',
      '.chat-user li.selected',
      '.chat-user li.active',
      '.chat-user li.cur',
      '.friend-content.selected',
      '.friend-content.active',
      '.friend-content.cur',
      '.friend-content-warp.selected',
      '.friend-content-warp.active',
      '.friend-content-warp.cur',
    ];
    const candidates = Array.from(document.querySelectorAll(selectors.join(','))).filter(isVisible);
    let best = null;

    for (const element of candidates) {
      const text = normalizeText(element.innerText || element.textContent || '');
      if (!text || text.length < 2) continue;

      let score = 0;
      if (bossName && text.includes(bossName)) score += 4;
      if (company && text.includes(company)) score += 4;
      if (jobName && text.includes(jobName)) score += 2;
      if (/正在与Boss|沟通/.test(text)) score += 1;

      if (!best || score > best.score) {
        best = { element, score, text };
      }
    }

    if (!best || best.score < 4) return null;
    return best;
  }

  // 构造“需要人工处理”的暂停错误，区别于真正脚本异常。
  function createPauseError(message) {
    const error = new Error(message);
    error.zhipinAutoPause = true;
    return error;
  }

  // 聊天页输入框长期不出现时，允许走重新点击沟通的重试路径。
  function isChatRenderTimeoutError(error) {
    return Boolean(error && /聊天界面渲染\s*等待超时/.test(String(error.message || error)));
  }

  // 等待聊天页关键区域就绪：输入框、会话列表、当前会话匹配。
  function waitForChatReady(job) {
    logDebugEvent('wait_chat_ready_start', {
      job: summarizeJobForDebug(job),
      timeoutSeconds: getWaitTimeout(),
      chatWaitTimeoutSeconds: getChatWaitTimeout(),
      hasChatInput: Boolean(findChatInput()),
      isChatPage: isChatPage(),
      runState: RunState.load(),
    });
    return waitFor(() => {
      if (!/\/chat\b|\/web\/geek\/chat/.test(location.pathname + location.hash) && !document.querySelector('.chat-input')) {
        return null;
      }

      if (document.readyState === 'loading') return null;

      const readyTarget = findChatInput();
      if (readyTarget) {
        logDebugEvent('wait_chat_ready_success', {
          job: summarizeJobForDebug(job),
          inputText: summarizeLongText(getEditableText(readyTarget)),
          href: location.href,
        });
        return readyTarget;
      }

      return null;
    }, getWaitTimeout(), '聊天界面渲染');
  }

  // 向聊天输入框写入文本并按 Enter，返回发送前快照供后续确认。
  async function sendChatTextByEnter(messageText) {
    const input = await waitFor(() => findChatInput(), getChatWaitTimeout(), '聊天输入框');
    const snapshot = getSendVerificationSnapshot(messageText);

    // BOSS 聊天框是 contenteditable div。这里只负责写入草稿并触发 Enter，是否真的发出由后续聊天记录确认决定。
    setEditableText(input, messageText);
    await waitFor(() => inputContainsText(findChatInput(), messageText), 3000, '聊天输入框写入文本');

    await sleep(300);
    pressEnter(findChatInput() || input);

    // 如果 Enter 没有触发发送，最多再点一次页面自己的发送按钮；之后仍未确认就直接停机。
    await sleep(800);
    const current = getSendVerificationSnapshot(messageText);
    if (!isMessageActuallySent(snapshot, current) && inputContainsText(findChatInput(), messageText)) {
      const sendButton = findSendButton();
      if (sendButton) clickNative(sendButton);
    }

    return snapshot;
  }

  // 等待输入框清空且聊天记录中新出现目标文本，确认消息确实发送。
  async function waitForMessageSent(messageText, beforeSend) {
    const snapshot = beforeSend || getSendVerificationSnapshot(messageText);

    await waitFor(() => {
      const input = findChatInput();
      const inputCleared = !normalizeText(getEditableText(input));
      const current = getSendVerificationSnapshot(messageText);

      if (inputCleared && isMessageActuallySent(snapshot, current)) {
        return true;
      }
      return null;
    }, getChatWaitTimeout(), '消息发送确认');
  }

  // 生成发送校验快照：目标 token 当前出现次数和“确认发送”次数。
  function getSendVerificationSnapshot(messageText) {
    const token = getMessageVerifyToken(messageText);
    const currentText = getCurrentConversationText();
    return {
      token,
      currentCount: countTextToken(currentText, token),
      currentConfirmedCount: countConfirmedToken(currentText, token),
    };
  }

  // 对比发送前后快照，判断消息是否新增到聊天内容区域。
  function isMessageActuallySent(before, after) {
    if (!before || !after) return false;

    // 只以右侧聊天内容区域为准；左侧会话预览、输入框草稿、脚本 UI 文本都不能作为成功依据。
    return after.currentCount > before.currentCount ||
      after.currentConfirmedCount > before.currentConfirmedCount;
  }

  // 只读取聊天内容区域文本，排除输入框草稿、左侧会话预览和脚本 UI。
  function getCurrentConversationText() {
    const roots = Array.from(document.querySelectorAll([
      '.chat-record',
      '.chat-message-list',
      '.chat-message',
      '.chat-conversation',
    ].join(','))).filter((element) => !isOwnUiElement(element) && isVisible(element));

    return normalizeText(roots.map(cloneConversationText).join(' '));
  }

  // 克隆聊天区域后删除输入框/按钮/脚本 UI，再提取用于发送确认的纯文本。
  function cloneConversationText(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll([
      '#chat-input',
      '.chat-input',
      'textarea',
      'input',
      '[contenteditable="true"]',
      '#zhipin-auto-greeting-root',
      '.chat-editor',
      '.editor-container',
      '.chat-op',
      '.message-controls',
      '.user-list-content',
      '.user-list',
      '.friend-list',
      '.chat-user',
      '.chat-user-list',
    ].join(',')).forEach((item) => item.remove());
    return normalizeText(clone.innerText || clone.textContent || '');
  }

  // 发送确认只使用消息前 60 个字符作为 token，减少长文本换行/裁剪带来的误差。
  function getMessageVerifyToken(messageText) {
    return normalizeText(messageText).slice(0, 24);
  }

  // 统计 token 在聊天文本中出现次数。
  function countTextToken(text, token) {
    const source = normalizeText(text);
    const target = normalizeText(token);
    if (!source || !target) return 0;

    let count = 0;
    let index = source.indexOf(target);
    while (index >= 0) {
      count += 1;
      index = source.indexOf(target, index + target.length);
    }
    return count;
  }

  // 更严格的 token 统计：排除输入框附近文本后，用于减少误判。
  function countConfirmedToken(text, token) {
    const source = normalizeText(text);
    const target = normalizeText(token);
    if (!source || !target) return 0;

    let count = 0;
    let index = source.indexOf(target);
    while (index >= 0) {
      const nearby = source.slice(Math.max(0, index - 80), Math.min(source.length, index + target.length + 80));
      if (/送达|已读|已发送/.test(nearby)) count += 1;
      index = source.indexOf(target, index + target.length);
    }
    return count;
  }

  // 判断草稿是否还留在输入框中，用于决定是否需要兜底点击发送按钮。
  function inputContainsText(input, expectedText) {
    const token = getMessageVerifyToken(expectedText);
    return token && normalizeText(getEditableText(input)).includes(token);
  }

  // 从聊天页返回岗位列表。优先保持浏览器历史和原列表滚动，不主动刷新 URL。
  async function navigateToJobList(listUrl) {
    if (hasVisibleJobCards()) return true;

    const timeout = Math.max(config.ignoreListRefresh ? 15000 : 8000, getWaitTimeout() * 1000);
    const targetListUrl = getRestorableListUrl(listUrl);

    if (isJobListRoute()) {
      UI.setStatus(config.ignoreListRefresh ? '岗位列表刷新中，正在等待列表恢复...' : '正在等待岗位列表恢复...', 'info');
      await waitForVisibleJobList(timeout);
      return true;
    }

    if (isChatPage()) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        UI.setStatus(attempt === 0
          ? '发送完成，正在通过浏览器历史返回岗位列表...'
          : '仍未看到岗位列表，再次执行浏览器历史返回...', 'info');
        const beforeHref = location.href;
        triggerBrowserHistoryBack(attempt);
        try {
          await waitForHistoryReturnOrJobList(beforeHref, Math.min(timeout, 5000 + attempt * 2000));
          await waitForVisibleJobList(timeout);
          return true;
        } catch (_) {}
      }

      if (targetListUrl) {
        UI.setStatus('浏览器历史返回未触发，正在打开原岗位列表页...', 'warn');
        pageWindow.location.assign(targetListUrl);
        await waitForVisibleJobList(timeout);
        return true;
      }

      throw new Error('浏览器历史返回后未恢复岗位列表，且缺少可恢复的岗位列表地址，请手动返回搜索结果页');
    }

    if (targetListUrl) {
      UI.setStatus('当前不在岗位列表页，正在打开原岗位列表页...', 'warn');
      pageWindow.location.assign(targetListUrl);
      await waitForVisibleJobList(timeout);
      return true;
    }

    throw new Error('当前页面不是聊天页，也没有可见岗位列表，请手动返回搜索结果页');
  }

  // 交替使用 back/go(-1)，应对页面 history 包装导致某一种方式失效。
  function triggerBrowserHistoryBack(attempt) {
    try {
      if (attempt % 2 === 0) {
        nativeHistoryNavigation.back();
      } else {
        nativeHistoryNavigation.go(-1);
      }
      return;
    } catch (error) {
      console.warn('[ZhipinAuto] 原生 history 返回失败，降级使用页面 history', error);
    }

    try {
      if (attempt % 2 === 0) {
        pageWindow.history.back();
      } else {
        pageWindow.history.go(-1);
      }
    } catch (error) {
      console.warn('[ZhipinAuto] 页面 history 返回失败', error);
    }
  }

  // 等待 URL 变化或岗位卡片出现，确认浏览器历史返回已经生效。
  function waitForHistoryReturnOrJobList(previousHref, timeout) {
    return waitFor(() => {
      if (hasVisibleJobCards()) return true;
      if (location.href !== previousHref && isJobListRoute()) return true;
      return null;
    }, timeout, '岗位列表恢复');
  }

  // 生成可恢复的列表 URL，只作为极端兜底，不作为正常返回路径。
  function getRestorableListUrl(listUrl) {
    const source = normalizeText(listUrl);
    if (!source) return '';

    try {
      const url = new URL(source, location.href);
      if (url.origin !== location.origin || !/\/web\/geek\/jobs/.test(url.pathname + url.hash)) return '';
      return url.href;
    } catch (_) {
      return '';
    }
  }

  // 判断当前是否处于岗位列表路由。
  function isJobListRoute() {
    return /\/web\/geek\/jobs/.test(location.pathname + location.hash);
  }

  // 判断岗位列表是否真的渲染出可见卡片。
  function hasVisibleJobCards() {
    return Array.from(document.querySelectorAll('li.job-card-box')).some(isVisible);
  }

  // 等待岗位列表卡片出现，返回阶段和启动恢复都会使用。
  function waitForVisibleJobList(timeout) {
    return waitFor(() => {
      const card = Array.from(document.querySelectorAll('li.job-card-box')).find(isVisible);
      return card || null;
    }, timeout, '岗位列表');
  }

  // 判断当前是否处于聊天路由。
  function isChatPage() {
    return Boolean(
      hasVisibleChatInputShell() ||
      findCommonPhraseButton() ||
      /\/web\/geek\/chat|\/chat/.test(location.pathname + location.hash),
    );
  }

  // 粗略判断聊天输入区域是否可见，用于区分聊天页未渲染和已进入聊天页。
  function hasVisibleChatInputShell() {
    return Array.from(document.querySelectorAll([
      '#chat-input.chat-input',
      '.chat-input[contenteditable="true"]',
      '[contenteditable="true"].chat-input',
      '.chat-input',
    ].join(','))).some((element) => !isOwnUiElement(element) && isVisible(element));
  }

  // 重试打开聊天时重新定位原岗位卡片，优先按岗位匹配，最后用旧游标兜底。
  function findJobCardForRetry(job, cards, fallbackIndex) {
    const candidates = cards && cards.length ? cards : getJobCards();
    for (const card of candidates) {
      if (isRetryCardMatch(card, job)) return card;
    }

    const fallback = candidates[Math.max(0, Number(fallbackIndex || 0))];
    return fallback && isRetryCardMatch(fallback, job) ? fallback : null;
  }

  // 判断重试时某张卡片是否像 pendingJob。
  function isRetryCardMatch(card, job) {
    if (!card || !job) return false;

    const domInfo = extractCardInfo(card);
    const match = JobRepository.cardLooksLikeJob(domInfo, job);
    if (match.comparable) return match.matched;

    const text = domInfo.text || normalizeText(card.innerText || card.textContent || '');
    const jobName = normalizeText(job.jobName);
    const company = normalizeText(job.company);
    const bossName = normalizeText(job.bossName);

    if (jobName && company) return text.includes(jobName) && text.includes(company);
    if (jobName && bossName) return text.includes(jobName) && text.includes(bossName);
    return Boolean(jobName && text.includes(jobName));
  }

  // 记录返回前列表快照，返回后用于判断列表是否刷新或上下文是否变化。
  function createJobListSnapshot() {
    const cards = getJobCards();
    const cardHeadItems = cards
      .slice(0, 8)
      .map((card) => makeCardSnapshotKey(extractCardInfo(card)))
      .filter(Boolean);
    const firstPage = runtime.latestFirstPageJobListResponse || {};

    return {
      href: location.href,
      contextKey: runtime.jobListContextKey || firstPage.contextKey || '',
      batchKey: runtime.jobListLastBatchKey || '',
      firstPageBatchKey: firstPage.batchKey || '',
      responseSerial: runtime.jobListResponseSerial || 0,
      firstPageSerial: runtime.jobListFirstPageSerial || 0,
      cardCount: cards.length,
      cardHeadKey: cardHeadItems.length ? hashString(cardHeadItems.join('||')) : '',
      capturedAt: Date.now(),
    };
  }

  // 生成当前可见卡片的简短签名，用于列表刷新检测。
  function makeCardSnapshotKey(domInfo) {
    if (!domInfo) return '';
    const key = (domInfo.keys || []).map(normalizeText).filter(Boolean)[0];
    if (key) return `key:${key}`;
    if (isMeaningfulCompositeKey(domInfo.looseSignature)) return `loose:${domInfo.looseSignature}`;
    if (isMeaningfulCompositeKey(domInfo.signature)) return `signature:${domInfo.signature}`;
    return '';
  }

  // 返回列表后短暂观察是否出现第一页接口响应，用于判断列表被刷新。
  async function waitForReturnedJobListRefresh(returnStartedAt) {
    const timeout = Math.min(Math.max(700, getWaitTimeout() * 250), 1800);

    try {
      await waitFor(() => {
        const latestFirstPage = runtime.latestFirstPageJobListResponse || {};
        if (latestFirstPage.capturedAt && Number(latestFirstPage.capturedAt) >= Number(returnStartedAt || 0)) {
          return latestFirstPage;
        }
        return null;
      }, timeout, '岗位列表刷新检测');
    } catch (_) {}
  }

  // 滚动列表底部并等待 BOSS 懒加载更多岗位卡片。
  async function scrollAndWaitForMore(previousCount) {
    const cards = getJobCards();
    const lastCard = cards[cards.length - 1];
    const scroller = findScrollParent(lastCard) || document.scrollingElement || document.documentElement;

    if (lastCard) lastCard.scrollIntoView({ block: 'end', inline: 'nearest' });
    scroller.scrollTop += Math.max(scroller.clientHeight * 0.8, 500);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));

    try {
      await waitFor(() => getJobCards().length > previousCount, Math.min(getWaitTimeout(), 6000), '加载更多岗位');
      return true;
    } catch (_) {
      return false;
    }
  }

  // 跳过岗位后将下一张卡片滚入视野，帮助页面继续懒加载和保持上下文。
  function scrollAhead(nextIndex) {
    const cards = getJobCards();
    const nextCard = cards[nextIndex];
    if (nextCard) {
      nextCard.scrollIntoView({ block: 'center', inline: 'nearest' });
      if (cards.length - nextIndex <= 5) {
        const scroller = findScrollParent(nextCard);
        if (scroller) {
          scroller.scrollTop += 400;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
      }
    }
  }

  // 列表刷新后从顶部重新开始时使用。
  function scrollJobListToTop() {
    const cards = getJobCards();
    const anchor = cards[0] || document.querySelector('li.job-card-box');
    const scroller = findScrollParent(anchor) || document.scrollingElement || document.documentElement;

    if (scroller) {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    }

    try {
      pageWindow.scrollTo(0, 0);
    } catch (_) {
      window.scrollTo(0, 0);
    }
  }

  // 查找真实滚动容器；BOSS 列表不一定滚动 document。
  function findScrollParent(element) {
    let current = element && element.parentElement;
    while (current && current !== document.body) {
      const style = getComputedStyle(current);
      if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight) {
        return current;
      }
      current = current.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // 等待某个可见元素出现的便捷封装。
  function waitForElement(selector, timeout, label) {
    return waitFor(() => {
      const element = document.querySelector(selector);
      return element && isVisible(element) ? element : null;
    }, timeout, label || selector);
  }

  // 通用等待器：MutationObserver + 定时轮询，适合等待 SPA DOM 或接口缓存变化。
  function waitFor(predicate, timeout, label) {
    const timeoutMs = timeout > 100 ? timeout : timeout * 1000;
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      let done = false;
      let observer = null;

      const check = () => {
        if (done) return;

        try {
          const result = predicate();
          if (result) {
            done = true;
            if (observer) observer.disconnect();
            resolve(result);
            return;
          }
        } catch (error) {
          if (error && error.zhipinAutoPause) {
            done = true;
            if (observer) observer.disconnect();
            reject(error);
            return;
          }
        }

        if (Date.now() - startedAt >= timeoutMs) {
          done = true;
          if (observer) observer.disconnect();
          reject(new Error(`${label || '目标元素'} 等待超时`));
        }
      };

      observer = new MutationObserver(check);
      observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
      });

      check();
      const timer = setInterval(() => {
        if (done) {
          clearInterval(timer);
          return;
        }
        check();
      }, 120);
    });
  }

  // 模拟用户点击，按真实坐标派发 pointer/mouse/click 事件。
  function clickElement(element) {
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const clientX = rect.left + Math.min(Math.max(rect.width / 2, 4), Math.max(rect.width - 4, 4));
    const clientY = rect.top + Math.min(Math.max(rect.height / 2, 4), Math.max(rect.height - 4, 4));
    const target = document.elementFromPoint(clientX, clientY) || element;
    const mouseInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: pageWindow,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      button: 0,
      buttons: 1,
    };

    // BOSS 的部分列表项依赖真实坐标下的 pointer/mouse 事件，单纯 element.click() 不会触发。
    dispatchPointer(target, 'pointerover', mouseInit);
    target.dispatchEvent(new MouseEvent('mouseover', mouseInit));
    dispatchPointer(target, 'pointerdown', mouseInit);
    target.dispatchEvent(new MouseEvent('mousedown', mouseInit));
    dispatchPointer(target, 'pointerup', Object.assign({}, mouseInit, { buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, mouseInit, { buttons: 0 })));
    target.dispatchEvent(new MouseEvent('click', Object.assign({}, mouseInit, { buttons: 0 })));

    if (target !== element) {
      try {
        element.click();
      } catch (_) {}
    }
  }

  // PointerEvent 不可用时降级为 MouseEvent。
  function dispatchPointer(target, type, init) {
    if (typeof PointerEvent !== 'function') return;

    try {
      target.dispatchEvent(new PointerEvent(type, Object.assign({
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }, init)));
    } catch (_) {}
  }

  // 写入 input/textarea/contenteditable，并派发 beforeinput/input/change 让 BOSS 内部状态同步。
  function setEditableText(container, text) {
    const target = container.matches('textarea,input,[contenteditable="true"]')
      ? container
      : container.querySelector('textarea,input,[contenteditable="true"]') || container;

    target.focus();
    if (typeof target.click === 'function') {
      try {
        target.click();
      } catch (_) {}
    }

    if ('value' in target) {
      setNativeValue(target, text);
      target.dispatchEvent(createInputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      }));
      target.dispatchEvent(createInputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      target.dispatchEvent(createDomEvent('change', { bubbles: true }));
      return;
    }

    // BOSS 的聊天框是 contenteditable div，直接写入文本后再派发 input，让站点同步内部状态。
    target.textContent = '';
    target.textContent = text;
    placeCaretAtEnd(target);

    target.dispatchEvent(createInputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }));
    target.dispatchEvent(createInputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  // 使用原生 value setter，避免 React/Vue 受控输入框读不到手动赋值。
  function setNativeValue(target, text) {
    const proto = target.tagName === 'TEXTAREA'
      ? pageWindow.HTMLTextAreaElement && pageWindow.HTMLTextAreaElement.prototype
      : pageWindow.HTMLInputElement && pageWindow.HTMLInputElement.prototype;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');

    if (descriptor && descriptor.set) {
      descriptor.set.call(target, text);
    } else {
      target.value = text;
    }
  }

  // 把光标放到可编辑区域末尾，确保 Enter 发送的是完整文本。
  function placeCaretAtEnd(target) {
    try {
      const selection = pageWindow.getSelection && pageWindow.getSelection();
      const range = pageWindow.document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } catch (_) {}
  }

  // 统一读取输入框或 contenteditable 的当前文本。
  function getEditableText(element) {
    if (!element) return '';
    if ('value' in element) return String(element.value || '');
    return String(element.innerText || element.textContent || '');
  }

  // 调用元素原生 click，绕过页面可能包装过的实例方法。
  function clickNative(element) {
    if (!element) return;
    try {
      element.focus && element.focus();
      const nativeClick = pageWindow.HTMLElement && pageWindow.HTMLElement.prototype.click;
      if (nativeClick) {
        nativeClick.call(element);
      } else {
        element.click();
      }
    } catch (_) {
      clickElement(element);
    }
  }

  // 创建 InputEvent，旧环境不支持时退回普通 Event。
  function createInputEvent(type, init) {
    const Ctor = pageWindow.InputEvent || InputEvent;
    try {
      return new Ctor(type, init);
    } catch (_) {
      return createDomEvent(type, init);
    }
  }

  // 普通 DOM 事件构造兜底。
  function createDomEvent(type, init) {
    const Ctor = pageWindow.Event || Event;
    return new Ctor(type, init || {});
  }

  // 在输入框上派发 Enter 键事件，触发页面自己的发送逻辑。
  function pressEnter(target) {
    const eventInit = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      view: pageWindow,
    };
    const Ctor = pageWindow.KeyboardEvent || KeyboardEvent;
    target.focus && target.focus();
    target.dispatchEvent(new Ctor('keydown', eventInit));
    target.dispatchEvent(new Ctor('keypress', eventInit));
    target.dispatchEvent(new Ctor('keyup', eventInit));
  }

  // 公司名按模式匹配，供公司筛选和黑名单共用。
  function companyTextMatches(targetText, mode, valueText) {
    const target = normalizeText(targetText);
    const value = normalizeText(valueText);
    if (!target || !value) return false;

    const matchMode = getCompanyMatchMode(mode);
    if (matchMode === 'exact') return target === value;
    if (matchMode === 'regex') return new RegExp(value).test(target);
    return target.includes(value);
  }

  // 公司筛选逻辑，支持精确、包含、正则三种模式。
  function companyMatches(company) {
    const value = normalizeText(config.companyFilterValue);
    if (!value) return true;
    return companyTextMatches(company, config.companyFilterMode, value);
  }

  // 收集岗位上可用于黑名单匹配的公司名，详情补全后会包含全称/简称。
  function getCompanyMatchCandidates(job, fallbackCompany) {
    const values = [
      job && job.company,
      job && job.companyFullName,
      job && job.companyShortName,
      fallbackCompany,
    ];
    return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
  }

  // 任意一条公司黑名单规则命中即跳过，返回命中的规则和公司文本。
  function findCompanyBlacklistMatch(job, fallbackCompany) {
    const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
    if (!rules.length) return null;

    const candidates = getCompanyMatchCandidates(job, fallbackCompany);
    for (const rule of rules) {
      for (const company of candidates) {
        try {
          if (companyTextMatches(company, rule.mode, rule.value)) {
            return { rule, company };
          }
        } catch (error) {
          logDebugEvent('invalid_company_blacklist_rule', {
            rule,
            error: error.message || String(error),
          }, 'warn');
        }
      }
    }
    return null;
  }

  // 根据当前配置判断岗位 Boss 活跃度是否命中，并返回可用于日志/UI 的判定信息。
  function bossActiveMatches(job) {
    const selectedKeys = getSelectedBossActiveKeys();
    const activeText = getDisplayBossActiveTime(job);
    const activeKey = normalizeBossActiveText(activeText);
    if (!selectedKeys.length) {
      return { matched: true, activeText, selectedText: '' };
    }

    return {
      matched: Boolean(activeKey && selectedKeys.some((key) => activeKey === key || activeKey.includes(key))),
      activeText,
      selectedText: normalizeBossActiveOptions(config.bossActiveFilterValues).join('、'),
    };
  }

  // 活跃度字段缺失时，从右侧详情 DOM 轻量补充；这里只补活跃度，不触发完整工商抓取。
  async function enrichBossActiveInfoForFilter(job) {
    if (!hasBossActiveFilter() || getDisplayBossActiveTime(job)) return job;

    try {
      const domDetail = await waitFor(() => {
        const detail = extractDetailInfo();
        return detail && detail.bossActiveTimeDesc ? detail : null;
      }, Math.min(1800, getWaitTimeout() * 1000), 'Boss活跃度');
      return mergeJobInfo(job, {
        bossActiveTimeDesc: domDetail.bossActiveTimeDesc,
        bossOnline: domDetail.bossOnline,
      });
    } catch (_) {
      return job;
    }
  }

  // 启动前校验配置，发现问题时返回可直接显示给用户的错误文案。
  function validateConfig() {
    const min = Number(config.delayMin);
    const max = Number(config.delayMax);
    const wait = Number(config.waitTimeout);

    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max < 1) {
      return '时间间隔必须是大于 0 的数字';
    }

    if (min > max) return '最小间隔不能大于最大间隔';
    if (!Number.isFinite(wait) || wait < 2) return '等待上限不能小于 2 秒';

    if (config.companyFilterMode === 'regex' && config.companyFilterValue) {
      try {
        new RegExp(config.companyFilterValue);
      } catch (error) {
        return `公司正则无效：${error.message}`;
      }
    }

    for (const rule of normalizeCompanyBlacklistRules(config.companyBlacklistRules)) {
      if (rule.mode !== 'regex') continue;
      try {
        new RegExp(rule.value);
      } catch (error) {
        return `公司黑名单正则无效：${rule.value} / ${error.message}`;
      }
    }

    if (config.greetingMode === 'customText' && config.textSource === 'text' && !normalizeMessageText(config.customText)) {
      return '自定义文本不能为空';
    }

    if (config.greetingMode === 'customText' && config.textSource === 'api' && !config.customApiUrl) {
      return '自定义文本接口不能为空';
    }

    if (config.greetingMode === 'customText' && config.textSource === 'api') {
      try {
        parseKeyValueConfig(config.customApiParams, 'URL 参数');
        parseKeyValueConfig(config.customApiHeaders, '请求头');
        parseRequestBodyConfig(config.customApiBody, '请求体');
      } catch (error) {
        return error.message || String(error);
      }
    }

    return '';
  }

  // 列表/详情等待上限，配置单位是秒，这里转换为毫秒前做最小值保护。
  function getWaitTimeout() {
    return Math.max(2, Number(config.waitTimeout || DEFAULT_CONFIG.waitTimeout));
  }

  // 聊天页打开重试次数，负数或异常值按 0 处理。
  function getChatOpenRetryLimit() {
    return Math.max(0, Math.floor(Number(config.chatOpenRetries ?? DEFAULT_CONFIG.chatOpenRetries) || 0));
  }

  // 聊天页等待时间比列表更长，给路由和会话渲染留余量。
  function getChatWaitTimeout() {
    return Math.max(15, getWaitTimeout());
  }

  // 生成两次沟通之间的随机等待毫秒数。
  function randomDelayMs(minSeconds, maxSeconds) {
    return randomDelaySeconds(minSeconds, maxSeconds) * 1000;
  }

  // 随机等待秒数，UI 状态里直接展示这个值。
  function randomDelaySeconds(minSeconds, maxSeconds) {
    const min = Math.max(1, Math.ceil(Number(minSeconds || DEFAULT_CONFIG.delayMin)));
    const max = Math.max(min, Math.floor(Number(maxSeconds || DEFAULT_CONFIG.delayMax)));
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  // 从 localStorage 中的 RunState 恢复 pendingJob，并补齐运行所需的派生字段。
  function revivePendingJob(state) {
    const pending = Object.assign({}, state.pendingJob || {});
    pending.rawJob = state.pendingRawJob || pending.rawJob || null;
    pending.id = pending.id || `job_${hashString(pending.jobKey || `${pending.jobName}|${pending.company}`)}`;
    pending.signature = pending.signature || makeSignature(pending.jobName, pending.company, pending.salary);
    return pending;
  }

  // 将岗位对象拍平成 IndexedDB/导出友好的结构，避免保存复杂引用和原型对象。
  function flattenJob(job) {
    return {
      id: job.id,
      jobKey: job.jobKey,
      signature: job.signature,
      orderIndex: job.orderIndex,
      jobName: job.jobName,
      salary: getDisplaySalary(job),
      company: job.company,
      bossName: job.bossName,
      bossTitle: job.bossTitle,
      bossActiveTimeDesc: getDisplayBossActiveTime(job),
      bossOnline: job.bossOnline,
      bossAvatar: job.bossAvatar,
      bossCertificated: job.bossCertificated,
      city: job.city,
      experience: job.experience,
      degree: job.degree,
      positionName: job.positionName,
      address: job.address,
      workAddress: job.workAddress,
      longitude: job.longitude,
      latitude: job.latitude,
      staticMapUrl: job.staticMapUrl,
      encryptAddressId: job.encryptAddressId,
      postDescription: job.postDescription,
      recruitmentCountDesc: job.recruitmentCountDesc,
      positionCode: job.positionCode,
      jobType: job.jobType,
      jobStatusDesc: job.jobStatusDesc,
      showSkills: Array.isArray(job.showSkills) ? job.showSkills.slice() : [],
      companyLogo: job.companyLogo,
      companyFullName: job.companyFullName,
      companyShortName: job.companyShortName,
      companyStage: job.companyStage,
      companyScale: job.companyScale,
      companyIndustry: job.companyIndustry,
      companyIntroduce: job.companyIntroduce,
      companyLabels: Array.isArray(job.companyLabels) ? job.companyLabels.slice() : [],
      businessInfo: job.businessInfo && typeof job.businessInfo === 'object' ? Object.assign({}, job.businessInfo) : null,
      legalRepresentative: job.legalRepresentative,
      establishedDate: job.establishedDate,
      companyType: job.companyType,
      manageState: job.manageState,
      registeredCapital: job.registeredCapital,
      registeredAddress: job.registeredAddress,
      businessTerm: job.businessTerm,
      businessRegion: job.businessRegion,
      unifiedSocialCreditCode: job.unifiedSocialCreditCode,
      approvalDate: job.approvalDate,
      formerName: job.formerName,
      registrationAuthority: job.registrationAuthority,
      businessIndustry: job.businessIndustry,
      businessScope: job.businessScope,
      brandId: job.brandId,
      encryptJobId: job.encryptJobId,
      securityId: job.securityId,
      lid: job.lid,
      source: job.source,
      sourceUrl: job.sourceUrl,
      detailSource: job.detailSource,
      detailSourceUrl: job.detailSourceUrl,
      detailCapturedAt: job.detailCapturedAt,
      htmlDetailUrl: job.htmlDetailUrl,
      htmlCapturedAt: job.htmlCapturedAt,
      companyDetailUrl: job.companyDetailUrl,
      companyDetailCapturedAt: job.companyDetailCapturedAt,
      domOnly: Boolean(job.domOnly),
    };
  }

  // 判断一条记录是否应视为“已沟通”，包括发送成功和本地/页面跳过。
  function isContactedRecord(record) {
    return Boolean(record && (
      record.status === 'sent' ||
      record.status === 'skipped_contacted' ||
      record.status === 'skipped_local_contacted' ||
      record.sentAt
    ));
  }

  // 为岗位生成一组稳定判重 key，优先使用加密岗位 ID、securityId、lid 等强标识。
  function getContactedKeys(job) {
    if (!job) return [];

    const rawJob = job.rawJob || {};
    const hasStableJobKey = job.jobKey && !isSyntheticJobKey(job.jobKey);
    const strongPairs = [
      ['jobKey', hasStableJobKey ? job.jobKey : ''],
      ['encryptJobId', job.encryptJobId],
      ['securityId', job.securityId],
      ['lid', job.lid],
      ['id', hasStableJobKey ? job.id : ''],
      ['rawJobId', rawJob.jobId],
      ['rawJobId', rawJob.job_id],
      ['rawEncryptJobId', rawJob.encryptJobId],
      ['rawSecurityId', rawJob.securityId],
      ['rawLid', rawJob.lid],
    ];

    const strongKeys = strongPairs
      .map(([type, value]) => makeContactedKey(type, value))
      .filter(Boolean);

    if (strongKeys.length) return Array.from(new Set(strongKeys));

    const looseSignature = job.looseSignature || makeLooseSignature(job.jobName, job.company);
    const fallbackKey = makeContactedKey('looseSignature', looseSignature);
    return fallbackKey ? [fallbackKey] : [];
  }

  // 给不同来源的判重值加前缀，避免不同字段值碰巧相同。
  function makeContactedKey(type, value) {
    const text = normalizeText(value);
    if (!text) return '';
    return `${type}:${text}`;
  }

  // synthetic key 是脚本用 DOM 字段拼出来的弱 key，不可当强身份使用。
  function isSyntheticJobKey(value) {
    return /^sig_/.test(normalizeText(value));
  }

  // 删除空值字段，避免保存记录时用空字符串覆盖后到的有效详情。
  function compactObject(source) {
    const output = {};
    Object.keys(source || {}).forEach((key) => {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
        output[key] = source[key];
      }
    });
    return output;
  }

  // 文本模板插值，例如 {jobName}、{company}、{bossName}。
  function interpolateText(template, job) {
    const source = String(template || '');
    const data = flattenJob(job || {});
    return source.replace(/\{(\w+)\}/g, (match, key) => {
      if (data[key] == null) return match;
      return String(data[key]);
    });
  }

  // 从一组候选字段中读取第一个非空字符串/数字。
  function pickFirstString(target, keys) {
    if (!target) return '';
    for (const key of keys) {
      const value = target[key];
      if (typeof value === 'string' && value.trim()) return normalizeText(value);
      if (typeof value === 'number') return String(value);
    }
    return '';
  }

  // 将接口中的标签数组归一化为字符串数组。
  function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => normalizeText(item && typeof item === 'object' ? item.name || item.text || item.label : item))
      .filter(Boolean);
  }

  // 清理文本但保留换行，用于岗位描述、经营范围等长文本。
  function normalizeTextPreserveLines(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 读取薪资字段，并过滤 BOSS 私有字体加密后的不可读薪资。
  function pickReadableSalary(target, keys) {
    // 接口 salaryDesc 是首选；如果取到的是私有区字符，继续尝试其它薪资字段。
    const first = pickFirstString(target, keys);
    if (!isEncryptedSalary(first)) return first;

    for (const key of keys) {
      const value = getReadableSalary(target && target[key]);
      if (value) return value;
    }
    return '';
  }

  // 生成岗位详情匹配 key，允许列表岗位和详情岗位互相找到。
  function getJobIdentityKeys(job) {
    if (!job) return [];

    const rawJob = job.rawJob || {};
    const values = [
      job.jobKey,
      job.encryptJobId,
      job.securityId,
      job.lid,
      rawJob.encryptId,
      rawJob.encryptJobId,
      rawJob.jobId,
      rawJob.job_id,
      rawJob.securityId,
      rawJob.lid,
      job.rawDetail && job.rawDetail.jobInfo && job.rawDetail.jobInfo.encryptId,
      job.rawDetail && job.rawDetail.securityId,
      job.rawDetail && job.rawDetail.lid,
    ];

    if (job.signature) values.push(`signature:${job.signature}`);
    if (job.looseSignature) values.push(`loose:${job.looseSignature}`);
    return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
  }

  // 可靠身份只包含真实接口 ID，不包含 DOM 拼出来的 sig_ 弱 key。
  function getReliableJobIdentityKeys(job) {
    if (!job) return [];

    const rawJob = job.rawJob || {};
    const rawDetail = job.rawDetail || {};
    const rawJobInfo = rawDetail.jobInfo || {};
    const values = [];
    const jobKey = normalizeText(job.jobKey);
    if (jobKey && !isSyntheticJobKey(jobKey)) values.push(jobKey);

    [
      job.encryptJobId,
      job.securityId,
      job.lid,
      rawJob.encryptId,
      rawJob.encryptJobId,
      rawJob.jobId,
      rawJob.job_id,
      rawJob.securityId,
      rawJob.lid,
      rawJobInfo.encryptId,
      rawJobInfo.encryptJobId,
      rawJobInfo.jobId,
      rawJobInfo.job_id,
      rawDetail.securityId,
      rawDetail.lid,
    ].forEach((value) => values.push(value));

    return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
  }

  // 弱签名只能用于没有可靠 ID 的兜底匹配，并且文本字段不能明显冲突。
  function isWeakDetailCompatible(job, detail) {
    return getWeakDetailCompatibilityReport(job, detail).compatible;
  }

  function getWeakDetailCompatibilityReport(job, detail) {
    if (!job || !detail) {
      return { compatible: false, reason: 'missing_job_or_detail' };
    }

    if (!areComparableTextsCompatible(job.jobName, detail.jobName)) {
      return {
        compatible: false,
        reason: 'job_name_mismatch',
        jobName: job.jobName,
        detailJobName: detail.jobName,
      };
    }
    if (!areComparableTextsCompatible(job.company, detail.company)) {
      return {
        compatible: false,
        reason: 'company_mismatch',
        company: job.company,
        detailCompany: detail.company,
      };
    }

    const jobSalary = getReadableSalary(job.salary);
    const detailSalary = getReadableSalary(detail.salary);
    if (jobSalary && detailSalary && jobSalary !== detailSalary) {
      return {
        compatible: false,
        reason: 'salary_mismatch',
        jobSalary,
        detailSalary,
      };
    }

    return {
      compatible: true,
      reason: 'weak_text_match',
      jobSalary,
      detailSalary,
    };
  }

  // 主动补拉详情后的安全校验：优先要求可靠 ID 命中，必要时才退回文本兼容判断。
  function isFetchedDetailCompatibleWithJob(job, detail, options) {
    return getFetchedDetailCompatibilityReport(job, detail, options).compatible;
  }

  function getFetchedDetailCompatibilityReport(job, detail, options) {
    const jobKeys = getReliableJobIdentityKeys(job);
    const detailKeyList = getReliableJobIdentityKeys(detail);
    const detailKeys = new Set(detailKeyList);
    const commonKeys = jobKeys.filter((key) => detailKeys.has(key));
    const allowWeakWithReliableKey = Boolean(options && options.allowWeakWithReliableKey);
    const weakReport = getWeakDetailCompatibilityReport(job, detail);

    if (jobKeys.length && detailKeyList.length) {
      if (commonKeys.length) {
        return Object.assign({}, weakReport, {
          compatible: true,
          reason: 'reliable_key_match',
          jobKeys,
          detailKeys: detailKeyList,
          commonKeys,
          allowWeakWithReliableKey,
        });
      }
      if (!allowWeakWithReliableKey) {
        return Object.assign({}, weakReport, {
          compatible: false,
          reason: 'reliable_key_mismatch',
          jobKeys,
          detailKeys: detailKeyList,
          commonKeys,
          allowWeakWithReliableKey,
        });
      }
    }

    return Object.assign({}, weakReport, {
      jobKeys,
      detailKeys: detailKeyList,
      commonKeys,
      allowWeakWithReliableKey,
    });
  }

  // 比较岗位名/公司名等文本字段；一边缺失时不阻断补全。
  function areComparableTextsCompatible(left, right) {
    const a = normalizeText(left);
    const b = normalizeText(right);
    if (!a || !b) return true;
    return a === b || a.includes(b) || b.includes(a);
  }

  // 只返回强身份 key，用于列表和详情之间高可信合并。
  function getJobStrongIdentityKeys(job) {
    return getReliableJobIdentityKeys(job);
  }

  // 详情对象入库索引用 key，和 getJobIdentityKeys 保持兼容。
  function getJobDetailKeys(detail) {
    if (!detail) return [];

    const rawDetail = detail.rawDetail || {};
    const rawJobInfo = rawDetail.jobInfo || {};
    const values = [
      detail.jobKey,
      detail.encryptJobId,
      detail.securityId,
      detail.lid,
      rawJobInfo.encryptId,
      rawJobInfo.encryptJobId,
      rawJobInfo.jobId,
      rawJobInfo.job_id,
      rawDetail.securityId,
      rawDetail.lid,
    ];

    return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
  }

  // UI/导出展示薪资时优先使用明文薪资，避免展示私有字体字符。
  function getDisplaySalary(job) {
    return getReadableSalary(job && job.salary) ||
      getReadableSalary(job && job.salaryDesc) ||
      getReadableSalary(job && job.rawDetail && job.rawDetail.jobInfo && job.rawDetail.jobInfo.salaryDesc) ||
      getReadableSalary(job && job.rawDetail && job.rawDetail.salaryDesc) ||
      getReadableSalary(job && job.rawJob && job.rawJob.salaryDesc) ||
      getReadableSalary(job && job.rawJob && job.rawJob.salary) ||
      '';
  }

  // Boss 活跃时间可能来自接口、HTML 或原始字段，这里统一展示取值。
  function getDisplayBossActiveTime(job) {
    if (!job) return '';
    if (job.bossOnline) return '在线';
    const rawActiveText =
      pickFirstString(job.rawDetail && job.rawDetail.bossInfo, [
        'activeTimeDesc',
        'bossActiveTimeDesc',
        'bossActiveDesc',
        'lastActiveTimeDesc',
        'onlineDesc',
      ]) ||
      pickFirstString(job.rawDetail, ['activeTimeDesc', 'bossActiveTimeDesc', 'bossActiveDesc']) ||
      pickFirstString(job.rawJob, ['activeTimeDesc', 'bossActiveTimeDesc', 'bossActiveDesc', 'lastActiveTimeDesc']);
    return getBossActiveOptionLabel(job.bossActiveTimeDesc) ||
      getBossActiveOptionLabel(rawActiveText) ||
      '';
  }

  // 公司展示优先完整公司名，再退回简称/列表公司名。
  function getDisplayCompany(job) {
    return getDisplayText(job && job.company);
  }

  // 统一清理导出/UI 文本。
  function getDisplayText(value) {
    const text = normalizeText(value);
    return text && !isEncryptedSalary(text) ? text : '';
  }

  // 判断薪资是否可读；私有区字符返回空。
  function getReadableSalary(value) {
    const text = normalizeText(value);
    if (!text || isEncryptedSalary(text)) return '';
    return text;
  }

  // BOSS 私有字体薪资一般落在 Unicode 私有区，不能用于记录和匹配。
  function isEncryptedSalary(text) {
    // BOSS 部分 DOM 会用私有区字体映射展示薪资，如 “-K”；接口 salaryDesc 通常是明文。
    return /[\uE000-\uF8FF]/.test(String(text || ''));
  }

  // 有深度限制的对象遍历，用于从未知接口结构中找岗位/常用语字段。
  function walkObject(value, visitor, depth) {
    const currentDepth = depth || 0;
    if (currentDepth > 8 || value == null) return;
    visitor(value);

    if (Array.isArray(value)) {
      value.forEach((item) => walkObject(item, visitor, currentDepth + 1));
      return;
    }

    if (typeof value === 'object') {
      Object.keys(value).forEach((key) => walkObject(value[key], visitor, currentDepth + 1));
    }
  }

  // 完整签名：岗位名 + 公司 + 薪资，匹配精度较高。
  function makeSignature(jobName, company, salary) {
    return [jobName, company, salary].map(normalizeText).join('|');
  }

  // 弱签名：岗位名 + 公司，薪资不可读或缺失时使用。
  function makeLooseSignature(jobName, company) {
    return [jobName, company].map(normalizeText).join('|');
  }

  // 过滤只有分隔符的空签名。
  function isMeaningfulCompositeKey(value) {
    const text = normalizeText(value);
    return Boolean(text && text.replace(/[|:]/g, ''));
  }

  // 单行文本归一化。
  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  // Boss 活跃度匹配专用归一化：去掉 DOM/伪元素残留、标点和分隔符。
  function normalizeBossActiveText(text) {
    return normalizeText(text)
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
      .replace(/::?(?:before|after)/gi, '')
      .replace(/[^\u3400-\u9FFFA-Za-z0-9]/g, '')
      .replace(/^(?:BOSS|Boss|boss|HR|hr)+/, '')
      .trim();
  }

  // 发送消息归一化：保留换行，只去掉首尾空白。
  function normalizeMessageText(text) {
    return String(text || '').replace(/\r\n/g, '\n').trim();
  }

  // 把用户输入转义为安全的正则字面量。
  function escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 判断元素是否可见，避免点击/等待隐藏节点。
  function isVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  // Promise 版延时。
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 带状态栏刷新的一秒倒计时等待，用于自动沟通间隔提示。
  async function waitWithStatusCountdown(nextRunAt, createMessage) {
    while (!runtime.stopRequested) {
      const state = RunState.load();
      if (!state || !state.active) return false;

      const remainingMs = Math.max(0, Number(nextRunAt || 0) - Date.now());
      if (remainingMs <= 0) break;

      const remainingSeconds = Math.ceil(remainingMs / 1000);
      UI.setStatus(createMessage(remainingSeconds), 'info');
      await sleep(Math.min(1000, remainingMs));
    }
    return !runtime.stopRequested;
  }

  // 统一使用 ISO 时间写入记录，便于排序和导出。
  function nowIso() {
    return new Date().toISOString();
  }

  // 解析面板里的本地时间输入。
  function parseDateTimeLocal(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // 面板状态展示用的本地时间格式。
  function formatLocalDateTime(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // 一条记录的沟通时间优先级，用于排序和按时间清理。
  function getRecordCommunicationTime(record) {
    return record && (record.sentAt || record.clickedAt || record.updatedAt || record.createdAt || '');
  }

  // 查询浏览器当前 origin 的存储使用量和配额。
  async function getStorageEstimate() {
    try {
      if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return null;
      const estimate = await navigator.storage.estimate();
      return {
        usage: Number(estimate.usage || 0),
        quota: Number(estimate.quota || 0),
      };
    } catch (_) {
      return null;
    }
  }

  // 构造用户可读的存储空间不足错误。
  function createStorageQuotaError(estimate, cause) {
    const usage = estimate && Number(estimate.usage || 0);
    const quota = estimate && Number(estimate.quota || 0);
    const ratio = quota ? Math.round((usage / quota) * 100) : 0;
    const detail = quota
      ? `当前已使用 ${formatBytes(usage)} / ${formatBytes(quota)}（约 ${ratio}%）。`
      : '';
    const error = new Error(`浏览器本地存储空间已接近上限，${detail}请先导出并删除部分岗位记录后再继续。`);
    error.cause = cause || null;
    error.zhipinStorageQuota = true;
    return error;
  }

  // 兼容不同浏览器的 IndexedDB 配额错误名称和消息。
  function isStorageQuotaError(error) {
    const name = String(error && error.name || '');
    const message = String(error && error.message || '');
    return /QuotaExceededError|NS_ERROR_DOM_QUOTA_REACHED/i.test(name) ||
      /quota|storage|空间|配额/i.test(message);
  }

  // 存储配额提示里的字节格式化。
  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[index]}`;
  }

  // 清理数据前的确认入口：优先使用脚本内弹窗，没有 UI 时退回浏览器 confirm。
  function askConfirm(message) {
    if (runtime.ui && runtime.ui.root) {
      return showConfirmDialog(message);
    }

    const confirmFn = window.confirm || pageWindow.confirm;
    if (typeof confirmFn !== 'function') {
      return Promise.reject(new Error('当前浏览器环境不支持确认弹窗'));
    }

    return Promise.resolve(confirmFn.call(window, message));
  }

  // 脚本内确认弹窗，避免页面样式或浏览器拦截影响确认流程。
  function showConfirmDialog(message) {
    return new Promise((resolve) => {
      const existing = runtime.ui.root.querySelector('.za-confirm-backdrop');
      if (existing) existing.remove();

      const backdrop = document.createElement('div');
      backdrop.className = 'za-confirm-backdrop';
      backdrop.innerHTML = `
        <div class="za-confirm-dialog" role="dialog" aria-modal="true" aria-label="确认操作">
          <div class="za-confirm-title">确认操作</div>
          <div class="za-confirm-message">${escapeHtml(message)}</div>
          <div class="za-confirm-actions">
            <button type="button" data-confirm="cancel">取消</button>
            <button type="button" class="za-danger" data-confirm="ok">确认删除</button>
          </div>
        </div>
      `;

      const cleanup = (value) => {
        backdrop.remove();
        resolve(value);
      };

      backdrop.addEventListener('click', (event) => {
        const action = event.target && event.target.dataset && event.target.dataset.confirm;
        if (action === 'ok') cleanup(true);
        if (action === 'cancel' || event.target === backdrop) cleanup(false);
      });

      backdrop.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') cleanup(false);
      });

      runtime.ui.root.appendChild(backdrop);
      const cancelButton = backdrop.querySelector('[data-confirm="cancel"]');
      if (cancelButton) cancelButton.focus();
    });
  }

  // 导出文件名中的时间戳。
  function dateFileName() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  // FNV-1a 风格哈希，用于合成稳定短 id。
  function hashString(input) {
    const text = String(input || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
  }

  // UI innerHTML 中插入文本前必须转义，避免记录内容破坏面板 DOM。
  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 优先使用系统“另存为”选择器；不可用时由 downloadBlob 降级成浏览器下载。
  function requestSaveFileHandle(fileName, extension) {
    const picker = pageWindow && pageWindow.showSaveFilePicker;
    if (typeof picker !== 'function') return null;

    const ext = String(extension || '').replace(/^\./, '').toLowerCase();
    const mimeType = ext === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/json';
    const description = ext === 'xlsx' ? 'Excel 工作簿' : 'JSON 数据';

    try {
      return Promise.resolve(picker.call(pageWindow, {
        suggestedName: ensureFileExtension(fileName, ext),
        excludeAcceptAllOption: true,
        types: [{
          description,
          accept: { [mimeType]: [`.${ext}`] },
        }],
      }));
    } catch (error) {
      console.warn('[ZhipinAuto] 系统另存为不可用，降级为浏览器下载', error);
      return null;
    }
  }

  // 写入用户选择的文件句柄，失败或不支持时创建 blob URL 触发下载。
  async function downloadBlob(content, fileName, type, extension, saveHandlePromise) {
    const safeFileName = ensureFileExtension(fileName, extension);
    const blob = createBlob(content, type);

    if (saveHandlePromise) {
      let handle = null;
      try {
        handle = await saveHandlePromise;
      } catch (error) {
        if (error && error.name === 'AbortError') {
          const cancelled = new Error('用户取消导出');
          cancelled.zhipinAutoExportCancelled = true;
          throw cancelled;
        }
        console.warn('[ZhipinAuto] 系统另存为失败，降级为浏览器下载', error);
      }

      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return ensureFileExtension(handle.name || safeFileName, extension);
      }
    }

    const url = URL.createObjectURL(blob);

    try {
      triggerAnchorDownload(url, safeFileName);
      return safeFileName;
    } catch (error) {
      throw new Error(`浏览器下载失败：${error.message || error}`);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    }
  }

  // 兼容字符串、ArrayBuffer 和已经构造好的 Blob。
  function createBlob(content, type) {
    if (content instanceof Blob) return content;
    return new Blob([content], { type });
  }

  // 清理非法文件名字符，并保证导出文件有正确扩展名。
  function ensureFileExtension(fileName, extension) {
    const normalized = String(fileName || `zhipin-job-records-${dateFileName()}`).replace(/[\\/:*?"<>|]+/g, '-');
    const ext = String(extension || '').replace(/^\./, '');
    if (!ext || new RegExp(`\\.${escapeRegExp(ext)}$`, 'i').test(normalized)) return normalized;
    return `${normalized}.${ext}`;
  }

  // 浏览器下载兜底：临时创建隐藏 a 标签并触发原生 click。
  function triggerAnchorDownload(url, fileName) {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.setAttribute('download', fileName);
    link.rel = 'noopener';
    link.style.display = 'none';
    (document.body || document.documentElement).appendChild(link);

    const nativeClick = pageWindow.HTMLAnchorElement && pageWindow.HTMLAnchorElement.prototype.click;
    if (nativeClick) {
      nativeClick.call(link);
    } else {
      link.click();
    }

    link.remove();
  }

  // 注入侧栏样式；全部限定在 #zhipin-auto-greeting-root 下，避免影响 BOSS 页面。
  function injectStyle() {
    if (document.getElementById('zhipin-auto-greeting-style')) return;

    const style = document.createElement('style');
    style.id = 'zhipin-auto-greeting-style';
    style.textContent = `
      #zhipin-auto-greeting-root {
        --za-width: 430px;
        --za-bg: #ffffff;
        --za-border: #d7dde7;
        --za-text: #1f2937;
        --za-muted: #667085;
        --za-primary: #00a6a7;
        --za-danger: #d92d20;
        color: var(--za-text);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        position: fixed;
        z-index: 2147483000;
        inset: 0 0 auto auto;
      }
      #zhipin-auto-greeting-root * {
        box-sizing: border-box;
      }
      #zhipin-auto-greeting-root [hidden] {
        display: none !important;
      }
      #zhipin-auto-greeting-root .za-toggle {
        position: fixed;
        right: 0;
        top: 45%;
        width: 42px;
        min-height: 88px;
        border: 1px solid var(--za-border);
        border-right: 0;
        border-radius: 8px 0 0 8px;
        background: var(--za-primary);
        color: #fff;
        cursor: pointer;
        writing-mode: vertical-rl;
        letter-spacing: 0;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
      }
      #zhipin-auto-greeting-root .za-panel {
        position: fixed;
        right: 0;
        top: 0;
        width: var(--za-width);
        max-width: calc(100vw - 24px);
        height: 100vh;
        background: var(--za-bg);
        border-left: 1px solid var(--za-border);
        box-shadow: -12px 0 28px rgba(15, 23, 42, 0.16);
        transform: translateX(100%);
        transition: transform 180ms ease;
        display: flex;
        flex-direction: column;
      }
      #zhipin-auto-greeting-root.za-open .za-panel {
        transform: translateX(0);
      }
      #zhipin-auto-greeting-root.za-open .za-toggle {
        display: none;
      }
      #zhipin-auto-greeting-root .za-header,
      #zhipin-auto-greeting-root .za-footer {
        flex: 0 0 auto;
        padding: 12px 14px;
        border-bottom: 1px solid var(--za-border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      #zhipin-auto-greeting-root .za-header {
        position: sticky;
        top: 0;
        z-index: 3;
        background: var(--za-bg);
        box-shadow: 0 1px 0 rgba(215, 221, 231, 0.85);
      }
      #zhipin-auto-greeting-root .za-header-title {
        flex: 1 1 auto;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-header-title strong,
      #zhipin-auto-greeting-root .za-header-title span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-header-actions {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #zhipin-auto-greeting-root .za-footer {
        border-top: 1px solid var(--za-border);
        border-bottom: 0;
      }
      #zhipin-auto-greeting-root .za-subtitle {
        display: block;
        color: var(--za-muted);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        background: #fff;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-feature-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 86px;
        padding: 0 8px;
      }
      #zhipin-auto-greeting-root .za-feature-panel {
        position: fixed;
        top: 58px;
        right: 14px;
        z-index: 4;
        width: calc(var(--za-width) - 28px);
        max-width: calc(100vw - 52px);
        padding: 10px;
        border: 1px solid var(--za-border);
        border-radius: 8px;
        background: #fff;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22);
      }
      #zhipin-auto-greeting-root .za-feature-panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-feature-panel-close {
        width: 26px;
        min-height: 26px;
        padding: 0;
        border-radius: 6px;
        background: #fff;
        color: var(--za-muted);
        font-size: 18px;
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-feature-list {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      #zhipin-auto-greeting-root .za-feature-switch {
        width: 100%;
        min-width: 0;
        height: auto;
        min-height: 38px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 8px;
        background: #fff;
        text-align: left;
        white-space: normal;
      }
      #zhipin-auto-greeting-root .za-feature-switch > span:first-child {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-feature-switch.za-enabled {
        border-color: #b7e4e5;
        background: #ecfeff;
        color: #007f80;
      }
      #zhipin-auto-greeting-root .za-feature-switch.za-readonly {
        border-style: dashed;
      }
      #zhipin-auto-greeting-root .za-feature-state {
        flex: 0 0 auto;
        color: var(--za-muted);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-feature-switch.za-enabled .za-feature-state {
        color: #007f80;
      }
      #zhipin-auto-greeting-root .za-status {
        flex: 0 0 auto;
        position: sticky;
        top: 73px;
        z-index: 2;
        margin: 12px 14px 0;
        padding: 9px 10px;
        border: 1px solid #d7dde7;
        border-radius: 6px;
        background: #eef2f6;
        box-shadow: 0 0 0 14px var(--za-bg), 0 10px 18px rgba(15, 23, 42, 0.08);
        color: #344054;
        word-break: break-word;
      }
      #zhipin-auto-greeting-root .za-status[data-type="ok"] {
        background: #ecfdf3;
        border-color: #abefc6;
        color: #027a48;
      }
      #zhipin-auto-greeting-root .za-status[data-type="warn"] {
        background: #fffaeb;
        border-color: #fedf89;
        color: #b54708;
      }
      #zhipin-auto-greeting-root .za-status[data-type="error"] {
        background: #fef3f2;
        border-color: #fecdca;
        color: #b42318;
      }
      #zhipin-auto-greeting-root .za-section {
        padding: 12px 14px 0;
      }
      #zhipin-auto-greeting-root .za-status + .za-section {
        padding-top: 20px;
      }
      #zhipin-auto-greeting-root .za-panel {
        overflow-y: auto;
      }
      #zhipin-auto-greeting-root h3 {
        margin: 0 0 8px;
        font-size: 13px;
        font-weight: 700;
      }
      #zhipin-auto-greeting-root label {
        display: block;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root input,
      #zhipin-auto-greeting-root select,
      #zhipin-auto-greeting-root textarea {
        width: 100%;
        min-height: 32px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 6px 8px;
        background: #fff;
        color: var(--za-text);
        font: inherit;
      }
      #zhipin-auto-greeting-root textarea {
        resize: vertical;
        min-height: 76px;
      }
      #zhipin-auto-greeting-root select[data-field="companyFilterMode"]:focus,
      #zhipin-auto-greeting-root select[data-field="companyFilterMode"]:focus-visible,
      #zhipin-auto-greeting-root select[data-field="exportType"]:focus,
      #zhipin-auto-greeting-root select[data-field="exportType"]:focus-visible {
        outline: none;
        box-shadow: none;
        border-color: var(--za-border);
      }
      #zhipin-auto-greeting-root button {
        min-height: 32px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 0 10px;
        background: #fff;
        color: var(--za-text);
        cursor: pointer;
        font: inherit;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      #zhipin-auto-greeting-root input:disabled,
      #zhipin-auto-greeting-root select:disabled,
      #zhipin-auto-greeting-root textarea:disabled {
        cursor: not-allowed;
        opacity: 0.72;
        background: #f3f4f6;
      }
      #zhipin-auto-greeting-root .za-primary {
        background: var(--za-primary);
        border-color: var(--za-primary);
        color: #fff;
        flex: 1;
      }
      #zhipin-auto-greeting-root .za-danger {
        background: #fff;
        border-color: #fecdca;
        color: var(--za-danger);
        flex: 1;
      }
      #zhipin-auto-greeting-root .za-danger-soft {
        border-color: #fecdca;
        color: var(--za-danger);
      }
      #zhipin-auto-greeting-root .za-cleanup-time {
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-radio-row,
      #zhipin-auto-greeting-root .za-inline {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-segment {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        margin-bottom: 10px;
        padding: 3px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        background: #f8fafc;
      }
      #zhipin-auto-greeting-root .za-segment label {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 30px;
        margin: 0;
        border-radius: 4px;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-segment label:has(input:checked) {
        background: #fff;
        border: 1px solid #b7e4e5;
        color: #007f80;
      }
      #zhipin-auto-greeting-root .za-source-block {
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-api-panel {
        display: grid;
        gap: 8px;
      }
      #zhipin-auto-greeting-root .za-api-panel label {
        margin: 0;
      }
      #zhipin-auto-greeting-root .za-api-panel textarea {
        min-height: 68px;
      }
      #zhipin-auto-greeting-root .za-api-endpoint {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 92px;
        gap: 8px;
        align-items: end;
      }
      #zhipin-auto-greeting-root .za-api-method {
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-fast-reply-control {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: start;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-trigger {
        width: 100%;
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        text-align: left;
      }
      #zhipin-auto-greeting-root .za-fast-reply-trigger span:first-child {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #zhipin-auto-greeting-root .za-fast-reply-arrow {
        flex: 0 0 auto;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root.za-fast-reply-open .za-fast-reply-arrow {
        transform: rotate(180deg);
      }
      #zhipin-auto-greeting-root .za-fast-reply-preview {
        max-height: 118px;
        margin-bottom: 8px;
        overflow-y: auto;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 8px;
        background: #fbfcfd;
        color: #344054;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      #zhipin-auto-greeting-root .za-fast-reply-preview[data-empty="true"] {
        color: var(--za-muted);
        background: #f8fafc;
      }
      #zhipin-auto-greeting-root .za-fast-reply-backdrop {
        position: fixed;
        z-index: 2147483002;
        top: 0;
        right: 0;
        width: var(--za-width);
        max-width: calc(100vw - 24px);
        height: 100vh;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 82px 14px 14px;
        background: rgba(15, 23, 42, 0.18);
      }
      #zhipin-auto-greeting-root .za-fast-reply-dialog {
        width: 100%;
        max-height: calc(100vh - 104px);
        min-height: 240px;
        display: flex;
        flex-direction: column;
        border: 1px solid var(--za-border);
        border-radius: 8px;
        background: #fff;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.24);
      }
      #zhipin-auto-greeting-root .za-fast-reply-head {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 12px;
        border-bottom: 1px solid var(--za-border);
      }
      #zhipin-auto-greeting-root .za-fast-reply-head strong,
      #zhipin-auto-greeting-root .za-fast-reply-head span {
        display: block;
      }
      #zhipin-auto-greeting-root .za-fast-reply-head span {
        color: var(--za-muted);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-search {
        flex: 0 0 auto;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid #eef2f6;
      }
      #zhipin-auto-greeting-root .za-fast-reply-list {
        flex: 1 1 auto;
        min-height: 0;
        max-height: min(68vh, 520px);
        overflow-y: auto;
        padding: 6px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-option {
        width: 100%;
        height: auto;
        min-height: 0;
        display: block;
        margin: 0 0 6px;
        padding: 8px 10px;
        border-color: transparent;
        background: #fff;
        text-align: left;
        white-space: normal;
      }
      #zhipin-auto-greeting-root .za-fast-reply-option:hover {
        border-color: #e4e7ec;
        background: #f8fafc;
      }
      #zhipin-auto-greeting-root .za-fast-reply-option.za-selected {
        border-color: #b7e4e5;
        background: #ecfeff;
      }
      #zhipin-auto-greeting-root .za-fast-reply-option-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 4px;
        color: var(--za-muted);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-selected-mark {
        flex: 0 0 auto;
        color: #007f80;
      }
      #zhipin-auto-greeting-root .za-fast-reply-option-text {
        display: block;
        color: var(--za-text);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      #zhipin-auto-greeting-root .za-fast-reply-empty {
        padding: 22px 10px;
        color: var(--za-muted);
        text-align: center;
      }
      #zhipin-auto-greeting-root .za-selected-area {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        min-height: 34px;
        margin-bottom: 8px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 5px;
        background: #fbfcfd;
      }
      #zhipin-auto-greeting-root .za-multi-dropdown {
        position: relative;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-multi-trigger {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        text-align: left;
      }
      #zhipin-auto-greeting-root .za-multi-trigger span:first-child {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #zhipin-auto-greeting-root .za-multi-arrow {
        flex: 0 0 auto;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-multi-dropdown.za-open .za-multi-arrow {
        transform: rotate(180deg);
      }
      #zhipin-auto-greeting-root .za-multi-menu {
        position: absolute;
        z-index: 2;
        top: calc(100% + 4px);
        left: 0;
        right: 0;
        max-height: 220px;
        overflow-y: auto;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 4px;
        background: #fff;
        box-shadow: 0 8px 20px rgba(15, 23, 42, 0.12);
      }
      #zhipin-auto-greeting-root .za-multi-option {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 30px;
        margin: 0;
        border-radius: 4px;
        padding: 4px 6px;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-multi-option:hover {
        background: #f8fafc;
      }
      #zhipin-auto-greeting-root .za-multi-option span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-blacklist-option {
        justify-content: space-between;
        cursor: default;
      }
      #zhipin-auto-greeting-root .za-blacklist-option-label {
        min-width: 0;
        flex: 1 1 auto;
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-blacklist-delete {
        flex: 0 0 24px;
        width: 24px;
        min-height: 24px;
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--za-muted);
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-blacklist-delete:hover {
        color: #b91c1c;
        background: #fee2e2;
      }
      #zhipin-auto-greeting-root .za-boss-active-add {
        margin-top: 8px;
      }
      #zhipin-auto-greeting-root .za-blacklist-actions {
        margin-top: 8px;
      }
      #zhipin-auto-greeting-root .za-option-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        min-height: 24px;
        margin: 2px 0 4px;
      }
      #zhipin-auto-greeting-root .za-selected-chip,
      #zhipin-auto-greeting-root .za-option-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        max-width: 100%;
        min-height: 24px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 2px 3px 2px 8px;
        background: #f8fafc;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-selected-chip {
        background: #ecfeff;
        border-color: #b7e4e5;
        color: #007f80;
      }
      #zhipin-auto-greeting-root .za-selected-chip > span,
      #zhipin-auto-greeting-root .za-option-chip > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-selected-chip button,
      #zhipin-auto-greeting-root .za-option-chip button {
        width: 22px;
        min-height: 22px;
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--za-muted);
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-empty-text {
        color: var(--za-muted);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-radio-row label,
      #zhipin-auto-greeting-root .za-check {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root input[type="checkbox"],
      #zhipin-auto-greeting-root input[type="radio"] {
        width: 16px;
        min-height: 16px;
      }
      #zhipin-auto-greeting-root .za-inline > * {
        flex: 1 1 auto;
      }
      #zhipin-auto-greeting-root .za-inline > button {
        flex: 0 0 auto;
      }
      #zhipin-auto-greeting-root .za-grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      #zhipin-auto-greeting-root .za-label,
      #zhipin-auto-greeting-root .za-hint {
        color: var(--za-muted);
        font-size: 12px;
        margin: 6px 0;
      }
      #zhipin-auto-greeting-root .za-list-section {
        padding-bottom: 24px;
      }
      #zhipin-auto-greeting-root .za-list-viewport {
        position: relative;
        height: 220px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        overflow-y: auto;
        background: #fbfcfd;
      }
      #zhipin-auto-greeting-root .za-list-spacer {
        width: 1px;
      }
      #zhipin-auto-greeting-root .za-list-items {
        position: absolute;
        inset: 0 0 auto 0;
      }
      #zhipin-auto-greeting-root .za-list-row {
        position: absolute;
        left: 0;
        right: 0;
        height: 66px;
        padding: 8px 10px;
        border-bottom: 1px solid #eef2f6;
        overflow: hidden;
      }
      #zhipin-auto-greeting-root .za-list-row strong,
      #zhipin-auto-greeting-root .za-list-row span {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-list-row span {
        color: var(--za-muted);
        margin-top: 4px;
      }
      #zhipin-auto-greeting-root .za-confirm-backdrop {
        position: fixed;
        inset: 0;
        z-index: 2147483001;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        background: rgba(15, 23, 42, 0.34);
      }
      #zhipin-auto-greeting-root .za-confirm-dialog {
        width: min(360px, calc(100vw - 32px));
        border: 1px solid var(--za-border);
        border-radius: 8px;
        background: #fff;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.24);
        padding: 16px;
      }
      #zhipin-auto-greeting-root .za-confirm-title {
        font-size: 15px;
        font-weight: 700;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-confirm-message {
        color: #344054;
        white-space: pre-wrap;
        word-break: break-word;
      }
      #zhipin-auto-greeting-root .za-confirm-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 16px;
      }
    `;

    document.documentElement.appendChild(style);
  }

  installAllowedPageRouteWatcher();

  // 所有模块都完成初始化后再挂载 UI，避免 document-start 下 body 已存在时触发 const TDZ。
  setTimeout(syncAllowedPageUi, 0);

  pageWindow.addEventListener('pageshow', () => {
    const allowed = syncAllowedPageUi();
    if (allowed) {
      setTimeout(() => {
        if (isAllowedDisplayPage()) Automation.resumeIfNeeded('pageshow');
      }, 300);
    }
  });
})();
