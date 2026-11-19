/**
 * DOM 上下文保护与同词消歧匹配器。
 * 区分代码块/终端/文件名与真实 UI 控件，以及 "New"（新建 vs 新上线）和 "None"（不分组 vs 关闭思考 vs 无）等语境。
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

  function isRelativeTimestampContext(contextEl) {
    if (!contextEl || contextEl.nodeType !== 1) return false;
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

  return {
    isFileTreeFilename,
    isInsideTooltipOrHover,
    isNewBadgeContext,
    isGroupByNoneContext,
    isThinkingNoneContext,
    shouldIgnoreElement,
    shouldIgnoreTextParent,
    shouldIgnoreAttrElement,
    isSwarmContext,
    isRelativeTimestampContext,
    isElapsedDurationContext
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createContextRules };
}
