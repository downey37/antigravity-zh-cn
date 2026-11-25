/**
 * DOM 上下文保护与同词消歧匹配器。
 * 区分代码块/终端/文件名与真实 UI 控件，以及 "New"（新建 vs 新）和 "None"（不分组 vs 关闭思考 vs 无）等语境。
 */
function createContextRules() {
  const IGNORE_CLOSEST_SELECTOR = [
    'pre', 'code', 'kbd', 'samp', 'var', 'textarea', 'input', 'svg',
    '.monaco-editor', '.xterm', '.hljs', '.code-block', '.katex',
    '[data-code-block]', '[data-testid="user-message-content"]',
    '#raw', '[data-testid="file-tree-node-icon"]'
  ].join(', ');

  const MARKDOWN_INTERACTIVE_SELECTOR = [
    'button', '[role="button"]', '[role="menuitem"]',
    '[data-testid*="plugin"]', '[data-testid*="card"]', 'summary'
  ].join(', ');

  const AUTO_MT_WHITELIST_SELECTOR = [
    '[data-testid="nux-card"]',
    '[data-testid="jetbox-service-announcement-banner"]',
    '[data-testid="titlebar-service-announcement-slot"]',
    '[data-testid="terminal-tab-nux"]',
    '[data-testid="feature-banner"]',
    '[data-testid="onboarding-auth-code-error"]',
    '[data-testid="jetbox-access-blocked-screen"]',
    '[data-testid="persona-description"]',
    '[data-testid*="persona-option-"]',
    '[data-testid="plugin-suggested-prompt-row"]'
  ].join(', ');

  function isAutoMtEligibleContext(contextEl) {
    if (!contextEl || !contextEl.closest) return false;
    const isOnboardingShellText = Boolean(
      contextEl.closest('[data-testid="onboarding-brand-shell"]') &&
      contextEl.closest('p, [role="alert"], .text-xl, .text-error')
    );
    const isMarketplaceCardDesc = Boolean(
      contextEl.closest('[data-testid="customization-card"]') &&
      contextEl.closest('div.text-sm.text-muted-foreground')
    );
    const isMarketplaceShelfSubtitle = Boolean(
      contextEl.closest('[data-testid="customizations-marketplace"]') &&
      contextEl.closest('p.text-sm.text-muted-foreground')
    );
    const isPluginDetailDesc = Boolean(
      contextEl.closest('[data-testid="plugin-detail"]') &&
      contextEl.closest('p.text-sm.text-muted-foreground')
    );
    if (
      !contextEl.closest(AUTO_MT_WHITELIST_SELECTOR) &&
      !isOnboardingShellText &&
      !isMarketplaceCardDesc &&
      !isMarketplaceShelfSubtitle &&
      !isPluginDetailDesc
    ) {
      return false;
    }
    if (contextEl.closest('code, pre, kbd, samp, var, input, textarea, .font-mono, [data-testid="user-message-content"], [data-markdown-root]')) {
      return false;
    }
    return true;
  }

  function isFileTreeFilename(el) {
    if (!el || !el.closest) return false;
    const trunc = el.closest('.whitespace-nowrap.truncate');
    if (trunc && trunc.parentElement && trunc.parentElement.querySelector) {
      return Boolean(trunc.parentElement.querySelector('[data-testid="file-tree-node-icon"]'));
    }
    return false;
  }

  function isInsideTooltipOrHover(el) {
    if (!el || !el.closest) return false;
    const tip = el.closest('[role="tooltip"], .compact-tooltip, .tippy-box, .monaco-hover, [data-hover-card-popup]');
    if (!tip) return false;
    if (el.closest('pre, code')) return false;
    return true;
  }

  function isNewBadgeContext(contextEl) {
    if (!contextEl || !contextEl.closest) return false;
    if (contextEl.closest('[data-testid="sidecar-new-button"]')) return false;
    if (contextEl.closest('[data-testid="model-selector-panel"]')) return true;
    const pill = contextEl.closest('.bg-secondary.rounded-full, span.bg-secondary.rounded, div.bg-secondary.rounded');
    return Boolean(pill && !pill.matches('button, [role="button"]') && !pill.closest('button, [role="button"]'));
  }

  function isGroupByNoneContext(contextEl) {
    if (!contextEl || !contextEl.closest) return false;
    if (contextEl.closest('[data-testid="group-by-option-none"]')) return true;
    const itemRow = contextEl.closest('[role="menuitem"], [role="menuitemradio"], [data-radix-collection-item]');
    if (itemRow && itemRow.querySelector && itemRow.querySelector('[data-testid="group-by-submenu-trigger"]')) {
      return true;
    }
    const p1 = contextEl.parentElement;
    if (p1 && p1.querySelector && p1.querySelector('[data-testid="group-by-submenu-trigger"]')) {
      return true;
    }
    const p2 = p1 && p1.parentElement;
    if (p2 && p2.querySelector && p2.querySelector('[data-testid="group-by-submenu-trigger"]')) {
      return true;
    }
    return false;
  }

  function isThinkingNoneContext(contextEl) {
    if (!contextEl || !contextEl.closest) return false;
    if (contextEl.closest('[data-testid*="thinking"], [aria-label*="Thinking"], [aria-label*="思考深度"]')) {
      return true;
    }
    const listbox = contextEl.closest('[role="listbox"], [role="menu"], [role="radiogroup"]');
    if (listbox && /Thinking Level|思考深度/.test(listbox.textContent || '')) {
      return true;
    }
    return false;
  }

  const PERMISSION_PRESET_DESC_RE =
    /Every command requires approval|每条命令执行前都需要批准|Run all commands without restrictions|无限制直接运行所有命令|无限制地直接运行所有命令|Ask before sensitive operations|执行敏感操作前先询问|Automatically decide if commands run|由智能体自动判断命令是否可执行/;

  const PERMISSION_PRESET_LABEL_RE =
    /^(?:This Computer|此电脑|Remote|远程|Permission Preset|权限预设)$/i;

  const PERMISSION_PRESET_ARIA_DESC_RE =
    /Controls what the agent is allowed to do|控制智能体允许执行的操作范围|Controls the actions the agent can take|控制智能体可执行的操作|Controls permissions for remote conversations|控制远程会话的运行权限/i;

  function isPermissionPresetContext(contextEl) {
    if (!contextEl || !contextEl.closest) return false;

    if (
      contextEl.closest(
        '[data-testid="permissions-selector-trigger"], ' +
        '[data-testid*="permissions-preset-option-"], ' +
        '[data-testid="permissions-use-global-settings"]'
      )
    ) {
      return true;
    }

    const item = contextEl.closest('.agy-overlay-item, [role="option"], [role="menuitem"], [role="menuitemradio"]');
    if (item && PERMISSION_PRESET_DESC_RE.test(item.textContent || '')) {
      return true;
    }

    const trigger = contextEl.closest('.agy-select-trigger, button[aria-labelledby], button[aria-describedby]');
    if (trigger && typeof document !== 'undefined' && typeof document.getElementById === 'function') {
      const labelledBy = (trigger.getAttribute('aria-labelledby') || '').trim();
      if (labelledBy) {
        for (const id of labelledBy.split(/\s+/)) {
          const ref = id && document.getElementById(id);
          if (ref && PERMISSION_PRESET_LABEL_RE.test((ref.textContent || '').trim())) {
            return true;
          }
        }
      }
      const describedBy = (trigger.getAttribute('aria-describedby') || '').trim();
      if (describedBy) {
        for (const id of describedBy.split(/\s+/)) {
          const ref = id && document.getElementById(id);
          if (ref && PERMISSION_PRESET_ARIA_DESC_RE.test(ref.textContent || '')) {
            return true;
          }
        }
      }
    }

    return false;
  }

  function shouldIgnoreElement(el) {
    if (!el) return true;
    const tag = el.nodeName;
    if (
      tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ||
      tag === 'PRE' || tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'VAR' ||
      tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SVG'
    ) {
      return true;
    }
    if (el.isContentEditable) return true;
    if (el.closest && el.closest(IGNORE_CLOSEST_SELECTOR)) {
      if (isInsideTooltipOrHover(el)) return false;
      if (
        el.closest('button, [role="button"], [role="menuitem"]') &&
        !el.closest('pre, code, .monaco-editor .view-lines, .xterm')
      ) {
        return false;
      }
      return true;
    }
    if (isFileTreeFilename(el)) return true;
    return false;
  }

  function shouldIgnoreTextParent(parentEl) {
    if (!parentEl || shouldIgnoreElement(parentEl)) return true;
    if (parentEl.closest) {
      const mentionLabel = parentEl.closest('[data-testid="menu-option-label"]');
      if (mentionLabel && !mentionLabel.closest('[data-testid="menu-category-row"]')) {
        return true;
      }
      if (parentEl.closest('[data-testid="hover-card-title"]')) {
        return true;
      }
      const mdRoot = parentEl.closest('[data-markdown-root], .msg-body.md');
      if (mdRoot && !parentEl.closest(MARKDOWN_INTERACTIVE_SELECTOR)) {
        return true;
      }
    }
    return false;
  }

  function shouldIgnoreAttrElement(el) {
    if (!el) return true;
    const tag = el.nodeName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'PRE' || tag === 'CODE' || tag === 'SVG') {
      return true;
    }
    if (el.closest) {
      const ignored = el.closest('.monaco-editor, .xterm, .hljs, .code-block, .katex, [data-code-block], [data-testid="user-message-content"], #raw');
      if (ignored) {
        const isInteractiveOrTooltip = el.closest('button, [role="button"], [data-tooltip-id], [role="tooltip"], .compact-tooltip, .monaco-hover');
        if (!isInteractiveOrTooltip || el.closest('pre, code')) {
          return true;
        }
      }
      const mdRoot = el.closest('[data-markdown-root], .msg-body.md');
      if (mdRoot && !el.closest(MARKDOWN_INTERACTIVE_SELECTOR)) {
        return true;
      }
    }
    if (isFileTreeFilename(el)) return true;
    return false;
  }

  function isSwarmContext(contextEl) {
    if (typeof document !== 'undefined' && document.title === 'Swarm') return true;
    if (contextEl && contextEl.closest && contextEl.closest('.msg-header, .roster-item, .msg-to, .msg-from')) {
      return true;
    }
    return false;
  }

  function hasClass(el, cls) {
    if (!el) return false;
    if (el.classList && typeof el.classList.contains === 'function') {
      return el.classList.contains(cls);
    }
    const cn = typeof el.className === 'string' ? el.className : '';
    return cn.split(/\s+/).includes(cls);
  }

  function isExecutionElapsedContext(contextEl) {
    if (!contextEl || contextEl.nodeType !== 1) return false;
    if (contextEl.getAttribute && contextEl.getAttribute('data-testid') === 'tool-group-elapsed') {
      return true;
    }
    return Boolean(contextEl.closest && contextEl.closest('[data-testid="tool-group-elapsed"]'));
  }

  function isRuntimeStatusContext(contextEl) {
    if (!contextEl || !contextEl.closest) return false;
    return Boolean(
      contextEl.closest(
        '[data-testid="tool-group-collapsible"], ' +
        '[data-testid="ephemeral-tool-status"], ' +
        '[data-testid="agent-loading"], ' +
        '[data-testid="worked-for-collapsible"], ' +
        '[data-testid="live-status-row"], ' +
        '[data-testid="queued-messages-status"]'
      )
    );
  }

  function isRelativeTimestampContext(contextEl) {
    if (!contextEl || contextEl.nodeType !== 1) return false;
    if (isExecutionElapsedContext(contextEl)) return false;
    const tag = contextEl.nodeName;
    if (
      tag === 'SPAN' &&
      contextEl.getAttribute &&
      contextEl.getAttribute('data-screenshot-volatile') === 'true' &&
      hasClass(contextEl, 'tabular-nums') &&
      hasClass(contextEl, 'shrink-0')
    ) {
      return true;
    }
    if (
      tag === 'DIV' &&
      hasClass(contextEl, 'ml-auto') &&
      hasClass(contextEl, 'shrink-0') &&
      hasClass(contextEl, 'whitespace-nowrap') &&
      hasClass(contextEl, 'text-muted-foreground')
    ) {
      return true;
    }
    if (
      tag === 'SPAN' &&
      hasClass(contextEl, 'shrink-0') &&
      hasClass(contextEl, 'text-muted-foreground') &&
      (
        (hasClass(contextEl, 'min-w-4') && hasClass(contextEl, 'text-right')) ||
        (hasClass(contextEl, 'font-mono') && Boolean(contextEl.closest && contextEl.closest('[data-testid="plugin-sidecar-modal"]')))
      )
    ) {
      return true;
    }
    return false;
  }

  function isElapsedDurationContext(contextEl) {
    if (!contextEl || contextEl.nodeType !== 1 || contextEl.nodeName !== 'SPAN') return false;
    if (
      hasClass(contextEl, 'shrink-0') &&
      hasClass(contextEl, 'text-muted-foreground') &&
      Boolean(contextEl.closest && contextEl.closest('[data-testid="running-row"]'))
    ) {
      return true;
    }
    if (
      hasClass(contextEl, 'font-mono') &&
      hasClass(contextEl, 'text-foreground') &&
      contextEl.previousSibling &&
      /^(?:Uptime|运行时间)$/.test((contextEl.previousSibling.textContent || '').trim()) &&
      Boolean(contextEl.closest && contextEl.closest('[data-testid="plugin-sidecar-modal"]'))
    ) {
      return true;
    }
    return false;
  }

  function isModelEffortContext(contextEl) {
    if (!contextEl || !contextEl.closest) return false;
    if (contextEl.closest('[data-testid="model-selector-orchestrator-model"]')) {
      return true;
    }
    if (
      contextEl.closest('[data-testid="model-selector-trigger"]') &&
      contextEl.closest('.opacity-70')
    ) {
      return true;
    }
    return false;
  }

  function isModelLabelContext(contextEl) {
    if (!contextEl || !contextEl.closest) return false;
    if (contextEl.closest('[data-testid="model-selector-custom-item"]')) {
      return false;
    }
    return Boolean(
      contextEl.closest(
        '[data-testid="model-selector-item"], ' +
        '[data-testid="model-selector-panel"], ' +
        '[data-testid="model-selector-trigger"], ' +
        '[data-testid="orchestrator-picker-row"], ' +
        '[data-testid="orchestrator-model"], ' +
        '[data-testid="orchestrator-executor-model"], ' +
        '[data-testid="automation-model-value"], ' +
        '[data-testid="sidecar-model-select"], ' +
        '[data-testid="sidecar-model-option"], ' +
        '[data-testid="new-sidecar-model"], ' +
        '[data-testid="schedule-editor-model"], ' +
        '[data-testid="cloud-trigger-editor-model"], ' +
        '[data-model]'
      )
    );
  }

  function isAutomationScheduleContext(contextEl) {
    if (!contextEl || !contextEl.closest) return false;
    return Boolean(
      contextEl.closest(
        '[data-testid="automation-schedule-editor"], ' +
        '[data-testid="schedule-custom"], ' +
        '[data-testid="schedule-repeat"], ' +
        '[data-testid="schedule-repeat-option"], ' +
        '[data-testid="schedule-weekday"], ' +
        '[data-testid="schedule-weekday-option"], ' +
        '[data-testid="schedule-custom-unit"], ' +
        '[data-testid="schedule-custom-unit-option"], ' +
        '[data-testid="schedule-day-of-month"], ' +
        '[data-testid="schedule-day-of-month-option"], ' +
        '[data-testid="schedule-time"], ' +
        '[data-testid="schedule-time-option"]'
      )
    );
  }

  const AUTOMATION_WEEKDAY_SHORT_MAP = {
    monday: '一',
    '星期一': '一',
    tuesday: '二',
    '星期二': '二',
    wednesday: '三',
    '星期三': '三',
    thursday: '四',
    '星期四': '四',
    friday: '五',
    '星期五': '五',
    saturday: '六',
    '星期六': '六',
    sunday: '日',
    '星期日': '日'
  };

  function getAutomationWeekdayShortLabel(contextEl) {
    if (!contextEl || !contextEl.closest || !contextEl.closest('[data-testid="schedule-custom"]')) {
      return null;
    }
    const btn = contextEl.closest('button[aria-label], [aria-label]');
    const lbl = btn && typeof btn.getAttribute === 'function' ? (btn.getAttribute('aria-label') || '').trim() : '';
    if (!lbl) return null;
    return AUTOMATION_WEEKDAY_SHORT_MAP[lbl.toLowerCase()] || null;
  }

  function isAutomationListRowContext(contextEl) {
    if (!contextEl || !contextEl.closest) return false;
    return Boolean(contextEl.closest('[data-testid="sidecar-row"], [data-testid="cloud-trigger-row"]'));
  }

  function isAutomationEnvironmentContext(contextEl) {
    if (!contextEl || !contextEl.closest) return false;
    return Boolean(
      contextEl.closest(
        '[data-testid="new-sidecar-modal"], ' +
        '[data-testid="new-sidecar-cloud-environment"], ' +
        '[data-testid="cloud-trigger-editor-panel"], ' +
        '[data-testid="automation-detail-page"], ' +
        '[data-testid="sidecar-detail"]'
      )
    );
  }

  function isAutomationStandaloneContext(contextEl) {
    if (!contextEl || !contextEl.closest) return false;
    return Boolean(
      contextEl.closest(
        '[data-testid="new-sidecar-project"], ' +
        '[data-testid="new-sidecar-modal"], ' +
        '[data-select-popup]'
      )
    );
  }

  function isAutomationReadsContext(contextEl) {
    if (!contextEl || !contextEl.closest) return false;
    return Boolean(
      contextEl.closest(
        '[data-testid="automation-settings"], ' +
        '[data-testid="automation-instructions-reads"]'
      )
    );
  }

  function isAutomationDetailOrListContext(contextEl) {
    if (!contextEl || !contextEl.closest) return false;
    return Boolean(
      contextEl.closest(
        '[data-testid="sidecar-detail"], ' +
        '[data-testid="automation-detail-page"], ' +
        '[data-testid="sidecars-view"], ' +
        '[data-testid="sidecar-list"]'
      )
    );
  }

  function getSettingsPageSubtitleContainer(contextEl) {
    let cur = contextEl;
    while (cur && cur.nodeType === 1) {
      if (
        cur.nodeName === 'DIV' &&
        hasClass(cur, 'text-muted-foreground') &&
        hasClass(cur, 'bg-transparent')
      ) {
        let prev = cur.previousElementSibling;
        if (prev === undefined) {
          prev = cur.previousSibling;
          while (prev && prev.nodeType !== 1) prev = prev.previousSibling;
        }
        return prev && prev.nodeName === 'H2' ? cur : null;
      }
      cur = cur.parentElement || cur.parentNode;
    }
    return null;
  }

  return {
    isFileTreeFilename,
    isInsideTooltipOrHover,
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
    isExecutionElapsedContext,
    isRuntimeStatusContext,
    isModelEffortContext,
    isModelLabelContext,
    isAutomationScheduleContext,
    getAutomationWeekdayShortLabel,
    isAutomationListRowContext,
    isAutomationEnvironmentContext,
    isAutomationStandaloneContext,
    isAutomationReadsContext,
    isAutomationDetailOrListContext,
    getSettingsPageSubtitleContainer,
    isAutoMtEligibleContext
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createContextRules };
}
