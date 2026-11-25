/**
 * 在浏览器与插件沙箱环境中运行的确定性全量汉化引擎主调度器。
 * 通过 Function.prototype.toString() 与子模块工厂组装为独立 IIFE，零外部依赖、零首帧闪烁。
 */
function antigravityI18nBootstrap(
  EXACT_DICT,
  ATTR_DICT,
  PRESERVE_LIST,
  DYNAMIC_RULES_FACTORY,
  CONTEXT_RULES_FACTORY,
  SPLIT_TEXT_TRANSLATOR,
  INITIAL_OTA_RULES,
  BUILTIN_META
) {
  'use strict';

  if (window.__ANTIGRAVITY_I18N_INITIALIZED__) {
    if (typeof window.__antigravitySetAutoMtEnabled === 'function' && typeof window.__ANTIGRAVITY_I18N_AUTO_MT_ENABLED__ === 'boolean') {
      window.__antigravitySetAutoMtEnabled(window.__ANTIGRAVITY_I18N_AUTO_MT_ENABLED__);
    }
    if (typeof window.__antigravitySetI18nEnabled === 'function' && typeof window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ === 'boolean') {
      window.__antigravitySetI18nEnabled(window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__);
    } else if (window.__antigravityTranslateAll) {
      window.__antigravityTranslateAll();
    }
    return;
  }
  window.__ANTIGRAVITY_I18N_INITIALIZED__ = true;

  let I18N_ENABLED = typeof window !== 'undefined' ? window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ !== false : true;
  let AUTO_MT_ENABLED = typeof window !== 'undefined' ? window.__ANTIGRAVITY_I18N_AUTO_MT_ENABLED__ !== false : true;
  let dictGeneration = 0;
  const CONTEXT_UPGRADE_ZH_SET = new Set(['新建', '无', '关闭思考', '请求审核', '全自动', '自动']);
  const ORIG_TEXT = typeof WeakMap === 'function' ? new WeakMap() : null;
  const ORIG_ATTRS = typeof WeakMap === 'function' ? new WeakMap() : null;

  function normalizeKey(s) {
    return String(s)
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u2026/g, '...')
      .replace(/[\u00A0\u2007\u202F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const PRESERVE_SET = new Set();
  const EXACT_MAP = new Map();
  const LOWER_EXACT = new Map();
  const NORM_EXACT = new Map();
  const NORM_LOWER = new Map();
  const ATTR_MAP = new Map();
  const NORM_ATTR = new Map();
  const NORM_ATTR_LOWER = new Map();
  let OTA_DYNAMIC_RULES = [];

  function compileOtaRules(rawRules) {
    const compiled = [];
    if (!Array.isArray(rawRules)) return compiled;
    const limit = Math.min(rawRules.length, 200);
    for (let i = 0; i < limit; i++) {
      const r = rawRules[i];
      if (!r || typeof r !== 'object') continue;
      if (typeof r.pattern !== 'string' || !r.pattern || r.pattern.length > 240) continue;
      if (typeof r.replace !== 'string' || r.replace.length > 240) continue;
      const flags = r.flags === undefined ? 'i' : String(r.flags);
      if (!/^[iu]*$/.test(flags)) continue;
      if (/\([^)]*[+*][^)]*\)[+*{]/.test(r.pattern)) continue;
      try {
        const re = new RegExp(r.pattern, flags);
        compiled.push({
          re,
          replace: r.replace,
          requireAscii: r.requireAscii !== false
        });
      } catch (_) {}
    }
    return compiled;
  }

  function rebuildDictIndexes(nextDict, nextAttrDict, nextPreserveList, nextRules) {
    PRESERVE_SET.clear();
    if (Array.isArray(nextPreserveList)) {
      for (let i = 0; i < nextPreserveList.length; i++) {
        if (typeof nextPreserveList[i] === 'string' && nextPreserveList[i]) {
          PRESERVE_SET.add(nextPreserveList[i]);
        }
      }
    }

    EXACT_MAP.clear();
    LOWER_EXACT.clear();
    NORM_EXACT.clear();
    NORM_LOWER.clear();
    if (nextDict && typeof nextDict === 'object') {
      for (const [k, v] of Object.entries(nextDict)) {
        if (typeof v !== 'string' || PRESERVE_SET.has(k)) continue;
        EXACT_MAP.set(k, v);
        const lk = k.toLowerCase().trim();
        if (!LOWER_EXACT.has(lk)) LOWER_EXACT.set(lk, v);
        const nk = normalizeKey(k);
        if (nk) {
          if (!NORM_EXACT.has(nk)) NORM_EXACT.set(nk, v);
          const nkl = nk.toLowerCase();
          if (!NORM_LOWER.has(nkl)) NORM_LOWER.set(nkl, v);
        }
      }
    }

    ATTR_MAP.clear();
    NORM_ATTR.clear();
    NORM_ATTR_LOWER.clear();
    if (nextAttrDict && typeof nextAttrDict === 'object') {
      for (const [k, v] of Object.entries(nextAttrDict)) {
        if (typeof v !== 'string' || PRESERVE_SET.has(k)) continue;
        ATTR_MAP.set(k, v);
        const nk = normalizeKey(k);
        if (nk) {
          if (!NORM_ATTR.has(nk)) NORM_ATTR.set(nk, v);
          const nkl = nk.toLowerCase();
          if (!NORM_ATTR_LOWER.has(nkl)) NORM_ATTR_LOWER.set(nkl, v);
        }
      }
    }

    OTA_DYNAMIC_RULES = compileOtaRules(nextRules);
    dictGeneration += 1;
  }

  rebuildDictIndexes(EXACT_DICT, ATTR_DICT, PRESERVE_LIST, INITIAL_OTA_RULES);
  window.__ANTIGRAVITY_I18N_META__ = BUILTIN_META && typeof BUILTIN_META === 'object' ? { ...BUILTIN_META } : { schemaVersion: 1 };
  window.__ANTIGRAVITY_I18N_PACK_VERSION__ = window.__ANTIGRAVITY_I18N_META__.packVersion || 'builtin';

  function lookupExact(trimmed, norm) {
    if (EXACT_MAP.has(trimmed)) return EXACT_MAP.get(trimmed);
    const lower = trimmed.toLowerCase();
    if (LOWER_EXACT.has(lower)) return LOWER_EXACT.get(lower);
    if (norm && NORM_EXACT.has(norm)) return NORM_EXACT.get(norm);
    const normLower = norm ? norm.toLowerCase() : '';
    if (normLower && NORM_LOWER.has(normLower)) return NORM_LOWER.get(normLower);
    return null;
  }

  const {
    DYNAMIC_RULES,
    translateCompactRelativeTime,
    translateCompactDuration,
    translateModelWithEffort,
    translateModelParenEffort
  } = DYNAMIC_RULES_FACTORY({ normalizeKey, lookupExact });
  const {
    isNewBadgeContext,
    isGroupByNoneContext,
    isThinkingNoneContext,
    isPermissionPresetContext,
    shouldIgnoreElement,
    shouldIgnoreTextParent,
    shouldIgnoreAttrElement,
    isSwarmContext,
    isRelativeTimestampContext,
    isElapsedDurationContext,
    isModelEffortContext,
    isModelLabelContext,
    getSettingsPageSubtitleContainer,
    isAutoMtEligibleContext
  } = CONTEXT_RULES_FACTORY();

  const TARGET_ATTRS = [
    'title',
    'aria-label',
    'placeholder',
    'data-placeholder',
    'data-tooltip',
    'data-tooltip-content',
    'data-tooltip-title',
    'data-tip',
    'data-title',
    'data-hint',
    'data-label',
    'data-description',
    'data-original-title',
    'tooltip',
    'alt'
  ];

  function translateContextSensitiveToken(norm, leadWs, trailWs, contextEl) {
    const normLower = norm.toLowerCase();

    // 模型选择器 / 新功能徽章中的 "New" 指“新”（区别于创建按钮“新建”）
    if ((normLower === 'new' || norm === '新建') && isNewBadgeContext(contextEl)) {
      return leadWs + '新' + trailWs;
    }

    // "None" 根据所在菜单上下文区分：“分组方式”为“不分组”，思考深度选择器为“关闭思考”，其余默认为“无”
    if (
      normLower === 'none' ||
      norm === '关闭思考' ||
      (norm === '无' && (isGroupByNoneContext(contextEl) || isThinkingNoneContext(contextEl)))
    ) {
      if (isGroupByNoneContext(contextEl)) {
        return leadWs + '不分组' + trailWs;
      }
      if (isThinkingNoneContext(contextEl)) {
        return leadWs + '关闭思考' + trailWs;
      }
      if (norm === '关闭思考') {
        return leadWs + '无' + trailWs;
      }
    }

    // 权限预设选择器中为模式标题附带括号英文原词（“默认”保持纯中文），其余位置保持纯中文
    if (
      (
        normLower === 'request review' || normLower === 'require review' || norm === '请求审核' ||
        normLower === 'turbo' || norm === '全自动' ||
        normLower === 'auto' || norm === '自动'
      ) &&
      isPermissionPresetContext(contextEl)
    ) {
      if (normLower === 'request review' || normLower === 'require review' || norm === '请求审核') {
        return leadWs + '请求审核 (Request Review)' + trailWs;
      }
      if (normLower === 'turbo' || norm === '全自动') {
        return leadWs + '全自动 (Turbo)' + trailWs;
      }
      if (normLower === 'auto' || norm === '自动') {
        return leadWs + '自动 (Auto)' + trailWs;
      }
    }

    return null;
  }

  function translateString(str, contextEl) {
    if (!str || typeof str !== 'string') return str;
    const wsMatch = str.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const leadWs = wsMatch ? wsMatch[1] : '';
    const trimmed = wsMatch ? wsMatch[2] : str.trim();
    const trailWs = wsMatch ? wsMatch[3] : '';
    if (!trimmed) return str;

    const norm = normalizeKey(trimmed);
    if (!norm || /^[\d\s.,:%+\-*/()[\]{}<>=!@#$%^&*_~`|\\/?]+$/.test(norm)) {
      return str;
    }

    if (PRESERVE_SET.has(trimmed) || PRESERVE_SET.has(norm)) {
      return str;
    }

    const ctxHit = translateContextSensitiveToken(norm, leadWs, trailWs, contextEl);
    if (ctxHit !== null) {
      return ctxHit;
    }

    // 侧栏会话列表、事件列表等紧凑相对时间戳（now / 47m / 3h / 3d / 2mo / 1y）
    if (isRelativeTimestampContext(contextEl)) {
      const relZh = translateCompactRelativeTime(norm);
      if (relZh) {
        return leadWs + relZh + trailWs;
      }
    }

    // 运行中任务与扩展运行时间等紧凑耗时（12s / 5m / 1h 23m）
    if (isElapsedDurationContext(contextEl)) {
      const durZh = translateCompactDuration(norm);
      if (durZh) {
        return leadWs + durZh + trailWs;
      }
    }

    // 1. 精确 / 大小写不敏感 / Unicode 归一化查表
    const direct = lookupExact(trimmed, norm);
    if (direct) {
      const effectiveTrailWs = (/^[ \t]+$/.test(trailWs) && /[：。！？，、]$/.test(direct)) ? '' : trailWs;
      return leadWs + direct + effectiveTrailWs;
    }

    // 1.2 模型选择器中合并展示的“模型名 + 思考深度”组合文案（Orchestrator 行与底部模型选择触发器）
    if (isModelEffortContext(contextEl)) {
      const modelEffortZh = translateModelWithEffort(norm);
      if (modelEffortZh && modelEffortZh !== norm) {
        return leadWs + modelEffortZh + trailWs;
      }
    }

    // 1.3 模型选择器中括号形式思考深度标签（如 "GPT-OSS 120B (Medium)" -> "GPT-OSS 120B (中)"）
    if (isModelLabelContext(contextEl)) {
      const modelParenZh = translateModelParenEffort(norm);
      if (modelParenZh && modelParenZh !== norm) {
        return leadWs + modelParenZh + trailWs;
      }
    }

    // 1.5 显式带括号的动态规则优先匹配
    for (let i = 0; i < DYNAMIC_RULES.length; i++) {
      const rule = DYNAMIC_RULES[i];
      if (rule[0].source.indexOf('\\(') !== -1 && rule[0].test(norm)) {
        const res = norm.replace(rule[0], rule[1]);
        if (res !== norm) {
          return leadWs + res + trailWs;
        }
      }
    }

    // 1.8 键盘快捷键括号后缀优先拆分
    const shortcutSuffixMatch = norm.match(
      /^(.+?)\s*\(((?:Enter|Esc|Escape|Tab|Space|Return|Backspace|Delete|Del|\u23ce|[\u2318\u2303\u2325\u21e7]+(?:\s*[^\s()]+)?|(?:Ctrl|Alt|Shift|Cmd|Meta|Win|Opt|Option|Super)(?:\s*[+\-]\s*[^\s()]+)+|F\d{1,2}))\)$/i
    );
    if (shortcutSuffixMatch) {
      const baseRaw = shortcutSuffixMatch[1].trim();
      const keyRaw = shortcutSuffixMatch[2].trim();
      if (baseRaw && !PRESERVE_SET.has(baseRaw)) {
        const baseZh = translateString(baseRaw, contextEl);
        if (baseZh && baseZh !== baseRaw) {
          return `${leadWs}${baseZh} (${keyRaw})${trailWs}`;
        }
      }
    }

    // 2. 动态模板正则匹配（内置动态规则 + 云端 OTA 声明式正则规则）
    for (let i = 0; i < DYNAMIC_RULES.length; i++) {
      const rule = DYNAMIC_RULES[i];
      if (rule[0].test(norm)) {
        const res = norm.replace(rule[0], rule[1]);
        if (res !== norm) {
          return leadWs + res + trailWs;
        }
      }
    }
    const hasCjk = /[\u4e00-\u9fff]/.test(norm);
    for (let i = 0; i < OTA_DYNAMIC_RULES.length; i++) {
      const rule = OTA_DYNAMIC_RULES[i];
      if (rule.requireAscii && hasCjk) continue;
      if (rule.re.test(norm)) {
        const res = norm.replace(rule.re, rule.replace);
        if (res !== norm) {
          return leadWs + res + trailWs;
        }
      }
    }

    // 2.5 通用括号后缀拆分匹配（要求括号前有空白、内部非中文，且避免对自带括号的译文二次叠加）
    const parenSuffixMatch = !/[\u4e00-\u9fff]/.test(norm) ? norm.match(/^(.+?)\s+\(([^()]+)\)$/) : null;
    if (parenSuffixMatch) {
      const baseRaw = parenSuffixMatch[1].trim();
      const innerRaw = parenSuffixMatch[2].trim();
      if (baseRaw && !PRESERVE_SET.has(baseRaw) && !/[\u4e00-\u9fff]/.test(innerRaw)) {
        let baseZh = lookupExact(baseRaw, baseRaw);
        if (!baseZh) {
          for (let i = 0; i < DYNAMIC_RULES.length; i++) {
            if (DYNAMIC_RULES[i][0].test(baseRaw)) {
              const candidate = baseRaw.replace(DYNAMIC_RULES[i][0], DYNAMIC_RULES[i][1]);
              if (candidate !== baseRaw) {
                baseZh = candidate;
                break;
              }
            }
          }
        }
        if (baseZh && baseZh !== baseRaw && !/[()（）]/.test(baseZh)) {
          const innerZh = lookupExact(innerRaw, innerRaw) || innerRaw;
          return `${leadWs}${baseZh} (${innerZh})${trailWs}`;
        }
      }
    }

    // Swarm 面板专属上下文短语
    if (isSwarmContext(contextEl)) {
      if (/^To\s+(.+)$/i.test(norm)) {
        return leadWs + norm.replace(/^To\s+(.+)$/i, '发送给 $1') + trailWs;
      }
      if (/^From\s+(.+)$/i.test(norm)) {
        return leadWs + norm.replace(/^From\s+(.+)$/i, '来自 $1') + trailWs;
      }
    }

    // 3. 标点容错匹配
    if (norm.endsWith('...')) {
      const stem = norm.slice(0, -3).trim();
      const stemHit = stem ? lookupExact(stem, stem) : null;
      if (stemHit) {
        const hasEllipsis = stemHit.endsWith('...') || stemHit.endsWith('…');
        return leadWs + stemHit + (hasEllipsis ? '' : '...') + trailWs;
      }
    }
    if (norm.endsWith('.')) {
      const stem = norm.slice(0, -1).trim();
      const stemHit = stem ? lookupExact(stem, stem) : null;
      if (stemHit) {
        const hasEnd = /[。！？.!?]$/.test(stemHit);
        return leadWs + stemHit + (hasEnd ? '' : '。') + trailWs;
      }
    }
    if (norm.endsWith(':')) {
      const stem = norm.slice(0, -1).trim();
      const stemHit = stem ? lookupExact(stem, stem) : null;
      if (stemHit) {
        const hasColon = /[：:]$/.test(stemHit);
        return leadWs + stemHit + (hasColon ? '' : '：') + trailWs;
      }
    }

    return str;
  }

  const AUTO_MT_MEM_CACHE = new Map();
  const AUTO_MT_PENDING = new Map();
  const AUTO_MT_FAILED_UNTIL = new Map();

  function isAutoMtCandidateText(norm) {
    if (!norm || norm.length < 4 || norm.length > 600) return false;
    if (/[\u4e00-\u9fff]/.test(norm) || PRESERVE_SET.has(norm)) return false;
    if (!/[A-Za-z]{2,}[\s/-]+[A-Za-z]{2,}/.test(norm)) return false;
    if (/^(?:https?:\/\/|[A-Za-z]:\\|\/[\w.-]+\/|\{[\s\S]*\}|\[[\s\S]*\])/.test(norm)) return false;
    return true;
  }

  function applyTextTranslation(node, currentVal, nextVal, fromSplit, fromAutoMt) {
    if (nextVal === currentVal) return;
    if (ORIG_TEXT) {
      const prev = ORIG_TEXT.get(node);
      const trueOrig = prev && currentVal === prev.translated ? prev.orig : currentVal;
      ORIG_TEXT.set(node, {
        orig: trueOrig,
        translated: nextVal,
        gen: dictGeneration,
        fromSplit: Boolean(fromSplit),
        fromAutoMt: Boolean(fromAutoMt)
      });
    }
    node.nodeValue = nextVal;
  }

  function maybeTranslateDynamicAnnouncement(node, val, parent) {
    if (!I18N_ENABLED || !AUTO_MT_ENABLED) return false;
    if (!isAutoMtEligibleContext(parent)) return false;
    const wsMatch = val.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const leadWs = wsMatch ? wsMatch[1] : '';
    const trimmed = wsMatch ? wsMatch[2] : val.trim();
    const trailWs = wsMatch ? wsMatch[3] : '';
    if (!trimmed) return false;
    const norm = normalizeKey(trimmed);
    if (!isAutoMtCandidateText(norm)) return false;

    if (AUTO_MT_MEM_CACHE.has(norm)) {
      const cachedZh = AUTO_MT_MEM_CACHE.get(norm);
      if (cachedZh && cachedZh !== norm) {
        applyTextTranslation(node, val, leadWs + cachedZh + trailWs, false, true);
        return true;
      }
      return false;
    }

    const otaBridge = typeof window !== 'undefined' ? window.antigravityI18nOta : null;
    if (!otaBridge || typeof otaBridge.translateDynamicText !== 'function') return false;
    if ((AUTO_MT_FAILED_UNTIL.get(norm) || 0) > Date.now()) return false;

    let waiters = AUTO_MT_PENDING.get(norm);
    const isNewRequest = !waiters;
    if (!waiters) {
      waiters = [];
      AUTO_MT_PENDING.set(norm, waiters);
    }
    if (!waiters.some((w) => w.node === node)) {
      waiters.push({ node, origVal: val, leadWs, trailWs });
    }

    if (isNewRequest) {
      try {
        Promise.resolve(otaBridge.translateDynamicText(norm))
          .then((res) => {
            const pendingWaiters = AUTO_MT_PENDING.get(norm) || [];
            AUTO_MT_PENDING.delete(norm);
            if (res && res.status === 'ok' && typeof res.translated === 'string') {
              const zh = res.translated.trim();
              if (zh && zh !== norm) {
                AUTO_MT_MEM_CACHE.set(norm, zh);
                if (I18N_ENABLED && AUTO_MT_ENABLED) {
                  for (let i = 0; i < pendingWaiters.length; i++) {
                    const w = pendingWaiters[i];
                    if (w && w.node && w.node.isConnected !== false && w.node.nodeValue === w.origVal) {
                      applyTextTranslation(w.node, w.origVal, w.leadWs + zh + w.trailWs, false, true);
                    }
                  }
                }
                return;
              }
            }
            if (!res || res.status !== 'disabled') {
              AUTO_MT_FAILED_UNTIL.set(norm, Date.now() + 60000);
            }
          })
          .catch(() => {
            AUTO_MT_PENDING.delete(norm);
            AUTO_MT_FAILED_UNTIL.set(norm, Date.now() + 60000);
          });
      } catch (_) {
        AUTO_MT_PENDING.delete(norm);
        AUTO_MT_FAILED_UNTIL.set(norm, Date.now() + 60000);
      }
    }
    return false;
  }

  function applyAttrTranslation(node, attr, currentVal, nextVal) {
    if (nextVal === currentVal) return;
    if (ORIG_ATTRS) {
      let attrMap = ORIG_ATTRS.get(node);
      if (!attrMap) {
        attrMap = new Map();
        ORIG_ATTRS.set(node, attrMap);
      }
      const prev = attrMap.get(attr);
      const trueOrig = prev && currentVal === prev.translated ? prev.orig : currentVal;
      attrMap.set(attr, { orig: trueOrig, translated: nextVal, gen: dictGeneration });
    }
    node.setAttribute(attr, nextVal);
  }

  function translateAttrValue(node, val) {
    const trimmed = val.trim();
    const nk = normalizeKey(val);
    if (PRESERVE_SET.has(trimmed) || (nk && PRESERVE_SET.has(nk))) return val;
    if (nk) {
      const leadWs = val.match(/^\s*/)[0];
      const trailWs = val.match(/\s*$/)[0];
      const ctxHit = translateContextSensitiveToken(nk, leadWs, trailWs, node);
      if (ctxHit !== null) return ctxHit;
    }
    const attrHit =
      (ATTR_MAP.has(val) ? ATTR_MAP.get(val) : null) ||
      (nk ? NORM_ATTR.get(nk) || NORM_ATTR_LOWER.get(nk.toLowerCase()) : null);
    if (attrHit) return attrHit;
    return translateString(val, node);
  }

  function translateElementAttrs(node) {
    if (!I18N_ENABLED || !node || node.nodeType !== 1 || isInjectedI18nControl(node) || shouldIgnoreAttrElement(node)) return;
    const prevMap = ORIG_ATTRS ? ORIG_ATTRS.get(node) : null;
    for (let i = 0; i < TARGET_ATTRS.length; i++) {
      const attr = TARGET_ATTRS[i];
      if (!node.hasAttribute || !node.hasAttribute(attr)) continue;
      const val = node.getAttribute(attr);
      if (!val) continue;
      const prev = prevMap ? prevMap.get(attr) : null;
      if (prev && val === prev.translated) {
        if (prev.gen === dictGeneration) {
          if (!CONTEXT_UPGRADE_ZH_SET.has(val.trim())) continue;
          const ctxNext = translateAttrValue(node, val);
          if (ctxNext !== val) {
            applyAttrTranslation(node, attr, val, ctxNext);
          }
          continue;
        }
        const retrans = translateAttrValue(node, prev.orig);
        if (retrans !== prev.orig && retrans !== val) {
          applyAttrTranslation(node, attr, val, retrans);
        } else {
          prev.gen = dictGeneration;
        }
        continue;
      }
      const nextVal = translateAttrValue(node, val);
      if (nextVal !== val) {
        applyAttrTranslation(node, attr, val, nextVal);
      }
    }
  }

  function isTrailingNodeInContainer(node, container) {
    let cur = node;
    while (cur && cur !== container) {
      let next = cur.nextSibling;
      while (next) {
        if (next.nodeType !== 3 || (next.nodeValue || '').trim() !== '') {
          return false;
        }
        next = next.nextSibling;
      }
      cur = cur.parentElement || cur.parentNode;
    }
    return cur === container;
  }

  function isTitleMenuRelated(node) {
    return Boolean(
      node &&
      node.nodeType === 1 &&
      node.matches &&
      (node.matches('[data-testid="title-menu-bar-option"], [data-browser-occluder="true"], [data-testid="title-menu-bar"]') ||
        (node.closest && node.closest('[data-testid="title-menu-bar"]')))
    );
  }

  function containsTitleMenuBar(node) {
    if (!node || node.nodeType !== 1) return false;
    if (isTitleMenuRelated(node)) return true;
    return Boolean(node.querySelector && node.querySelector('[data-testid="title-menu-bar"]'));
  }

  const INJECTED_I18N_SELECTOR =
    '[data-antigravity-i18n-titlebar-toggle-wrap="true"], [data-antigravity-i18n-titlebar-toggle="true"], [data-antigravity-i18n-titlebar-style="true"], [data-antigravity-i18n-ota-item="true"]';

  function isInjectedI18nControl(node) {
    if (!node) return false;
    const el = node.nodeType === 1 ? node : (node.parentElement || null);
    if (!el || el.nodeType !== 1) return false;
    return Boolean(
      (el.matches && el.matches(INJECTED_I18N_SELECTOR)) ||
      (el.closest && el.closest(INJECTED_I18N_SELECTOR))
    );
  }

  function translateNode(node) {
    if (!node) return;

    if (!I18N_ENABLED) {
      if (containsTitleMenuBar(node)) {
        ensureTitleBarLangToggle(node);
        ensureTitleBarOtaMenuItem(node);
      }
      return;
    }

    if (node.nodeType === 3) {
      const parent = node.parentElement || node.parentNode;
      if (isInjectedI18nControl(parent) || shouldIgnoreTextParent(parent)) return;
      const val = node.nodeValue;
      if (!val) return;
      const prev = ORIG_TEXT ? ORIG_TEXT.get(node) : null;
      if (prev && val === prev.translated) {
        if (prev.gen === dictGeneration) {
          if (prev.fromSplit || !CONTEXT_UPGRADE_ZH_SET.has(val.trim())) return;
          const ctxNext = translateString(val, parent);
          if (ctxNext !== val) {
            applyTextTranslation(node, val, ctxNext, false);
          }
          return;
        }
        const splitRetrans = SPLIT_TEXT_TRANSLATOR(node, prev.orig, parent);
        if (splitRetrans !== null) {
          if (splitRetrans !== val) {
            applyTextTranslation(node, val, splitRetrans, true);
          } else {
            prev.gen = dictGeneration;
            prev.fromSplit = true;
          }
          return;
        }
        const subtitleContainer = getSettingsPageSubtitleContainer(parent);
        const isTrailingSub = Boolean(subtitleContainer && isTrailingNodeInContainer(node, subtitleContainer));
        let retrans = translateString(prev.orig, parent);
        if (isTrailingSub) {
          retrans = retrans.replace(/。(\s*)$/, '$1');
        }
        if (retrans !== prev.orig && retrans !== val) {
          applyTextTranslation(node, val, retrans, false);
        } else {
          prev.gen = dictGeneration;
        }
        return;
      }

      const splitTrans = SPLIT_TEXT_TRANSLATOR(node, val, parent);
      if (splitTrans !== null) {
        if (splitTrans !== val) applyTextTranslation(node, val, splitTrans, true);
        return;
      }
      const subtitleContainer = getSettingsPageSubtitleContainer(parent);
      const isTrailingSub = Boolean(subtitleContainer && isTrailingNodeInContainer(node, subtitleContainer));
      let trans = translateString(val, parent);
      if (isTrailingSub) {
        trans = trans.replace(/。(\s*)$/, '$1');
      }
      if (trans !== val) {
        applyTextTranslation(node, val, trans, false, false);
      } else {
        maybeTranslateDynamicAnnouncement(node, val, parent);
      }
      return;
    }

    if (node.nodeType === 1) {
      if (isInjectedI18nControl(node)) {
        return;
      }

      translateElementAttrs(node);

      if (shouldIgnoreElement(node)) {
        if (
          node.matches &&
          node.matches('.monaco-editor, .code-block, [data-code-block], [data-testid="user-message-content"]') &&
          node.querySelectorAll
        ) {
          const innerInteractive = node.querySelectorAll('button, [role="button"], [data-tooltip-id], [role="tooltip"], .compact-tooltip, .monaco-hover');
          for (let i = 0; i < innerInteractive.length; i++) {
            translateNode(innerInteractive[i]);
          }
        }
        return;
      }

      if (node.shadowRoot) {
        observeRoot(node.shadowRoot);
        translateSubtree(node.shadowRoot);
      }

      for (let child = node.firstChild; child; child = child.nextSibling) {
        translateNode(child);
      }

      if (node.matches) {
        if (node.matches('[data-testid="title-menu-bar"]')) {
          ensureTitleBarLangToggle(node);
        } else if (node.matches('[data-testid="title-menu-bar-option"], [data-browser-occluder="true"]')) {
          ensureTitleBarOtaMenuItem(node);
        }
      }
    } else if (node.nodeType === 11) {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        translateNode(child);
      }
    }
  }

  function makeTitleMenuButton(optBtn, attrName, labelText, onClickFn) {
    const wrapper = document.createElement('div');
    const btn = document.createElement('button');
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-testid', 'title-menu-bar-option');
    btn.setAttribute(attrName, 'true');
    btn.className = optBtn.className || 'w-full px-3 py-1.5 text-left transition-colors flex justify-between items-center duration-100 select-none outline-none cursor-default hover:bg-secondary';
    const span = document.createElement('span');
    if (typeof document.createTextNode === 'function') {
      span.appendChild(document.createTextNode(labelText));
    } else {
      span.textContent = labelText;
    }
    btn.appendChild(span);
    if (typeof btn.addEventListener === 'function') {
      btn.addEventListener('click', (ev) => {
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
        try {
          if (typeof KeyboardEvent === 'function' && typeof document.dispatchEvent === 'function') {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          }
        } catch (_) {}
        onClickFn();
      });
    }
    wrapper.appendChild(btn);
    return wrapper;
  }

  function setAttrIfChanged(el, attr, val) {
    if (!el || typeof el.setAttribute !== 'function') return;
    if (typeof el.getAttribute === 'function' && el.getAttribute(attr) === val) return;
    el.setAttribute(attr, val);
  }

  function setBtnLabelText(btn, label) {
    if (!btn) return;
    const span = btn.firstChild;
    if (!span) return;
    if (span.firstChild && span.firstChild.nodeType === 3) {
      if (span.firstChild.nodeValue !== label) {
        span.firstChild.nodeValue = label;
      }
    } else if (typeof document !== 'undefined' && typeof document.createTextNode === 'function') {
      while (span.firstChild) span.removeChild(span.firstChild);
      span.appendChild(document.createTextNode(label));
    }
  }

  const TITLEBAR_TOGGLE_STYLE_CSS = [
    '[data-antigravity-i18n-titlebar-toggle-wrap="true"]{margin-left:6px;display:inline-flex;align-items:center;-webkit-app-region:no-drag;}',
    '[data-antigravity-i18n-titlebar-toggle="true"]{position:relative;box-sizing:border-box;appearance:none;-webkit-appearance:none;margin:0;display:inline-grid;grid-template-columns:1fr 1fr;align-items:center;height:24px;min-width:58px;padding:2px;border-radius:8px;border:1px solid var(--border,var(--card-border,rgba(10,10,12,0.10)));background:var(--background,var(--card,#ffffff));box-shadow:0 1px 2px rgba(10,10,12,0.05);color:var(--foreground,inherit);font-size:11.5px;line-height:1;cursor:pointer;user-select:none;touch-action:none;-webkit-app-region:no-drag;overflow:visible;outline:none;transition:border-color 180ms ease,background-color 180ms ease,box-shadow 180ms ease;}',
    '[data-antigravity-i18n-titlebar-toggle="true"]:hover{border-color:color-mix(in srgb,var(--foreground,#808080) 12%,var(--border,rgba(10,10,12,0.14)));background:var(--card,var(--background,#ffffff));box-shadow:0 1px 3px rgba(10,10,12,0.08);}',
    '.dark [data-antigravity-i18n-titlebar-toggle="true"]{background:var(--onyx-raised,var(--card,var(--sidebar-muted,#15151a)));border-color:var(--border,var(--card-border,rgba(255,255,255,0.08)));box-shadow:0 1px 2px rgba(0,0,0,0.28);}',
    '.dark [data-antigravity-i18n-titlebar-toggle="true"]:hover{background:var(--onyx-selected,var(--sidebar-secondary,var(--card,#1f1f24)));border-color:color-mix(in srgb,var(--foreground,#ffffff) 12%,var(--border,rgba(255,255,255,0.10)));box-shadow:0 1px 3px rgba(0,0,0,0.38);}',
    '[data-antigravity-i18n-titlebar-toggle="true"]:focus-visible{box-shadow:0 0 0 2px color-mix(in srgb,var(--primary,var(--accent,#2F71E3)) 38%,transparent);}',
    '[data-antigravity-i18n-pill-thumb="true"]{position:absolute;top:2px;bottom:2px;left:2px;width:calc(50% - 2px);margin:0;border:none;background:transparent;box-shadow:none;pointer-events:none;z-index:0;will-change:transform;transform:translate3d(0%,0,0);transition:transform 420ms cubic-bezier(0.34,1.56,0.64,1);}',
    '[data-antigravity-i18n-titlebar-toggle="true"][data-lang="en"] [data-antigravity-i18n-pill-thumb="true"]{transform:translate3d(100%,0,0);}',
    '[data-antigravity-i18n-titlebar-toggle="true"][data-dragging="true"] [data-antigravity-i18n-pill-thumb="true"]{transition:none;}',
    '[data-antigravity-i18n-pill-thumb-fill="true"]{display:block;width:100%;height:100%;border-radius:6px;background:var(--primary,var(--accent,#2F71E3));box-shadow:0 1px 2px color-mix(in srgb,var(--primary,var(--accent,#2F71E3)) 26%,rgba(0,0,0,0.16));transform-origin:center center;transition:transform 200ms cubic-bezier(0.34,1.56,0.64,1),filter 160ms ease,box-shadow 200ms ease;}',
    '[data-antigravity-i18n-titlebar-toggle="true"][data-pressed="true"] [data-antigravity-i18n-pill-thumb-fill="true"]{transform:scale(1.07,0.91);filter:brightness(1.05);}',
    '[data-antigravity-i18n-titlebar-toggle="true"][data-dragging="true"] [data-antigravity-i18n-pill-thumb-fill="true"]{transform:scale(1.09,0.89);filter:brightness(1.07);box-shadow:0 2px 5px color-mix(in srgb,var(--primary,var(--accent,#2F71E3)) 36%,rgba(0,0,0,0.2));}',
    '[data-antigravity-i18n-titlebar-toggle="true"]:not([data-dragging="true"])[data-bounce="zh"] [data-antigravity-i18n-pill-thumb-fill="true"]{animation:ag-i18n-jelly-zh 440ms cubic-bezier(0.22,1,0.36,1);}',
    '[data-antigravity-i18n-titlebar-toggle="true"]:not([data-dragging="true"])[data-bounce="en"] [data-antigravity-i18n-pill-thumb-fill="true"]{animation:ag-i18n-jelly-en 440ms cubic-bezier(0.22,1,0.36,1);}',
    '[data-antigravity-i18n-pill-zh="true"],[data-antigravity-i18n-pill-en="true"]{position:relative;z-index:1;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;height:100%;margin:0;border:none;background:transparent;box-shadow:none;white-space:nowrap;pointer-events:none;transition:color 200ms ease,opacity 200ms ease,transform 240ms cubic-bezier(0.34,1.56,0.64,1);color:var(--muted-foreground,currentColor);font-weight:500;opacity:0.85;}',
    '[data-antigravity-i18n-titlebar-toggle="true"]:hover [data-antigravity-i18n-pill-zh="true"],[data-antigravity-i18n-titlebar-toggle="true"]:hover [data-antigravity-i18n-pill-en="true"]{color:var(--foreground,currentColor);opacity:1;}',
    '[data-antigravity-i18n-titlebar-toggle="true"]:not([data-drag-target])[data-lang="zh"] [data-antigravity-i18n-pill-zh="true"],[data-antigravity-i18n-titlebar-toggle="true"]:not([data-drag-target])[data-lang="en"] [data-antigravity-i18n-pill-en="true"],[data-antigravity-i18n-titlebar-toggle="true"][data-drag-target="zh"] [data-antigravity-i18n-pill-zh="true"],[data-antigravity-i18n-titlebar-toggle="true"][data-drag-target="en"] [data-antigravity-i18n-pill-en="true"],[data-antigravity-i18n-titlebar-toggle="true"]:hover:not([data-drag-target])[data-lang="zh"] [data-antigravity-i18n-pill-zh="true"],[data-antigravity-i18n-titlebar-toggle="true"]:hover:not([data-drag-target])[data-lang="en"] [data-antigravity-i18n-pill-en="true"],[data-antigravity-i18n-titlebar-toggle="true"]:hover[data-drag-target="zh"] [data-antigravity-i18n-pill-zh="true"],[data-antigravity-i18n-titlebar-toggle="true"]:hover[data-drag-target="en"] [data-antigravity-i18n-pill-en="true"]{color:var(--primary-foreground,#ffffff);font-weight:600;opacity:1;transform:scale(1.02);}',
    '@keyframes ag-i18n-jelly-zh{0%{transform:scale(1,1);}26%{transform:scale(1.20,0.84);}54%{transform:scale(0.91,1.09);}78%{transform:scale(1.04,0.97);}100%{transform:scale(1,1);}}',
    '@keyframes ag-i18n-jelly-en{0%{transform:scale(1,1);}26%{transform:scale(1.20,0.84);}54%{transform:scale(0.91,1.09);}78%{transform:scale(1.04,0.97);}100%{transform:scale(1,1);}}',
    '@media (prefers-reduced-motion:reduce){[data-antigravity-i18n-pill-thumb="true"],[data-antigravity-i18n-pill-thumb-fill="true"],[data-antigravity-i18n-pill-zh="true"],[data-antigravity-i18n-pill-en="true"]{transition:none!important;animation:none!important;}}'
  ].join('\n');

  function removeAttrIfPresent(el, attr) {
    if (!el || typeof el.removeAttribute !== 'function') return;
    if (typeof el.hasAttribute === 'function' && !el.hasAttribute(attr)) return;
    el.removeAttribute(attr);
  }

  function setThumbTransform(thumb, val) {
    if (thumb && thumb.style) {
      thumb.style.transform = val;
    }
  }

  function ensureTitleBarToggleStyles() {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
    const styleHost = document.head || document.documentElement;
    if (!styleHost) return;
    const queryRoot = (document.documentElement && typeof document.documentElement.querySelector === 'function')
      ? document.documentElement
      : (typeof styleHost.querySelector === 'function'
        ? styleHost
        : (typeof document.querySelector === 'function' ? document : null));
    if (queryRoot && queryRoot.querySelector('[data-antigravity-i18n-titlebar-style="true"]')) {
      return;
    }
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-antigravity-i18n-titlebar-style', 'true');
    if (typeof document.createTextNode === 'function') {
      styleEl.appendChild(document.createTextNode(TITLEBAR_TOGGLE_STYLE_CSS));
    } else {
      styleEl.textContent = TITLEBAR_TOGGLE_STYLE_CSS;
    }
    styleHost.appendChild(styleEl);
  }

  function updateTitleBarToggleVisuals(btn, forcedEnabled, allowBounce) {
    if (!btn) return;
    const enabled = typeof forcedEnabled === 'boolean' ? forcedEnabled : I18N_ENABLED;
    const nextLang = enabled ? 'zh' : 'en';
    const prevLang = typeof btn.getAttribute === 'function' ? btn.getAttribute('data-lang') : null;
    const tip = enabled
      ? '当前：简体中文（点击或拖动切换为英文原文）'
      : 'Current: English (Click or drag to switch to 简体中文)';
    setAttrIfChanged(btn, 'title', tip);
    setAttrIfChanged(btn, 'aria-label', tip);
    setAttrIfChanged(btn, 'aria-pressed', enabled ? 'true' : 'false');
    setAttrIfChanged(btn, 'data-lang', nextLang);
    if (prevLang && prevLang !== nextLang && allowBounce !== false) {
      setAttrIfChanged(btn, 'data-bounce', nextLang);
    }
    if (typeof btn.querySelector === 'function') {
      const zhSpan = btn.querySelector('[data-antigravity-i18n-pill-zh="true"]');
      const enSpan = btn.querySelector('[data-antigravity-i18n-pill-en="true"]');
      if (zhSpan) {
        setAttrIfChanged(zhSpan, 'data-active', enabled ? 'true' : 'false');
      }
      if (enSpan) {
        setAttrIfChanged(enSpan, 'data-active', enabled ? 'false' : 'true');
      }
    }
  }

  function triggerTitleBarToggle(btn) {
    try {
      const bridgeNow = typeof window !== 'undefined' ? window.antigravityI18nOta : null;
      if (bridgeNow && typeof bridgeNow.toggleLanguage === 'function') {
        Promise.resolve(bridgeNow.toggleLanguage()).catch(() => {
          updateTitleBarToggleVisuals(btn, I18N_ENABLED, false);
        });
      } else if (typeof window.__antigravitySetI18nEnabled === 'function') {
        window.__antigravitySetI18nEnabled(!I18N_ENABLED);
      }
    } catch (_) {}
  }

  function ensureTitleBarLangToggle(rootEl) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
    const otaBridge = typeof window !== 'undefined' ? window.antigravityI18nOta : null;
    if (
      !(otaBridge && typeof otaBridge.toggleLanguage === 'function') &&
      typeof window.__antigravitySetI18nEnabled !== 'function'
    ) {
      return;
    }

    ensureTitleBarToggleStyles();

    const bars = [];
    if (rootEl && rootEl.nodeType === 1) {
      if (rootEl.matches && rootEl.matches('[data-testid="title-menu-bar"]')) {
        bars.push(rootEl);
      } else if (rootEl.closest && rootEl.closest('[data-testid="title-menu-bar"]')) {
        bars.push(rootEl.closest('[data-testid="title-menu-bar"]'));
      } else if (rootEl.querySelectorAll) {
        const found = rootEl.querySelectorAll('[data-testid="title-menu-bar"]');
        for (let i = 0; i < found.length; i++) bars.push(found[i]);
      }
    }

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (!bar) continue;
      if (bar.querySelector && bar.querySelector('[data-antigravity-i18n-titlebar-toggle="true"]')) {
        updateTitleBarToggleVisuals(bar.querySelector('[data-antigravity-i18n-titlebar-toggle="true"]'));
        continue;
      }

      const wrap = document.createElement('div');
      wrap.setAttribute('data-antigravity-i18n-titlebar-toggle-wrap', 'true');

      const btn = document.createElement('button');
      btn.setAttribute('type', 'button');
      btn.setAttribute('data-antigravity-i18n-titlebar-toggle', 'true');

      const thumb = document.createElement('span');
      thumb.setAttribute('data-antigravity-i18n-pill-thumb', 'true');
      thumb.setAttribute('aria-hidden', 'true');
      const thumbFill = document.createElement('span');
      thumbFill.setAttribute('data-antigravity-i18n-pill-thumb-fill', 'true');
      thumb.appendChild(thumbFill);

      const zhSpan = document.createElement('span');
      zhSpan.setAttribute('data-antigravity-i18n-pill-zh', 'true');
      if (typeof document.createTextNode === 'function') {
        zhSpan.appendChild(document.createTextNode('中'));
      } else {
        zhSpan.textContent = '中';
      }

      const enSpan = document.createElement('span');
      enSpan.setAttribute('data-antigravity-i18n-pill-en', 'true');
      if (typeof document.createTextNode === 'function') {
        enSpan.appendChild(document.createTextNode('EN'));
      } else {
        enSpan.textContent = 'EN';
      }

      btn.appendChild(thumb);
      btn.appendChild(zhSpan);
      btn.appendChild(enSpan);
      updateTitleBarToggleVisuals(btn, I18N_ENABLED, false);

      if (typeof btn.addEventListener === 'function') {
        let activePointerId = null;
        let startX = 0;
        let baseOffset = 0;
        let maxTravel = 27;
        let currentProgress = I18N_ENABLED ? 0 : 1;
        let hasDragged = false;
        let suppressNextClick = false;
        let suppressClickTimer = 0;

        const clearDragVisuals = () => {
          removeAttrIfPresent(btn, 'data-pressed');
          removeAttrIfPresent(btn, 'data-dragging');
          removeAttrIfPresent(btn, 'data-drag-target');
          setThumbTransform(thumb, '');
        };

        btn.addEventListener('pointerdown', (ev) => {
          if (ev && typeof ev.button === 'number' && ev.button !== 0) return;
          if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
          const rectWidth = typeof btn.getBoundingClientRect === 'function' ? btn.getBoundingClientRect().width : 0;
          const trackWidth = btn.clientWidth || (rectWidth ? Math.max(0, rectWidth - 2) : 0) || 56;
          maxTravel = Math.max(1, (trackWidth - 4) / 2);
          activePointerId = ev && ev.pointerId !== undefined ? ev.pointerId : 1;
          startX = ev && typeof ev.clientX === 'number' ? ev.clientX : 0;
          baseOffset = I18N_ENABLED ? 0 : maxTravel;
          currentProgress = I18N_ENABLED ? 0 : 1;
          hasDragged = false;
          setAttrIfChanged(btn, 'data-pressed', 'true');
          if (typeof btn.setPointerCapture === 'function' && ev && ev.pointerId !== undefined) {
            try { btn.setPointerCapture(ev.pointerId); } catch (_) {}
          }
        });

        btn.addEventListener('pointermove', (ev) => {
          if (activePointerId === null) return;
          if (ev && ev.pointerId !== undefined && ev.pointerId !== activePointerId) return;
          const clientX = ev && typeof ev.clientX === 'number' ? ev.clientX : startX;
          const dx = clientX - startX;
          if (!hasDragged && Math.abs(dx) < 3) return;
          if (!hasDragged) {
            hasDragged = true;
            setAttrIfChanged(btn, 'data-dragging', 'true');
          }
          const rawOffset = baseOffset + dx;
          let clampedOffset = rawOffset;
          if (rawOffset < 0) {
            clampedOffset = Math.max(-3.5, rawOffset * 0.18);
          } else if (rawOffset > maxTravel) {
            clampedOffset = maxTravel + Math.min(3.5, (rawOffset - maxTravel) * 0.18);
          }
          currentProgress = Math.max(0, Math.min(1, rawOffset / maxTravel));
          setThumbTransform(thumb, `translate3d(${clampedOffset.toFixed(2)}px, 0, 0)`);
          setAttrIfChanged(btn, 'data-drag-target', currentProgress < 0.5 ? 'zh' : 'en');
        });

        const finishPointer = (ev, cancelled) => {
          if (activePointerId === null) return;
          if (ev && ev.pointerId !== undefined && ev.pointerId !== activePointerId) return;
          if (typeof btn.releasePointerCapture === 'function' && ev && ev.pointerId !== undefined) {
            try { btn.releasePointerCapture(ev.pointerId); } catch (_) {}
          }
          const didDrag = hasDragged;
          activePointerId = null;
          hasDragged = false;
          removeAttrIfPresent(btn, 'data-pressed');
          removeAttrIfPresent(btn, 'data-dragging');
          removeAttrIfPresent(btn, 'data-drag-target');
          if (didDrag) {
            suppressNextClick = true;
            if (suppressClickTimer) clearTimeout(suppressClickTimer);
            suppressClickTimer = setTimeout(() => {
              suppressClickTimer = 0;
              suppressNextClick = false;
            }, 120);
            if (!cancelled) {
              const targetEnabled = currentProgress < 0.5;
              if (targetEnabled !== I18N_ENABLED) {
                updateTitleBarToggleVisuals(btn, targetEnabled, true);
                setThumbTransform(thumb, '');
                triggerTitleBarToggle(btn);
                return;
              }
            }
          }
          setThumbTransform(thumb, '');
        };

        btn.addEventListener('pointerup', (ev) => finishPointer(ev, false));
        btn.addEventListener('pointercancel', (ev) => {
          clearDragVisuals();
          finishPointer(ev, true);
        });

        btn.addEventListener('click', (ev) => {
          if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
          if (suppressNextClick) {
            suppressNextClick = false;
            if (suppressClickTimer) {
              clearTimeout(suppressClickTimer);
              suppressClickTimer = 0;
            }
            return;
          }
          updateTitleBarToggleVisuals(btn, !I18N_ENABLED, true);
          triggerTitleBarToggle(btn);
        });
      }

      wrap.appendChild(btn);
      bar.appendChild(wrap);
    }
  }

  function updateInjectedTitleBarLabels() {
    if (typeof document === 'undefined') return;
    const queryRoot = (document.documentElement && typeof document.documentElement.querySelectorAll === 'function')
      ? document.documentElement
      : (typeof document.querySelectorAll === 'function' ? document : null);
    if (!queryRoot) return;
    const otaLabel = I18N_ENABLED ? '检查汉化更新' : 'Check i18n Updates';
    const otaBtns = queryRoot.querySelectorAll('[data-antigravity-i18n-ota-item="true"]');
    for (let i = 0; i < otaBtns.length; i++) setBtnLabelText(otaBtns[i], otaLabel);
    const titleToggles = queryRoot.querySelectorAll('[data-antigravity-i18n-titlebar-toggle="true"]');
    for (let i = 0; i < titleToggles.length; i++) updateTitleBarToggleVisuals(titleToggles[i]);
  }

  function ensureTitleBarOtaMenuItem(rootEl) {
    if (
      typeof document === 'undefined' ||
      typeof document.createElement !== 'function' ||
      !window.antigravityI18nOta
    ) {
      return;
    }
    const otaBridge = window.antigravityI18nOta;
    if (typeof otaBridge.checkForUpdates !== 'function') return;

    const candidates = [];
    if (rootEl && rootEl.nodeType === 1) {
      if (rootEl.matches && rootEl.matches('[data-testid="title-menu-bar-option"]')) {
        candidates.push(rootEl);
      } else if (rootEl.querySelectorAll) {
        const list = rootEl.querySelectorAll('[data-testid="title-menu-bar-option"]');
        for (let i = 0; i < list.length; i++) candidates.push(list[i]);
      }
    }
    for (let i = 0; i < candidates.length; i++) {
      const optBtn = candidates[i];
      if (!optBtn || !optBtn.closest || !optBtn.closest('[data-testid="title-menu-bar"]')) continue;
      if (optBtn.getAttribute && optBtn.getAttribute('data-antigravity-i18n-ota-item') === 'true') {
        continue;
      }
      const label = (optBtn.textContent || '').trim();
      if (
        label !== '检查更新' &&
        label !== 'Check for Updates' &&
        label !== '正在检查更新...' &&
        label !== 'Checking for Updates...' &&
        label !== '正在下载更新...' &&
        label !== 'Downloading Update...' &&
        label !== '重启以更新' &&
        label !== 'Restart to Update'
      ) {
        continue;
      }
      const itemWrapper = optBtn.parentElement;
      const menuPopup = itemWrapper && itemWrapper.parentElement;
      if (!menuPopup) continue;
      if (menuPopup.querySelector && menuPopup.querySelector('[data-antigravity-i18n-ota-item="true"]')) {
        continue;
      }

      const otaWrapper = makeTitleMenuButton(
        optBtn,
        'data-antigravity-i18n-ota-item',
        I18N_ENABLED ? '检查汉化更新' : 'Check i18n Updates',
        () => {
          try {
            Promise.resolve(otaBridge.checkForUpdates()).catch(() => {});
          } catch (_) {}
        }
      );
      if (itemWrapper.nextSibling) {
        menuPopup.insertBefore(otaWrapper, itemWrapper.nextSibling);
      } else {
        menuPopup.appendChild(otaWrapper);
      }
    }
  }

  function restoreOriginalAttrs(node) {
    if (!ORIG_ATTRS || !node || node.nodeType !== 1) return;
    const attrMap = ORIG_ATTRS.get(node);
    if (!attrMap) return;
    attrMap.forEach((rec, attr) => {
      if (node.getAttribute && node.getAttribute(attr) === rec.translated && rec.orig !== rec.translated) {
        node.setAttribute(attr, rec.orig);
      }
    });
  }

  function restoreOriginalSubtree(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      if (ORIG_TEXT) {
        const rec = ORIG_TEXT.get(root);
        if (rec && root.nodeValue === rec.translated && rec.orig !== rec.translated) {
          root.nodeValue = rec.orig;
        }
      }
      return;
    }
    if (root.nodeType === 1) {
      if (isInjectedI18nControl(root)) return;
      restoreOriginalAttrs(root);
      if (root.shadowRoot) {
        restoreOriginalSubtree(root.shadowRoot);
      }
      for (let child = root.firstChild; child; child = child.nextSibling) {
        restoreOriginalSubtree(child);
      }
    } else if (root.nodeType === 11) {
      for (let child = root.firstChild; child; child = child.nextSibling) {
        restoreOriginalSubtree(child);
      }
    }
  }

  function restoreAutoMtSubtree(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      if (ORIG_TEXT) {
        const rec = ORIG_TEXT.get(root);
        if (rec && rec.fromAutoMt && root.nodeValue === rec.translated && rec.orig !== rec.translated) {
          root.nodeValue = rec.orig;
        }
      }
      return;
    }
    if (root.nodeType === 1) {
      if (isInjectedI18nControl(root)) return;
      if (root.shadowRoot) {
        restoreAutoMtSubtree(root.shadowRoot);
      }
      for (let child = root.firstChild; child; child = child.nextSibling) {
        restoreAutoMtSubtree(child);
      }
    } else if (root.nodeType === 11) {
      for (let child = root.firstChild; child; child = child.nextSibling) {
        restoreAutoMtSubtree(child);
      }
    }
  }

  function translateSubtree(root) {
    if (!root) return;
    translateNode(root);
  }

  window.__antigravityTranslateString = translateString;
  window.__antigravityTranslateAll = function () {
    if (!I18N_ENABLED) return;
    const root = typeof document !== 'undefined' ? (document.documentElement || document.body) : null;
    if (root) {
      translateSubtree(root);
    }
  };
  window.__antigravityIsI18nEnabled = function () {
    return I18N_ENABLED;
  };
  window.__antigravityIsAutoMtEnabled = function () {
    return AUTO_MT_ENABLED;
  };
  window.__antigravitySetAutoMtEnabled = function (enabled) {
    const nextEnabled = Boolean(enabled);
    if (nextEnabled === AUTO_MT_ENABLED) {
      return AUTO_MT_ENABLED;
    }
    AUTO_MT_ENABLED = nextEnabled;
    const root = typeof document !== 'undefined' ? (document.documentElement || document.body) : null;
    if (AUTO_MT_ENABLED) {
      if (I18N_ENABLED) {
        if (root) translateSubtree(root);
        if (typeof document !== 'undefined') translatePortals();
      }
    } else {
      if (root) restoreAutoMtSubtree(root);
      if (typeof document !== 'undefined') {
        const queryRoot = (document.documentElement && typeof document.documentElement.querySelectorAll === 'function')
          ? document.documentElement
          : (typeof document.querySelectorAll === 'function' ? document : null);
        if (queryRoot) {
          const portals = queryRoot.querySelectorAll(PORTAL_SELECTOR);
          for (let i = 0; i < portals.length; i++) {
            const p = portals[i];
            if (!p) continue;
            if (p.parentElement && p.parentElement.closest && p.parentElement.closest(PORTAL_SELECTOR)) {
              continue;
            }
            restoreAutoMtSubtree(p);
          }
        }
      }
    }
    return AUTO_MT_ENABLED;
  };
  window.__antigravitySetI18nEnabled = function (enabled) {
    const nextEnabled = Boolean(enabled);
    if (nextEnabled === I18N_ENABLED) {
      updateInjectedTitleBarLabels();
      return I18N_ENABLED;
    }
    I18N_ENABLED = nextEnabled;
    const root = typeof document !== 'undefined' ? (document.documentElement || document.body) : null;
    if (I18N_ENABLED) {
      if (root) translateSubtree(root);
      if (typeof document !== 'undefined') translatePortals();
    } else {
      if (root) restoreOriginalSubtree(root);
      if (typeof document !== 'undefined') {
        const queryRoot = (document.documentElement && typeof document.documentElement.querySelectorAll === 'function')
          ? document.documentElement
          : (typeof document.querySelectorAll === 'function' ? document : null);
        if (queryRoot) {
          const portals = queryRoot.querySelectorAll(PORTAL_SELECTOR);
          for (let i = 0; i < portals.length; i++) {
            const p = portals[i];
            if (!p) continue;
            if (p.parentElement && p.parentElement.closest && p.parentElement.closest(PORTAL_SELECTOR)) {
              continue;
            }
            restoreOriginalSubtree(p);
          }
        }
      }
    }
    updateInjectedTitleBarLabels();
    return I18N_ENABLED;
  };
  window.__antigravityApplyOtaPack = function (pack) {
    if (!pack || typeof pack !== 'object') return false;
    if (!pack.dictionary || typeof pack.dictionary !== 'object' || Array.isArray(pack.dictionary)) return false;
    if (!pack.attrDict || typeof pack.attrDict !== 'object' || Array.isArray(pack.attrDict)) return false;
    if (typeof pack.packVersion === 'string' && pack.packVersion && window.__ANTIGRAVITY_I18N_PACK_VERSION__ === pack.packVersion) {
      return false;
    }
    const nextPreserve = Array.isArray(pack.preserveList) ? pack.preserveList : PRESERVE_LIST;
    rebuildDictIndexes(pack.dictionary, pack.attrDict, nextPreserve, Array.isArray(pack.rules) ? pack.rules : []);
    if (typeof pack.packVersion === 'string' && pack.packVersion) {
      window.__ANTIGRAVITY_I18N_PACK_VERSION__ = pack.packVersion;
    }
    window.__ANTIGRAVITY_I18N_META__ = {
      ...(window.__ANTIGRAVITY_I18N_META__ || {}),
      packVersion: window.__ANTIGRAVITY_I18N_PACK_VERSION__,
      builtAt: pack.builtAt || (window.__ANTIGRAVITY_I18N_META__ && window.__ANTIGRAVITY_I18N_META__.builtAt) || '',
      dictCount: EXACT_MAP.size,
      attrCount: ATTR_MAP.size,
      ruleCount: OTA_DYNAMIC_RULES.length
    };
    if (I18N_ENABLED) {
      try {
        window.__antigravityTranslateAll();
        if (typeof document !== 'undefined' && document.querySelectorAll) {
          translatePortals();
        }
      } catch (_) {}
    }
    return true;
  };

  const observedRoots = new WeakSet();
  const VISIBILITY_ATTRS = ['style', 'hidden', 'open', 'aria-hidden', 'data-open', 'data-state'];
  const OBSERVED_ATTRS = TARGET_ATTRS.concat(VISIBILITY_ATTRS);

  function isElementHiddenForAttr(el, attrName) {
    if (!el || !el.getAttribute) return false;
    const val = el.getAttribute(attrName);
    if (attrName === 'aria-hidden' && val === 'true') return true;
    if (attrName === 'hidden' && val !== null) return true;
    if (attrName === 'open' && val === null && el.nodeName === 'DETAILS') return true;
    if (attrName === 'data-state' && val === 'closed') return true;
    if (attrName === 'data-open' && (val === 'false' || val === null)) return true;
    if (attrName === 'style') {
      if (el.style && el.style.display === 'none') return true;
      if (val && /(?:^|;)\s*display\s*:\s*none\b/i.test(val)) return true;
    }
    return false;
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root) || typeof MutationObserver === 'undefined') return;
    observedRoots.add(root);

    try {
      let burstWindowStart = 0;
      let burstCount = 0;
      let cooldownUntil = 0;
      let cooldownTimer = 0;

      const observer = new MutationObserver((mutations) => {
        const now = Date.now();
        if (now < cooldownUntil) {
          if (typeof observer.takeRecords === 'function') observer.takeRecords();
          return;
        }
        if (!burstWindowStart || now - burstWindowStart > 500) {
          burstWindowStart = now;
          burstCount = 1;
        } else {
          burstCount += 1;
          if (burstCount > 60) {
            cooldownUntil = now + 120;
            burstCount = 0;
            if (typeof observer.takeRecords === 'function') observer.takeRecords();
            if (!cooldownTimer) {
              cooldownTimer = setTimeout(() => {
                cooldownTimer = 0;
                if (I18N_ENABLED) {
                  translatePortals();
                  scheduleFullTranslate();
                }
              }, 130);
            }
            return;
          }
        }

        try {
          if (!I18N_ENABLED) {
            const disabledAdded = new Set();
            for (let i = 0; i < mutations.length; i++) {
              const m = mutations[i];
              if (m && m.type === 'childList') {
                for (let j = 0; j < m.addedNodes.length; j++) {
                  const added = m.addedNodes[j];
                  if (!added || isInjectedI18nControl(added)) continue;
                  disabledAdded.add(added);
                }
              }
            }
            disabledAdded.forEach((added) => {
              if (added.parentNode && disabledAdded.has(added.parentNode)) return;
              if (containsTitleMenuBar(added)) {
                ensureTitleBarLangToggle(added);
                ensureTitleBarOtaMenuItem(added);
              }
            });
            return;
          }

          const addedSet = new Set();
          const charSet = new Set();
          const attrSet = new Set();
          const visList = [];
          const visSeen = new Set();

          for (let i = 0; i < mutations.length; i++) {
            const m = mutations[i];
            if (!m) continue;
            if (m.type === 'childList') {
              for (let j = 0; j < m.addedNodes.length; j++) {
                const added = m.addedNodes[j];
                if (!added || isInjectedI18nControl(added)) continue;
                addedSet.add(added);
              }
            } else if (m.type === 'characterData') {
              if (m.target && !isInjectedI18nControl(m.target)) {
                charSet.add(m.target);
              }
            } else if (m.type === 'attributes' && m.target) {
              if (isInjectedI18nControl(m.target)) continue;
              if (TARGET_ATTRS.includes(m.attributeName)) {
                attrSet.add(m.target);
              } else if (VISIBILITY_ATTRS.includes(m.attributeName) && !isElementHiddenForAttr(m.target, m.attributeName)) {
                if (m.attributeName === 'style') {
                  if (m.target.matches && m.target.matches(PORTAL_SELECTOR)) {
                    if (!visSeen.has(m.target)) {
                      visSeen.add(m.target);
                      visList.push(m.target);
                    }
                  }
                } else if (
                  m.attributeName === 'aria-hidden' &&
                  (isShellContainer(m.target) || (typeof m.target.childElementCount === 'number' && m.target.childElementCount > 30 && !(m.target.matches && m.target.matches(PORTAL_SELECTOR))))
                ) {
                  // 弹窗关闭移除根容器 aria-hidden 时不再整树重扫
                } else if (!visSeen.has(m.target)) {
                  visSeen.add(m.target);
                  visList.push(m.target);
                }
              }
            }
          }

          addedSet.forEach((added) => {
            if (added.parentNode && addedSet.has(added.parentNode)) return;
            translateSubtree(added);
          });
          charSet.forEach((target) => {
            if (!addedSet.has(target)) {
              translateNode(target);
            }
          });
          attrSet.forEach((target) => {
            if (!addedSet.has(target)) {
              translateElementAttrs(target);
            }
          });
          if (visList.length > 0) {
            for (let i = 0; i < visList.length; i++) {
              const target = visList[i];
              if (!addedSet.has(target)) {
                translateSubtree(target);
              }
            }
            schedulePortalTranslate();
          }
        } finally {
          if (typeof observer.takeRecords === 'function') {
            observer.takeRecords();
          }
        }
      });

      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: OBSERVED_ATTRS
      });
    } catch (e) {}
  }

  function collectInsertTargets(node) {
    if (!node) return null;
    if (node.nodeType === 11 && node.childNodes) {
      return Array.prototype.slice.call(node.childNodes);
    }
    return node;
  }

  function translateInsertedTargets(targets) {
    if (!targets) return;
    if (Array.isArray(targets)) {
      for (let i = 0; i < targets.length; i++) {
        translateSubtree(targets[i]);
      }
    } else {
      translateSubtree(targets);
    }
  }

  if (typeof Node !== 'undefined' && Node.prototype) {
    const origAppendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function (child) {
      const targets = this && this.isConnected ? collectInsertTargets(child) : null;
      const res = origAppendChild.call(this, child);
      if (targets) {
        try {
          translateInsertedTargets(targets);
        } catch (e) {}
      }
      return res;
    };

    const origInsertBefore = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function (newNode, referenceNode) {
      const targets = this && this.isConnected ? collectInsertTargets(newNode) : null;
      const res = origInsertBefore.call(this, newNode, referenceNode);
      if (targets) {
        try {
          translateInsertedTargets(targets);
        } catch (e) {}
      }
      return res;
    };
  }

  if (typeof Element !== 'undefined' && Element.prototype) {
    ['append', 'prepend', 'replaceChildren'].forEach((method) => {
      const orig = Element.prototype[method];
      if (typeof orig === 'function') {
        Element.prototype[method] = function (...nodes) {
          const targets = [];
          if (this && this.isConnected && !shouldIgnoreTextParent(this)) {
            for (let i = 0; i < nodes.length; i++) {
              if (typeof nodes[i] === 'string') {
                if (I18N_ENABLED) {
                  try {
                    const rawStr = nodes[i];
                    const transStr = translateString(rawStr, this);
                    if (transStr !== rawStr) {
                      if (typeof document !== 'undefined' && typeof document.createTextNode === 'function') {
                        const tn = document.createTextNode(rawStr);
                        applyTextTranslation(tn, rawStr, transStr);
                        nodes[i] = tn;
                      } else {
                        nodes[i] = transStr;
                      }
                    }
                  } catch (e) {}
                }
              } else if (nodes[i] && typeof nodes[i] === 'object' && nodes[i].nodeType) {
                const collected = collectInsertTargets(nodes[i]);
                if (Array.isArray(collected)) {
                  for (let j = 0; j < collected.length; j++) targets.push(collected[j]);
                } else if (collected) {
                  targets.push(collected);
                }
              }
            }
          }
          const res = orig.apply(this, nodes);
          if (this && this.isConnected && targets.length > 0) {
            for (let i = 0; i < targets.length; i++) {
              try {
                translateSubtree(targets[i]);
              } catch (e) {}
            }
          }
          return res;
        };
      }
    });

    if (Element.prototype.attachShadow) {
      const origAttachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) {
        const shadow = origAttachShadow.call(this, init);
        try {
          observeRoot(shadow);
          if (I18N_ENABLED && this && this.isConnected) {
            translateSubtree(shadow);
          }
        } catch (e) {}
        return shadow;
      };
    }
  }

  const PORTAL_SELECTOR = [
    '[role="tooltip"]', '.compact-tooltip', '[role="dialog"]', '[role="menu"]', '[role="listbox"]',
    '[data-hover-card-popup]',
    '[data-base-ui-portal]', '[data-radix-popper-content-wrapper]',
    '[data-floating-ui-portal]', '.tippy-box', '.monaco-hover',
    '.settings-modal-container', '.settings-modal-backdrop',
    '.agy-dialog', '[aria-modal="true"]'
  ].join(', ');

  function translatePortals() {
    if (!I18N_ENABLED || !document.querySelectorAll) return;
    const queryRoot = (document.documentElement && typeof document.documentElement.querySelectorAll === 'function')
      ? document.documentElement
      : document;
    const portals = queryRoot.querySelectorAll(PORTAL_SELECTOR);
    for (let i = 0; i < portals.length; i++) {
      const p = portals[i];
      if (!p) continue;
      if (p.parentElement && p.parentElement.closest && p.parentElement.closest(PORTAL_SELECTOR)) {
        continue;
      }
      translateSubtree(p);
    }
  }

  let portalRafId = 0;
  function schedulePortalTranslate() {
    if (!I18N_ENABLED || portalRafId) return;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    portalRafId = raf(() => {
      portalRafId = 0;
      translatePortals();
    });
  }

  const HOVER_TRIGGER_SELECTOR = 'button, [role="button"], [role="menuitem"], [role="option"], [data-tooltip-id], [aria-describedby], [title], [data-hover-card-trigger], a, [tabindex], [aria-haspopup]';
  const HOVER_DELAY_STEPS = [80, 260, 500];
  let hoverDelayTimers = [];
  let lastHoverTarget = null;
  function isShellContainer(el) {
    if (!el) return true;
    if (el === document.documentElement || el === document.body || el.id === 'root' || el.id === 'app') return true;
    const p = el.parentElement;
    if (
      p &&
      ((typeof document !== 'undefined' && p === document.body) || p.id === 'root' || p.id === 'app') &&
      !(el.matches && el.matches(PORTAL_SELECTOR))
    ) {
      return true;
    }
    return false;
  }
  function isSmallHoverTarget(el) {
    if (!el || el.nodeType !== 1 || isShellContainer(el)) return false;
    if (typeof el.childElementCount === 'number' && el.childElementCount > 15) return false;
    return !shouldIgnoreElement(el);
  }
  function isInteractiveHoverTarget(el) {
    if (!el || el.nodeType !== 1 || isShellContainer(el)) return false;
    if (el.closest && el.closest('[data-tooltip-id], [aria-describedby], [data-hover-card-trigger]')) {
      return true;
    }
    if (!isSmallHoverTarget(el)) return false;
    return Boolean(el.closest && el.closest(HOVER_TRIGGER_SELECTOR));
  }

  function scheduleDelayedHoverTranslate(targetEl) {
    if (!I18N_ENABLED) return;
    for (let i = 0; i < hoverDelayTimers.length; i++) {
      clearTimeout(hoverDelayTimers[i]);
    }
    hoverDelayTimers = [];
    for (let i = 0; i < HOVER_DELAY_STEPS.length; i++) {
      const delay = HOVER_DELAY_STEPS[i];
      const tid = setTimeout(() => {
        if (!I18N_ENABLED) return;
        if (isSmallHoverTarget(targetEl) && targetEl.isConnected) {
          translateSubtree(targetEl);
        }
        translatePortals();
      }, delay);
      hoverDelayTimers.push(tid);
    }
  }

  let fullTimer = 0;
  function scheduleFullTranslate() {
    if (!I18N_ENABLED || fullTimer) return;
    fullTimer = setTimeout(() => {
      fullTimer = 0;
      window.__antigravityTranslateAll();
    }, 40);
  }

  let settledTimer = 0;
  function scheduleSettledTranslate(delay = 280) {
    if (!I18N_ENABLED) return;
    if (settledTimer) clearTimeout(settledTimer);
    settledTimer = setTimeout(() => {
      settledTimer = 0;
      if (!I18N_ENABLED) return;
      translatePortals();
      window.__antigravityTranslateAll();
    }, delay);
  }

  function initEngine() {
    if (document.documentElement) {
      observeRoot(document.documentElement);
      ensureTitleBarLangToggle(document.documentElement);
    }
    window.__antigravityTranslateAll();
    updateInjectedTitleBarLabels();
    scheduleSettledTranslate(350);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initEngine);
    } else {
      initEngine();
    }

    ['pointerenter', 'focusin'].forEach((eventName) => {
      document.addEventListener(eventName, (e) => {
        if (!I18N_ENABLED) return;
        const target = e ? e.target : null;
        if (isSmallHoverTarget(target) && target !== lastHoverTarget) {
          lastHoverTarget = target;
          translateSubtree(target);
        }
        if (eventName === 'focusin' || isInteractiveHoverTarget(target)) {
          schedulePortalTranslate();
          scheduleDelayedHoverTranslate(target);
        }
      }, { capture: true, passive: true });
    });

    ['click', 'keydown'].forEach((eventName) => {
      document.addEventListener(eventName, (e) => {
        if (!I18N_ENABLED) return;
        if (eventName === 'keydown' && e && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== 'Enter' && e.key !== 'Escape') {
          return;
        }
        const target = e ? e.target : null;
        if (isSmallHoverTarget(target)) {
          translateSubtree(target);
        }
        schedulePortalTranslate();
      }, { capture: true, passive: true });
    });
  }

  if (typeof window !== 'undefined') {
    if (window.history && !window.history.__antigravityHistoryPatched) {
      try {
        window.history.__antigravityHistoryPatched = true;
        ['pushState', 'replaceState'].forEach((fnName) => {
          const orig = window.history[fnName];
          if (typeof orig === 'function') {
            window.history[fnName] = function (...args) {
              const res = orig.apply(this, args);
              schedulePortalTranslate();
              scheduleFullTranslate();
              scheduleSettledTranslate(280);
              return res;
            };
          }
        });
      } catch (e) {}
    }

    if (window.addEventListener) {
      ['focus', 'popstate', 'hashchange'].forEach((eventName) => {
        window.addEventListener(eventName, () => {
          schedulePortalTranslate();
          scheduleFullTranslate();
        });
      });

      window.addEventListener('load', () => {
        setTimeout(initEngine, 20);
      });
    }
  }

  console.log('[Antigravity-i18n] 全量确定性汉化引擎已就绪 (' + EXACT_MAP.size + ' 词条)！');
}

if (typeof module !== 'undefined') {
  module.exports = { antigravityI18nBootstrap };
}
