const vm = require('vm');
const assert = require('assert');
const { createMockDomEnv } = require('./mock_dom');


function createMockLexicalController(initialMention, initialText, initialOptions = {}) {
  let stateText = initialText;
  let mentionCommand = initialMention.command;
  let mentionExportValue = initialMention.exportValue !== undefined ? initialMention.exportValue : initialMention.command;
  let mentionRawText = initialMention.rawText !== undefined
    ? initialMention.rawText
    : `[/${mentionCommand}](slashCommand;${mentionCommand})`;
  const textKey = 'text-1';
  const selection = {
    anchor: { key: textKey, offset: initialText.length, type: 'text' },
    focus: { key: textKey, offset: initialText.length, type: 'text' }
  };
  const listeners = new Set();
  const updateLog = [];
  let inReadOrUpdate = false;

  const makeNodes = () => {
    const mentionNode = {
      getType: () => 'contextScopeItemMention',
      getTextContent: () => {
        if (!inReadOrUpdate) throw new Error('Must be called inside read/update');
        return mentionRawText;
      },
      exportJSON: () => ({ trigger: '/', value: mentionExportValue, type: 'contextScopeItemMention', version: 1 })
    };
    const textNode = {
      __key: textKey,
      getKey: () => textKey,
      getType: () => 'text',
      getTextContent: () => {
        if (!inReadOrUpdate) throw new Error('Must be called inside read/update');
        return stateText;
      },
      setTextContent: (next) => {
        stateText = next;
        return textNode;
      },
      select: (anchorOffset, focusOffset) => {
        selection.anchor = { key: textKey, offset: anchorOffset, type: 'text' };
        selection.focus = { key: textKey, offset: focusOffset, type: 'text' };
        return selection;
      }
    };
    const paraNode = {
      getType: () => 'paragraph',
      getChildren: () => [mentionNode, textNode]
    };
    const rootNode = {
      getType: () => 'root',
      getChildren: () => [paraNode]
    };
    return {
      _nodeMap: new Map([['root', rootNode]]),
      _selection: selection,
      read: (fn) => {
        const prev = inReadOrUpdate;
        inReadOrUpdate = true;
        try { return fn(); } finally { inReadOrUpdate = prev; }
      }
    };
  };

  let currentState = makeNodes();
  const editor = {
    _pendingEditorState: null,
    isEditable: () => initialOptions.editable !== false,
    isComposing: () => initialOptions.composing === true,
    getEditorState: () => currentState,
    registerUpdateListener: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update: (fn, opts) => {
      const tags = opts && opts.tag ? (Array.isArray(opts.tag) ? opts.tag : [opts.tag]) : [];
      updateLog.push({ tags, discrete: Boolean(opts && opts.discrete), before: stateText });
      const prev = inReadOrUpdate;
      inReadOrUpdate = true;
      editor._pendingEditorState = currentState;
      try {
        fn();
      } finally {
        editor._pendingEditorState = null;
        inReadOrUpdate = prev;
      }
      currentState = makeNodes();
      const payload = { editorState: currentState, tags: new Set(tags) };
      listeners.forEach((fnListener) => fnListener(payload));
    }
  };

  return {
    editor,
    getText: () => stateText,
    setRawContent: (nextCmd, nextText, nextOpts = {}) => {
      mentionCommand = nextCmd;
      mentionExportValue = nextOpts.exportValue !== undefined ? nextOpts.exportValue : nextCmd;
      mentionRawText = nextOpts.rawText !== undefined
        ? nextOpts.rawText
        : `[/${nextCmd}](slashCommand;${nextCmd})`;
      stateText = nextText;
      selection.anchor = { key: textKey, offset: nextText.length, type: 'text' };
      selection.focus = { key: textKey, offset: nextText.length, type: 'text' };
      currentState = makeNodes();
      listeners.forEach((fnListener) => fnListener({ editorState: currentState, tags: new Set() }));
    },
    getSelection: () => selection,
    getUpdateCount: () => updateLog.length,
    getUpdateLog: () => updateLog
  };
}

async function runLexicalPromptVerification(i18nCode) {


  const setupSandbox = (initialEnabled = true) => {
    const { DomNode, DomElement, makeText } = createMockDomEnv();
    const html = new DomElement('HTML');
    html.isConnected = true;
    const body = new DomElement('BODY');
    html.appendChild(body);
    const rootDiv = new DomElement('DIV');
    rootDiv.id = 'root';
    body.appendChild(rootDiv);
    const activeObservers = [];
    let setTimeoutCount = 0;
    const countedSetTimeout = (fn, ms, ...rest) => {
      setTimeoutCount += 1;
      return setTimeout(fn, ms, ...rest);
    };
    const sandbox = {
      console, setTimeout: countedSetTimeout, clearTimeout, queueMicrotask,
      Node: DomNode,
      Element: DomElement,
      NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
      MutationObserver: class {
        constructor(cb) { this.cb = cb; activeObservers.push(this); }
        observe() {}
      },
      requestAnimationFrame: (cb) => { cb(); return 1; },
      window: {
        __ANTIGRAVITY_I18N_INITIAL_ENABLED__: initialEnabled,
        location: { protocol: 'app:' },
        history: {},
        addEventListener() {}
      },
      location: { protocol: 'app:' },
      document: {
        readyState: 'complete',
        title: 'Antigravity',
        documentElement: html,
        body,
        createElement: (tag) => new DomElement(String(tag).toUpperCase()),
        createTextNode: (val) => makeText(val),
        querySelectorAll: () => [],
        addEventListener: () => {}
      }
    };
    sandbox.window.document = sandbox.document;
    vm.runInNewContext(i18nCode, sandbox);
    return { DomElement, makeText, rootDiv, sandbox, activeObservers, getTimerCount: () => setTimeoutCount };
  };

  // 1. ZH mode mount / "Create with Prompt" translates both chip (including <svg> icon) and Lexical TextNode without timer/microtask loops
  {
    const { DomElement, makeText, rootDiv, sandbox, getTimerCount } = setupSandbox(true);
    const lexEl = new DomElement('DIV');
    lexEl.setAttribute('data-lexical-editor', 'true');
    lexEl.isContentEditable = true;
    const ctrl = createMockLexicalController(
      { command: 'automation' },
      ' Guide me through creating an automated task'
    );
    lexEl.__lexicalEditor = ctrl.editor;

    const p = new DomElement('P');
    p.isContentEditable = true;
    const chip = new DomElement('SPAN');
    chip.setAttribute('contenteditable', 'false');
    const chipSvg = new DomElement('SVG');
    const chipSvgPath = new DomElement('PATH');
    chipSvg.appendChild(chipSvgPath);
    const chipInner = new DomElement('SPAN');
    const chipText = makeText('automation');
    chipInner.appendChild(chipText);
    chip.appendChild(chipSvg);
    chip.appendChild(chipInner);
    const promptDomSpan = new DomElement('SPAN');
    promptDomSpan.isContentEditable = true;
    const promptDomText = makeText(' Guide me through creating an automated task');
    promptDomSpan.appendChild(promptDomText);
    p.appendChild(chip);
    p.appendChild(promptDomSpan);
    lexEl.appendChild(p);
    rootDiv.appendChild(lexEl);

    assert.strictEqual(chipText.nodeValue, '自动化任务', 'Automation slashCommand chip must translate to 自动化任务');
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.strictEqual(ctrl.getText(), ' 引导我创建一个自动化任务', 'Lexical TextNode must translate via deferred editor.update');
    assert.strictEqual(promptDomText.nodeValue, ' Guide me through creating an automated task', 'Engine must not directly mutate contentEditable DOM text');
    assert.strictEqual(ctrl.getSelection().anchor.offset, 13, 'Selection offset must adjust to new end of translated text');
    assert.strictEqual(ctrl.getUpdateCount(), 1, 'Sync must happen in a single history-merge update');
    assert(ctrl.getUpdateLog()[0].tags.includes('history-merge'));
    assert(ctrl.getUpdateLog()[0].tags.includes('antigravity-i18n-preset'));
    assert.strictEqual(ctrl.getUpdateLog()[0].discrete, true);

    const settledTimers = getTimerCount();
    assert(settledTimers <= 5, `Timer scheduling must stay bounded during mount/sync, got ${settledTimers}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(ctrl.getUpdateCount(), 1, 'Async updateListener scheduling must not trigger a second update loop');
    assert.strictEqual(getTimerCount(), settledTimers, 'SVG inside [contenteditable="false"] chip must not cause runaway timer rescheduling');

    // 2. EN <-> ZH toggle round-trip (must also remain free of runaway timers with SVG chip)
    sandbox.window.__antigravitySetI18nEnabled(false);
    assert.strictEqual(chipText.nodeValue, 'automation', 'Disabling i18n must restore chip text to automation');
    assert.strictEqual(ctrl.getText(), ' Guide me through creating an automated task', 'Disabling i18n must revert Lexical TextNode to English');
    assert.strictEqual(ctrl.getSelection().anchor.offset, 44, 'Selection offset must restore to English end offset');
    assert.strictEqual(ctrl.getUpdateCount(), 2);

    sandbox.window.__antigravitySetI18nEnabled(true);
    assert.strictEqual(chipText.nodeValue, '自动化任务', 'Re-enabling i18n must re-translate chip text to 自动化任务');
    assert.strictEqual(ctrl.getText(), ' 引导我创建一个自动化任务', 'Re-enabling i18n must re-translate Lexical TextNode to Chinese');
    assert.strictEqual(ctrl.getSelection().anchor.offset, 13);
    assert.strictEqual(ctrl.getUpdateCount(), 3);
    const afterToggleTimers = getTimerCount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(getTimerCount(), afterToggleTimers, 'Toggling [中 | EN] with SVG chip must not schedule runaway timers');

    // 3. Draft deserialization compatibility (exportJSON().value === "contextScopeItemMention", getTextContent() has slashCommand;automation)
    ctrl.setRawContent('automation', ' Guide me through creating an automated task', {
      exportValue: 'contextScopeItemMention',
      rawText: '[/automation](slashCommand;automation)'
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.strictEqual(ctrl.getText(), ' 引导我创建一个自动化任务', 'Deserialized mention node must match via getTextContent()');

    // 4. Other built-in slash command preset prompts (plugin & migrate-workflows)
    ctrl.setRawContent('plugin', ' Create a plugin that ...', { rawText: '[plugin](slashCommand;plugin)' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.strictEqual(ctrl.getText(), ' 创建一个插件，功能是...');

    ctrl.setRawContent('migrate-workflows', ' migrate my existing workflows to skills', {
      rawText: '[/migrate-workflows](slashCommand;migrate-workflows)'
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.strictEqual(ctrl.getText(), ' 将我现有的工作流迁移为技能');

    // 5. User-edited text guard (must never overwrite customized prompts)
    const customEn = ' Guide me through creating an automated task for Gmail';
    ctrl.setRawContent('automation', customEn);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.strictEqual(ctrl.getText(), customEn, 'Customized English prompt must never be overwritten');
    sandbox.window.__antigravitySetI18nEnabled(false);
    assert.strictEqual(ctrl.getText(), customEn);
    sandbox.window.__antigravitySetI18nEnabled(true);
    assert.strictEqual(ctrl.getText(), customEn);

    const customZh = ' 每天早上帮我整理邮件';
    ctrl.setRawContent('automation', customZh);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.strictEqual(ctrl.getText(), customZh, 'Customized Chinese prompt must never be overwritten');
    sandbox.window.__antigravitySetI18nEnabled(false);
    assert.strictEqual(ctrl.getText(), customZh, 'Toggling to English must preserve user-edited Chinese text');
  }

  // 6. EN mode "Create with Prompt": stays English with zero editor.update calls, then translates when switched to ZH
  {
    const { DomElement, makeText, rootDiv, sandbox, activeObservers } = setupSandbox(false);
    const lexEl = new DomElement('DIV');
    lexEl.setAttribute('data-lexical-editor', 'true');
    lexEl.isContentEditable = true;
    const ctrl = createMockLexicalController({ command: 'automation' }, '');
    lexEl.__lexicalEditor = ctrl.editor;
    rootDiv.appendChild(lexEl);

    const p = new DomElement('P');
    p.isContentEditable = true;
    const chip = new DomElement('SPAN');
    chip.setAttribute('contenteditable', 'false');
    const chipText = makeText('automation');
    chip.appendChild(chipText);
    p.appendChild(chip);
    lexEl.appendChild(p);
    ctrl.setRawContent('automation', ' Guide me through creating an automated task');
    if (activeObservers[0]) {
      activeObservers[0].cb([{ type: 'childList', addedNodes: [p] }]);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));

    assert.strictEqual(chipText.nodeValue, 'automation', 'English mode must keep chip in English');
    assert.strictEqual(ctrl.getText(), ' Guide me through creating an automated task', 'English mode must keep prompt in English');
    assert.strictEqual(ctrl.getUpdateCount(), 0, 'English mode must invoke zero editor.update calls');

    sandbox.window.__antigravitySetI18nEnabled(true);
    assert.strictEqual(chipText.nodeValue, '自动化任务', 'Switching EN -> ZH must translate existing chip');
    assert.strictEqual(ctrl.getText(), ' 引导我创建一个自动化任务', 'Switching EN -> ZH must translate existing untouched prompt');
    assert.strictEqual(ctrl.getUpdateCount(), 1);
  }
}

module.exports = { createMockLexicalController, runLexicalPromptVerification };
