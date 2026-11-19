const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const asar = require('@electron/asar');

const projectRoot = path.resolve(__dirname, '..');
const dictPath = path.join(projectRoot, 'assets', 'dictionary.json');
const defaultInstallDir = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'resources')
  : path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'antigravity', 'resources');
const installDir = process.env.ANTIGRAVITY_RESOURCES || defaultInstallDir;
const deployedAsar = process.env.ANTIGRAVITY_ASAR || path.join(installDir, 'app.asar');
const localOnly = process.argv.includes('--local');

function makeEl({ tag = 'SPAN', testid = null, cls = '', attrs = {}, parent = null, children = [], text = '' } = {}) {
  const mergedAttrs = { ...attrs };
  if (testid) mergedAttrs['data-testid'] = testid;
  const el = {
    nodeName: tag,
    nodeType: 1,
    className: cls,
    isContentEditable: false,
    _attrs: mergedAttrs,
    parentElement: parent,
    parentNode: parent,
    children,
    firstChild: children[0] || null,
    _text: text,
    get textContent() {
      if (this._text) return this._text;
      return this.children.map((c) => c.textContent || '').join('');
    },
    hasAttribute(k) { return k in this._attrs; },
    getAttribute(k) { return this._attrs[k]; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    matches(sel) {
      const classes = (this.className || '').split(/\s+/).filter(Boolean);
      return sel.split(',').some((raw) => {
        const s = raw.trim();
        if (!s) return false;
        if (s === this.nodeName.toLowerCase()) return true;
        if (s === '#raw') return this._attrs.id === 'raw';
        const exactAttr = s.match(/^\[([a-zA-Z0-9_-]+)="([^"]+)"\]$/);
        if (exactAttr) return this._attrs[exactAttr[1]] === exactAttr[2];
        const containsAttr = s.match(/^\[([a-zA-Z0-9_-]+)\*="([^"]+)"\]$/);
        if (containsAttr) return String(this._attrs[containsAttr[1]] || '').includes(containsAttr[2]);
        const hasAttr = s.match(/^\[([a-zA-Z0-9_-]+)\]$/);
        if (hasAttr) return hasAttr[1] in this._attrs;
        if (/^(?:[a-z]+\.)?(?:\.[a-zA-Z0-9_-]+)+$/.test(s)) {
          const parts = s.split('.');
          const tagPart = parts[0];
          if (tagPart && tagPart.toUpperCase() !== this.nodeName) return false;
          return parts.slice(1).every((c) => classes.includes(c));
        }
        return false;
      });
    },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (cur.matches && cur.matches(sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector(sel) {
      const wanted = sel.match(/\[data-testid="([^"]+)"\]/);
      if (!wanted) return null;
      const visit = (node) => {
        if (node._attrs && node._attrs['data-testid'] === wanted[1]) return node;
        for (const c of (node.children || [])) {
          const hit = visit(c);
          if (hit) return hit;
        }
        return null;
      };
      return visit(this);
    },
    querySelectorAll(sel) {
      const results = [];
      const visit = (node) => {
        if (node !== this && node.matches && node.matches(sel)) results.push(node);
        for (const c of (node.children || [])) visit(c);
      };
      visit(this);
      return results;
    }
  };
  for (let i = 0; i < children.length; i++) {
    children[i].parentElement = el;
    children[i].parentNode = el;
    children[i].previousSibling = i > 0 ? children[i - 1] : null;
    children[i].nextSibling = i + 1 < children.length ? children[i + 1] : null;
  }
  return el;
}

function makeTextNode(val, parent = null, prev = null, next = null) {
  return {
    nodeType: 3,
    nodeValue: val,
    get textContent() { return this.nodeValue; },
    parentElement: parent,
    parentNode: parent,
    previousSibling: prev,
    nextSibling: next
  };
}

function loadEngineInSandbox(i18nCode, protocol = 'app:', docTitle = 'Antigravity') {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    window: { location: { protocol } },
    location: { protocol },
    document: {
      title: docTitle,
      documentElement: null,
      body: null,
      createTreeWalker: () => ({ nextNode: () => null })
    },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (cb) => cb(),
  };
  sandbox.window.document = sandbox.document;

  const testWrapped = i18nCode.replace(
    "    if (document.readyState === 'loading')",
    "    globalThis.__i18nTest = { translateString, translateNode, translateElementAttrs, SPLIT_TEXT_TRANSLATOR, ATTR_DICT, EXACT_DICT, PRESERVE_SET, shouldIgnoreElement, shouldIgnoreTextParent, shouldIgnoreAttrElement, isSwarmContext };\n    return;\n    if (document.readyState === 'loading')"
  );
  vm.runInNewContext(testWrapped, sandbox);
  assert(sandbox.__i18nTest, 'Failed to extract i18n runtime API in VM');
  return sandbox.__i18nTest;
}

function runVerification() {
  let i18nCode;
  let pkgVersion = 'local';
  let asarEntriesCount = 0;

  if (localOnly) {
    const localI18n = path.join(projectRoot, 'build', 'i18n.js');
    assert(fs.existsSync(localI18n), `Missing local build/i18n.js at ${localI18n}`);
    i18nCode = fs.readFileSync(localI18n, 'utf8');
  } else {
    assert(fs.existsSync(deployedAsar), `Missing app.asar at ${deployedAsar}`);
    i18nCode = asar.extractFile(deployedAsar, path.join('dist', 'i18n.js')).toString('utf8');
    pkgVersion = JSON.parse(asar.extractFile(deployedAsar, 'package.json').toString('utf8')).version;
    asarEntriesCount = asar.listPackage(deployedAsar).length;

    // 校验主进程全部关键补丁是否成功落盘
    const updaterCode = asar.extractFile(deployedAsar, path.join('dist', 'updater.js')).toString('utf8');
    const ipcCode = asar.extractFile(deployedAsar, path.join('dist', 'ipcHandlers.js')).toString('utf8');
    const menuCode = asar.extractFile(deployedAsar, path.join('dist', 'menu.js')).toString('utf8');
    const utilsCode = asar.extractFile(deployedAsar, path.join('dist', 'utils.js')).toString('utf8');
    const secCode = asar.extractFile(deployedAsar, path.join('dist', 'webviewPopupSecurity.js')).toString('utf8');
    const wizardCode = asar.extractFile(deployedAsar, path.join('dist', 'ideInstall', 'wizardHtml.js')).toString('utf8');

    const expectedAutoPatch = path.join(__dirname, 'auto_patch_on_update.js');
    const updaterLower = updaterCode.toLowerCase();
    const expectedLower = expectedAutoPatch.toLowerCase();
    assert(
      updaterLower.includes(expectedLower) || updaterLower.includes(expectedLower.replace(/\\/g, '\\\\')),
      'updater.js must reference UI管理/scripts/auto_patch_on_update.js'
    );
    assert(updaterCode.includes('spawnAutoPatcherOnUpdate') && updaterCode.includes('preferredNode') && updaterCode.includes('--no-relaunch'), 'updater.js must include spawnAutoPatcherOnUpdate, preferredNode, and --no-relaunch');
    assert(ipcCode.includes('updater_1.quitAndInstall'), 'ipcHandlers.js updater:quit-and-install must delegate to updater_1.quitAndInstall');
    assert(ipcCode.includes('translateNativeNotificationText'), 'ipcHandlers.js must include translateNativeNotificationText');
    assert(ipcCode.includes('translateContextMenuLabel'), 'ipcHandlers.js must include translateContextMenuLabel');
    assert(asar.statFile(deployedAsar, path.join('dist', 'native_context_dict.json')), 'app.asar must include dist/native_context_dict.json');
    assert(menuCode.includes('translateMenuRecursively'), 'menu.js must include translateMenuRecursively');
    const getCodeIdx = utilsCode.indexOf('function _getAntigravityI18nCode');
    const createWinIdx = utilsCode.indexOf('function createWindow');
    assert(getCodeIdx !== -1 && createWinIdx !== -1 && getCodeIdx < createWinIdx && !utilsCode.includes('http://localhost:') && utilsCode.includes('frameOrigin === mainOrigin'), 'utils.js must define module-level _getAntigravityI18nCode cache and use exact frameOrigin matching');
    assert(secCode.includes('颁发给：') && secCode.includes('请勿在此网站上输入任何敏感信息'), 'webviewPopupSecurity.js must translate body and certificate fields');
    assert(wizardCode.includes('Antigravity 已全新重构'), 'wizardHtml.js must translate body paragraph');

    const extraMainAssertions = [
      ['dist/deviceChooser.js', '连接设备'],
      ['dist/webauthn.js', '选择通行密钥'],
      ['dist/cablev2.js', '使用手机或平板电脑'],
      ['dist/remote/disconnectedPage.js', '正在重新连接...'],
      ['dist/remote/signInCallback.js', '登录成功'],
      ['dist/remote/sshPrompts.js', '请触碰你的安全密钥'],
      ['dist/remote/sshErrorText.js', '错误代码：'],
      ['dist/remote/sshArgs.js', 'SSH 身份验证失败'],
      ['dist/remote/remoteManager.js', '选择 SSH 配置文件']
    ];
    for (const [rel, needle] of extraMainAssertions) {
      const code = asar.extractFile(deployedAsar, path.normalize(rel)).toString('utf8');
      new vm.Script(code, { filename: rel });
      assert(code.includes(needle), `${rel} must include localized text: ${needle}`);
    }
    for (const rel of ['dist/utils.js', 'dist/menu.js', 'dist/tray.js', 'dist/main.js', 'dist/updater.js', 'dist/provisionSplash.js', 'dist/ipcHandlers.js', 'dist/webviewPopupSecurity.js', 'dist/ideInstall/wizardHtml.js', 'dist/languageServer.js']) {
      new vm.Script(asar.extractFile(deployedAsar, path.normalize(rel)).toString('utf8'), { filename: rel });
    }
    assert(!fs.existsSync(path.join(projectRoot, 'build', 'app.asar.unpacked')), 'build/app.asar.unpacked should be cleaned after packaging');
  }

  new vm.Script(i18nCode);
  const api = loadEngineInSandbox(i18nCode);

  const dict = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
  assert.strictEqual(dict['None'], '无');

  // 1. Group By / Thinking / Coordinator None disambiguation + recovery from premature '无'
  const optNone = makeEl({ testid: 'group-by-option-none' });
  assert.strictEqual(api.translateString('None', optNone), '不分组');
  assert.strictEqual(api.translateString('关闭思考', optNone), '不分组');
  assert.strictEqual(api.translateString('无', optNone), '不分组');

  const triggerSpan = makeEl({ testid: 'group-by-submenu-trigger', text: 'Group By' });
  const badgeSpan = makeEl({ cls: 'ml-auto', text: 'None' });
  makeEl({ tag: 'DIV', children: [triggerSpan, badgeSpan] });
  assert.strictEqual(api.translateString('None', badgeSpan), '不分组');
  assert.strictEqual(api.translateString('无', badgeSpan), '不分组');

  const coordEl = makeEl({ tag: 'DIV' });
  const thinkingEl = makeEl({ testid: 'thinking-level-select' });
  assert.strictEqual(api.translateString('None', coordEl), '无');
  assert.strictEqual(api.translateString('无', coordEl), '无');
  assert.strictEqual(api.translateString('None', thinkingEl), '关闭思考');
  assert.strictEqual(api.translateString('无', thinkingEl), '关闭思考');

  // 2. Recent UI fixes + regressions + dynamic rule spacing/tightening
  const cases = [
    ['Add Resource', '添加资源'],
    ['Environment', '环境'],
    ['Display', '显示'],
    ['Auto Pin', '自动置顶'],
    ['Archived Only', '仅已归档'],
    ['Archived', '已归档'],
    ['Subtitles', '副标题'],
    ['Worktree', '工作树'],
    ['Decorations', '状态标记'],
    ['Add GitHub resources', '添加 GitHub 资源'],
    ['Connect your account to browse GitHub.', '连接你的账号以浏览 GitHub。'],
    ["A project's private resources must all belong to one owner (acme).", '同一项目中的私有资源必须全部归属于同一所有者 (acme)。'],
    ['Choose icon and color', '选择图标与颜色'],
    ['Icon', '图标'],
    ['Coordinator goal', '协调器目标'],
    ['Notice', '提示'],
    ['Outside of Project', '未在项目中'],
    ['Updated 12:11', '更新于 12:11'],
    ['Updated a minute ago', '更新于 1 分钟前'],
    ['Updated Nov 18, 2026', '更新于 2026年11月18日'],
    ['Updated the configuration file', 'Updated the configuration file'],
    ['(1,200 tokens)', '（1,200 个 Token）'],
    ['(1,200 tokens', '(1,200 tokens'],
    ['1,200 tokens)', '1,200 tokens)'],
    ['Plugin: ', '插件：'],
    ['Working directory: ', '工作目录：'],
    ['Agent: ', '智能体：'],
    ['Generation Steps (', '生成步骤 ('],
    ['Not referenced by any feature (', '未被任何功能引用 ('],
    ['Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash', '此分组包含的模型：Gemini 4 Hydrogen, Gemini 3.8 Flash'],
    ['Argon that may offload routine steps to Hydrogen. Same Argon-level quality, fewer tokens used.', 'Argon，可将常规步骤分流至 Hydrogen。同等 Argon 级质量，消耗更少 Token。'],
    ['GPT-OSS will be removed from Antigravity on November 18, 2026.', 'GPT-OSS 将于 2026年11月18日从 Antigravity 中移除。'],
    ['Gemini 4 Carbon is currently available to Ultra plan subscribers.', 'Gemini 4 Carbon 目前仅面向 Ultra 套餐订阅用户开放。'],
    ['New Project', '新建项目'],
    ['Name', '名称'],
    ['Color', '颜色'],
    ['Built In', '内置'],
    ['Marketplace', '插件市场'],
    ['by Google', '由 Google 提供'],
    ['Executed notebook', '已执行 Notebook'],
    ['Executing notebook cells', '正在执行 Notebook 单元格'],
    ['Failed to execute notebook cells', '执行 Notebook 单元格失败'],
    ['Failed to execute notebook', '执行 Notebook 失败'],
    ['Failed to load settings.', '加载设置失败'],
    ['Failed to delete your project.', '删除你的项目失败。'],
    ['Failed to delete "my-proj"', '删除“my-proj”失败'],
    ['Failed to delete project: EACCES', '删除项目失败：EACCES'],
    ['Failed to load shared conversation', '加载共享会话失败'],
    ['Failed to load bundle. Please try again.', '加载插件包失败，请重试。'],
    ['Failed to load diff contents.', '加载差异内容失败。'],
    ['Failed to load image', '加载图片失败'],
    ['Failed to load video', '加载视频失败'],
    ['Couldn\'t pin conversation', '无法置顶会话'],
    ['Failed to mark as unread conversation', '无法将会话标记为未读'],
    ['Failed to set permissions for conversation', '无法设置会话权限'],
    ['Remove from history', '从历史记录移除'],
    ['Close downloads', '关闭下载'],
    ['Close Sidebar', '收起侧边栏'],
    ['Copy image', '复制图片'],
    ['Copy Link', '复制链接'],
    ['Copy sign-in link', '复制登录链接'],
    ['Copy gh auth login command', '复制 gh auth login 命令'],
    ['Stop all agents', '停止所有智能体'],
    ['Stop recording', '停止录音'],
    ['Stop Recording', '停止语音输入'],
    ['Record Audio', '语音输入'],
    ['Stop Recording and Send', '停止语音并发送'],
    ['Stop execution', '停止执行'],
    ['Resume environment', '恢复环境'],
    ['Resume 1 comment draft', '恢复 1 条批注草稿'],
    ['Toggle file diff', '切换文件差异'],
    ['Toggle checkerboard background', '切换棋盘格背景'],
    ['Allow Next Non-Corp Prompt', '允许下次非企业密码输入'],
    ['Runs on this computer', '在本机上运行'],
    ['Creates a local automation that runs on this computer', '创建在本机上运行的本地自动化任务'],
    ['Allow running this command?', '是否允许运行此命令？'],
    ['Remove not supported on this list', 'Remove not supported on this list'],
    ['Allow Non-Flow Ports To Switch Sides', 'Allow Non-Flow Ports To Switch Sides'],
    ['command(issues mutate)', 'command(issues mutate)'],
    ['toString', 'toString'],
    ['valueOf', 'valueOf'],
    ['constructor', 'constructor'],
    ['hasOwnProperty', 'hasOwnProperty'],
    ['__proto__', '__proto__'],
    ['Version 2.32.2', '版本 2.32.2'],
    ['Version control is enabled', 'Version control is enabled'],
    ['Old files deleted', 'Old files deleted'],
    ['Project deleted', '项目已删除'],
    ['1 Draft', '1 份草稿'],
    ['FILES CHANGED', '已更改文件'],
    ['1 file changed', '1 个文件已更改'],
    ['3 active conversations and 2 archived conversations', '3 个活跃会话和 2 个已归档会话'],
    ['Settings', '设置'],
    ['Projects', '项目'],
    ['Browser', '浏览器'],
    ['Output', '输出'],
    ['Artifacts', '产物'],
    ['Sidecar', '后台服务'],
    ['Side Question', '临时提问'],
    ['Side Question: test', '临时提问：test'],
    ['Fork', '分支 (Fork)'],
    ['Forked from "Main"', '分支自“Main”'],
    ['Hooks', '钩子 (Hooks)'],
    ['Issues', '议题 (Issue)'],
    ['Pull Requests', '拉取请求 (PR)'],
    ['Amend', '修订提交 (Amend)'],
    ['MCP Server', 'MCP 服务'],
    ['Install IDE', '安装 IDE'],
    ['Disconnect GitHub', '断开与 GitHub 的连接'],
    ['Weekly on Monday at 9:00 AM', '每周一 9:00 AM'],
    ['The MCP server "demo" from plugin "ext" failed to start.', '插件“ext”中的 MCP 服务“demo”启动失败。'],
    ['Manage project resources, agent settings, and permissions.', '管理项目资源、智能体设置及权限。'],
    ['You have used some of your weekly limit, it will fully refresh in 5 days, 21 hours.', '你已使用部分每周配额，将在 5 天 21 小时后完全重置。'],
    ['You have used some of your 5-hour limit, it will fully refresh in 4 hours, 26 minutes.', '你已使用部分 5 小时配额，将在 4 小时 26 分钟后完全重置。'],
    ['You have hit your weekly limit, it refreshes in 4 days, 8 hours. If on a supported paid plan, you can use AI credits in the interim or upgrade to a higher tier.', '你已达到每周配额上限，将在 4 天 8 小时后重置。如果你使用的是受支持的付费套餐，在此期间可使用 AI 额度，或升级至更高级别套餐。'],
    ['You have hit your weekly limit, the 5-hour limit does not currently apply. Your weekly limit will fully refresh in 4 days, 8 hours.', '你已达到每周配额上限，当前不适用 5 小时配额限制。你的每周配额将在 4 天 8 小时后完全重置。'],
    ['You have hit your 5-hour limit, it refreshes in 2 hours, 15 minutes.', '你已达到 5 小时配额上限，将在 2 小时 15 分钟后重置。'],
    ['You have hit your weekly limit, it refreshes in less than a minute. If on a supported paid plan, you can use AI credits in the interim.', '你已达到每周配额上限，将在不到 1 分钟后重置。如果你使用的是受支持的付费套餐，在此期间可使用 AI 额度。'],
    ['If on a supported paid plan, you can use AI credits in the interim or upgrade to a higher tier.', '如果你使用的是受支持的付费套餐，在此期间可使用 AI 额度，或升级至更高级别套餐。'],
    ['Antigravity', 'Antigravity'],
    ['Google Drive', 'Google Drive'],
    ['just now', '刚刚'],
    ['Just now', '刚刚'],
    ['2mo ago', '2 个月前'],
    ['1w ago', '1 周前'],
    ['1y ago', '1 年前'],
    ['Updated 1y ago', '更新于 1 年前'],
    ['Running for 1h 20m', '已运行 1 小时 20 分钟'],
    ['Up 15m', '已运行 15 分钟'],
    ['Up to date', 'Up to date'],
    ['47m', '47m'],
    ['3h', '3h'],
    ['3d', '3d'],
    ['2mo', '2mo'],
    ['now', 'now']
  ];
  for (const [en, zh] of cases) {
    assert.strictEqual(api.translateString(en, coordEl), zh, `Mismatch for ${en}`);
  }

  // 2b. Context-isolated relative timestamps & elapsed durations
  const sidebarTitleEl = makeEl({ tag: 'SPAN', cls: 'truncate text-left w-full' });
  for (const sample of ['now', '47m', '3h', '3d', '2mo', '3mo', '1y']) {
    assert.strictEqual(api.translateString(sample, sidebarTitleEl), sample, `Title must stay untouched for ${sample}`);
  }

  const sidebarTimeEl = makeEl({
    tag: 'SPAN',
    cls: 'text-sm text-foreground opacity-60 min-w-4 shrink-0 text-right tabular-nums',
    attrs: { 'data-screenshot-volatile': 'true' }
  });
  for (const [en, zh] of [
    ['now', '刚刚'],
    ['10s', '10 秒前'],
    ['47m', '47 分钟前'],
    ['3h', '3 小时前'],
    ['3d', '3 天前'],
    ['2w', '2 周前'],
    ['2mo', '2 个月前'],
    ['3mo', '3 个月前'],
    ['1y', '1 年前'],
    ['47 分钟前', '47 分钟前'],
    ['刚刚', '刚刚'],
    ['3D', '3D']
  ]) {
    assert.strictEqual(api.translateString(en, sidebarTimeEl), zh, `Sidebar time mismatch for ${en}`);
  }

  const browserPillTimeEl = makeEl({
    tag: 'DIV',
    cls: 'ml-auto shrink-0 whitespace-nowrap text-sm text-muted-foreground'
  });
  assert.strictEqual(api.translateString('47m', browserPillTimeEl), '47 分钟前');

  const sidecarModal = makeEl({ testid: 'plugin-sidecar-modal' });
  const sidecarEventTimeEl = makeEl({
    tag: 'SPAN',
    cls: 'text-[10px] text-muted-foreground font-mono shrink-0',
    parent: sidecarModal
  });
  assert.strictEqual(api.translateString('3h', sidecarEventTimeEl), '3 小时前');

  const autoEventTimeEl = makeEl({
    tag: 'SPAN',
    cls: 'text-sm text-muted-foreground min-w-4 shrink-0 ml-4 text-right select-text'
  });
  assert.strictEqual(api.translateString('2mo', autoEventTimeEl), '2 个月前');

  const runningRow = makeEl({ testid: 'running-row' });
  const runningDurationEl = makeEl({
    tag: 'SPAN',
    cls: 'text-sm text-muted-foreground shrink-0',
    parent: runningRow
  });
  assert.strictEqual(api.translateString('5m', runningDurationEl), '5 分钟');
  assert.strictEqual(api.translateString('1h 23m', runningDurationEl), '1 小时 23 分钟');
  assert.strictEqual(api.translateString('2d 3h 15m', runningDurationEl), '2 天 3 小时 15 分钟');

  const uptimeLabel = makeEl({ tag: 'SPAN', cls: 'text-muted-foreground', text: '运行时间' });
  const uptimeValue = makeEl({ tag: 'SPAN', cls: 'font-mono text-foreground' });
  makeEl({ tag: 'DIV', parent: sidecarModal, children: [uptimeLabel, uptimeValue] });
  assert.strictEqual(api.translateString('47m', uptimeValue), '47 分钟');

  // 3. New pill vs + New button
  const modelPanel = makeEl({ testid: 'model-selector-panel' });
  const newPill = makeEl({ cls: 'bg-secondary rounded-full', parent: modelPanel });
  const sidecarNew = makeEl({ testid: 'sidecar-new-button' });
  assert.strictEqual(api.translateString('New', newPill), '新');
  assert.strictEqual(api.translateString('New', sidecarNew), '新建');

  // 3b. Home greeting carousel (named + unnamed)
  assert.strictEqual(api.translateString('Hey Downey, what should we build today?'), '嗨 Downey，今天想做点什么？');
  assert.strictEqual(api.translateString('Hey there, what should we build today?'), '你好，今天想做点什么？');
  assert.strictEqual(api.translateString('Welcome back, Downey. Where should we pick up?'), '欢迎回来，Downey。我们从哪里继续？');
  assert.strictEqual(api.translateString('Welcome back. Where should we pick up?'), '欢迎回来，我们从哪里继续？');
  assert.strictEqual(api.translateString("Good to see you, Downey. What's next?"), '很高兴见到你，Downey。接下来要做什么？');
  assert.strictEqual(api.translateString("Good to see you. What's next?"), '很高兴见到你，接下来要做什么？');

  // 3c. Permission preset bilingual parenthetical labels preserved ("Default" stays pure Chinese)
  const presetOpt = makeEl({
    tag: 'DIV',
    cls: 'agy-overlay-item',
    text: 'Request Review Every command requires approval.'
  });
  assert.strictEqual(api.translateString('Request Review', presetOpt), '请求审核 (Request Review)');
  assert.strictEqual(api.translateString('Turbo', presetOpt), '全自动 (Turbo)');
  assert.strictEqual(api.translateString('Default', presetOpt), '默认');
  assert.strictEqual(api.translateString('Auto', presetOpt), '自动 (Auto)');

  // 3d. v2.33.0 Keyboard Shortcuts & Keybinding Scheme translations
  assert.strictEqual(api.translateString('Keybinding Scheme'), '按键绑定方案');
  assert.strictEqual(api.translateString('VS Code Default'), 'VS Code 默认');
  assert.strictEqual(api.translateString('Antigravity (AGY) Style'), 'Antigravity (AGY) 风格');
  assert.strictEqual(api.translateString('Customize Shortcuts'), '自定义快捷键');
  assert.strictEqual(api.translateString('VS Code Keyboard Shortcuts'), 'VS Code 键盘快捷键');
  assert.strictEqual(api.translateString('Terminal: Select All'), '终端：全选');
  assert.strictEqual(api.translateString('Side Question Selection'), '对选中内容发起临时提问');
  assert.strictEqual(
    api.translateString('Inspect live bindings or record custom key chords filtered to'),
    '查看实时按键绑定或录制自定义组合键，已自动筛选'
  );

  // 4. Split text nodes (including out-of-order translation)
  const t1 = makeTextNode('Add ');
  const t2 = makeTextNode('GitHub');
  const t3 = makeTextNode(' resources');
  const spanAddRes = makeEl({ tag: 'SPAN', children: [t1, t2, t3] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(t3, ' resources', spanAddRes), ' 资源');
  t3.nodeValue = ' 资源';
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(t1, 'Add ', spanAddRes), '添加 ');

  const o1 = makeTextNode('Open ');
  const o2 = makeTextNode('Gmail');
  const o3 = makeTextNode(' 面板');
  const spanOpenPanel = makeEl({ tag: 'SPAN', children: [o1, o2, o3] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(o1, 'Open ', spanOpenPanel), '打开 ');

  const d1 = makeTextNode('2');
  const d2 = makeTextNode(' insertion');
  const d3 = makeTextNode('s');
  const spanDiff = makeEl({ tag: 'SPAN', children: [d1, d2, d3] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(d3, 's', spanDiff), '');

  const bw1 = makeTextNode('There are currently no Build with ');
  const bw2 = makeTextNode('Google');
  const bw3 = makeTextNode(' plugins available.');
  const divBw = makeEl({ tag: 'DIV', children: [bw1, bw2, bw3] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(bw1, 'There are currently no Build with ', divBw), '当前暂无“Build with ');
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(bw3, ' plugins available.', divBw), '”相关可用插件。');

  const ah1 = makeTextNode('(');
  const ah2 = makeTextNode('12');
  const ah3 = makeTextNode(' ');
  const ah4 = makeTextNode('lines');
  const ah5 = makeTextNode(' above hidden)');
  const divAh = makeEl({ tag: 'DIV', children: [ah1, ah2, ah3, ah4, ah5] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(ah4, 'lines', divAh), '行');
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(ah5, ' above hidden)', divAh), '，上方已隐藏)');

  const docLink = makeEl({ tag: 'A', text: '文档指南' });
  const docPeriod = makeTextNode('.');
  const spanDoc = makeEl({ tag: 'SPAN', children: [makeTextNode('请阅读'), docLink, docPeriod] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(docPeriod, '.', spanDoc), '。');

  // 5. DOM translateNode + ATTR_DICT + context ignore guards
  const inputEl = makeEl({ tag: 'INPUT', attrs: { placeholder: 'Search conversations...', 'aria-label': 'Antigravity' } });
  api.translateNode(inputEl);
  assert.strictEqual(inputEl.getAttribute('placeholder'), '搜索会话...');
  assert.strictEqual(inputEl.getAttribute('aria-label'), 'Antigravity');

  const preCodeText = makeTextNode('New Project');
  const preEl = makeEl({ tag: 'PRE', children: [preCodeText] });
  api.translateNode(preEl);
  assert.strictEqual(preCodeText.nodeValue, 'New Project');

  const mdPlainText = makeTextNode('Settings');
  const mdBtnText = makeTextNode('Copy');
  const mdBtn = makeEl({ tag: 'BUTTON', children: [mdBtnText] });
  const mdRoot = makeEl({ tag: 'DIV', attrs: { 'data-markdown-root': 'true' }, children: [mdPlainText, mdBtn] });
  api.translateNode(mdRoot);
  assert.strictEqual(mdPlainText.nodeValue, 'Settings');
  assert.strictEqual(mdBtnText.nodeValue, '复制');

  const fileIcon = makeEl({ tag: 'SPAN', testid: 'file-tree-node-icon' });
  const fileNameText = makeTextNode('Settings');
  const fileSpan = makeEl({ tag: 'SPAN', cls: 'whitespace-nowrap truncate', children: [fileNameText] });
  makeEl({ tag: 'DIV', children: [fileIcon, fileSpan] });
  api.translateNode(fileSpan);
  assert.strictEqual(fileNameText.nodeValue, 'Settings');

  // 6. Swarm context isolation: plugin:// protocol alone must NOT trigger To/From rewrite
  const pluginApi = loadEngineInSandbox(i18nCode, 'plugin:', 'Other Extension');
  assert.strictEqual(pluginApi.translateString('To continue, sign in', makeEl({ tag: 'DIV' })), 'To continue, sign in');
  const swarmApi = loadEngineInSandbox(i18nCode, 'plugin:', 'Swarm');
  assert.strictEqual(swarmApi.translateString('To worker-1', makeEl({ tag: 'DIV' })), '发送给 worker-1');

  // 7. Prototype safety on attributes, preset themes kept in English, & full-dictionary idempotency
  const protoEl = makeEl({ tag: 'BUTTON', attrs: { title: 'toString', 'aria-label': 'constructor' } });
  api.translateNode(protoEl);
  assert.strictEqual(protoEl.getAttribute('title'), 'toString');
  assert.strictEqual(protoEl.getAttribute('aria-label'), 'constructor');

  for (const themeName of ['Catppuccin', 'One Light', 'Solarized Light', 'Dracula', 'Monokai', 'One Dark Pro', 'Tokyo Night', 'Solarized Dark']) {
    assert.strictEqual(api.translateString(themeName, coordEl), themeName, `Preset theme should stay English: ${themeName}`);
  }
  for (const [k, v] of Object.entries(api.EXACT_DICT)) {
    assert.strictEqual(api.translateString(v, coordEl), v, `EXACT_DICT not idempotent for ${k} => ${v}`);
  }
  for (const [k, v] of Object.entries(api.ATTR_DICT)) {
    assert.strictEqual(api.translateString(v, coordEl), v, `ATTR_DICT not idempotent for ${k} => ${v}`);
  }

  // 8. Full DOM lifecycle hooks & hot-path guards (running unmodified i18nCode without early return)
  runDomLifecycleVerification(i18nCode);

  console.log(`ALL VERIFY CHECKS PASSED! version=v${pkgVersion}, EXACT_DICT=${Object.keys(api.EXACT_DICT).length}, ATTR_DICT=${Object.keys(api.ATTR_DICT).length}, asarEntries=${asarEntriesCount}`);
}

function runDomLifecycleVerification(i18nCode) {
  function DomNode(nodeType, tag) {
    this.nodeType = nodeType;
    this.nodeName = tag || '';
    this.parentElement = null;
    this.parentNode = null;
    this.childNodes = [];
    this.isConnected = false;
    this._attrs = {};
    this.className = '';
    this.id = '';
    this.isContentEditable = false;
  }
  Object.defineProperty(DomNode.prototype, 'children', {
    get() { return this.childNodes.filter((c) => c.nodeType === 1); }
  });
  Object.defineProperty(DomNode.prototype, 'childElementCount', {
    get() { return this.children.length; }
  });
  Object.defineProperty(DomNode.prototype, 'firstChild', {
    get() { return this.childNodes[0] || null; }
  });
  Object.defineProperty(DomNode.prototype, 'nextSibling', {
    get() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx >= 0 && idx + 1 < this.parentNode.childNodes.length ? this.parentNode.childNodes[idx + 1] : null;
    }
  });
  Object.defineProperty(DomNode.prototype, 'previousSibling', {
    get() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx > 0 ? this.parentNode.childNodes[idx - 1] : null;
    }
  });
  Object.defineProperty(DomNode.prototype, 'textContent', {
    get() {
      if (this.nodeType === 3) return this.nodeValue || '';
      return this.childNodes.map((c) => c.textContent).join('');
    }
  });
  DomNode.prototype.hasAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); };
  DomNode.prototype.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; };
  DomNode.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
  DomNode.prototype.matches = function (sel) {
    return sel.split(',').some((raw) => {
      const s = raw.trim();
      if (!s) return false;
      if (s === this.nodeName.toLowerCase()) return true;
      const exact = s.match(/^\[([a-zA-Z0-9_-]+)="([^"]+)"\]$/);
      if (exact) return this._attrs[exact[1]] === exact[2];
      return false;
    });
  };
  DomNode.prototype.closest = function (sel) {
    let cur = this;
    while (cur) {
      if (cur.nodeType === 1 && cur.matches(sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  };
  DomNode.prototype.querySelector = () => null;
  DomNode.prototype.querySelectorAll = () => [];
  DomNode.prototype.appendChild = function (child) {
    if (child.nodeType === 11) {
      const moved = [...child.childNodes];
      child.childNodes.length = 0;
      for (const c of moved) this.appendChild(c);
      return child;
    }
    child.parentNode = this;
    child.parentElement = this.nodeType === 1 ? this : null;
    const propagateConn = (n, val) => {
      n.isConnected = val;
      for (const c of n.childNodes) propagateConn(c, val);
    };
    propagateConn(child, this.isConnected);
    this.childNodes.push(child);
    return child;
  };
  DomNode.prototype.insertBefore = function (newNode, refNode) {
    if (!refNode) return this.appendChild(newNode);
    const idx = this.childNodes.indexOf(refNode);
    newNode.parentNode = this;
    newNode.parentElement = this.nodeType === 1 ? this : null;
    const propagateConn = (n, val) => {
      n.isConnected = val;
      for (const c of n.childNodes) propagateConn(c, val);
    };
    propagateConn(newNode, this.isConnected);
    this.childNodes.splice(idx >= 0 ? idx : this.childNodes.length, 0, newNode);
    return newNode;
  };

  function DomElement(tag) { DomNode.call(this, 1, tag); }
  DomElement.prototype = Object.create(DomNode.prototype);
  DomElement.prototype.append = function (...items) {
    for (const item of items) {
      if (typeof item === 'string') {
        const tn = new DomNode(3);
        tn.nodeValue = item;
        this.appendChild(tn);
      } else {
        this.appendChild(item);
      }
    }
  };
  DomElement.prototype.prepend = DomElement.prototype.append;
  DomElement.prototype.replaceChildren = function (...items) {
    this.childNodes.length = 0;
    this.append(...items);
  };
  DomElement.prototype.attachShadow = function () {
    const sr = new DomNode(11);
    sr.isConnected = this.isConnected;
    this.shadowRoot = sr;
    return sr;
  };

  const makeText = (val) => {
    const tn = new DomNode(3);
    tn.nodeValue = val;
    return tn;
  };

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
  const sandbox = {
    console, setTimeout, clearTimeout,
    Node: DomNode,
    Element: DomElement,
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    MutationObserver: class {
      constructor(cb) { observerCb = cb; }
      observe(target) { observedTargets.push(target); }
    },
    requestAnimationFrame: (cb) => { cb(); return 1; },
    window: { location: { protocol: 'app:' }, history: {}, addEventListener() {} },
    location: { protocol: 'app:' },
    document: {
      readyState: 'complete',
      title: 'Antigravity',
      documentElement: html,
      body,
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
}

runVerification();
