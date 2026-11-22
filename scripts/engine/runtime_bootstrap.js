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
  SPLIT_TEXT_TRANSLATOR
) {
  'use strict';

  if (window.__ANTIGRAVITY_I18N_INITIALIZED__) {
    if (window.__antigravityTranslateAll) {
      window.__antigravityTranslateAll();
    }
    return;
  }
  window.__ANTIGRAVITY_I18N_INITIALIZED__ = true;

  function normalizeKey(s) {
    return String(s)
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u2026/g, '...')
      .replace(/[\u00A0\u2007\u202F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const PRESERVE_SET = new Set(PRESERVE_LIST);
  const EXACT_MAP = new Map();
  const LOWER_EXACT = new Map();
  const NORM_EXACT = new Map();
  const NORM_LOWER = new Map();

  for (const [k, v] of Object.entries(EXACT_DICT)) {
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

  const ATTR_MAP = new Map();
  const NORM_ATTR = new Map();
  const NORM_ATTR_LOWER = new Map();
  for (const [k, v] of Object.entries(ATTR_DICT)) {
    ATTR_MAP.set(k, v);
    const nk = normalizeKey(k);
    if (nk) {
      if (!NORM_ATTR.has(nk)) NORM_ATTR.set(nk, v);
      const nkl = nk.toLowerCase();
      if (!NORM_ATTR_LOWER.has(nkl)) NORM_ATTR_LOWER.set(nkl, v);
    }
  }

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
    translateModelWithEffort
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
    isModelEffortContext
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

    // 模型选择器 / 新功能徽章中的 "New" 指“新”（区别于创建按钮“新建”）
    if ((norm === 'New' || norm === 'new' || norm === '新建') && isNewBadgeContext(contextEl)) {
      return leadWs + '新' + trailWs;
    }

    // "None" 根据所在菜单上下文区分：“分组方式”为“不分组”，思考深度选择器为“关闭思考”，其余默认为“无”
    if (
      norm === 'None' ||
      norm === 'none' ||
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
        norm === 'Request Review' || norm === 'Request review' || norm === '请求审核' ||
        norm === 'Turbo' || norm === '全自动' ||
        norm === 'Auto' || norm === '自动'
      ) &&
      isPermissionPresetContext(contextEl)
    ) {
      if (norm === 'Request Review' || norm === 'Request review' || norm === '请求审核') {
        return leadWs + '请求审核 (Request Review)' + trailWs;
      }
      if (norm === 'Turbo' || norm === '全自动') {
        return leadWs + '全自动 (Turbo)' + trailWs;
      }
      if (norm === 'Auto' || norm === '自动') {
        return leadWs + '自动 (Auto)' + trailWs;
      }
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

    // 2. 动态模板正则匹配
    for (let i = 0; i < DYNAMIC_RULES.length; i++) {
      const rule = DYNAMIC_RULES[i];
      if (rule[0].test(norm)) {
        const res = norm.replace(rule[0], rule[1]);
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

  function translateElementAttrs(node) {
    if (!node || node.nodeType !== 1 || shouldIgnoreAttrElement(node)) return;
    for (let i = 0; i < TARGET_ATTRS.length; i++) {
      const attr = TARGET_ATTRS[i];
      if (!node.hasAttribute || !node.hasAttribute(attr)) continue;
      const val = node.getAttribute(attr);
      if (!val) continue;
      const nk = normalizeKey(val);
      if (PRESERVE_SET.has(val.trim()) || (nk && PRESERVE_SET.has(nk))) continue;
      const attrHit =
        (ATTR_MAP.has(val) ? ATTR_MAP.get(val) : null) ||
        (nk ? NORM_ATTR.get(nk) || NORM_ATTR_LOWER.get(nk.toLowerCase()) : null);
      if (attrHit) {
        if (attrHit !== val) node.setAttribute(attr, attrHit);
      } else {
        const trans = translateString(val, node);
        if (trans !== val) {
          node.setAttribute(attr, trans);
        }
      }
    }
  }

  function translateNode(node) {
    if (!node) return;

    if (node.nodeType === 3) {
      const parent = node.parentElement || node.parentNode;
      if (shouldIgnoreTextParent(parent)) return;
      const val = node.nodeValue;
      if (val) {
        const splitTrans = SPLIT_TEXT_TRANSLATOR(node, val, parent);
        if (splitTrans !== null) {
          if (splitTrans !== val) node.nodeValue = splitTrans;
          return;
        }
        const trans = translateString(val, parent);
        if (trans !== val) {
          node.nodeValue = trans;
        }
      }
      return;
    }

    if (node.nodeType === 1) {
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
    } else if (node.nodeType === 11) {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        translateNode(child);
      }
    }
  }

  function translateSubtree(root) {
    if (!root) return;
    translateNode(root);
  }

  window.__antigravityTranslateString = translateString;
  window.__antigravityTranslateAll = function () {
    const root = document.documentElement || document.body;
    if (root) {
      translateSubtree(root);
    }
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
    if (attrName === 'data-open' && val === 'false') return true;
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
      const observer = new MutationObserver((mutations) => {
        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i];
          if (m.type === 'childList') {
            for (let j = 0; j < m.addedNodes.length; j++) {
              translateSubtree(m.addedNodes[j]);
            }
          } else if (m.type === 'characterData') {
            translateNode(m.target);
          } else if (m.type === 'attributes' && m.target) {
            if (TARGET_ATTRS.includes(m.attributeName)) {
              translateElementAttrs(m.target);
            } else if (VISIBILITY_ATTRS.includes(m.attributeName) && !isElementHiddenForAttr(m.target, m.attributeName)) {
              if (m.attributeName === 'style') {
                if (m.target.matches && m.target.matches(PORTAL_SELECTOR)) {
                  translateSubtree(m.target);
                  schedulePortalTranslate();
                }
              } else if (m.attributeName === 'aria-hidden' && (isShellContainer(m.target) || (typeof m.target.childElementCount === 'number' && m.target.childElementCount > 30 && !(m.target.matches && m.target.matches(PORTAL_SELECTOR))))) {
                // 弹窗关闭移除根容器 aria-hidden 时不再整树重扫
              } else {
                translateSubtree(m.target);
                schedulePortalTranslate();
              }
            }
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
                try {
                  nodes[i] = translateString(nodes[i], this);
                } catch (e) {}
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
          if (this && this.isConnected) {
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
    if (!document.querySelectorAll) return;
    const portals = document.querySelectorAll(PORTAL_SELECTOR);
    for (let i = 0; i < portals.length; i++) {
      translateSubtree(portals[i]);
    }
  }

  let portalRafId = 0;
  function schedulePortalTranslate() {
    if (portalRafId) return;
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
    return Boolean(
      !el ||
      el === document.documentElement ||
      el === document.body ||
      el.id === 'root' ||
      el.id === 'app' ||
      (typeof document !== 'undefined' && document.body && el.parentElement === document.body && !(el.matches && el.matches(PORTAL_SELECTOR)))
    );
  }
  function isSmallHoverTarget(el) {
    if (!el || el.nodeType !== 1 || isShellContainer(el)) return false;
    if (typeof el.childElementCount === 'number' && el.childElementCount > 15) return false;
    return !shouldIgnoreElement(el);
  }
  function isInteractiveHoverTarget(el) {
    if (!isSmallHoverTarget(el)) return false;
    return Boolean(el.closest && el.closest(HOVER_TRIGGER_SELECTOR));
  }

  function scheduleDelayedHoverTranslate(targetEl) {
    for (let i = 0; i < hoverDelayTimers.length; i++) {
      clearTimeout(hoverDelayTimers[i]);
    }
    hoverDelayTimers = [];
    for (let i = 0; i < HOVER_DELAY_STEPS.length; i++) {
      const delay = HOVER_DELAY_STEPS[i];
      const tid = setTimeout(() => {
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
    if (fullTimer) return;
    fullTimer = setTimeout(() => {
      fullTimer = 0;
      window.__antigravityTranslateAll();
    }, 40);
  }

  function initEngine() {
    if (document.documentElement) {
      observeRoot(document.documentElement);
    }
    window.__antigravityTranslateAll();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initEngine);
    } else {
      initEngine();
    }

    ['pointerenter', 'focusin'].forEach((eventName) => {
      document.addEventListener(eventName, (e) => {
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

  console.log('[Antigravity-i18n] 全量确定性汉化引擎已就绪 (' + Object.keys(EXACT_DICT).length + ' 词条)！');
}

if (typeof module !== 'undefined') {
  module.exports = { antigravityI18nBootstrap };
}
