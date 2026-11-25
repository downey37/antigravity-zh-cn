const vm = require('vm');
const assert = require('assert');
const { createMockDomEnv } = require('./mock_dom');

function runDomLifecycleVerification(i18nCode) {
  const { DomNode, DomElement, makeText } = createMockDomEnv();

  const html = new DomElement('HTML');
  html.isConnected = true;
  const body = new DomElement('BODY');
  html.appendChild(body);
  const rootDiv = new DomElement('DIV');
  rootDiv.id = 'root';
  body.appendChild(rootDiv);
  for (let i = 0; i < 35; i++) {
    rootDiv.appendChild(new DomElement('DIV'));
  }

  let observerCb = null;
  const observedTargets = [];
  const docListeners = {};
  let otaMenuClickedCount = 0;
  const dispatchedDocEvents = [];
  const sandbox = {
    console, setTimeout, clearTimeout,
    Node: DomNode,
    Element: DomElement,
    KeyboardEvent: function (type, init) { this.type = type; Object.assign(this, init || {}); },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    MutationObserver: class {
      constructor(cb) { observerCb = cb; }
      observe(target) { observedTargets.push(target); }
    },
    requestAnimationFrame: (cb) => { cb(); return 1; },
    window: {
      location: { protocol: 'app:' },
      history: {},
      addEventListener() {},
      antigravityI18nOta: {
        checkForUpdates: () => { otaMenuClickedCount++; return Promise.resolve({ status: 'up_to_date' }); },
        toggleLanguage: () => {
          const next = sandbox.window.__antigravitySetI18nEnabled(!sandbox.window.__antigravityIsI18nEnabled());
          return Promise.resolve({ enabled: next });
        }
      }
    },
    location: { protocol: 'app:' },
    document: {
      readyState: 'complete',
      title: 'Antigravity',
      documentElement: html,
      body,
      createElement: (tag) => new DomElement(String(tag).toUpperCase()),
      createTextNode: (val) => makeText(val),
      dispatchEvent: (ev) => { dispatchedDocEvents.push(ev); },
      querySelectorAll: () => [],
      addEventListener: (ev, fn) => { docListeners[ev] = fn; }
    }
  };
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(i18nCode, sandbox);

  // 1. appendChild with DocumentFragment translates inserted nodes immediately
  const frag = new DomNode(11);
  const fragSpan = new DomElement('SPAN');
  const fragText = makeText('New Project');
  fragSpan.appendChild(fragText);
  frag.appendChild(fragSpan);
  rootDiv.appendChild(frag);
  assert.strictEqual(fragText.nodeValue, '新建项目');

  // 2. Element.prototype.append translates raw string argument immediately
  const strSpan = new DomElement('SPAN');
  rootDiv.appendChild(strSpan);
  strSpan.append('Settings');
  assert.strictEqual(strSpan.firstChild.nodeValue, '设置');

  // 3. attachShadow observes & translates shadowRoot contents
  const hostEl = new DomElement('DIV');
  rootDiv.appendChild(hostEl);
  const shadow = hostEl.attachShadow({ mode: 'open' });
  assert(observedTargets.includes(shadow), 'attachShadow must register MutationObserver on shadowRoot');
  const shadowSpan = new DomElement('SPAN');
  const shadowText = makeText('Add Resource');
  shadowSpan.appendChild(shadowText);
  shadow.appendChild(shadowSpan);
  assert.strictEqual(shadowText.nodeValue, '添加资源');

  // 4. MutationObserver characterData & attributes handling
  const mutText = makeText('Close downloads');
  const mutEl = new DomElement('BUTTON');
  mutEl.setAttribute('title', 'Copy Link');
  mutEl.appendChild(mutText);
  observerCb([
    { type: 'characterData', target: mutText },
    { type: 'attributes', attributeName: 'title', target: mutEl }
  ]);
  assert.strictEqual(mutText.nodeValue, '关闭下载');
  assert.strictEqual(mutEl.getAttribute('title'), '复制链接');

  // 5. Hot-path guard: aria-hidden removal / pointerenter / click / Enter on #root must NOT walk #root
  let rootWalks = 0;
  const origDesc = Object.getOwnPropertyDescriptor(DomNode.prototype, 'firstChild');
  Object.defineProperty(rootDiv, 'firstChild', {
    get() {
      rootWalks++;
      return origDesc.get.call(this);
    }
  });
  observerCb([{ type: 'attributes', attributeName: 'aria-hidden', target: rootDiv }]);
  docListeners.pointerenter({ target: rootDiv });
  docListeners.click({ target: rootDiv });
  docListeners.keydown({ key: 'Enter', target: rootDiv });
  assert.strictEqual(rootWalks, 0, 'Shell #root must not be traversed on aria-hidden removal, pointerenter, click, or Enter');

  // 6. data-state="open" on a popover still translates its subtree
  const pop = new DomElement('DIV');
  pop.setAttribute('data-state', 'open');
  const popText = makeText('Archived Only');
  pop.appendChild(popText);
  observerCb([{ type: 'attributes', attributeName: 'data-state', target: pop }]);
  assert.strictEqual(popText.nodeValue, '仅已归档');

  // 7. Sidebar volatile relative timestamp appends & live characterData updates translate seamlessly
  const timeSpan = new DomElement('SPAN');
  timeSpan.className = 'text-sm text-foreground opacity-60 min-w-4 shrink-0 text-right tabular-nums';
  timeSpan.setAttribute('data-screenshot-volatile', 'true');
  const timeText = makeText('47m');
  timeSpan.appendChild(timeText);
  rootDiv.appendChild(timeSpan);
  assert.strictEqual(timeText.nodeValue, '47 分钟前');
  timeText.nodeValue = '2mo';
  observerCb([{ type: 'characterData', target: timeText }]);
  assert.strictEqual(timeText.nodeValue, '2 个月前');

  // 8. Orchestrator model selector combined "Model + Effort" appends & characterData updates translate seamlessly
  const orchModelSpan = new DomElement('SPAN');
  orchModelSpan.setAttribute('data-testid', 'model-selector-orchestrator-model');
  const orchModelText = makeText('Gemini 4 Neon Extra High');
  orchModelSpan.appendChild(orchModelText);
  rootDiv.appendChild(orchModelSpan);
  assert.strictEqual(orchModelText.nodeValue, 'Gemini 4 Neon 超高');
  orchModelText.nodeValue = 'Claude Opus 5.5 High';
  observerCb([{ type: 'characterData', target: orchModelText }]);
  assert.strictEqual(orchModelText.nodeValue, 'Claude Opus 5.5 高');

  // 8b. Automation model selector trigger & dropdown options translate on mount and live selection change
  const autoTrigger = new DomElement('DIV');
  autoTrigger.setAttribute('data-testid', 'new-sidecar-model');
  autoTrigger.setAttribute('data-model', 'neon-high');
  const autoTriggerSpan = new DomElement('SPAN');
  const autoTriggerText = makeText('Gemini 4 Neon (High)');
  autoTriggerSpan.appendChild(autoTriggerText);
  autoTrigger.appendChild(autoTriggerSpan);
  rootDiv.appendChild(autoTrigger);
  assert.strictEqual(autoTriggerText.nodeValue, 'Gemini 4 Neon (高)');

  const autoOpt1 = new DomElement('DIV');
  autoOpt1.setAttribute('data-testid', 'sidecar-model-option');
  autoOpt1.setAttribute('data-model', 'neon-xhigh');
  const autoOpt1Text = makeText('Gemini 4 Neon (XHigh)');
  autoOpt1.appendChild(autoOpt1Text);
  const autoOpt2 = new DomElement('DIV');
  autoOpt2.setAttribute('data-testid', 'sidecar-model-option');
  autoOpt2.setAttribute('data-model', 'carbon-medium');
  const autoOpt2Text = makeText('Gemini 4 Carbon (Medium)');
  autoOpt2.appendChild(autoOpt2Text);
  body.appendChild(autoOpt1);
  body.appendChild(autoOpt2);
  assert.strictEqual(autoOpt1Text.nodeValue, 'Gemini 4 Neon (超高)');
  assert.strictEqual(autoOpt2Text.nodeValue, 'Gemini 4 Carbon (中)');

  autoTriggerText.nodeValue = 'Gemini 4 Argon (Medium)';
  observerCb([{ type: 'characterData', target: autoTriggerText }]);
  assert.strictEqual(autoTriggerText.nodeValue, 'Gemini 4 Argon (中)');

  // 8c. Automation custom schedule editor live mount & EN/ZH round-trip
  const liveSchedCustom = new DomElement('DIV');
  liveSchedCustom.setAttribute('data-testid', 'schedule-custom');
  const liveOnText = makeText('on');
  const liveUnitBtn = new DomElement('BUTTON');
  liveUnitBtn.setAttribute('data-testid', 'schedule-custom-unit');
  const liveUnitText = makeText('week');
  liveUnitBtn.appendChild(liveUnitText);
  const liveAtText = makeText('at');
  const liveTimeBtn = new DomElement('BUTTON');
  liveTimeBtn.setAttribute('data-testid', 'schedule-time');
  const liveTimeText = makeText('9:00 AM');
  liveTimeBtn.appendChild(liveTimeText);
  const liveTueBtn = new DomElement('BUTTON');
  liveTueBtn.setAttribute('aria-label', 'Tuesday');
  const liveTueText = makeText('T');
  liveTueBtn.appendChild(liveTueText);
  const liveThuBtn = new DomElement('BUTTON');
  liveThuBtn.setAttribute('aria-label', 'Thursday');
  const liveThuText = makeText('T');
  liveThuBtn.appendChild(liveThuText);
  liveSchedCustom.appendChild(liveOnText);
  liveSchedCustom.appendChild(liveUnitBtn);
  liveSchedCustom.appendChild(liveAtText);
  liveSchedCustom.appendChild(liveTimeBtn);
  liveSchedCustom.appendChild(liveTueBtn);
  liveSchedCustom.appendChild(liveThuBtn);
  rootDiv.appendChild(liveSchedCustom);
  assert.strictEqual(liveOnText.nodeValue, '星期');
  assert.strictEqual(liveUnitText.nodeValue, '周');
  assert.strictEqual(liveAtText.nodeValue, '时间');
  assert.strictEqual(liveTimeText.nodeValue, '上午 9:00');
  assert.strictEqual(liveTueBtn.getAttribute('aria-label'), '星期二');
  assert.strictEqual(liveTueText.nodeValue, '二');
  assert.strictEqual(liveThuBtn.getAttribute('aria-label'), '星期四');
  assert.strictEqual(liveThuText.nodeValue, '四');
  sandbox.window.__antigravitySetI18nEnabled(false);
  assert.strictEqual(liveOnText.nodeValue, 'on');
  assert.strictEqual(liveUnitText.nodeValue, 'week');
  assert.strictEqual(liveTimeText.nodeValue, '9:00 AM');
  assert.strictEqual(liveTueText.nodeValue, 'T');
  assert.strictEqual(liveThuText.nodeValue, 'T');
  sandbox.window.__antigravitySetI18nEnabled(true);
  assert.strictEqual(liveOnText.nodeValue, '星期');
  assert.strictEqual(liveUnitText.nodeValue, '周');
  assert.strictEqual(liveTimeText.nodeValue, '上午 9:00');
  assert.strictEqual(liveTueText.nodeValue, '二');
  assert.strictEqual(liveThuText.nodeValue, '四');

  // 9. Model selector compact-tooltip portal mount & live tooltip switch translate seamlessly
  const tipBox = new DomElement('DIV');
  tipBox.setAttribute('role', 'tooltip');
  tipBox.className = 'compact-tooltip surface-glass';
  const tipInner = new DomElement('DIV');
  tipInner.className = 'max-w-[200px]';
  const tipText = makeText('Sonnet 5.5 is now available on paid Pro and Ultra plans. Third-party model access will no longer be available on your current plan starting on November 30, 2026.');
  tipInner.appendChild(tipText);
  tipBox.appendChild(tipInner);
  body.appendChild(tipBox);
  assert.strictEqual(
    tipText.nodeValue,
    'Sonnet 5.5 现已面向付费 Pro 和 Ultra 套餐开放。自 2026年11月30日起，你当前的套餐将不再提供第三方模型访问权限。'
  );
  tipText.nodeValue = 'Gemini 4 Hydrogen is currently available to paid Pro and Ultra subscribers.';
  observerCb([{ type: 'characterData', target: tipText }]);
  assert.strictEqual(
    tipText.nodeValue,
    'Gemini 4 Hydrogen 目前仅面向付费 Pro 和 Ultra 订阅用户开放。'
  );
  tipText.nodeValue = 'The original Gemini 4 model for advanced workflows. Leaving on Nov 30.';
  observerCb([{ type: 'characterData', target: tipText }]);
  assert.strictEqual(
    tipText.nodeValue,
    '原版 Gemini 4 模型，适用于高级工作流。将于 11月30日下线。'
  );
  tipText.nodeValue = 'Use Hydrogen for better quality with lower quota usage. Leaving on Nov 30.';
  observerCb([{ type: 'characterData', target: tipText }]);
  assert.strictEqual(
    tipText.nodeValue,
    '请使用 Hydrogen 以获得更高质量与更低配额消耗。将于 11月30日下线。'
  );

  // 10. Live OTA hot-reload (__antigravityApplyOtaPack): adds/overrides dict, applies declarative rules, ignores bad regexes, idempotent per version
  const otaSpan = new DomElement('SPAN');
  otaSpan.setAttribute('title', 'Brand New OTA Tooltip');
  const otaText = makeText('Brand New Server Label');
  otaSpan.appendChild(otaText);
  const otaRuleSpan = new DomElement('SPAN');
  const otaRuleText = makeText('Gemini 5 Ultra will launch on Dec 25.');
  otaRuleSpan.appendChild(otaRuleText);
  const otaPreserveSpan = new DomElement('SPAN');
  const otaPreserveText = makeText('CustomBrandX');
  otaPreserveSpan.appendChild(otaPreserveText);
  rootDiv.appendChild(otaSpan);
  rootDiv.appendChild(otaRuleSpan);
  rootDiv.appendChild(otaPreserveSpan);
  assert.strictEqual(otaText.nodeValue, 'Brand New Server Label');
  assert.strictEqual(otaSpan.getAttribute('title'), 'Brand New OTA Tooltip');
  assert.strictEqual(otaRuleText.nodeValue, 'Gemini 5 Ultra will launch on Dec 25.');

  const otaPack = {
    schemaVersion: 1,
    packVersion: '2099.01.01.000001',
    builtAt: '2099-01-01T00:00:01.000Z',
    dictionary: {
      'Brand New Server Label': '全新服务端标签',
      'Settings': '系统设置（热更测试）',
      'CustomBrandX': '不应翻译的品牌',
      'New Project': '新建项目',
      'Add Resource': '添加资源',
      'Check for Updates': '检查更新'
    },
    attrDict: {
      'Brand New OTA Tooltip': '全新热更提示'
    },
    preserveList: ['Antigravity', 'CustomBrandX'],
    rules: [
      {
        id: 'ota-launch-test',
        pattern: '^(.+?)\\s+will\\s+launch\\s+on\\s+(.+?)\\.$',
        flags: 'i',
        replace: '$1 将于 $2 发布。',
        requireAscii: true
      },
      { id: 'bad-regex', pattern: '[invalid(', flags: 'i', replace: 'x' },
      { id: 'unsafe-flag', pattern: '^foo$', flags: 'g', replace: 'bar' }
    ]
  };
  assert.strictEqual(sandbox.window.__antigravityApplyOtaPack(otaPack), true);
  assert.strictEqual(otaText.nodeValue, '全新服务端标签');
  assert.strictEqual(otaSpan.getAttribute('title'), '全新热更提示');
  assert.strictEqual(otaRuleText.nodeValue, 'Gemini 5 Ultra 将于 Dec 25 发布。');
  assert.strictEqual(otaPreserveText.nodeValue, 'CustomBrandX');
  assert.strictEqual(sandbox.window.__antigravityTranslateString('Settings'), '系统设置（热更测试）');
  assert.strictEqual(sandbox.window.__antigravityTranslateString('foo'), 'foo');
  assert.strictEqual(sandbox.window.__antigravityApplyOtaPack(otaPack), false, 'Re-applying same OTA packVersion must be idempotent no-op');

  // 11. Windows custom title-menu-bar ("Antigravity" dropdown) injects "检查汉化更新" right below "检查更新" (no redundant toggle item)
  const titleBar = new DomElement('DIV');
  titleBar.setAttribute('data-testid', 'title-menu-bar');
  const menuWrap = new DomElement('DIV');
  titleBar.appendChild(menuWrap);
  rootDiv.appendChild(titleBar);

  const popup = new DomElement('DIV');
  popup.setAttribute('data-browser-occluder', 'true');
  const verDiv = new DomElement('DIV');
  const verBtn = new DomElement('BUTTON');
  verBtn.setAttribute('data-testid', 'title-menu-bar-option');
  const verSpan = new DomElement('SPAN');
  verSpan.appendChild(makeText('Version 2.34.0'));
  verBtn.appendChild(verSpan);
  verDiv.appendChild(verBtn);
  const updDiv = new DomElement('DIV');
  const updBtn = new DomElement('BUTTON');
  updBtn.setAttribute('data-testid', 'title-menu-bar-option');
  updBtn.className = 'w-full px-3 py-1.5 hover:bg-secondary';
  const updSpan = new DomElement('SPAN');
  updSpan.appendChild(makeText('Check for Updates'));
  updBtn.appendChild(updSpan);
  updDiv.appendChild(updBtn);
  popup.appendChild(verDiv);
  popup.appendChild(updDiv);
  menuWrap.appendChild(popup);

  const injectedBtns = popup.querySelectorAll('[data-antigravity-i18n-ota-item="true"]');
  assert.strictEqual(injectedBtns.length, 1, 'Windows Antigravity title menu must inject exactly one 检查汉化更新 item');
  assert.strictEqual(injectedBtns[0].textContent, '检查汉化更新');
  assert.strictEqual(injectedBtns[0].className, updBtn.className);
  const injectedToggleBtns = popup.querySelectorAll('[data-antigravity-i18n-toggle-item="true"]');
  assert.strictEqual(injectedToggleBtns.length, 0, 'Windows Antigravity title menu must not inject redundant toggle item when top [中 | EN] pill exists');
  assert.strictEqual(popup.children.length, 3);
  const titleBarToggleBtns = titleBar.querySelectorAll('[data-antigravity-i18n-titlebar-toggle="true"]');
  assert.strictEqual(titleBarToggleBtns.length, 1, 'Top title bar must inject permanent [中 | EN] toggle pill');
  const titleToggleStyles = html.querySelectorAll('[data-antigravity-i18n-titlebar-style="true"]');
  assert.strictEqual(titleToggleStyles.length, 1, 'Top title bar toggle must inject shared stylesheet once');
  const toggleCss = titleToggleStyles[0].textContent;
  assert(
    toggleCss.includes('var(--primary') &&
    toggleCss.includes('var(--primary-foreground') &&
    toggleCss.includes('var(--background') &&
    toggleCss.includes('var(--onyx-raised') &&
    toggleCss.includes('var(--card-border') &&
    toggleCss.includes('var(--border') &&
    toggleCss.includes('height:24px') &&
    toggleCss.includes('border-radius:8px') &&
    toggleCss.includes('border-radius:6px') &&
    toggleCss.includes('cursor:pointer') &&
    !toggleCss.includes('cursor:grab') &&
    toggleCss.includes('appearance:none') &&
    toggleCss.includes('box-shadow:none') &&
    toggleCss.includes('cubic-bezier(0.34,1.56,0.64,1)') &&
    toggleCss.includes('ag-i18n-jelly-zh') &&
    toggleCss.includes('ag-i18n-jelly-en'),
    'Toggle stylesheet must sync with Settings accent CSS vars, native rounded-lg/md geometry, pointer cursor, CSS resets, and spring/jelly animations'
  );
  const titleToggleBtn = titleBarToggleBtns[0];
  assert.strictEqual(titleToggleBtn.getAttribute('role'), null, 'Titlebar toggle must not use role="switch" to avoid colliding with Antigravity light-theme [role="switch"] CSS');
  assert.strictEqual(titleToggleBtn.getAttribute('data-lang'), 'zh');
  assert.strictEqual(titleToggleBtn.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(titleToggleBtn.getAttribute('data-bounce'), null, 'Initial render must not trigger bounce animation');
  assert.strictEqual(titleToggleBtn.getAttribute('title'), '当前：简体中文（点击或拖动切换为英文原文）');
  const thumbPill = titleToggleBtn.querySelector('[data-antigravity-i18n-pill-thumb="true"]');
  const thumbFillPill = titleToggleBtn.querySelector('[data-antigravity-i18n-pill-thumb-fill="true"]');
  assert(thumbPill && thumbFillPill, 'Title bar toggle must include sliding capsule thumb and inner fill');
  const zhPill = titleToggleBtn.querySelector('[data-antigravity-i18n-pill-zh="true"]');
  const enPill = titleToggleBtn.querySelector('[data-antigravity-i18n-pill-en="true"]');
  assert.strictEqual(zhPill.textContent, '中');
  assert.strictEqual(enPill.textContent, 'EN');
  assert.strictEqual(zhPill.getAttribute('data-active'), 'true');
  assert.strictEqual(enPill.getAttribute('data-active'), 'false');

  // Click dispatches Escape to close React menu & triggers IPC checkForUpdates
  injectedBtns[0]._listeners.click[0]({ stopPropagation() {} });
  assert.strictEqual(otaMenuClickedCount, 1);
  assert.strictEqual(dispatchedDocEvents.some((e) => e.key === 'Escape'), true);

  // 12. Clicking top title-bar [中 | EN] pill restores original English nodes/attrs losslessly & skips new mutations while disabled
  assert.strictEqual(sandbox.window.__antigravityIsI18nEnabled(), true);
  titleToggleBtn._listeners.click[0]({ stopPropagation() {} });
  assert.strictEqual(sandbox.window.__antigravityIsI18nEnabled(), false);
  assert.strictEqual(fragText.nodeValue, 'New Project');
  assert.strictEqual(strSpan.firstChild.nodeValue, 'Settings');
  assert.strictEqual(shadowText.nodeValue, 'Add Resource');
  assert.strictEqual(timeText.nodeValue, '2mo');
  assert.strictEqual(orchModelText.nodeValue, 'Claude Opus 5.5 High');
  assert.strictEqual(tipText.nodeValue, 'Use Hydrogen for better quality with lower quota usage. Leaving on Nov 30.');
  assert.strictEqual(otaText.nodeValue, 'Brand New Server Label');
  assert.strictEqual(otaSpan.getAttribute('title'), 'Brand New OTA Tooltip');
  assert.strictEqual(verSpan.firstChild.nodeValue, 'Version 2.34.0');
  assert.strictEqual(updSpan.firstChild.nodeValue, 'Check for Updates');
  assert.strictEqual(injectedBtns[0].textContent, 'Check i18n Updates');
  assert.strictEqual(titleToggleBtn.getAttribute('title'), 'Current: English (Click or drag to switch to 简体中文)');
  assert.strictEqual(titleToggleBtn.getAttribute('data-lang'), 'en');
  assert.strictEqual(titleToggleBtn.getAttribute('data-bounce'), 'en');
  assert.strictEqual(titleToggleBtn.getAttribute('aria-pressed'), 'false');
  assert.strictEqual(enPill.getAttribute('data-active'), 'true');
  assert.strictEqual(zhPill.getAttribute('data-active'), 'false');
  assert.strictEqual(zhPill.textContent, '中');
  assert.strictEqual(enPill.textContent, 'EN');

  const whileEnglishSpan = new DomElement('SPAN');
  const whileEnglishText = makeText('Add Resource');
  whileEnglishSpan.appendChild(whileEnglishText);
  rootDiv.appendChild(whileEnglishSpan);
  assert.strictEqual(whileEnglishText.nodeValue, 'Add Resource', 'New nodes added in English mode must remain English');

  // Click top title-bar [中 | EN] pill again to switch back to Simplified Chinese
  titleToggleBtn._listeners.click[0]({ stopPropagation() {} });
  assert.strictEqual(sandbox.window.__antigravityIsI18nEnabled(), true);
  assert.strictEqual(fragText.nodeValue, '新建项目');
  assert.strictEqual(strSpan.firstChild.nodeValue, '系统设置（热更测试）');
  assert.strictEqual(shadowText.nodeValue, '添加资源');
  assert.strictEqual(timeText.nodeValue, '2 个月前');
  assert.strictEqual(orchModelText.nodeValue, 'Claude Opus 5.5 高');
  assert.strictEqual(otaText.nodeValue, '全新服务端标签');
  assert.strictEqual(otaSpan.getAttribute('title'), '全新热更提示');
  assert.strictEqual(whileEnglishText.nodeValue, '添加资源');
  assert.strictEqual(updSpan.firstChild.nodeValue, '检查更新');
  assert.strictEqual(injectedBtns[0].textContent, '检查汉化更新');
  assert.strictEqual(titleToggleBtn.getAttribute('title'), '当前：简体中文（点击或拖动切换为英文原文）');
  assert.strictEqual(titleToggleBtn.getAttribute('data-lang'), 'zh');
  assert.strictEqual(titleToggleBtn.getAttribute('data-bounce'), 'zh');
  assert.strictEqual(titleToggleBtn.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(zhPill.getAttribute('data-active'), 'true');
  assert.strictEqual(enPill.getAttribute('data-active'), 'false');

  // 12b. Pointer drag interaction on title-bar toggle (drag past midpoint toggles & suppresses trailing click; short drag snaps back)
  titleToggleBtn.getBoundingClientRect = () => ({ width: 58 });
  thumbPill.style = {};
  const emitPtr = (type, clientX, pointerId = 1) => {
    for (const fn of (titleToggleBtn._listeners[type] || [])) {
      fn({ type, button: 0, pointerId, clientX, stopPropagation() {} });
    }
  };
  // Drag right past midpoint: 中 -> EN
  emitPtr('pointerdown', 10);
  emitPtr('pointermove', 30);
  assert.strictEqual(titleToggleBtn.getAttribute('data-dragging'), 'true');
  assert.strictEqual(titleToggleBtn.getAttribute('data-drag-target'), 'en');
  assert(thumbPill.style.transform && thumbPill.style.transform.includes('translate3d('));
  emitPtr('pointerup', 30);
  assert.strictEqual(sandbox.window.__antigravityIsI18nEnabled(), false, 'Dragging past midpoint right must switch to English');
  assert.strictEqual(titleToggleBtn.getAttribute('data-lang'), 'en');
  assert.strictEqual(titleToggleBtn.getAttribute('data-dragging'), null);
  assert.strictEqual(titleToggleBtn.getAttribute('data-drag-target'), null);
  assert.strictEqual(thumbPill.style.transform, '');
  // Trailing synthetic click right after drag must be suppressed (must stay in English)
  titleToggleBtn._listeners.click[0]({ stopPropagation() {} });
  assert.strictEqual(sandbox.window.__antigravityIsI18nEnabled(), false, 'Trailing click after drag must not double-toggle');

  // Short drag left (< midpoint) snaps back and keeps English
  emitPtr('pointerdown', 30);
  emitPtr('pointermove', 24);
  emitPtr('pointerup', 24);
  assert.strictEqual(sandbox.window.__antigravityIsI18nEnabled(), false, 'Short drag not crossing midpoint must snap back without toggling');
  assert.strictEqual(titleToggleBtn.getAttribute('data-lang'), 'en');
  assert.strictEqual(thumbPill.style.transform, '');

  // Drag left past midpoint: EN -> 中
  emitPtr('pointerdown', 30);
  emitPtr('pointermove', 10);
  assert.strictEqual(titleToggleBtn.getAttribute('data-drag-target'), 'zh');
  emitPtr('pointerup', 10);
  assert.strictEqual(sandbox.window.__antigravityIsI18nEnabled(), true, 'Dragging past midpoint left must switch back to Simplified Chinese');
  assert.strictEqual(titleToggleBtn.getAttribute('data-lang'), 'zh');
  assert.strictEqual(thumbPill.style.transform, '');

  // 13. Startup in persisted English mode (__ANTIGRAVITY_I18N_INITIAL_ENABLED__ = false) keeps UI English while injecting clickable [中 | EN] pill
  const { DomNode: DomNodeEn, DomElement: DomElementEn, makeText: makeTextEn } = createMockDomEnv();
  const htmlEn = new DomElementEn('HTML');
  htmlEn.isConnected = true;
  const bodyEn = new DomElementEn('BODY');
  htmlEn.appendChild(bodyEn);
  const rootEn = new DomElementEn('DIV');
  rootEn.id = 'root';
  bodyEn.appendChild(rootEn);
  const sandboxEn = {
    console, setTimeout, clearTimeout,
    Node: DomNodeEn,
    Element: DomElementEn,
    KeyboardEvent: function (type, init) { this.type = type; Object.assign(this, init || {}); },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (cb) => { cb(); return 1; },
    window: {
      __ANTIGRAVITY_I18N_INITIAL_ENABLED__: false,
      location: { protocol: 'app:' },
      history: {},
      addEventListener() {},
      antigravityI18nOta: {
        checkForUpdates: () => Promise.resolve({ status: 'up_to_date' }),
        toggleLanguage: () => {
          const next = sandboxEn.window.__antigravitySetI18nEnabled(!sandboxEn.window.__antigravityIsI18nEnabled());
          return Promise.resolve({ enabled: next });
        }
      }
    },
    location: { protocol: 'app:' },
    document: {
      readyState: 'complete',
      title: 'Antigravity',
      documentElement: htmlEn,
      body: bodyEn,
      createElement: (tag) => new DomElementEn(String(tag).toUpperCase()),
      createTextNode: (val) => makeTextEn(val),
      dispatchEvent: () => {},
      querySelectorAll: () => [],
      addEventListener: () => {}
    }
  };
  sandboxEn.window.document = sandboxEn.document;
  vm.runInNewContext(i18nCode, sandboxEn);
  assert.strictEqual(sandboxEn.window.__antigravityIsI18nEnabled(), false);
  const headerWrapEn = new DomElementEn('DIV');
  const barEn = new DomElementEn('DIV');
  barEn.setAttribute('data-testid', 'title-menu-bar');
  const labelSpanEn = new DomElementEn('SPAN');
  const labelTextEn = makeTextEn('Settings');
  labelSpanEn.appendChild(labelTextEn);
  headerWrapEn.appendChild(barEn);
  headerWrapEn.appendChild(labelSpanEn);
  rootEn.appendChild(headerWrapEn);
  assert.strictEqual(labelTextEn.nodeValue, 'Settings', 'Persisted English startup must keep UI in English');
  const enBarToggles = barEn.querySelectorAll('[data-antigravity-i18n-titlebar-toggle="true"]');
  assert.strictEqual(enBarToggles.length, 1, 'Title bar toggle pill must still be injected when starting in English mode');
  assert.strictEqual(enBarToggles[0].getAttribute('data-lang'), 'en');
  assert.strictEqual(enBarToggles[0].querySelector('[data-antigravity-i18n-pill-en="true"]').getAttribute('data-active'), 'true');
  enBarToggles[0]._listeners.click[0]({ stopPropagation() {} });
  assert.strictEqual(sandboxEn.window.__antigravityIsI18nEnabled(), true);
  assert.strictEqual(labelTextEn.nodeValue, '设置', 'Clicking [中 | EN] from English startup must translate UI immediately');
}

function runMutationConvergenceVerification(i18nCode) {
  const { DomNode, DomElement, makeText } = createMockDomEnv();
  const activeObservers = [];

  function isSubtreeOf(node, root) {
    let cur = node;
    while (cur) {
      if (cur === root) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  function enqueueMutation(record) {
    for (const obs of activeObservers) {
      if (!obs.root || !isSubtreeOf(record.target, obs.root)) continue;
      if (record.type === 'attributes' && obs.opts && Array.isArray(obs.opts.attributeFilter)) {
        if (!obs.opts.attributeFilter.includes(record.attributeName)) continue;
      }
      obs.queue.push(record);
    }
  }

  function flushMutations(maxTicks = 25) {
    let ticks = 0;
    while (ticks < maxTicks) {
      const batch = [];
      for (const obs of activeObservers) {
        if (obs.queue.length > 0) {
          batch.push({ obs, records: obs.queue.splice(0, obs.queue.length) });
        }
      }
      if (batch.length === 0) return ticks;
      ticks += 1;
      for (const item of batch) {
        item.obs.cb(item.records, item.obs.instance);
      }
    }
    throw new Error(`MutationObserver failed to converge within ${maxTicks} ticks (infinite loop detected)`);
  }

  function createLiveText(val) {
    const tn = makeText(val);
    let internalVal = String(val);
    Object.defineProperty(tn, 'nodeValue', {
      configurable: true,
      enumerable: true,
      get() { return internalVal; },
      set(next) {
        const nextStr = next === null || next === undefined ? '' : String(next);
        if (nextStr === internalVal) return;
        const oldVal = internalVal;
        internalVal = nextStr;
        if (this.isConnected) {
          enqueueMutation({ type: 'characterData', target: this, oldValue: oldVal });
        }
      }
    });
    return tn;
  }

  const origAppendChild = DomNode.prototype.appendChild;
  DomNode.prototype.appendChild = function (child) {
    const inserted = child.nodeType === 11 ? [...child.childNodes] : [child];
    const res = origAppendChild.call(this, child);
    if (this.isConnected && inserted.length > 0) {
      enqueueMutation({ type: 'childList', target: this, addedNodes: inserted, removedNodes: [] });
    }
    return res;
  };
  const origInsertBefore = DomNode.prototype.insertBefore;
  DomNode.prototype.insertBefore = function (newNode, refNode) {
    const inserted = newNode.nodeType === 11 ? [...newNode.childNodes] : [newNode];
    const res = origInsertBefore.call(this, newNode, refNode);
    if (this.isConnected && inserted.length > 0) {
      enqueueMutation({ type: 'childList', target: this, addedNodes: inserted, removedNodes: [] });
    }
    return res;
  };
  const origSetAttribute = DomNode.prototype.setAttribute;
  DomNode.prototype.setAttribute = function (k, v) {
    const oldVal = this.getAttribute(k);
    origSetAttribute.call(this, k, v);
    if (this.isConnected && this.nodeType === 1) {
      enqueueMutation({ type: 'attributes', target: this, attributeName: k, oldValue: oldVal });
    }
  };
  const origRemoveAttribute = DomNode.prototype.removeAttribute;
  DomNode.prototype.removeAttribute = function (k) {
    const had = this.hasAttribute(k);
    const oldVal = this.getAttribute(k);
    origRemoveAttribute.call(this, k);
    if (this.isConnected && this.nodeType === 1 && had) {
      enqueueMutation({ type: 'attributes', target: this, attributeName: k, oldValue: oldVal });
    }
  };

  class LiveMutationObserver {
    constructor(cb) {
      this._rec = { cb, root: null, opts: null, queue: [], instance: this };
      activeObservers.push(this._rec);
    }
    observe(target, opts) {
      this._rec.root = target;
      this._rec.opts = opts || {};
    }
    takeRecords() {
      return this._rec.queue.splice(0, this._rec.queue.length);
    }
    disconnect() {
      this._rec.root = null;
      this._rec.queue.length = 0;
    }
  }

  const html = new DomElement('HTML');
  html.isConnected = true;
  const body = new DomElement('BODY');
  html.appendChild(body);
  const rootDiv = new DomElement('DIV');
  rootDiv.id = 'root';
  body.appendChild(rootDiv);

  const findById = (node, id) => {
    if (!node || !id) return null;
    if (node.nodeType === 1 && (node.id === id || (node._attrs && node._attrs.id === id))) return node;
    for (const c of node.childNodes) {
      const hit = findById(c, id);
      if (hit) return hit;
    }
    return null;
  };

  const docListeners = {};
  const sandbox = {
    console, setTimeout, clearTimeout,
    Node: DomNode,
    Element: DomElement,
    KeyboardEvent: function (type, init) { this.type = type; Object.assign(this, init || {}); },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    MutationObserver: LiveMutationObserver,
    requestAnimationFrame: (cb) => { cb(); return 1; },
    window: {
      location: { protocol: 'app:' },
      history: {},
      addEventListener() {},
      antigravityI18nOta: {
        checkForUpdates: () => Promise.resolve({ status: 'up_to_date' }),
        toggleLanguage: () => {
          const next = sandbox.window.__antigravitySetI18nEnabled(!sandbox.window.__antigravityIsI18nEnabled());
          return Promise.resolve({ enabled: next });
        }
      }
    },
    location: { protocol: 'app:' },
    document: {
      readyState: 'complete',
      title: 'Antigravity',
      documentElement: html,
      body,
      createElement: (tag) => new DomElement(String(tag).toUpperCase()),
      createTextNode: (val) => createLiveText(val),
      dispatchEvent: () => {},
      getElementById: (id) => findById(html, id),
      querySelectorAll: (sel) => html.querySelectorAll(sel),
      addEventListener: (ev, fn) => {
        docListeners[ev] = docListeners[ev] || [];
        docListeners[ev].push(fn);
      }
    }
  };
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(i18nCode, sandbox);
  flushMutations();

  const assertNoOscillationAfterSyntheticMutations = (nodes) => {
    for (const n of nodes) {
      if (n.nodeType === 3) {
        enqueueMutation({ type: 'characterData', target: n, oldValue: n.nodeValue });
      } else if (n.nodeType === 1) {
        for (const attr of ['title', 'aria-label']) {
          if (n.hasAttribute(attr)) {
            enqueueMutation({ type: 'attributes', target: n, attributeName: attr, oldValue: n.getAttribute(attr) });
          }
        }
      }
    }
    const extraTicks = flushMutations();
    assert(extraTicks <= 2, `Expected synthetic re-check to converge in <= 2 ticks, took ${extraTicks}`);
  };

  // 1. Settings -> General permission preset (DWb / yWb lowercase labels + case variants + attributes)
  const portalWrap = new DomElement('DIV');
  portalWrap.setAttribute('data-base-ui-portal', 'true');
  const backdrop = new DomElement('DIV');
  backdrop.className = 'settings-modal-backdrop';
  const modalContainer = new DomElement('DIV');
  modalContainer.className = 'settings-modal-container';
  portalWrap.appendChild(backdrop);
  backdrop.appendChild(modalContainer);

  const pcLabel = new DomElement('SPAN');
  pcLabel.id = 'pc-label';
  const pcLabelText = createLiveText('This computer');
  pcLabel.appendChild(pcLabelText);

  const pcDesc = new DomElement('SPAN');
  pcDesc.id = 'pc-desc';
  const pcDescText = createLiveText('Controls the actions the agent can take');
  pcDesc.appendChild(pcDescText);

  const triggerBtn = new DomElement('BUTTON');
  triggerBtn.className = 'agy-select-trigger';
  triggerBtn.setAttribute('aria-labelledby', 'pc-label');
  triggerBtn.setAttribute('aria-describedby', 'pc-desc');
  triggerBtn.setAttribute('title', 'Require Review');
  const triggerText = createLiveText('Request Review');
  triggerBtn.appendChild(triggerText);

  modalContainer.appendChild(pcLabel);
  modalContainer.appendChild(pcDesc);
  modalContainer.appendChild(triggerBtn);

  const presetVariants = [
    ['Request Review', 'Every command requires approval', '请求审核 (Request Review)'],
    ['Request review', 'Every command requires approval', '请求审核 (Request Review)'],
    ['Require Review', 'Every command requires approval', '请求审核 (Request Review)'],
    ['Auto', 'Automatically decide if commands run', '自动 (Auto)'],
    ['auto', 'Automatically decide if commands run', '自动 (Auto)'],
    ['Turbo', 'Run all commands without restrictions', '全自动 (Turbo)'],
    ['turbo', 'Run all commands without restrictions', '全自动 (Turbo)']
  ];
  const presetTextNodes = [triggerText];
  const presetBtns = [triggerBtn];
  const expectedPresetNodes = [[triggerText, '请求审核 (Request Review)']];

  for (const [label, desc, expected] of presetVariants) {
    const opt = new DomElement('DIV');
    opt.className = 'agy-overlay-item';
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-label', label);
    const titleSpan = new DomElement('SPAN');
    const titleText = createLiveText(label);
    titleSpan.appendChild(titleText);
    const descSpan = new DomElement('SPAN');
    descSpan.appendChild(createLiveText(desc));
    opt.appendChild(titleSpan);
    opt.appendChild(descSpan);
    modalContainer.appendChild(opt);
    presetTextNodes.push(titleText);
    presetBtns.push(opt);
    expectedPresetNodes.push([titleText, expected], [opt, expected]);
  }

  body.appendChild(portalWrap);
  assert(flushMutations() <= 2);
  assert.strictEqual(pcLabelText.nodeValue, '此电脑');
  assert.strictEqual(triggerBtn.getAttribute('title'), '请求审核 (Request Review)');
  for (const [target, expected] of expectedPresetNodes) {
    if (target.nodeType === 3) {
      assert.strictEqual(target.nodeValue, expected, `Permission preset text must stabilize at ${expected}`);
    } else {
      assert.strictEqual(target.getAttribute('aria-label'), expected, `Permission preset attr must stabilize at ${expected}`);
    }
  }
  assertNoOscillationAfterSyntheticMutations([...presetTextNodes, ...presetBtns]);
  for (const [target, expected] of expectedPresetNodes) {
    if (target.nodeType === 3) assert.strictEqual(target.nodeValue, expected);
    else assert.strictEqual(target.getAttribute('aria-label'), expected);
  }

  // 2. Delayed permission preset context upgrade (mount button first -> 请求审核, then mount label -> 请求审核 (Request Review))
  const delayedWrap = new DomElement('DIV');
  const delayedBtn = new DomElement('BUTTON');
  delayedBtn.className = 'agy-select-trigger';
  delayedBtn.setAttribute('aria-labelledby', 'delayed-pp-label');
  delayedBtn.setAttribute('title', 'Request Review');
  const delayedSpan = new DomElement('SPAN');
  const delayedText = createLiveText('Request Review');
  delayedSpan.appendChild(delayedText);
  delayedBtn.appendChild(delayedSpan);
  delayedWrap.appendChild(delayedBtn);
  body.appendChild(delayedWrap);
  flushMutations();
  assert.strictEqual(delayedText.nodeValue, '请求审核');
  assert.strictEqual(delayedBtn.getAttribute('title'), '请求审核');

  const delayedLabel = new DomElement('SPAN');
  delayedLabel.id = 'delayed-pp-label';
  delayedLabel.appendChild(createLiveText('Permission preset'));
  delayedWrap.appendChild(delayedLabel);
  assertNoOscillationAfterSyntheticMutations([delayedText, delayedBtn]);
  assert.strictEqual(delayedText.nodeValue, '请求审核 (Request Review)');
  assert.strictEqual(delayedBtn.getAttribute('title'), '请求审核 (Request Review)');
  assertNoOscillationAfterSyntheticMutations([delayedText, delayedBtn]);
  assert.strictEqual(delayedText.nodeValue, '请求审核 (Request Review)');

  // 2b. Bottom chat-footer permission selector trigger + SSH host search input
  const footerPermBtn = new DomElement('BUTTON');
  footerPermBtn.setAttribute('data-testid', 'permissions-selector-trigger');
  footerPermBtn.setAttribute('aria-label', 'Agent permissions preset selector, current: Turbo');
  const footerPermSpan = new DomElement('SPAN');
  const footerPermText = createLiveText('Turbo');
  footerPermSpan.appendChild(footerPermText);
  footerPermBtn.appendChild(footerPermSpan);

  const sshSearchInput = new DomElement('INPUT');
  sshSearchInput.setAttribute('data-testid', 'project-selector-ssh-host-search');
  sshSearchInput.setAttribute('placeholder', 'Search Hosts\u2026');

  body.appendChild(footerPermBtn);
  body.appendChild(sshSearchInput);
  flushMutations();
  assert.strictEqual(footerPermText.nodeValue, '全自动 (Turbo)');
  assert.strictEqual(footerPermBtn.getAttribute('aria-label'), '智能体权限预设选择器，当前：全自动');
  assert.strictEqual(sshSearchInput.getAttribute('placeholder'), '搜索主机...');
  assertNoOscillationAfterSyntheticMutations([footerPermText, footerPermBtn, sshSearchInput]);
  assert.strictEqual(footerPermText.nodeValue, '全自动 (Turbo)');

  // 3. New badge context ("NEW", "New", "new", "Create New") + attr
  const modelPanel = new DomElement('DIV');
  modelPanel.setAttribute('data-testid', 'model-selector-panel');
  const newUpperText = createLiveText('NEW');
  const newLowerText = createLiveText('new');
  const createNewText = createLiveText('Create New');
  const badgeEl = new DomElement('SPAN');
  badgeEl.setAttribute('title', 'NEW');
  badgeEl.appendChild(newUpperText);
  badgeEl.appendChild(newLowerText);
  badgeEl.appendChild(createNewText);
  modelPanel.appendChild(badgeEl);
  body.appendChild(modelPanel);
  flushMutations();
  assert.strictEqual(newUpperText.nodeValue, '新');
  assert.strictEqual(newLowerText.nodeValue, '新');
  assert.strictEqual(badgeEl.getAttribute('title'), '新');
  // Create New first hits EXACT_DICT -> '新建', then upgrades on subsequent check -> '新' without looping
  assertNoOscillationAfterSyntheticMutations([newUpperText, newLowerText, createNewText, badgeEl]);
  assert.strictEqual(createNewText.nodeValue, '新');
  assertNoOscillationAfterSyntheticMutations([createNewText]);
  assert.strictEqual(createNewText.nodeValue, '新');

  // 4. Group-by "NONE" and Thinking "NONE" context sensitivity
  const groupNoneEl = new DomElement('DIV');
  groupNoneEl.setAttribute('data-testid', 'group-by-option-none');
  groupNoneEl.setAttribute('aria-label', 'NONE');
  const groupNoneText = createLiveText('NONE');
  groupNoneEl.appendChild(groupNoneText);
  const thinkingEl = new DomElement('DIV');
  thinkingEl.setAttribute('data-testid', 'thinking-level-select');
  thinkingEl.setAttribute('title', 'NONE');
  const thinkingNoneText = createLiveText('NONE');
  thinkingEl.appendChild(thinkingNoneText);
  body.appendChild(groupNoneEl);
  body.appendChild(thinkingEl);
  flushMutations();
  assert.strictEqual(groupNoneText.nodeValue, '不分组');
  assert.strictEqual(groupNoneEl.getAttribute('aria-label'), '不分组');
  assert.strictEqual(thinkingNoneText.nodeValue, '关闭思考');
  assert.strictEqual(thinkingEl.getAttribute('title'), '关闭思考');
  assertNoOscillationAfterSyntheticMutations([groupNoneText, groupNoneEl, thinkingNoneText, thinkingEl]);
  assert.strictEqual(groupNoneText.nodeValue, '不分组');
  assert.strictEqual(thinkingNoneText.nodeValue, '关闭思考');

  // 5. Split-node rules under live characterData MO ("Type ", " (still loading…)", "No ... yet")
  const typeWrap = new DomElement('SPAN');
  const typeText = createLiveText('Type ');
  const slashCode = new DomElement('CODE');
  slashCode.appendChild(createLiveText('/'));
  const typeTail = createLiveText(' and select plan');
  typeWrap.appendChild(typeText);
  typeWrap.appendChild(slashCode);
  typeWrap.appendChild(typeTail);

  const devExtWrap = new DomElement('SPAN');
  const devExtName = new DomElement('SPAN');
  devExtName.appendChild(createLiveText('ext-host'));
  const devLoadingWrap = new DomElement('SPAN');
  const devLoadingText = createLiveText(' (still loading\u2026)');
  devLoadingWrap.appendChild(devLoadingText);
  devExtWrap.appendChild(devExtName);
  devExtWrap.appendChild(devLoadingWrap);

  const customEmptyWrap = new DomElement('SPAN');
  const noPrefixText = createLiveText('No ');
  const midSkillsSpan = new DomElement('SPAN');
  midSkillsSpan.appendChild(createLiveText('skills'));
  const yetSuffixText = createLiveText(' yet');
  customEmptyWrap.appendChild(noPrefixText);
  customEmptyWrap.appendChild(midSkillsSpan);
  customEmptyWrap.appendChild(yetSuffixText);

  modalContainer.appendChild(typeWrap);
  modalContainer.appendChild(devExtWrap);
  modalContainer.appendChild(customEmptyWrap);
  flushMutations();
  assert.strictEqual(typeText.nodeValue, '输入 ');
  assert.strictEqual(devLoadingText.nodeValue, '（仍在加载...）');
  assert.strictEqual(noPrefixText.nodeValue, '暂无 ');
  assert.strictEqual(yetSuffixText.nodeValue, '');
  assertNoOscillationAfterSyntheticMutations([typeText, devLoadingText, noPrefixText, yetSuffixText]);
  sandbox.window.__antigravityTranslateAll();
  assert.strictEqual(typeText.nodeValue, '输入 ', 'Split Type node must stay 输入 , not loop to 类型 ');
  assert.strictEqual(devLoadingText.nodeValue, '（仍在加载...）', 'Developer split loading text must stay intact');
  assert.strictEqual(noPrefixText.nodeValue, '暂无 ', 'Customizations split No prefix must stay 暂无 , not 否 ');

  // 6. Nested Settings modal portal dedup (3 nested portal selectors -> visited once per schedulePortalTranslate)
  const appText = createLiveText('Appearance');
  const appHeading = new DomElement('H3');
  appHeading.appendChild(appText);
  modalContainer.appendChild(appHeading);
  flushMutations();
  assert.strictEqual(appText.nodeValue, '外观');

  let containerVisitCount = 0;
  const origModalHasAttr = modalContainer.hasAttribute;
  modalContainer.hasAttribute = function (k) {
    if (k === 'title') containerVisitCount += 1;
    return origModalHasAttr.call(this, k);
  };
  if (docListeners.focusin && docListeners.focusin[0]) {
    docListeners.focusin[0]({ target: triggerBtn });
  }
  flushMutations();
  assert.strictEqual(containerVisitCount, 1, 'Nested Settings portals must be visited once per translatePortals pass, not 3x');

  // 7. Zero redundant titlebar toggle setAttribute spam on repeated scans
  const titleBar = new DomElement('DIV');
  titleBar.setAttribute('data-testid', 'title-menu-bar');
  const titleMenuChild = new DomElement('DIV');
  const titleSpan = new DomElement('SPAN');
  titleSpan.appendChild(createLiveText('Help'));
  titleMenuChild.appendChild(titleSpan);
  titleBar.appendChild(titleMenuChild);
  rootDiv.appendChild(titleBar);
  flushMutations();

  const toggleBtn = titleBar.querySelector('[data-antigravity-i18n-titlebar-toggle="true"]');
  const thumbPill = toggleBtn.querySelector('[data-antigravity-i18n-pill-thumb="true"]');
  const zhPill = toggleBtn.querySelector('[data-antigravity-i18n-pill-zh="true"]');
  const enPill = toggleBtn.querySelector('[data-antigravity-i18n-pill-en="true"]');
  let titlebarAttrWrites = 0;
  for (const el of [toggleBtn, thumbPill, zhPill, enPill]) {
    const origSet = el.setAttribute;
    el.setAttribute = function (k, v) {
      titlebarAttrWrites += 1;
      return origSet.call(this, k, v);
    };
  }
  sandbox.window.__antigravityTranslateAll();
  assert.strictEqual(titlebarAttrWrites, 0, 'Repeated full scan must emit 0 setAttribute writes on already up-to-date titlebar toggle');

  // 8. Shell container (#root > div without >30 children) & Base UI data-open removal guards
  const appShell = new DomElement('DIV');
  appShell.id = 'app-shell';
  const shellProbe = new DomElement('SPAN');
  let shellProbeChecks = 0;
  const origShellHasAttr = shellProbe.hasAttribute;
  shellProbe.hasAttribute = function (k) {
    if (k === 'title') shellProbeChecks += 1;
    return origShellHasAttr.call(this, k);
  };
  shellProbe.appendChild(createLiveText('General'));
  appShell.appendChild(shellProbe);
  rootDiv.appendChild(appShell);
  appShell.setAttribute('aria-hidden', 'true');
  flushMutations();
  shellProbeChecks = 0;
  appShell.removeAttribute('aria-hidden');
  flushMutations();
  assert.strictEqual(shellProbeChecks, 0, 'Removing aria-hidden from #root direct non-portal shell child must not re-walk app shell');

  const closePopup = new DomElement('DIV');
  closePopup.className = 'agy-dialog';
  closePopup.setAttribute('data-open', 'true');
  const popupProbe = new DomElement('SPAN');
  let popupProbeChecks = 0;
  const origPopupHasAttr = popupProbe.hasAttribute;
  popupProbe.hasAttribute = function (k) {
    if (k === 'title') popupProbeChecks += 1;
    return origPopupHasAttr.call(this, k);
  };
  popupProbe.appendChild(createLiveText('Cancel'));
  closePopup.appendChild(popupProbe);
  body.appendChild(closePopup);
  flushMutations();
  popupProbeChecks = 0;
  closePopup.removeAttribute('data-open');
  flushMutations();
  assert.strictEqual(popupProbeChecks, 0, 'Removing data-open on dialog close must treat element as hidden and not re-walk subtree');

  // 9. Live MO + OTA hot-reload + [中 | EN] toggle preserves split nodes & converges
  const otaSettingsSpan = new DomElement('SPAN');
  const otaSettingsText = createLiveText('Settings');
  otaSettingsSpan.appendChild(otaSettingsText);
  rootDiv.appendChild(otaSettingsSpan);
  flushMutations();
  assert.strictEqual(otaSettingsText.nodeValue, '设置');

  assert.strictEqual(
    sandbox.window.__antigravityApplyOtaPack({
      schemaVersion: 1,
      packVersion: '2099.02.01.000001',
      builtAt: '2099-02-01T00:00:00.000Z',
      dictionary: {
        'Settings': '系统设置（热更测试）',
        'Type': '类型'
      },
      attrDict: {},
      preserveList: ['Antigravity'],
      rules: []
    }),
    true
  );
  assert(flushMutations() <= 2);
  assert.strictEqual(otaSettingsText.nodeValue, '系统设置（热更测试）');
  assert.strictEqual(typeText.nodeValue, '输入 ', 'Split node must remain protected across OTA hot-reload');

  toggleBtn._listeners.click[0]({ stopPropagation() {} });
  flushMutations();
  assert.strictEqual(otaSettingsText.nodeValue, 'Settings');
  assert.strictEqual(typeText.nodeValue, 'Type ');

  toggleBtn._listeners.click[0]({ stopPropagation() {} });
  flushMutations();
  assert.strictEqual(otaSettingsText.nodeValue, '系统设置（热更测试）');
  assert.strictEqual(typeText.nodeValue, '输入 ');

  // 10. English mode cachedTitleBarToggle skips unrelated subtree querySelector + appendChild skips duplicate MO walk
  toggleBtn._listeners.click[0]({ stopPropagation() {} });
  flushMutations();
  const enUnrelated = new DomElement('DIV');
  let enQueryCalls = 0;
  enUnrelated.querySelector = () => { enQueryCalls += 1; return null; };
  enUnrelated.appendChild(createLiveText('Unrelated panel'));
  rootDiv.appendChild(enUnrelated);
  flushMutations();
  assert.strictEqual(enQueryCalls, 0, 'English mode with mounted toggle must not scan unrelated subtrees for title-menu-bar');

  toggleBtn._listeners.click[0]({ stopPropagation() {} });
  flushMutations();
  const dedupNode = new DomElement('SPAN');
  let dedupAttrWalks = 0;
  const origDedupHasAttr = dedupNode.hasAttribute;
  dedupNode.hasAttribute = function (k) {
    if (k === 'title') dedupAttrWalks += 1;
    return origDedupHasAttr.call(this, k);
  };
  dedupNode.appendChild(createLiveText('Save'));
  rootDiv.appendChild(dedupNode);
  assert.strictEqual(dedupAttrWalks, 1, 'appendChild must translate inserted node once');
  flushMutations();
  assert.strictEqual(dedupAttrWalks, 1, 'Immediate childList MO must skip node already translated by appendChild');
}

module.exports = { runDomLifecycleVerification, runMutationConvergenceVerification };
