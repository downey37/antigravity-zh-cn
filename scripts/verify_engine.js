process.noAsar = true;

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const asar = require('@electron/asar');
const { verifyVersionConsistency } = require('./release_version');
const { resolveInstallPaths } = require('./runtime_paths');

const projectRoot = path.resolve(__dirname, '..');
const dictPath = path.join(projectRoot, 'assets', 'dictionary.json');
const resolvedPaths = resolveInstallPaths();
const installDir = resolvedPaths.installDir;
const deployedAsar = process.env.ANTIGRAVITY_ASAR || resolvedPaths.asarPath;
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
    assert(ipcCode.includes('getNativeContextDict'), 'ipcHandlers.js must integrate OTA getNativeContextDict');
    assert(ipcCode.includes('i18n-ota:check-updates'), 'ipcHandlers.js must register i18n-ota:check-updates IPC handler');
    assert(ipcCode.includes("ipcMain.handle('i18n-ota:toggle-language'") && ipcCode.includes("ipcMain.handle('i18n-ota:get-language-enabled'"), 'ipcHandlers.js must register language toggle IPC handlers via ipcMain.handle');
    assert(ipcCode.includes("ipcMain.handle('i18n-ota:translate-dynamic'") && ipcCode.includes("ipcMain.handle('i18n-ota:get-auto-mt-enabled'") && ipcCode.includes("ipcMain.handle('i18n-ota:toggle-auto-mt'"), 'ipcHandlers.js must register dynamic auto-MT IPC handlers via ipcMain.handle');
    assert(ipcCode.includes('isI18nEnabled') && ipcCode.includes('function _i18nT('), 'ipcHandlers.js must respect isI18nEnabled and define _i18nT');
    const preloadCode = asar.extractFile(deployedAsar, path.join('dist', 'preload.js')).toString('utf8');
    assert(
      (preloadCode.match(/exposeInMainWorld\('antigravityI18nOta'/g) || []).length === 2 &&
      preloadCode.includes('i18n-ota:check-updates') &&
      preloadCode.includes('toggleLanguage') &&
      preloadCode.includes('i18n-ota:toggle-language') &&
      preloadCode.includes('translateDynamicText') &&
      preloadCode.includes('getAutoMtEnabled') &&
      preloadCode.includes('toggleAutoMt'),
      'preload.js must expose antigravityI18nOta (including auto-MT IPC) in both remote and local window branches'
    );
    const mainCode = asar.extractFile(deployedAsar, path.join('dist', 'main.js')).toString('utf8');
    assert(mainCode.includes('antigravity-i18n-check-update') && mainCode.includes('antigravity-i18n-toggle-lang') && mainCode.includes('function _i18nT(') && mainCode.includes('切换为英文原文'), 'main.js must add OTA check, language toggle, and _i18nT');
    assert(updaterCode.includes('_I18N_UPDATE_STEPS') && updaterCode.includes('function _i18nT(') && updaterCode.includes('MenuUpdateStep["CheckForUpdates"] = "Check for Updates"'), 'updater.js must keep English MenuUpdateStep keys and dynamically translate via _i18nT');
    const trayCode = asar.extractFile(deployedAsar, path.join('dist', 'tray.js')).toString('utf8');
    assert(trayCode.includes('_syncTrayLabels') && trayCode.includes('onLanguageChange') && trayCode.includes('切换为英文原文'), 'tray.js must subscribe to onLanguageChange for tray labels');
    assert(asar.statFile(deployedAsar, path.join('dist', 'native_context_dict.json')), 'app.asar must include dist/native_context_dict.json');
    assert(asar.statFile(deployedAsar, path.join('dist', 'i18n_ota.js')), 'app.asar must include dist/i18n_ota.js');
    assert(asar.statFile(deployedAsar, path.join('dist', 'i18n_meta.json')), 'app.asar must include dist/i18n_meta.json');
    const embeddedMeta = JSON.parse(asar.extractFile(deployedAsar, path.join('dist', 'i18n_meta.json')).toString('utf8'));
    assert.strictEqual(embeddedMeta.schemaVersion, 1, 'dist/i18n_meta.json must have schemaVersion 1');
    assert(Array.isArray(embeddedMeta.preserveList) && embeddedMeta.preserveList.includes('Antigravity'), 'dist/i18n_meta.json must include preserveList');
    assert(menuCode.includes('translateMenuRecursively') && menuCode.includes('antigravity-i18n-check-update') && menuCode.includes('antigravity-i18n-toggle-lang') && menuCode.includes('antigravity-i18n-toggle-auto-mt') && menuCode.includes('onLanguageChange') && menuCode.includes('onAutoMtChange') && menuCode.includes('__antigravityOrigLabel || menuItem.label'), 'menu.js must include translateMenuRecursively, OTA check, language toggle, auto-MT toggle item, change listeners, and __antigravityOrigLabel updateAction lookup');
    const getCodeIdx = utilsCode.indexOf('function _getAntigravityI18nCode');
    const createWinIdx = utilsCode.indexOf('function createWindow');
    assert(
      getCodeIdx !== -1 &&
      createWinIdx !== -1 &&
      getCodeIdx < createWinIdx &&
      !utilsCode.includes('http://localhost:') &&
      utilsCode.includes('frameOrigin === mainOrigin') &&
      utilsCode.includes('did-navigate-in-page') &&
      utilsCode.includes('_getAntigravityI18nOta') &&
      utilsCode.includes('applyCachedPackToWebContents') &&
      utilsCode.includes('getInitialStateScript'),
      'utils.js must define module-level _getAntigravityI18nCode / _getAntigravityI18nOta caches, sync initial enabled state, listen to did-navigate-in-page, and use exact frameOrigin matching'
    );
    assert(secCode.includes('颁发给：') && secCode.includes('请勿在此网站上输入任何敏感信息') && secCode.includes('function _i18nT('), 'webviewPopupSecurity.js must dynamically translate body and certificate fields');
    assert(wizardCode.includes('Antigravity 已全新重构') && wizardCode.includes('function _i18nT('), 'wizardHtml.js must dynamically translate body paragraph');

    const extraMainAssertions = [
      ['dist/provisionSplash.js', '正在配置 WSL'],
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
      assert(code.includes('function _i18nT('), `${rel} must define dynamic _i18nT helper`);
    }
    for (const rel of ['dist/utils.js', 'dist/menu.js', 'dist/tray.js', 'dist/main.js', 'dist/preload.js', 'dist/updater.js', 'dist/provisionSplash.js', 'dist/ipcHandlers.js', 'dist/webviewPopupSecurity.js', 'dist/ideInstall/wizardHtml.js', 'dist/languageServer.js', 'dist/i18n_ota.js']) {
      new vm.Script(asar.extractFile(deployedAsar, path.normalize(rel)).toString('utf8'), { filename: rel });
    }

    // Live runtime toggle test for real patched main-process modules (webviewPopupSecurity & disconnectedPage)
    let mockMainEnabled = true;
    const loadPatchedCjs = (code, filename) => {
      const mod = { exports: {} };
      const customRequire = (id) => {
        if (id === './i18n_ota' || id === '../i18n_ota') {
          return { isI18nEnabled: () => mockMainEnabled };
        }
        if (id === 'electron') return { Menu: {}, dialog: {} };
        if (id === 'crypto') return require('crypto');
        return require(id);
      };
      const fn = vm.runInNewContext(`(function(exports, require, module) {\n${code}\n})`, { console, URL, Buffer }, { filename });
      fn(mod.exports, customRequire, mod);
      return mod.exports;
    };
    const secMod = loadPatchedCjs(secCode, 'dist/webviewPopupSecurity.js');
    assert.strictEqual(secMod.formatPopupSecurityLabel({ url: 'http://example.com', level: 'insecure' }, 'http://example.com'), '不安全');
    assert(secMod.formatConnectionInfo({ url: 'https://example.com', level: 'secure' }).detail.includes('连接安全'));
    mockMainEnabled = false;
    assert.strictEqual(secMod.formatPopupSecurityLabel({ url: 'http://example.com', level: 'insecure' }, 'http://example.com'), 'Not secure');
    assert(secMod.formatConnectionInfo({ url: 'https://example.com', level: 'secure' }).detail.includes('Connection is secure'));

    const discCode = asar.extractFile(deployedAsar, path.join('dist', 'remote', 'disconnectedPage.js')).toString('utf8');
    const discMod = loadPatchedCjs(discCode, 'dist/remote/disconnectedPage.js');
    let loadedDataUrl = '';
    const mockWin = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false },
      loadURL: (u) => { loadedDataUrl = u; return Promise.resolve(); }
    };
    mockMainEnabled = true;
    discMod.showDisconnectedPage(mockWin, { label: 'devbox', state: 'disconnected', canStop: true });
    let decodedHtml = decodeURIComponent(loadedDataUrl.split(',')[1]);
    assert(decodedHtml.includes('已断开与 devbox 的连接') && decodedHtml.includes('重新连接') && decodedHtml.includes('停止服务端'));
    mockMainEnabled = false;
    discMod.showDisconnectedPage(mockWin, { label: 'devbox', state: 'disconnected', canStop: true });
    decodedHtml = decodeURIComponent(loadedDataUrl.split(',')[1]);
    assert(decodedHtml.includes('Disconnected from devbox') && decodedHtml.includes('Reconnect') && decodedHtml.includes('Stop Server'));

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
    ['Gemini 4 Carbon is currently available to Ultra plan subscribers.', 'Gemini 4 Carbon 目前仅面向 Ultra 订阅用户开放。'],
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
    ['Guide me through creating an automated task', '引导我创建一个自动化任务'],
    ['Create a plugin that ...', '创建一个插件，功能是...'],
    ['migrate my existing workflows to skills', '将我现有的工作流迁移为技能'],
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
    ['Weekly on Monday at 9:00 AM', '每周一 上午 9:00'],
    ['The MCP server "demo" from plugin "ext" failed to start.', '插件“ext”中的 MCP 服务“demo”启动失败。'],
    ['Manage project resources, agent settings, and permissions.', '管理项目资源、智能体设置及权限'],
    ['You have used some of your weekly limit, it will fully refresh in 5 days, 21 hours.', '你已使用部分每周配额，将在 5 天 21 小时后完全重置。'],
    ['You have used some of your 5-hour limit, it will fully refresh in 4 hours, 26 minutes.', '你已使用部分 5 小时配额，将在 4 小时 26 分钟后完全重置。'],
    ['You have hit your weekly limit, it refreshes in 4 days, 8 hours. If on a supported paid plan, you can use AI credits in the interim or upgrade to a higher tier.', '你已达到每周配额上限，将在 4 天 8 小时后重置。如果你使用的是受支持的付费套餐，在此期间可使用 AI 额度，或升级到更高级别套餐。'],
    ['You have hit your weekly limit, the 5-hour limit does not currently apply. Your weekly limit will fully refresh in 4 days, 8 hours.', '你已达到每周配额上限，当前不适用 5 小时配额限制。你的每周配额将在 4 天 8 小时后完全重置。'],
    ['You have hit your 5-hour limit, it refreshes in 2 hours, 15 minutes.', '你已达到 5 小时配额上限，将在 2 小时 15 分钟后重置。'],
    ['You have hit your weekly limit, it refreshes in less than a minute. If on a supported paid plan, you can use AI credits in the interim.', '你已达到每周配额上限，将在不到 1 分钟后重置。如果你使用的是受支持的付费套餐，在此期间可使用 AI 额度。'],
    ['If on a supported paid plan, you can use AI credits in the interim or upgrade to a higher tier.', '如果你使用的是受支持的付费套餐，在此期间可使用 AI 额度，或升级到更高级别套餐。'],
    // 不同订阅套餐与模型可用性/退市/升级提示一致性回归校验
    ['Gemini 4 Hydrogen is currently available to paid Pro and Ultra subscribers.', 'Gemini 4 Hydrogen 目前仅面向付费 Pro 和 Ultra 订阅用户开放。'],
    ['Gemini 4 Neon is currently available to paid Pro and Ultra subscribers.', 'Gemini 4 Neon 目前仅面向付费 Pro 和 Ultra 订阅用户开放。'],
    ['Gemini 4 Argon is currently available to Ultra plan subscribers.', 'Gemini 4 Argon 目前仅面向 Ultra 订阅用户开放。'],
    ['Gemini 4 Carbon is currently available to Google AI Ultra 20x subscribers.', 'Gemini 4 Carbon 目前仅面向 Google AI Ultra 20x 订阅用户开放。'],
    ['Gemini 4 Neon is currently available to paid, non-trial Pro and Ultra subscribers.', 'Gemini 4 Neon 目前仅面向正式付费（非试用）Pro 和 Ultra 订阅用户开放。'],
    ['Sonnet 5.5 is now available on paid Pro and Ultra plans. Third-party model access will no longer be available on your current plan starting on November 30, 2026.', 'Sonnet 5.5 现已面向付费 Pro 和 Ultra 套餐开放。自 2026年11月30日起，你当前的套餐将不再提供第三方模型访问权限。'],
    ['Opus 5.5 is now available on paid Pro and Ultra plans. Third-party model access will no longer be available on your current plan starting on November 30, 2026.', 'Opus 5.5 现已面向付费 Pro 和 Ultra 套餐开放。自 2026年11月30日起，你当前的套餐将不再提供第三方模型访问权限。'],
    ['Claude Sonnet 5.5 is now available on paid Pro and Ultra plans. Claude Sonnet 4.6 will be removed from Antigravity on December 15, 2026.', 'Claude Sonnet 5.5 现已面向付费 Pro 和 Ultra 套餐开放。Claude Sonnet 4.6 将于 2026年12月15日从 Antigravity 中移除。'],
    ['GPT-OSS will be removed from Antigravity on November 30, 2026.', 'GPT-OSS 将于 2026年11月30日从 Antigravity 中移除。'],
    ['Gemini 4 Neon requires a paid Pro or Ultra plan.', 'Gemini 4 Neon 需要付费 Pro 或 Ultra 套餐才能使用。'],
    ['Third-party model access is only available on paid Pro and Ultra plans.', '第三方模型访问权限仅面向付费 Pro 和 Ultra 套餐开放。'],
    ['Third-party model access is no longer available on your current plan.', '你当前的套餐已不再提供第三方模型访问权限。'],
    ['Gemini 4 Carbon is not available on your current plan.', 'Gemini 4 Carbon 在你当前的套餐中不可用。'],
    ['Free users and Google AI Plus users receive the minimum base limits on Antigravity. You can upgrade to Google AI Pro or above to receive higher rate limits.', '免费用户和 Google AI Plus 用户在 Antigravity 上享有最低基础配额。你可以升级到 Google AI Pro 或更高级别套餐以获取更高的请求速率上限。'],
    ['You can upgrade to a Google AI Ultra plan to receive higher rate limits.', '你可以升级到 Google AI Ultra 套餐以获取更高的请求速率上限。'],
    ['You can upgrade to a Google AI Ultra 20x plan to receive higher rate limits.', '你可以升级到 Google AI Ultra 20x 套餐以获取更高的请求速率上限。'],
    ['You can upgrade to Google AI Ultra 5x or 20x to receive higher rate limits.', '你可以升级到 Google AI Ultra 5x 或 20x 以获取更高的请求速率上限。'],
    ['You receive the highest rate limits on Antigravity.', '你在 Antigravity 上享有最高的请求速率上限。'],
    ['Google AI Ultra 20x users receive the highest rate limits on Antigravity.', 'Google AI Ultra 20x 用户在 Antigravity 上享有最高的请求速率上限。'],
    ['Google AI Ultra 5x users receive 5x higher rate limits on Antigravity.', 'Google AI Ultra 5x 用户在 Antigravity 上享有 5 倍更高的请求速率上限。'],
    ['This account is ineligible for higher rate limits through a Google AI plan at this time.', '此账号目前无法通过 Google AI 套餐获取更高的请求速率上限。'],
    ['Promotional and trial plans do not include third-party model access. You can upgrade to a paid Google AI Pro or Ultra plan to access third-party models.', '促销和试用套餐不包含第三方模型访问权限。你可以升级到付费 Google AI Pro 或 Ultra 套餐以使用第三方模型。'],
    ['Google Workspace accounts are currently ineligible for Google AI Pro or Ultra plans.', 'Google Workspace 账号目前无法订阅 Google AI Pro 或 Ultra 套餐。'],
    ['Your Plan: Free', '当前套餐：免费版'],
    ['Your Plan: Antigravity Starter Quota', '当前套餐：Antigravity 入门配额'],
    ['Your Plan: Google AI Plus', '当前套餐：Google AI Plus'],
    ['Your Plan: Google AI Pro', '当前套餐：Google AI Pro'],
    ['Your Plan: Google AI Pro (Trial)', '当前套餐：Google AI Pro（试用版）'],
    ['Your Plan: Google AI Ultra 5x', '当前套餐：Google AI Ultra 5x'],
    ['Your Plan: Google AI Ultra 20x', '当前套餐：Google AI Ultra 20x'],
    ['Your Plan: Enterprise Gateway', '当前套餐：企业网关'],
    ['Upgrade to Ultra 20x', '升级到 Ultra 20x'],
    ['Enable AI Credit Overages', '开启 AI 额度超额使用'],
    ['You have not used any of your weekly limit.', '你尚未使用任何每周配额。'],
    ['You have not used any of your 5-hour limit.', '你尚未使用任何 5 小时配额。'],
    ['Gemini 4 Argon Five Hour Limit Remaining', 'Gemini 4 Argon 5 小时剩余配额'],
    ['For paid Pro plans, Neon quota is separate. Higher Neon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.', '对于付费 Pro 套餐，Neon 配额独立计算。Ultra 套餐提供更高的 Neon 配额（包含在更大的 Gemini 总配额池中）。'],
    ["Your plan's baseline quota will refresh on 11/24/2026, 2:00:00 PM. You can upgrade to a Google AI Ultra 20x plan to receive higher rate limits.", '你当前套餐的基础配额将于 11/24/2026, 2:00:00 PM 重置。你可以升级到 Google AI Ultra 20x 套餐以获取更高的请求速率上限。'],
    ['Sorry, this account is ineligible to use Antigravity', '抱歉，此账号无法使用 Antigravity'],
    ['Further action is required to use Antigravity', '需要进一步操作才能使用 Antigravity'],
    ['Use Business Account', '使用企业账号'],
    // 严格负向隔离：非套餐普通英文句子不被误译
    ['This plugin is available for free.', 'This plugin is available for free.'],
    ['This feature requires standard.', 'This feature requires standard.'],
    ['You are on branch main.', 'You are on branch main.'],
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

  const permTriggerEl = makeEl({ testid: 'permissions-selector-trigger' });
  const permGlobalEl = makeEl({ testid: 'permissions-use-global-settings' });
  for (const el of [permTriggerEl, permGlobalEl]) {
    assert.strictEqual(api.translateString('Turbo', el), '全自动 (Turbo)');
    assert.strictEqual(api.translateString('Request Review', el), '请求审核 (Request Review)');
    assert.strictEqual(api.translateString('Auto', el), '自动 (Auto)');
    assert.strictEqual(api.translateString('Default', el), '默认');
  }
  assert.strictEqual(api.translateString('Turbo'), '全自动');
  assert.strictEqual(api.translateString('Request Review'), '请求审核');

  assert.strictEqual(
    api.translateString('Model cannot be changed while the agent is running'),
    '智能体运行期间无法切换模型'
  );
  assert.strictEqual(
    api.translateString('Permissions cannot be changed while the agent is running'),
    '智能体运行期间无法更改权限'
  );
  assert.strictEqual(
    api.translateString('Agent permissions preset: Turbo, Permissions cannot be changed while the agent is running'),
    '智能体权限预设：全自动，智能体运行期间无法更改权限'
  );
  assert.strictEqual(
    api.translateString('Cannot continue as a new conversation while side question is running'),
    '临时提问运行期间无法继续为新会话'
  );
  assert.strictEqual(
    api.translateString('Model: Gemini 3.1 Pro High, Model cannot be changed while the agent is running'),
    '模型：Gemini 3.1 Pro 高，智能体运行期间无法切换模型'
  );
  assert.strictEqual(api.translateString('Runs on this machine'), '在此电脑上运行');
  assert.strictEqual(api.translateString('Search Hosts\u2026'), '搜索主机...');
  assert.strictEqual(api.translateString('Search Hosts...'), '搜索主机...');
  assert.strictEqual(api.translateString('Loading Hosts\u2026'), '正在加载主机...');
  assert.strictEqual(api.translateString('No hosts in ~/.ssh/config yet'), '~/.ssh/config 中暂无主机配置');
  assert.strictEqual(api.translateString('No matching hosts'), '未找到匹配的主机');
  assert.strictEqual(api.translateString('1 hidden host'), '1 个已隐藏的主机');
  assert.strictEqual(api.translateString('3 hidden hosts'), '3 个已隐藏的主机');
  assert.strictEqual(api.translateString('Cloning locally\u2026'), '正在克隆到本地...');
  assert.strictEqual(
    api.translateString('Where the agent runs, current: This Computer'),
    '智能体运行位置，当前：此电脑'
  );
  assert.strictEqual(
    api.translateString('Where the agent runs, current: This Computer (Cloning locally\u2026)'),
    '智能体运行位置，当前：此电脑（正在克隆到本地...）'
  );

  // 3g. v2.35.1 tooltips, Inbox Mode, Plugin Permissions, Dictation Languages, Remote Clone, Open With & Agents
  assert.strictEqual(api.translateString('Continue as a New Conversation'), '继续为新会话');
  assert.strictEqual(
    api.translateString('Cannot continue as a new conversation during Battle Mode \u2014 end the battle first'),
    '对战模式期间无法继续为新会话 — 请先结束对战'
  );
  assert.strictEqual(
    api.translateString("Cannot continue a subagent's side question as a new conversation"),
    '无法将子智能体的临时提问继续为新会话'
  );
  assert.strictEqual(api.translateString('Locked while grouped by Status'), '按状态分组时已锁定');
  assert.strictEqual(api.translateString('Cloud Conversation'), '云端会话');
  assert.strictEqual(api.translateString('Toggle Virtual Machine'), '切换虚拟机');
  assert.strictEqual(api.translateString('Live preview unavailable'), '实时预览不可用');
  assert.strictEqual(
    api.translateString('You have a conversation in progress. Updating will interrupt it, and it will automatically resume once the update completes.'),
    '你有一个正在进行的会话。更新会暂时中断它，并在更新完成后自动恢复。'
  );
  assert.strictEqual(
    api.translateString('You have 3 conversations in progress. Updating will interrupt them, and they will automatically resume once the update completes.'),
    '你有 3 个正在进行的会话。更新会暂时中断它们，并在更新完成后自动恢复。'
  );
  assert.strictEqual(
    api.translateString("You have 2 conversations in progress. Updating will cancel them and you'll need to manually restart them."),
    '你有 2 个正在进行的会话。更新将取消它们，之后你需要手动重新启动。'
  );
  assert.strictEqual(api.translateString('Inbox Mode'), '收件箱模式');
  assert.strictEqual(api.translateString('Resolve conversation'), '将会话标记为已解决');
  assert.strictEqual(api.translateString('Working Section'), '进行中分区');
  assert.strictEqual(api.translateString('Auto-Resolve'), '自动解决');
  assert.strictEqual(api.translateString('Resolved "My Task"'), '已解决“My Task”');
  assert.strictEqual(api.translateString('Plugin permissions'), '插件权限');
  assert.strictEqual(api.translateString('Revoke all: File System'), '全部撤销：File System');
  assert.strictEqual(
    api.translateString('All 3 will be revoked. The plugin will ask before doing this again.'),
    '将撤销全部 3 项权限。插件下次执行此类操作前会再次询问你。'
  );
  assert.strictEqual(api.translateString('Allowed in my-project'), '在 my-project 中允许');
  assert.strictEqual(api.translateString('Yes, always allow in this project'), '是，在此项目中始终允许');
  assert.strictEqual(api.translateString('Dictation languages'), '语音听写语言');
  assert.strictEqual(api.translateString('Auto-detect (browser defaults)'), '自动检测（浏览器默认）');
  assert.strictEqual(api.translateString('Orchestrator model selection'), 'Orchestrator 模型选择');
  assert.strictEqual(api.translateString('Clone from Remote'), '从远程克隆');
  assert.strictEqual(api.translateString('Clone from This Computer'), '从此电脑克隆');
  assert.strictEqual(api.translateString('Open with'), '打开方式');
  assert.strictEqual(api.translateString('Text viewer'), '文本查看器');
  assert.strictEqual(api.translateString('PDF viewer'), 'PDF 查看器');
  assert.strictEqual(api.translateString('New Agent'), '新建智能体');
  assert.strictEqual(api.translateString('For My Team'), '供团队共享');
  assert.strictEqual(api.translateString('Type your own answer'), '输入你自己的回答');
  assert.strictEqual(api.translateString('Search by name or username'), '按姓名或用户名搜索');

  // 3h. Customizations marketplace shelves, categories, plugin descriptions, suggested prompts & builtin skills
  assert.strictEqual(api.translateString('Featured'), '精选');
  assert.strictEqual(api.translateString('Design, Creative & Media'), '设计、创意与媒体');
  assert.strictEqual(
    api.translateString('Plan work, track issues, sign documents, and manage your notes and files.'),
    '规划工作、追踪议题、签署文档以及管理笔记与文件。'
  );
  assert.strictEqual(api.translateString('Read, draft, and edit docs.'), '读取、起草并编辑 Google Docs 文档。');
  assert.strictEqual(
    api.translateString('Create, edit, review, resize, and brand-check Canva designs with the Canva MCP server.'),
    '通过 Canva MCP 服务创建、编辑、审阅、调整尺寸并检查 Canva 设计的品牌规范一致性。'
  );
  assert.strictEqual(
    api.translateString('Build, deploy and manage apps on Cloudflare Workers, storage and AI, with platform skills and the Cloudflare API through one MCP server.'),
    '通过统一 MCP 服务与平台技能，使用 Cloudflare API 在 Cloudflare Workers、存储与 AI 平台上构建、部署及管理应用。'
  );
  assert.strictEqual(
    api.translateString('Deploy this project to Cloudflare Workers'),
    '将此项目部署到 Cloudflare Workers'
  );
  assert.strictEqual(
    api.translateString('ONLY for the coordinator of an active /swarm session. What the coordinator writes so the Swarm UI\'s Overview can show the swarm\'s goal, its groups of work and a screenshot timeline; load it before you brief and add the first workers. Outside /swarm, do not load this.'),
    '仅限活跃 /swarm 会话的协调器使用。用于写入蜂群界面「概览」所需的蜂群目标、工作分组及截图时间线；请在向首批工作节点派发任务并添加前加载。非 /swarm 会话请勿加载。'
  );
  assert.strictEqual(
    api.translateString('Manage local Antigravity conversations programmatically over HTTP+JSON: create a new conversation (with an optional initial prompt), list conversations, read conversation metadata and run state, rename, archive, pin, star, tag, or group conversations, and delete conversations. Use when the user asks to list, rename, pin, star, archive, delete, or start conversations, including the current one, or when a script, plugin, or automation needs to manage conversations outside of subagent tool calls.'),
    '通过 HTTP+JSON 以编程方式管理本地 Antigravity 会话：创建新会话（可选附带初始提示词）、列出会话、读取会话元数据与运行状态、重命名、归档、置顶、标星、添加标签、分组以及删除会话。当用户要求列出、重命名、置顶、标星、归档、删除或启动会话（包括当前会话），或脚本、插件与自动化任务需要在子智能体工具调用之外管理会话时使用。'
  );

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

  // 3e. v2.34.0 Orchestrator settings (preserve "Orchestrator" as model name), model menu effort labels, outside-of dynamic nouns, & builtin skill/plugin descriptions
  assert.strictEqual(api.PRESERVE_SET.has('Orchestrator'), true);
  assert.strictEqual(api.translateString('Orchestrator'), 'Orchestrator');
  assert.strictEqual(api.translateString('Orchestrator Settings'), 'Orchestrator 设置');
  assert.strictEqual(
    api.translateString('Choose the models Orchestrator uses. A larger, smarter orchestrator model with a faster, cheaper executor gives high quality for fewer tokens.'),
    '选择 Orchestrator 使用的模型。用更强、更聪明的 Orchestrator 模型搭配更快、更实惠的执行模型，可在消耗更少 Token 的情况下获得高质量结果。'
  );
  assert.strictEqual(api.translateString('Orchestrator Model'), 'Orchestrator 模型');
  assert.strictEqual(
    api.translateString('Plans the work, makes design decisions, and reviews the result. Pick a top-tier model. You can also pick one per conversation from the Orchestrator row in the model menu.'),
    '负责规划工作、做出设计决策并审查结果。建议选择顶级模型。你也可以在模型选择器的“Orchestrator”行中为每个会话单独选择。'
  );
  assert.strictEqual(api.translateString('Executor Model'), '执行模型');
  assert.strictEqual(
    api.translateString('Carries out the plan: searches, edits, builds, and tests. Pick a faster, cheaper model.'),
    '负责执行计划：搜索、编辑、构建与测试。建议选择更快、更实惠的模型。'
  );
  assert.strictEqual(api.translateString("The Orchestrator's own planner"), 'Orchestrator 自带规划器');
  assert.strictEqual(api.translateString('Extra High'), '超高');
  assert.strictEqual(api.translateString('XHigh'), '超高');
  assert.strictEqual(api.translateString('Thinking effort'), '思考深度');
  assert.strictEqual(
    api.translateString('Offloads routine steps to a faster executor. Same quality, fewer tokens used.'),
    '将常规步骤分流给更快的执行模型。同等质量，消耗更少 Token。'
  );
  assert.strictEqual(
    api.translateString('For most deep reasoning and complex problems'),
    '适用于大多数深度推理与复杂问题'
  );
  assert.strictEqual(
    api.translateString('The original Gemini 4 model for advanced workflows'),
    '原版 Gemini 4 模型，适用于高级工作流'
  );
  assert.strictEqual(
    api.translateString('For speed and efficiency in execution tasks'),
    '适用于追求速度与效率的执行任务'
  );
  assert.strictEqual(
    api.translateString('For your hardest, long-horizon tasks'),
    '适用于最具挑战性的长周期任务'
  );
  assert.strictEqual(
    api.translateString('For your hardest, long-horizon tasks.'),
    '适用于最具挑战性的长周期任务。'
  );
  assert.strictEqual(api.translateString('Leaving Soon'), '即将下线');
  assert.strictEqual(api.translateString('Leaving soon'), '即将下线');
  assert.strictEqual(api.translateString('Retiring Soon'), '即将停用');
  assert.strictEqual(api.translateString('Ending Soon'), '即将结束');
  assert.strictEqual(api.translateString('Removing Soon'), '即将移除');
  assert.strictEqual(api.translateString('Experimental'), '实验性');
  assert.strictEqual(api.translateString('Prototype'), '原型');
  assert.strictEqual(api.translateString('Third-party'), '第三方');
  assert.strictEqual(api.translateString('Gemini 4 Carbon now available!'), 'Gemini 4 Carbon 现已开放！');
  assert.strictEqual(api.translateString('Gemini 4 Carbon now available in Antigravity!'), 'Gemini 4 Carbon 现已在 Antigravity 中开放！');

  // 3e-1b. "Leaving Soon" model retirement, replacement & switch-to-model tooltip dynamic templates
  const leavingCases = [
    ['Gemini 4 Argon is leaving Antigravity on November 30, 2026.', 'Gemini 4 Argon 将于 2026年11月30日从 Antigravity 下线。'],
    ['Gemini 4 Argon is leaving Antigravity on November 30.', 'Gemini 4 Argon 将于 11月30日从 Antigravity 下线。'],
    ['Gemini 4 Argon will leave Antigravity on November 30, 2026.', 'Gemini 4 Argon 将于 2026年11月30日从 Antigravity 下线。'],
    ['Gemini 3.8 Flash is leaving on November 30.', 'Gemini 3.8 Flash 将于 11月30日下线。'],
    ['Gemini 4 Argon is leaving Antigravity soon.', 'Gemini 4 Argon 即将从 Antigravity 下线。'],
    ['This model is leaving soon.', '此模型即将下线。'],
    ['Leaving Antigravity on November 30, 2026.', '将于 2026年11月30日从 Antigravity 下线。'],
    ['Leaving on November 30.', '将于 11月30日下线。'],
    ['Leaving Nov 30.', '将于 11月30日下线。'],
    [
      'The original Gemini 4 model for advanced workflows. Leaving on Nov 30.',
      '原版 Gemini 4 模型，适用于高级工作流。将于 11月30日下线。'
    ],
    [
      'Use Hydrogen for better quality with lower quota usage. Leaving on Nov 30.',
      '请使用 Hydrogen 以获得更高质量与更低配额消耗。将于 11月30日下线。'
    ],
    [
      'For most deep reasoning and complex problems. Leaving on Dec 15.',
      '适用于大多数深度推理与复杂问题。将于 12月15日下线。'
    ],
    [
      'For your hardest, long-horizon tasks. Available until Dec 31, 2026.',
      '适用于最具挑战性的长周期任务。可用至 2026年12月31日。'
    ],
    [
      'Switch to Gemini 4 Neon for higher quality at lower cost.',
      '请切换到 Gemini 4 Neon 以获得更高质量与更低成本。'
    ],
    ['Leaving on the table.', 'Leaving on the table.'],
    ['Scheduled for removal on November 30, 2026.', '计划于 2026年11月30日移除。'],
    ['Gemini 4 Argon is scheduled to leave Antigravity on 2026-11-30.', 'Gemini 4 Argon 计划于 2026年11月30日从 Antigravity 下线。'],
    ['Gemini 3.8 Flash is being retired on November 30, 2026.', 'Gemini 3.8 Flash 将于 2026年11月30日停用。'],
    ['Gemini 4 Argon will remain available until November 30, 2026.', 'Gemini 4 Argon 将可用至 2026年11月30日。'],
    ['Available until November 30, 2026.', '可用至 2026年11月30日。'],
    ['Gemini 3.8 Flash is being replaced by Gemini 4 Hydrogen.', 'Gemini 3.8 Flash 将由 Gemini 4 Hydrogen 替代。'],
    ['Gemini 4 Argon will be replaced by Gemini 4 Neon or Gemini 4 Carbon.', 'Gemini 4 Argon 将由 Gemini 4 Neon 或 Gemini 4 Carbon 替代。'],
    ['Switch to Gemini 4 Neon or Gemini 4 Carbon.', '请切换到 Gemini 4 Neon 或 Gemini 4 Carbon。'],
    ['Try Gemini 4 Hydrogen instead.', '建议改用 Gemini 4 Hydrogen。'],
    ['We recommend switching to Gemini 4 Neon for most deep reasoning and complex problems.', '建议切换到 Gemini 4 Neon 以处理大多数深度推理与复杂问题。'],
    [
      'Gemini 4 Argon is leaving Antigravity on November 30, 2026. Switch to Gemini 4 Neon or Gemini 4 Carbon.',
      'Gemini 4 Argon 将于 2026年11月30日从 Antigravity 下线。请切换到 Gemini 4 Neon 或 Gemini 4 Carbon。'
    ],
    [
      'Gemini 3.8 Flash will be removed from Antigravity on November 30, 2026. Try Gemini 4 Hydrogen instead.',
      'Gemini 3.8 Flash 将于 2026年11月30日从 Antigravity 中移除。建议改用 Gemini 4 Hydrogen。'
    ],
    [
      'Leaving Soon — Gemini 4 Argon, Gemini 3.8 Flash, GPT-OSS-120b, and Claude 4.6 models are leaving on November 30, 2026.',
      '即将下线 — Gemini 4 Argon、Gemini 3.8 Flash、GPT-OSS-120b 和 Claude 4.6 模型将于 2026年11月30日下线。'
    ],
    [
      'After November 30, 2026, conversations using Gemini 3.8 Flash will automatically switch to Gemini 4 Hydrogen.',
      '2026年11月30日后，使用 Gemini 3.8 Flash 的会话将自动切换到 Gemini 4 Hydrogen。'
    ],
    // Negative isolation checks
    ['Try again.', '重试。'],
    ['Use defaults for local testing.', 'Use defaults for local testing.'],
    ['Leaving the directory unchanged.', 'Leaving the directory unchanged.'],
    // Swarm UI & newly extracted strings
    ['The team', '团队成员'],
    ['Coordinator', '协调器'],
    ['Export GIF', '导出 GIF'],
    ['Exporting\u2026', '正在导出...'],
    ['Close preview', '关闭预览'],
    ['Use theme to be imported with settings', '使用随设置导入的主题'],
    ['Waiting on @worker-1', '等待 @worker-1 响应'],
    ['Go to #12 on the Board', '跳转到消息板 #12'],
    ['Posted in #general; click to show only #general', '发布于 #general；点击仅显示 #general'],
    ['Narrator read up to #5 of 12', '记录员已读至 #5 / 12']
  ];
  for (const [en, zh] of leavingCases) {
    assert.strictEqual(api.translateString(en), zh, `Leaving/Swarm mismatch for ${en}`);
  }

  // 3e-2. Model selector Orchestrator row & trigger combined "Model + Effort" strings
  const orchModelEl = makeEl({ testid: 'model-selector-orchestrator-model' });
  assert.strictEqual(api.translateString('Gemini 4 Neon Extra High', orchModelEl), 'Gemini 4 Neon 超高');
  assert.strictEqual(api.translateString('Gemini 4 Neon High', orchModelEl), 'Gemini 4 Neon 高');
  assert.strictEqual(api.translateString('Gemini 4 Neon Medium', orchModelEl), 'Gemini 4 Neon 中');
  assert.strictEqual(api.translateString('Gemini 4 Neon Low', orchModelEl), 'Gemini 4 Neon 低');
  assert.strictEqual(api.translateString('Gemini 4 Neon Extra', orchModelEl), 'Gemini 4 Neon 超高');
  assert.strictEqual(api.translateString('Gemini 4 Neon XHigh', orchModelEl), 'Gemini 4 Neon 超高');
  assert.strictEqual(api.translateString('Gemini 4 Neon Max', orchModelEl), 'Gemini 4 Neon 最高');
  assert.strictEqual(api.translateString('Gemini 4 Neon Minimal', orchModelEl), 'Gemini 4 Neon 极简');
  assert.strictEqual(api.translateString('Claude Opus 5.5 Extra High', orchModelEl), 'Claude Opus 5.5 超高');
  assert.strictEqual(api.translateString('GPT-OSS 120B Medium', orchModelEl), 'GPT-OSS 120B 中');
  assert.strictEqual(api.translateString("The Orchestrator's own planner", orchModelEl), 'Orchestrator 自带规划器');
  assert.strictEqual(api.translateString('Gemini 4 Carbon', orchModelEl), 'Gemini 4 Carbon');
  assert.strictEqual(api.translateString('Gemini 4 Neon 超高', orchModelEl), 'Gemini 4 Neon 超高');

  const modelTriggerBtn = makeEl({ tag: 'BUTTON', testid: 'model-selector-trigger' });
  const triggerSubSpan = makeEl({ tag: 'SPAN', cls: 'opacity-70', parent: modelTriggerBtn });
  const triggerLabelSpan = makeEl({ tag: 'SPAN', parent: modelTriggerBtn });
  assert.strictEqual(api.translateString('Gemini 4 Neon Extra High', triggerSubSpan), 'Gemini 4 Neon 超高');
  assert.strictEqual(api.translateString(' Gemini 4 Neon Extra High', triggerSubSpan), ' Gemini 4 Neon 超高');
  assert.strictEqual(api.translateString('Extra High', triggerSubSpan), '超高');
  assert.strictEqual(api.translateString('Extra High · 1M', triggerSubSpan), '超高 · 1M');
  assert.strictEqual(api.translateString('XHigh · 1M', triggerSubSpan), '超高 · 1M');
  assert.strictEqual(api.translateString('Medium · 200K', triggerSubSpan), '中 · 200K');
  assert.strictEqual(api.translateString('Orchestrator', triggerLabelSpan), 'Orchestrator');
  assert.strictEqual(api.translateString('My Custom High', triggerLabelSpan), 'My Custom High');

  // Negative isolation outside model-selector effort context
  assert.strictEqual(api.translateString('Gemini 4 Neon Extra High'), 'Gemini 4 Neon Extra High');
  assert.strictEqual(api.translateString('Volume High'), 'Volume High');
  assert.strictEqual(api.translateString('Priority Medium'), 'Priority Medium');

  // Dynamic aria-label for model selector trigger
  assert.strictEqual(
    api.translateString('Select model, current: Orchestrator Gemini 4 Neon Extra High'),
    '选择模型，当前：Orchestrator Gemini 4 Neon 超高'
  );
  assert.strictEqual(
    api.translateString('Select model, current: Gemini 4 Neon Medium'),
    '选择模型，当前：Gemini 4 Neon 中'
  );
  assert.strictEqual(
    api.translateString('Select model, current: Gemini 4 Neon Extra High · 1M'),
    '选择模型，当前：Gemini 4 Neon 超高 · 1M'
  );
  assert.strictEqual(
    api.translateString('Select model, current: No Model Selected'),
    '选择模型，当前：未选择模型'
  );
  assert.strictEqual(
    api.translateString('Select model, current: 3 models selected'),
    '选择模型，当前：已选 3 个模型'
  );
  assert.strictEqual(
    api.translateString('Select model, current: Gemini 4 Carbon'),
    '选择模型，当前：Gemini 4 Carbon'
  );

  // 3e-3. Single-variant model labels with parenthesized thinking effort (e.g. "GPT-OSS 120B (Medium)")
  const modelItemRow = makeEl({ testid: 'model-selector-item' });
  assert.strictEqual(api.translateString('GPT-OSS 120B (Medium)', modelItemRow), 'GPT-OSS 120B (中)');
  assert.strictEqual(api.translateString('GPT-OSS 120B (Low)', modelItemRow), 'GPT-OSS 120B (低)');
  assert.strictEqual(api.translateString('GPT-OSS 120B (High)', modelItemRow), 'GPT-OSS 120B (高)');
  assert.strictEqual(api.translateString('Gemini 4 Neon (XHigh)', modelItemRow), 'Gemini 4 Neon (超高)');
  assert.strictEqual(api.translateString('Gemini 4 Neon (Extra High)', modelItemRow), 'Gemini 4 Neon (超高)');
  assert.strictEqual(api.translateString('Claude Sonnet 4.5 (High Thinking)', modelItemRow), 'Claude Sonnet 4.5 (高)');
  assert.strictEqual(api.translateString('GPT-OSS 120B (Max)', modelItemRow), 'GPT-OSS 120B (最高)');
  assert.strictEqual(api.translateString('GPT-OSS 120B (Minimal)', modelItemRow), 'GPT-OSS 120B (极简)');
  assert.strictEqual(api.translateString('GPT-OSS 120B (中)', modelItemRow), 'GPT-OSS 120B (中)');

  assert.strictEqual(api.translateString('GPT-OSS 120B (Medium)', triggerLabelSpan), 'GPT-OSS 120B (中)');
  assert.strictEqual(api.translateString('My Custom High', triggerLabelSpan), 'My Custom High');

  const orchPickerRow = makeEl({ testid: 'orchestrator-picker-row' });
  assert.strictEqual(api.translateString('GPT-OSS 120B (Medium)', orchPickerRow), 'GPT-OSS 120B (中)');

  // 3e-3a. Automation / sidecar / orchestrator model selectors (Ryd / Tyd / Syd / RVb)
  const newSidecarTrigger = makeEl({ tag: 'DIV', testid: 'new-sidecar-model', attrs: { 'data-model': 'neon-high' } });
  const newSidecarLabel = makeEl({ tag: 'SPAN', parent: newSidecarTrigger });
  assert.strictEqual(api.translateString('Gemini 4 Neon (High)', newSidecarLabel), 'Gemini 4 Neon (高)');
  assert.strictEqual(api.translateString('Gemini 4 Neon (XHigh)', newSidecarLabel), 'Gemini 4 Neon (超高)');
  assert.strictEqual(api.translateString('Gemini 4 Carbon (Medium)', newSidecarLabel), 'Gemini 4 Carbon (中)');
  assert.strictEqual(api.translateString('Gemini 4 Argon (Low)', newSidecarLabel), 'Gemini 4 Argon (低)');

  const sidecarOption = makeEl({ tag: 'DIV', testid: 'sidecar-model-option', attrs: { 'data-model': 'neon-high' } });
  assert.strictEqual(api.translateString('Gemini 4 Neon (High)', sidecarOption), 'Gemini 4 Neon (高)');
  assert.strictEqual(api.translateString('Gemini 4 Neon (High) (unavailable)', sidecarOption), 'Gemini 4 Neon (高) (不可用)');
  assert.strictEqual(api.translateString('Gemini 4 Carbon (unavailable)', sidecarOption), 'Gemini 4 Carbon (不可用)');
  assert.strictEqual(api.translateString('Flash (latest)', sidecarOption), 'Flash (最新)');

  const scheduleModelEl = makeEl({ tag: 'DIV', testid: 'schedule-editor-model' });
  const sidecarSelectEl = makeEl({ tag: 'DIV', testid: 'sidecar-model-select' });
  const cloudModelEl = makeEl({ tag: 'DIV', testid: 'cloud-trigger-editor-model' });
  const genericDataModelEl = makeEl({ tag: 'DIV', attrs: { 'data-model': 'carbon-high' } });
  const orchSettingModelEl = makeEl({ tag: 'DIV', testid: 'orchestrator-model' });
  const orchExecModelEl = makeEl({ tag: 'DIV', testid: 'orchestrator-executor-model' });
  assert.strictEqual(api.translateString('Gemini 4 Carbon (High)', scheduleModelEl), 'Gemini 4 Carbon (高)');
  assert.strictEqual(api.translateString('Gemini 4 Neon (XHigh)', sidecarSelectEl), 'Gemini 4 Neon (超高)');
  assert.strictEqual(api.translateString('Gemini 4 Argon (Medium)', cloudModelEl), 'Gemini 4 Argon (中)');
  assert.strictEqual(api.translateString('Gemini 4 Carbon (High)', genericDataModelEl), 'Gemini 4 Carbon (高)');
  assert.strictEqual(api.translateString('Gemini 4 Neon (High)', orchSettingModelEl), 'Gemini 4 Neon (高)');
  assert.strictEqual(api.translateString('Gemini 4 Argon (Medium)', orchExecModelEl), 'Gemini 4 Argon (中)');

  const autoModelValEl = makeEl({ tag: 'SPAN', testid: 'automation-model-value' });
  assert.strictEqual(api.translateString('Gemini 4 Neon (High) · This computer', autoModelValEl), 'Gemini 4 Neon (高) · 此电脑');
  assert.strictEqual(api.translateString('Gemini 4 Carbon · This computer', autoModelValEl), 'Gemini 4 Carbon · 此电脑');

  assert.strictEqual(
    api.translateString('Gemini 4 Argon (High) is no longer available. Runs use Gemini 4 Neon (High) instead.'),
    'Gemini 4 Argon (高)已不再可用。运行时将改用 Gemini 4 Neon (高)。'
  );
  assert.strictEqual(
    api.translateString('Gemini 4 Argon (High) is no longer available. Runs will fail until you pick another model.'),
    'Gemini 4 Argon (高)已不再可用。在你选择其他模型前，任务运行将会失败。'
  );

  // 3e-3b. Automation schedule editor, summaries, timestamps, blockers, credentials, and context disambiguations
  const schedCustom = makeEl({ tag: 'DIV', testid: 'schedule-custom' });
  const schedUnit = makeEl({ tag: 'BUTTON', testid: 'schedule-custom-unit', parent: schedCustom });
  const schedUnitOpt = makeEl({ tag: 'DIV', testid: 'schedule-custom-unit-option', parent: schedCustom });
  const schedTime = makeEl({ tag: 'BUTTON', testid: 'schedule-time', parent: schedCustom });
  const schedDom = makeEl({ tag: 'BUTTON', testid: 'schedule-day-of-month', parent: schedCustom });
  assert.strictEqual(api.translateString('hours', schedUnit), '小时');
  assert.strictEqual(api.translateString('week', schedUnit), '周');
  assert.strictEqual(api.translateString('month', schedUnitOpt), '月');
  const schedEditor = makeEl({ tag: 'DIV', testid: 'automation-schedule-editor' });
  assert.strictEqual(api.translateString('on', schedCustom), '星期');
  assert.strictEqual(api.translateString('on', schedEditor), '的');
  assert.strictEqual(api.translateString('on the', schedCustom), '的');
  assert.strictEqual(api.translateString('at', schedCustom), '时间');
  assert.strictEqual(api.translateString('1st', schedDom), '1 日');
  assert.strictEqual(api.translateString('2nd', schedDom), '2 日');
  assert.strictEqual(api.translateString('3rd', schedDom), '3 日');
  assert.strictEqual(api.translateString('28th', schedDom), '28 日');
  assert.strictEqual(api.translateString('9:00 AM', schedTime), '上午 9:00');
  assert.strictEqual(api.translateString('2:30 PM', schedTime), '下午 2:30');
  assert.strictEqual(api.translateString('12:00 AM', schedTime), '凌晨 00:00');
  assert.strictEqual(api.translateString('12:30 AM', schedTime), '凌晨 00:30');
  assert.strictEqual(api.translateString('1:00 AM', schedTime), '凌晨 1:00');
  assert.strictEqual(api.translateString('05:30 AM', schedTime), '凌晨 05:30');
  assert.strictEqual(api.translateString('5:30 AM', schedTime), '凌晨 5:30');
  assert.strictEqual(api.translateString('6:00 AM', schedTime), '上午 6:00');
  assert.strictEqual(api.translateString('12:00 PM', schedTime), '中午 12:00');
  assert.strictEqual(api.translateString('12:30 PM', schedTime), '下午 12:30');
  assert.strictEqual(api.translateString('5:30 PM', schedTime), '下午 5:30');
  assert.strictEqual(api.translateString('6:00 PM', schedTime), '晚上 6:00');
  assert.strictEqual(api.translateString('06:00 PM', schedTime), '晚上 06:00');
  assert.strictEqual(api.translateString('11:30 PM', schedTime), '晚上 11:30');
  const schedTimeOpt = makeEl({ tag: 'DIV', testid: 'schedule-time-option', parent: schedCustom });
  assert.strictEqual(api.translateString('12:00 AM', schedTimeOpt), '凌晨 00:00');
  assert.strictEqual(api.translateString('12:30 AM', schedTimeOpt), '凌晨 00:30');
  assert.strictEqual(api.translateString('05:30 AM', schedTimeOpt), '凌晨 05:30');
  assert.strictEqual(api.translateString('6:00 AM', schedTimeOpt), '上午 6:00');
  assert.strictEqual(api.translateString('12:00 PM', schedTimeOpt), '中午 12:00');
  assert.strictEqual(api.translateString('12:30 PM', schedTimeOpt), '下午 12:30');
  assert.strictEqual(api.translateString('5:30 PM', schedTimeOpt), '下午 5:30');
  assert.strictEqual(api.translateString('06:00 PM', schedTimeOpt), '晚上 06:00');
  assert.strictEqual(api.translateString('11:30 PM', schedTimeOpt), '晚上 11:30');

  const weekdayPairs = [
    ['M', 'Monday', '一'],
    ['T', 'Tuesday', '二'],
    ['W', 'Wednesday', '三'],
    ['T', 'Thursday', '四'],
    ['F', 'Friday', '五'],
    ['S', 'Saturday', '六'],
    ['S', 'Sunday', '日']
  ];
  for (const [shortEn, fullEn, shortZh] of weekdayPairs) {
    const btnEn = makeEl({ tag: 'BUTTON', attrs: { 'aria-label': fullEn }, parent: schedCustom });
    const spanEn = makeEl({ tag: 'SPAN', parent: btnEn });
    assert.strictEqual(api.translateString(shortEn, spanEn), shortZh);
    const btnZh = makeEl({ tag: 'BUTTON', attrs: { 'aria-label': `星期${shortZh === '日' ? '日' : shortZh}` }, parent: schedCustom });
    assert.strictEqual(api.translateString(shortEn, btnZh), shortZh);
  }
  assert.strictEqual(api.translateString('Keep: Daily at 9:00 AM', schedCustom), '保留当前：每天 上午 9:00');
  assert.strictEqual(api.translateString('Keep: Daily at 12:00 PM', schedCustom), '保留当前：每天 中午 12:00');
  assert.strictEqual(api.translateString('Keep: Daily at 12:30 PM', schedCustom), '保留当前：每天 下午 12:30');

  // Negative guards outside schedule context
  assert.strictEqual(api.translateString('hours'), 'hours');
  assert.strictEqual(api.translateString('week'), 'week');
  assert.strictEqual(api.translateString('month'), 'month');
  assert.strictEqual(api.translateString('on'), 'on');
  assert.strictEqual(api.translateString('on the'), 'on the');
  assert.strictEqual(api.translateString('at'), 'at');
  assert.strictEqual(api.translateString('1st'), '1st');
  assert.strictEqual(api.translateString('M'), 'M');
  assert.strictEqual(api.translateString('T'), 'T');
  assert.strictEqual(api.translateString('9:00 AM'), '9:00 AM');

  // Schedule summaries (D6)
  assert.strictEqual(api.translateString('Every weekday'), '每工作日');
  assert.strictEqual(api.translateString('Weekdays at 9:00 AM'), '每工作日 上午 9:00');
  assert.strictEqual(api.translateString('weekdays at 9:00 AM'), '每工作日 上午 9:00');
  assert.strictEqual(api.translateString('Weekends at 10:00 AM'), '每周末 上午 10:00');
  assert.strictEqual(api.translateString('Every 15 minutes on weekdays'), '每工作日每 15 分钟');
  assert.strictEqual(api.translateString('Every hour at :30 on weekends'), '每周末每小时第 30 分');
  assert.strictEqual(api.translateString('Every 2 hours on Mondays'), '每周一每 2 小时');
  assert.strictEqual(api.translateString('Every hour, 9 AM to 5 PM, on weekdays'), '每工作日每小时（上午 9 点至下午 5 点）');
  assert.strictEqual(api.translateString('Mon, Wed and Fri at 9:00 AM'), '每周一、周三、周五 上午 9:00');
  assert.strictEqual(api.translateString('Monthly on the 15th at 2:30 PM'), '每月 15 日 下午 2:30');
  assert.strictEqual(api.translateString('Daily at 9:00 AM'), '每天 上午 9:00');
  assert.strictEqual(api.translateString('Daily at 12:00 AM'), '每天 凌晨 00:00');
  assert.strictEqual(api.translateString('Weekdays at 12:30 AM'), '每工作日 凌晨 00:30');
  assert.strictEqual(api.translateString('Monthly on the 1st at 12:00 PM'), '每月 1 日 中午 12:00');
  assert.strictEqual(api.translateString('Every hour, 12 AM to 12 PM'), '每小时（凌晨 0 点至中午 12 点）');
  assert.strictEqual(api.translateString('Every hour, 5 AM to 6 PM'), '每小时（凌晨 5 点至晚上 6 点）');
  assert.strictEqual(api.translateString('Every hour, 6 AM to 11 PM'), '每小时（上午 6 点至晚上 11 点）');

  // Next run (myd) & run history timestamps (lyd)
  assert.strictEqual(api.translateString('Next run today around 9:00 AM GMT+8'), '下次运行：今天约 上午 9:00 GMT+8');
  assert.strictEqual(api.translateString('Next run today around 12:00 AM GMT+8'), '下次运行：今天约 凌晨 00:00 GMT+8');
  assert.strictEqual(api.translateString('Next run tomorrow around 2:30 PM GMT+8'), '下次运行：明天约 下午 2:30 GMT+8');
  assert.strictEqual(api.translateString('Next run tomorrow around 12:00 PM GMT+8'), '下次运行：明天约 中午 12:00 GMT+8');
  assert.strictEqual(api.translateString('Next run on Monday around 9:00 AM GMT+8'), '下次运行：星期一 约 上午 9:00 GMT+8');
  assert.strictEqual(api.translateString('Next run on December 1 around 9:00 AM GMT+8'), '下次运行：12月1日 约 上午 9:00 GMT+8');
  assert.strictEqual(api.translateString('Today 9:00 AM'), '今天 上午 9:00');
  assert.strictEqual(api.translateString('Today 12:00 AM'), '今天 凌晨 00:00');
  assert.strictEqual(api.translateString('Yesterday 2:30 PM'), '昨天 下午 2:30');
  assert.strictEqual(api.translateString('Yesterday 12:30 AM'), '昨天 凌晨 00:30');
  assert.strictEqual(api.translateString('Mon 9:00 AM'), '周一 上午 9:00');
  assert.strictEqual(api.translateString('Mon 12:00 PM'), '周一 中午 12:00');
  assert.strictEqual(api.translateString('Nov 25, 9:00 AM'), '11月25日 上午 9:00');
  assert.strictEqual(api.translateString('Nov 25, 12:30 PM'), '11月25日 下午 12:30');
  assert.strictEqual(api.translateString('Nov 25, 2025, 2:30 PM'), '2025年11月25日 下午 2:30');

  // Blockers, wizard steps, failures, triggers, credentials, list states
  assert.strictEqual(api.translateString('Required to create: title, instructions'), '创建前需填写：标题、指令说明');
  assert.strictEqual(api.translateString('Required to save: instructions'), '保存前需填写：指令说明');
  assert.strictEqual(api.translateString('Step 1 of 3'), '第 1 / 3 步');
  assert.strictEqual(api.translateString('Failed: timeout'), '失败：timeout');
  assert.strictEqual(api.translateString('Triggered Daily summary'), '已触发 Daily summary');
  assert.strictEqual(api.translateString('Connect an account so the agent can run automations.'), '连接账号以便智能体运行自动化任务。');
  assert.strictEqual(api.translateString('Connect an account for GitHub so the agent can run automations.'), '为 GitHub 连接账号以便智能体运行自动化任务。');
  assert.strictEqual(api.translateString('Credentials expire in 2 hours. Refresh credentials to keep this automation running'), '凭据将在 2 小时 后过期。请刷新凭据以保持此自动化任务正常运行');
  assert.strictEqual(api.translateString('Always on'), '常驻运行');
  assert.strictEqual(api.translateString('Paused'), '已暂停');
  assert.strictEqual(api.translateString('Scheduled'), '定时计划');

  // Context disambiguations in Automations vs default global meanings
  const autoModalEl = makeEl({ tag: 'DIV', testid: 'new-sidecar-modal' });
  const autoProjEl = makeEl({ tag: 'DIV', testid: 'new-sidecar-project', parent: autoModalEl });
  const autoRowEl = makeEl({ tag: 'DIV', testid: 'sidecar-row' });
  const autoSettingsEl = makeEl({ tag: 'DIV', testid: 'automation-settings' });
  const autoListEl = makeEl({ tag: 'DIV', testid: 'sidecar-list' });
  assert.strictEqual(api.translateString('Machine', autoModalEl), '运行云端主机');
  assert.strictEqual(api.translateString('全机', autoModalEl), '运行云端主机');
  assert.strictEqual(api.translateString('Machine'), '全机');
  assert.strictEqual(api.translateString('Standalone', autoProjEl), '独立运行');
  assert.strictEqual(api.translateString('独立窗口', autoProjEl), '独立运行');
  assert.strictEqual(api.translateString('Standalone'), '独立窗口');
  assert.strictEqual(api.translateString('Next', autoRowEl), '下次');
  assert.strictEqual(api.translateString('下一步', autoRowEl), '下次');
  assert.strictEqual(api.translateString('Last', autoRowEl), '上次');
  assert.strictEqual(api.translateString('Next'), '下一步');
  assert.strictEqual(api.translateString('Reads', autoSettingsEl), '可读取');
  assert.strictEqual(api.translateString('读取操作', autoSettingsEl), '可读取');
  assert.strictEqual(api.translateString('Reads'), '读取操作');
  assert.strictEqual(api.translateString('Delete Daily summary', autoListEl), '删除 Daily summary');
  assert.strictEqual(api.translateString('Delete Daily summary'), 'Delete Daily summary');

  const customModelItem = makeEl({ testid: 'model-selector-custom-item', parent: modelPanel });
  assert.strictEqual(api.translateString('My Custom Model (Medium)', customModelItem), 'My Custom Model (Medium)');

  assert.strictEqual(api.translateString('GPT-OSS 120B (Medium)'), 'GPT-OSS 120B (Medium)');
  assert.strictEqual(api.translateString('Gemini 4 Neon (High)'), 'Gemini 4 Neon (High)');
  assert.strictEqual(api.translateString('Gemini 4 Carbon (unavailable)'), 'Gemini 4 Carbon (unavailable)');
  assert.strictEqual(api.translateString('Flash (latest)'), 'Flash (latest)');
  assert.strictEqual(api.translateString('Priority (Medium)'), 'Priority (Medium)');
  assert.strictEqual(
    api.translateString('Select model, current: GPT-OSS 120B (Medium)'),
    '选择模型，当前：GPT-OSS 120B (中)'
  );
  assert.strictEqual(api.translateString('Settings for conversations outside of projects.'), '在项目之外创建的独立会话设置');
  assert.strictEqual(api.translateString('Settings for conversations outside of workspaces.'), '在工作区之外创建的独立会话设置');
  assert.strictEqual(api.translateString('Manage project folders and settings.'), '管理项目文件夹与设置');
  assert.strictEqual(api.translateString('Unlock the power of agent swarms.'), '解锁多智能体 Swarm 协作的强大能力。');
  assert.strictEqual(
    api.translateString("Build, package, and debug MCP Apps for Antigravity: MCP server tools whose results render as interactive UI in the conversation, in the side pane, or full-page from the sidebar. Use when adding a UI to an MCP tool, building or theming the app itself, packaging it as a plugin, or debugging an app that doesn't render or behave as expected."),
    '为 Antigravity 构建、打包与调试 MCP 应用（将 MCP 服务工具的结果以交互式 UI 渲染在会话、侧边面板或全页中），适用于为 MCP 工具添加界面、定制主题、打包插件或排查渲染异常。'
  );
  // 3e-4. Global terminology consistency checks
  assert.strictEqual(api.translateString('Scheduled Task'), '计划任务');
  assert.strictEqual(api.translateString('Only Scheduled'), '仅计划任务');
  assert.strictEqual(api.translateString('Enable Telemetry'), '开启遥测');
  assert.strictEqual(api.translateString('Enable AI Credit Overages'), '开启 AI 额度超额使用');
  assert.strictEqual(api.translateString('Enable Browser Agent'), '启用浏览器智能体');
  assert.strictEqual(api.translateString('Purchase Credits'), '购买额度');
  assert.strictEqual(api.translateString('Get More AI Credits'), '获取更多 AI 额度');
  assert.strictEqual(api.translateString('Preferences'), '偏好设置');
  assert.strictEqual(api.translateString('Open Preferences'), '打开偏好设置');
  assert.strictEqual(api.translateString('Proceed in sandbox'), '在沙盒环境中执行');
  assert.strictEqual(api.translateString('Proceed in Sandbox'), '在沙盒环境中执行');
  assert.strictEqual(api.translateString('Browsing History'), '浏览历史记录');
  assert.strictEqual(api.translateString('Browsing history'), '浏览历史记录');
  assert.strictEqual(api.translateString('Enter to Send'), '按 Enter 发送');
  assert.strictEqual(api.translateString('Enter to send'), '按 Enter 发送');
  assert.strictEqual(api.translateString('No events recorded'), '暂无事件记录');
  assert.strictEqual(api.translateString('No events recorded.'), '暂无事件记录。');
  assert.strictEqual(api.translateString('Accept All Changes'), '接受所有更改');
  assert.strictEqual(api.translateString('Discard All Changes'), '放弃所有更改');
  assert.strictEqual(api.translateString('Review Changes'), '查看更改');
  assert.strictEqual(api.translateString('Discard comment draft'), '放弃批注草稿');
  assert.strictEqual(api.translateString('Add Comment'), '添加批注');
  assert.strictEqual(api.translateString('Edit Comment'), '编辑批注');
  assert.strictEqual(api.translateString('Selected element preview'), '选中区域预览');
  assert.strictEqual(api.translateString('Conversation details unavailable'), '会话详情不可用');
  assert.strictEqual(api.translateString('Conversation Width'), '会话宽度');
  assert.strictEqual(api.translateString('Switch to Dark Mode'), '切换到深色模式');
  assert.strictEqual(api.translateString('Switch To'), '切换到');
  assert.strictEqual(api.translateString('Please switch to Gemini 4 Neon instead.'), '请切换到 Gemini 4 Neon。');
  assert.strictEqual(api.translateString('Collapse sidebar'), '收起侧边栏');
  assert.strictEqual(api.translateString('Select an option'), '请选择一项');
  assert.strictEqual(api.translateString('Reconnecting'), '正在重新连接');
  assert.strictEqual(api.translateString('Free users receive the minimum base rate limits on Antigravity.'), '免费用户在 Antigravity 上享有最低基础请求速率上限。');
  assert.strictEqual(
    api.translateString('ONLY for the native-swarm worker whose brief says it is the monitor. On a timer, it checks whether the whole swarm has stalled and calls on the one member who can unstick it. Coordinators and other workers: do not load this.'),
    '仅限任务简报指定为监控员的原生 Swarm 协作工作节点使用。定时检查整个 Swarm 是否停滞并唤醒可推进任务的成员；协调器与其他工作节点请勿加载。'
  );
  assert.strictEqual(
    api.translateString("What the coordinator writes so the Swarm UI's Overview can show the swarm's goal, its groups of work and a screenshot timeline. Load it before you brief and add the first workers to a swarm."),
    '指导协调器编写 Swarm 界面概览所需的目标、工作分组与截图时间线信息，请在分配任务并添加首批工作节点前加载。'
  );

  // 3e-5. Settings page subtitles (no trailing period) & "可选" wording checks
  const settingsPageSubtitles = [
    ['Configure agent execution, queued message delivery, and permissions.', '配置智能体执行机制、队列消息传递及权限控制'],
    ['Manage Antigravity app settings.', '管理 Antigravity 应用设置'],
    ["Configure the agent's visual theme and display preferences.", '配置智能体的外观视觉主题与显示偏好'],
    ['Keyboard shortcuts for quick navigation and control.', '配置用于快速导航与控制的快捷键'],
    ['Manage your keybinding scheme and customize shortcuts in VS Code.', '管理按键绑定方案，并在 VS Code 中自定义快捷键'],
    ['Manage your notification preferences.', '管理你的通知偏好设置'],
    ['Manage your model quota and credits.', '管理你的模型配额与 AI 额度'],
    ['Configure built-in browser, link opening, and browser subagent preferences.', '配置内置浏览器、链接打开方式以及浏览器子智能体的偏好设置'],
    ['Manage your plan, credentials, and general preferences.', '管理你的套餐、凭据及常规偏好设置'],
    ['Agent settings and permissions for conversations outside of projects.', '配置未归属于任何项目的独立会话的智能体设置与权限策略'],
    ['Manage project folders, agent settings, and permissions.', '管理项目文件夹、智能体设置及权限'],
    ['Manage fine-grained permissions for GitHub.', '管理 GitHub 的细粒度访问权限'],
    ['Developer-only tools. These settings do not affect other users.', '仅限开发者使用的工具，这些设置不会影响其他用户']
  ];
  for (const [en, zh] of settingsPageSubtitles) {
    assert.strictEqual(api.translateString(en), zh);
  }
  assert.strictEqual(api.translateString('Attach a screenshot (optional)'), '上传屏幕截图（可选）');
  assert.strictEqual(api.translateString('(Optional) Tell us more...'), '（可选）详细说明你的反馈...');
  assert.strictEqual(api.translateString('(Optional) Tell us more or type your reason...'), '（可选）详细说明你的原因或建议...');
  for (const [k, v] of Object.entries(api.EXACT_DICT)) {
    assert(!v.includes('选填'), `EXACT_DICT must not use 选填: ${k} => ${v}`);
  }
  for (const [k, v] of Object.entries(api.ATTR_DICT)) {
    assert(!v.includes('选填'), `ATTR_DICT must not use 选填: ${k} => ${v}`);
  }

  // 3f. v2.34.0 General Input Box, Browsing Data & Cookies, Sidebar Customization, Bundles & Approvals
  assert.strictEqual(api.translateString('Input Box'), '输入框');
  assert.strictEqual(api.translateString('Choose which key sends a message in the chat composer.'), '选择在聊天输入框中发送消息的快捷键。');
  assert.strictEqual(api.translateString('Press Ctrl+Enter to send, Enter for a new line.'), '按 Ctrl+Enter 发送，按 Enter 换行。');
  assert.strictEqual(api.translateString('Browsing Data'), '浏览数据');
  assert.strictEqual(api.translateString('Cookies by Site'), '按网站管理 Cookie');
  assert.strictEqual(api.translateString('3 cookies'), '3 个 Cookie');
  assert.strictEqual(api.translateString('Delete cookies for example.com'), '删除 example.com 的 Cookie');
  assert.strictEqual(api.translateString('Customize Sidebar'), '自定义侧边栏');
  assert.strictEqual(api.translateString('Filter and Sort'), '筛选与排序');
  assert.strictEqual(api.translateString('Show Automation Conversations'), '显示自动化会话');
  assert.strictEqual(api.translateString('Select Sidebar Item 1'), '选择侧边栏第 1 项');
  assert.strictEqual(api.translateString('Review bundle before adding'), '添加前请审查此插件包');
  assert.strictEqual(api.translateString('Add bundle Starter Pack'), '添加插件包 Starter Pack');
  assert.strictEqual(
    api.translateString('This plugin in Starter Pack may have looser code review. Review its contents before adding the bundle.'),
    'Starter Pack 中的此插件代码审查可能较宽松，请在添加插件包前先查看其内容。'
  );
  assert.strictEqual(api.translateString('Deny with note'), '拒绝并附说明');
  assert.strictEqual(api.translateString('Insert into main conversation'), '插入主会话');
  assert.strictEqual(
    api.translateString('Telemetry is turned off for your account. This means Antigravity does not collect any of your prompts, content, or model responses, but will still collect general usage patterns (e.g., feature adoption, active user counts).'),
    '你的账号已关闭遥测功能。这意味着 Antigravity 不会收集你的任何提示词、内容或模型回复，但仍会收集常规使用模式（例如功能采用率和活跃用户数）。'
  );

  // 3g. Unauthenticated onboarding, login/SSO/WIF/auth-code flows & Go/ConnectRPC/network auth errors
  const onboardingExactCases = [
    ['Welcome to Antigravity!', '欢迎使用 Antigravity！'],
    ['WIF Config', 'WIF 配置'],
    ['E.g. locations/global/workforcePools...', '例如：locations/global/workforcePools...'],
    ['Sign In with SSO', '使用单点登录 (SSO) 登录'],
    ['Trouble signing in? Enter authorization code', '登录遇到问题？输入授权码'],
    ['Submit code', '提交授权码'],
    ['Authorization code was rejected. Paste a fresh code and try again.', '授权码无效或已被拒绝，请粘贴新的授权码后重试。'],
    ['Copied sign-in link to clipboard', '已复制登录链接到剪贴板'],
    ['Switched to authorization code sign-in', '已切换为授权码登录'],
    ['Select Antigravity Theme', '选择 Antigravity 主题'],
    ['Select Theme', '选择主题'],
    ["Let's tailor the experience for you. What best describes your work?", '让我们为你定制使用体验。以下哪项最符合你的工作方向？'],
    ['Hey there!', '你好！'],
    ['Learn more by visiting our', '如需了解更多，请访问我们的'],
    ['FAQ', '常见问题'],
    ['Verify', '去验证'],
    ['This account is not eligible for Antigravity.', '此账号无法使用 Antigravity。'],
    ['Sign-in failed while exchanging authorization code. Return to Antigravity for details and try again.', '交换授权码时登录失败。请返回 Antigravity 查看详情并重试。'],
    ['Sign-in session is no longer active. Please start sign-in again.', '登录会话已失效，请重新发起登录。'],
    ['Authorization code submission timed out. Please try again.', '提交授权码超时，请重试。'],
    ["Sign-in didn't finish. Try again.", '登录未完成，请重试。'],
    ['Authentication successful! You can close this window.', '登录成功！你可以关闭此窗口。'],
    ['enterprise license assignment is disabled by administrator policy; pay-as-you-go billing is required', '管理员策略已禁用企业许可证分配，必须使用按量付费计费模式'],
    ['Authentication failed', '身份验证失败'],
    ['Authentication expired. Please log back in.', '身份验证已过期，请重新登录。']
  ];
  for (const [en, zh] of onboardingExactCases) {
    assert.strictEqual(api.translateString(en), zh, `Onboarding/Auth static check failed for: ${en}`);
  }
  const onboardingAttrCases = [
    ['Continue with Google', '使用 Google 账号继续'],
    ['E.g. locations/global/workforcePools...', '例如：locations/global/workforcePools...'],
    ['Light preview', '浅色预览'],
    ['Dark preview', '深色预览'],
    ['Sign-in required', '需要登录']
  ];
  for (const [en, zh] of onboardingAttrCases) {
    assert.strictEqual(api.ATTR_DICT[en], zh, `Onboarding/Auth ATTR_DICT check failed for: ${en}`);
  }
  assert.strictEqual(api.translateString('Welcome to Antigravity!'), '欢迎使用 Antigravity！');
  assert.strictEqual(api.translateString('Select MyApp Theme'), '选择 MyApp 主题');
  assert.strictEqual(api.translateString('Hey Alice!'), '你好，Alice！');
  assert.strictEqual(api.translateString('Further action is required to use Antigravity'), '需要进一步操作才能使用 Antigravity');
  assert.strictEqual(
    api.translateString("You're signing in on devbox. Your sign-in stays on that machine."),
    '你正在 devbox 上登录。登录状态将仅保留在该主机上。'
  );
  assert.strictEqual(api.translateString('Sign-in failed: access_denied'), '登录失败：访问被拒绝 (access_denied)');
  assert.strictEqual(api.translateString('Sign-in failed: context deadline exceeded'), '登录失败：网络连接超时（请检查网络或代理设置）');
  assert.strictEqual(
    api.translateString('OAuth callback error (access_denied): User denied access'),
    'OAuth 回调错误 (access_denied)：User denied access'
  );
  assert.strictEqual(
    api.translateString('[unavailable] Rpc failed due to xhr error'),
    '[服务不可用] 网络请求失败（请检查网络连接或代理设置）'
  );
  assert.strictEqual(
    api.translateString('Antigravity is not currently available in your country.'),
    'Antigravity 目前暂不支持你所在的地区。'
  );
  assert.strictEqual(
    api.translateString('Your organization has disabled Antigravity.'),
    '你的组织管理员已禁用 Antigravity。'
  );
  assert.strictEqual(
    api.translateString('Your account is not eligible for higher rate limits through Google AI Pro.'),
    '你的账号目前无法通过 Google AI Pro 获取更高的请求速率上限。'
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

  const ext1 = makeTextNode('Always open');
  const ext2 = makeTextNode(' ');
  const extCode = makeEl({ tag: 'CODE', text: 'mailto:' });
  const ext3 = makeTextNode(' links without asking');
  const spanExt = makeEl({ tag: 'SPAN', children: [ext1, ext2, extCode, ext3] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(ext1, 'Always open', spanExt), '始终打开');
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(ext3, ' links without asking', spanExt), ' 链接且不再询问');

  const ck1 = makeTextNode('Clearing cookies and site data for ');
  const ck2 = makeTextNode('example.com');
  const ck3 = makeTextNode(' may sign you out of this site.');
  const spanCk = makeEl({ tag: 'SPAN', children: [ck1, ck2, ck3] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(ck1, 'Clearing cookies and site data for ', spanCk), '清除 ');
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(ck3, ' may sign you out of this site.', spanCk), ' 的 Cookie 和网站数据可能会使你退出该网站的登录状态。');

  const ds1 = makeTextNode('Delete ');
  const ds2 = makeEl({ tag: 'STRONG', text: 'my-skill' });
  const ds3 = makeTextNode('? This removes it from your config directory.');
  const divDs = makeEl({ tag: 'DIV', children: [ds1, ds2, ds3] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(ds1, 'Delete ', divDs), '删除 ');
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(ds3, '? This removes it from your config directory.', divDs), '？这会将其从你的配置目录中移除。');

  const yp1 = makeTextNode('Your Plan: ');
  const yp2 = makeTextNode('Free');
  const divYp = makeEl({ tag: 'DIV', cls: 'font-medium', children: [yp1, yp2] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(yp2, 'Free', divYp), '免费版');
  yp1.nodeValue = '当前套餐：';
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(yp2, 'Free', divYp), '免费版');

  const inelig1 = makeTextNode('Sorry, this account is ineligible to use ');
  const inelig2 = makeTextNode('Antigravity');
  const divInelig = makeEl({ tag: 'DIV', children: [inelig1, inelig2] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(inelig1, 'Sorry, this account is ineligible to use ', divInelig), '抱歉，此账号无法使用 ');

  const conn1 = makeTextNode('3');
  const conn2 = makeTextNode(' on for this conversation');
  const divConn = makeEl({ tag: 'DIV', children: [conn1, conn2] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(conn2, ' on for this conversation', divConn), ' 项已在此会话中开启');

  const hold1 = makeTextNode('Hold ');
  const hold2 = makeEl({ tag: 'KBD', text: 'Shift' });
  const hold3 = makeTextNode(' to upload');
  const spanHold = makeEl({ tag: 'SPAN', children: [hold1, hold2, hold3] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(hold1, 'Hold ', spanHold), '按住 ');
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(hold3, ' to upload', spanHold), ' 上传');

  const ssh1 = makeTextNode('No hosts in ');
  const ssh2 = makeTextNode('~/.ssh/config');
  const ssh3 = makeTextNode(' yet. Type one above.');
  const pSsh = makeEl({ tag: 'P', children: [ssh1, ssh2, ssh3] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(ssh1, 'No hosts in ', pSsh), '在 ');
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(ssh3, ' yet. Type one above.', pSsh), ' 中暂无主机配置，可在上方直接输入。');

  const bwg1 = makeTextNode('Plugins are packaged collections of skills and MCPs to help the Agent');
  const bwg2 = makeTextNode(' ');
  const bwg3 = makeTextNode('in Antigravity ');
  const bwg4 = makeTextNode('work with Google developer products. You can always change your choices in Settings.');
  const pBwg = makeEl({ tag: 'P', children: [bwg1, bwg2, bwg3, bwg4] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(bwg3, 'in Antigravity ', pBwg), '，在 Antigravity 中 ');

  const err1 = makeTextNode('Error: ');
  const err2 = makeTextNode('network failure');
  const divErr = makeEl({ tag: 'DIV', children: [err1, err2] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(err1, 'Error: ', divErr), '错误：');

  const mcpSign1 = makeTextNode('Sign-in failed: ');
  const mcpSign2 = makeTextNode('token expired');
  const pMcpSign = makeEl({ tag: 'P', children: [mcpSign1, mcpSign2] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(mcpSign1, 'Sign-in failed: ', pMcpSign), '登录失败：');

  const tosLink1 = makeEl({ tag: 'A', text: 'Google Antigravity Terms of Service' });
  const tosAnd = makeTextNode('and');
  const tosLink2 = makeEl({ tag: 'A', text: 'Google Privacy Policy' });
  const spanTos = makeEl({ tag: 'SPAN', children: [makeTextNode('Allow Google... '), tosLink1, makeTextNode(' '), tosAnd, makeTextNode(' '), tosLink2] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(tosAnd, 'and', spanTos), '和');

  const faqReason = makeTextNode('此账号无法使用 Antigravity');
  const faqDot = makeTextNode('. ');
  const faqLead = makeTextNode('Learn more by visiting our');
  const pFaq = makeEl({ tag: 'P', children: [faqReason, faqDot, faqLead] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(faqDot, '. ', pFaq), '。');
  faqReason.nodeValue = '此账号无法使用 Antigravity。';
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(faqDot, '. ', pFaq), ' ');

  // Automation detail sentence, reads prefix, duplicate name/ID, and empty search split nodes
  const autoRuns1 = makeTextNode('Runs');
  const autoSp1 = makeTextNode(' ');
  const autoSchedLink = makeEl({ tag: 'BUTTON', text: 'daily at 上午 9:00' });
  const autoSp2 = makeTextNode(' ');
  const autoIn = makeTextNode('in');
  const autoSp3 = makeTextNode(' ');
  const autoProjLink = makeEl({ tag: 'BUTTON', text: 'MyProj' });
  const autoSp4 = makeTextNode(' ');
  const autoWith = makeTextNode('with');
  const autoSp5 = makeTextNode(' ');
  const autoModelLink = makeEl({ tag: 'BUTTON', text: 'Gemini 4 Neon (高)' });
  const autoSp6 = makeTextNode(' ');
  const autoLocal = makeTextNode('on this computer.');
  const autoSentenceP = makeEl({
    tag: 'P',
    children: [autoRuns1, autoSp1, autoSchedLink, autoSp2, autoIn, autoSp3, autoProjLink, autoSp4, autoWith, autoSp5, autoModelLink, autoSp6, autoLocal]
  });
  makeEl({ tag: 'DIV', testid: 'automation-settings', children: [autoSentenceP] });
  api.translateNode(autoSentenceP);
  assert.strictEqual(autoSentenceP.textContent, '运行计划：daily at 上午 9:00，位于 MyProj，使用 Gemini 4 Neon (高)（本机运行）。');

  const readsLead = makeTextNode('Reads ');
  const readsP = makeEl({ tag: 'P', testid: 'automation-instructions-reads', children: [readsLead, makeTextNode('notes.md')] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(readsLead, 'Reads ', readsP), '可读取：');

  const dupName1 = makeTextNode('An ');
  const dupName2 = makeTextNode('automation');
  const dupName3 = makeTextNode(' with this name already exists on this computer. Run it remotely, or go back and rename it.');
  const dupNameSpan = makeEl({ tag: 'SPAN', children: [dupName1, dupName2, dupName3] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(dupName1, 'An ', dupNameSpan), '此电脑上已存在同名的');
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(dupName3, dupName3.nodeValue, dupNameSpan), '。可改为远程运行，或返回修改名称。');

  const dupId1 = makeTextNode('An ');
  const dupId2 = makeTextNode('automation');
  const dupId3 = makeTextNode(' with the ID \u201c');
  const dupId4 = makeTextNode('daily-bug');
  const dupId5 = makeTextNode('\u201d already exists.');
  const dupIdSpan = makeEl({ tag: 'SPAN', children: [dupId1, dupId2, dupId3, dupId4, dupId5] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(dupId1, 'An ', dupIdSpan), '');
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(dupId3, ' with the ID \u201c', dupIdSpan), '（ID 为“');
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(dupId5, '\u201d already exists.', dupIdSpan), '”）已存在。');

  const noMatch1 = makeTextNode('No ');
  const noMatch2 = makeTextNode('automations');
  const noMatch3 = makeTextNode(' match \u201c');
  const noMatch4 = makeTextNode('foo');
  const noMatch5 = makeTextNode('\u201d.');
  const noMatchP = makeEl({ tag: 'P', children: [noMatch1, noMatch2, noMatch3, noMatch4, noMatch5] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(noMatch1, 'No ', noMatchP), '没有');
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(noMatch3, ' match \u201c', noMatchP), '匹配“');
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(noMatch5, '\u201d.', noMatchP), '”。');

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

  // 5b. Context-aware Settings page (LU) subtitle trailing-period removal vs OU/PU preservation
  const luSharedText = makeTextNode('Modify permissions for file, terminal, and MCP tools.');
  const luH2 = makeEl({ tag: 'H2', text: 'Tool Permissions' });
  const luSubDiv = makeEl({ tag: 'DIV', cls: 'text-muted-foreground bg-transparent', children: [luSharedText] });
  const luHeader = makeEl({ tag: 'DIV', cls: 'flex-1 flex flex-col gap-1 min-w-0 bg-transparent', children: [luH2, luSubDiv] });
  api.translateNode(luHeader);
  assert.strictEqual(luSharedText.nodeValue, '修改文件、终端与 MCP 工具的权限设置');
  api.translateNode(luHeader);
  assert.strictEqual(luSharedText.nodeValue, '修改文件、终端与 MCP 工具的权限设置');

  const ouSharedText = makeTextNode('Modify permissions for file, terminal, and MCP tools.');
  const ouSubSpan = makeEl({ tag: 'SPAN', cls: 'text-sm text-muted-foreground whitespace-pre-wrap', children: [ouSharedText] });
  api.translateNode(ouSubSpan);
  assert.strictEqual(ouSharedText.nodeValue, '修改文件、终端与 MCP 工具的权限设置。');

  const luCustBody = makeTextNode('Configure default behaviors, skills, and MCP servers.');
  const luCustSpace = makeTextNode(' ');
  const luCustLink = makeEl({ tag: 'A', children: [makeTextNode('Learn more')] });
  const luCustDot = makeTextNode('.');
  const luCustSpan = makeEl({ tag: 'SPAN', children: [luCustBody, luCustSpace, luCustLink, luCustDot] });
  const luCustHeader = makeEl({
    tag: 'DIV',
    cls: 'flex-1 flex flex-col gap-1 min-w-0 bg-transparent',
    children: [
      makeEl({ tag: 'H2', text: 'Customizations' }),
      makeEl({ tag: 'DIV', cls: 'text-muted-foreground bg-transparent', children: [luCustSpan] })
    ]
  });
  api.translateNode(luCustHeader);
  assert.strictEqual(luCustBody.nodeValue, '配置默认行为、技能与 MCP 服务。');
  assert.strictEqual(luCustLink.children[0].nodeValue, '了解更多');
  assert.strictEqual(luCustDot.nodeValue, '');

  const luNoLinkBody = makeTextNode('Configure default behaviors, skills, and MCP servers.');
  const luNoLinkHeader = makeEl({
    tag: 'DIV',
    cls: 'flex-1 flex flex-col gap-1 min-w-0 bg-transparent',
    children: [
      makeEl({ tag: 'H2', text: 'Customizations' }),
      makeEl({
        tag: 'DIV',
        cls: 'text-muted-foreground bg-transparent',
        children: [makeEl({ tag: 'SPAN', children: [luNoLinkBody] })]
      })
    ]
  });
  api.translateNode(luNoLinkHeader);
  assert.strictEqual(luNoLinkBody.nodeValue, '配置默认行为、技能与 MCP 服务');

  const puBody = makeTextNode('Configure global allowed and denied resource permissions.');
  const puSpace = makeTextNode(' ');
  const puLink = makeEl({ tag: 'A', children: [makeTextNode('Learn more')] });
  const puDot = makeTextNode('.');
  const puSpan = makeEl({ tag: 'SPAN', children: [puBody, puSpace, puLink, puDot] });
  const puSection = makeEl({
    tag: 'DIV',
    cls: 'flex flex-col gap-1',
    children: [
      makeEl({ tag: 'DIV', children: [makeEl({ tag: 'H3', text: 'Global Permissions' })] }),
      makeEl({ tag: 'DIV', cls: 'text-sm text-muted-foreground leading-relaxed', children: [puSpan] })
    ]
  });
  api.translateNode(puSection);
  assert.strictEqual(puBody.nodeValue, '配置全局允许和拒绝的资源访问权限。');
  assert.strictEqual(puLink.children[0].nodeValue, '了解更多');
  assert.strictEqual(puDot.nodeValue, '。');

  const optionalTextarea = makeEl({
    tag: 'TEXTAREA',
    attrs: { placeholder: '(Optional) Tell us more...' }
  });
  api.translateNode(optionalTextarea);
  assert.strictEqual(optionalTextarea.getAttribute('placeholder'), '（可选）详细说明你的反馈...');

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

  // 8.5 Live-firing MutationObserver convergence & storm protection verification
  runMutationConvergenceVerification(i18nCode);

  // 9. Version & README/baseline metadata consistency
  const verCheck = verifyVersionConsistency(projectRoot);
  assert.strictEqual(
    verCheck.ok,
    true,
    `Version metadata consistency failed:\n - ${verCheck.errors.join('\n - ')}`
  );

  console.log(`ALL VERIFY CHECKS PASSED! version=v${pkgVersion}, patch=v${verCheck.patchVersion}, baseline=v${verCheck.clientVersion}, EXACT_DICT=${Object.keys(api.EXACT_DICT).length}, ATTR_DICT=${Object.keys(api.ATTR_DICT).length}, asarEntries=${asarEntriesCount}`);
}

function createMockDomEnv() {
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
  DomNode.prototype.setAttribute = function (k, v) {
    const valStr = String(v);
    this._attrs[k] = valStr;
    if (k === 'class') this.className = valStr;
    if (k === 'id') this.id = valStr;
  };
  DomNode.prototype.removeAttribute = function (k) {
    delete this._attrs[k];
    if (k === 'class') this.className = '';
    if (k === 'id') this.id = '';
  };
  DomNode.prototype.matches = function (sel) {
    if (this.nodeType !== 1 || !sel) return false;
    const classes = (this.className || (this._attrs && this._attrs.class) || '').split(/\s+/).filter(Boolean);
    return sel.split(',').some((raw) => {
      let s = raw.trim();
      if (!s) return false;
      const tagM = s.match(/^([a-zA-Z0-9_-]+)/);
      if (tagM) {
        if (this.nodeName.toLowerCase() !== tagM[1].toLowerCase()) return false;
        s = s.slice(tagM[0].length);
      }
      while (s.length > 0) {
        if (s[0] === '.') {
          const clsM = s.match(/^\.([a-zA-Z0-9_-]+)/);
          if (!clsM || !classes.includes(clsM[1])) return false;
          s = s.slice(clsM[0].length);
        } else if (s[0] === '#') {
          const idM = s.match(/^#([a-zA-Z0-9_-]+)/);
          const nodeId = this.id || this._attrs.id || '';
          if (!idM || nodeId !== idM[1]) return false;
          s = s.slice(idM[0].length);
        } else if (s[0] === '[') {
          const attrM = s.match(/^\[([a-zA-Z0-9_-]+)(?:(\*)?="([^"]*)")?\]/);
          if (!attrM) return false;
          const attrName = attrM[1];
          const op = attrM[2];
          const expected = attrM[3];
          const has = Object.prototype.hasOwnProperty.call(this._attrs, attrName);
          if (!has) return false;
          if (expected !== undefined) {
            const actual = String(this._attrs[attrName]);
            if (op === '*' ? !actual.includes(expected) : actual !== expected) return false;
          }
          s = s.slice(attrM[0].length);
        } else {
          return false;
        }
      }
      return true;
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
  DomNode.prototype.querySelector = function (sel) {
    const visit = (node) => {
      if (node !== this && node.nodeType === 1 && node.matches(sel)) return node;
      for (const c of node.childNodes) {
        const hit = visit(c);
        if (hit) return hit;
      }
      return null;
    };
    return visit(this);
  };
  DomNode.prototype.querySelectorAll = function (sel) {
    const out = [];
    const visit = (node) => {
      if (node !== this && node.nodeType === 1 && node.matches(sel)) out.push(node);
      for (const c of node.childNodes) visit(c);
    };
    visit(this);
    return out;
  };
  DomNode.prototype.addEventListener = function (ev, fn) {
    this._listeners = this._listeners || {};
    this._listeners[ev] = this._listeners[ev] || [];
    this._listeners[ev].push(fn);
  };
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

  return { DomNode, DomElement, makeText };
}

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
}

async function runOtaControllerVerification() {
  const crypto = require('crypto');
  const http = require('http');
  const { buildOtaPack, validateOtaRules } = require('./build_ota_pack');
  const { createOtaController } = require('./ota/i18n_ota_main');

  // 1. Validate buildOtaPack & declarative rule guards
  const dry = buildOtaPack({ dryRun: true, notes: 'verify-smoke' });
  assert.strictEqual(dry.manifest.schemaVersion, 1);
  assert(/^[a-f0-9]{64}$/.test(dry.manifest.sha256));
  assert(dry.manifest.dictCount >= 4000, 'OTA pack dictCount sanity check');
  assert.throws(() => validateOtaRules([{ pattern: '(a+)+$', flags: 'i', replace: 'x' }]), /嵌套量词/);
  assert.throws(() => validateOtaRules([{ pattern: '^a$', flags: 'g', replace: 'x' }]), /flags/);
  assert.strictEqual(validateOtaRules([{ id: 'ok', pattern: '^Hello (.+)$', flags: 'i', replace: '你好 $1' }]).length, 1);

  // 2. Spin up local mock HTTP OTA server (primary fails 500 -> secondary serves valid manifest + pack with ETag)
  const samplePack = {
    schemaVersion: 1,
    packVersion: '2026.12.01.120000',
    builtAt: '2026-12-01T12:00:00.000Z',
    engineVersion: '0.3.0',
    minEngineVersion: '0.3.0',
    dictionary: {
      'OTA Live Test Key': 'OTA 实时测试词条',
      'Copy Link': '复制链接（OTA）'
    },
    attrDict: {
      'OTA Attr Tip': 'OTA 属性提示'
    },
    preserveList: ['Antigravity'],
    rules: [
      { id: 'r1', pattern: '^Deploy\\s+(\\d+)$', flags: 'i', replace: '部署 $1' }
    ]
  };
  const samplePackText = JSON.stringify(samplePack);
  const sampleSha = crypto.createHash('sha256').update(samplePackText, 'utf8').digest('hex');
  const sampleManifest = {
    schemaVersion: 1,
    packVersion: samplePack.packVersion,
    builtAt: samplePack.builtAt,
    engineVersion: '0.3.0',
    minEngineVersion: '0.3.0',
    packFile: 'dict-pack.json',
    sha256: sampleSha,
    dictCount: 2,
    attrCount: 1,
    ruleCount: 1,
    releaseUrl: 'https://github.com/downey37/antigravity-zh-cn/releases/latest',
    notes: 'mock ota update'
  };

  let mode = 'normal';
  let manifestEtag = '"etag-v1"';
  let packDownloads = 0;

  const server = http.createServer((req, res) => {
    const cleanUrl = (req.url || '').split('?')[0];
    if (cleanUrl.startsWith('/primary/')) {
      res.writeHead(500);
      res.end('primary down');
      return;
    }
    if (cleanUrl === '/backup/manifest.json') {
      if (mode === 'incompatible') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...sampleManifest, engineVersion: '9.9.9', minEngineVersion: '9.9.9' }));
        return;
      }
      if (mode === 'tampered') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...sampleManifest, packVersion: '2026.12.02.000000', builtAt: '2026-12-02T00:00:00.000Z', sha256: '0'.repeat(64) }));
        return;
      }
      if (req.headers['if-none-match'] === manifestEtag) {
        res.writeHead(304, { ETag: manifestEtag });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: manifestEtag });
      res.end(JSON.stringify(sampleManifest));
      return;
    }
    if (cleanUrl === '/backup/dict-pack.json') {
      packDownloads++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(samplePackText);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrls = [`http://127.0.0.1:${port}/primary`, `http://127.0.0.1:${port}/backup`];
  const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-i18n-ota-test-'));

  try {
    const mainExecs = [];
    const pluginFrameExecs = [];
    const extFrameExecs = [];
    const mockWc = {
      isDestroyed: () => false,
      getURL: () => 'https://antigravity.local/app',
      once: () => {},
      executeJavaScript: (code) => { mainExecs.push(code); return Promise.resolve(); },
      mainFrame: {
        framesInSubtree: [
          { url: 'plugin://swarm/index.html', executeJavaScript: (code) => { pluginFrameExecs.push(code); return Promise.resolve(); } },
          { url: 'https://example.com/third-party', executeJavaScript: (code) => { extFrameExecs.push(code); return Promise.resolve(); } }
        ]
      }
    };
    mockWc.mainFrame.framesInSubtree.unshift(mockWc.mainFrame);

    const ctrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls,
      minDictCount: 1,
      minAttrCount: 1,
      builtinMeta: {
        schemaVersion: 1,
        engineVersion: '0.3.0',
        packVersion: '2026.11.24.000000',
        builtAt: '2026-11-24T00:00:00.000Z'
      },
      env: {}
    });
    ctrl.registerWebContents(mockWc);

    // 2a. Primary fails -> fallback succeeds -> broadcasts to main + plugin subframe only (never external https)
    const r1 = await ctrl.checkForUpdates({ manual: false });
    assert.strictEqual(r1.status, 'updated');
    assert.strictEqual(r1.packVersion, samplePack.packVersion);
    assert.strictEqual(packDownloads, 1);
    assert.strictEqual(mainExecs.length, 1);
    assert.strictEqual(pluginFrameExecs.length, 1);
    assert.strictEqual(extFrameExecs.length, 0, 'OTA broadcast must never inject into third-party external subframes');
    assert.strictEqual(ctrl.getNativeContextDict().exactMap.get('OTA Live Test Key'), 'OTA 实时测试词条');

    // 2b. Second background check hits ETag 304 without downloading pack again
    const r2 = await ctrl.checkForUpdates({ manual: false });
    assert.strictEqual(r2.status, 'up_to_date');
    assert.strictEqual(packDownloads, 1);

    // 2c. Tampered SHA-256 is rejected and previous valid pack remains active
    mode = 'tampered';
    const r3 = await ctrl.checkForUpdates({ manual: false });
    assert.strictEqual(r3.status, 'error');
    assert.strictEqual(ctrl.getActiveVersion(), samplePack.packVersion);

    // 2d. Engine upgrade required when minEngineVersion > local engineVersion
    mode = 'incompatible';
    const r4 = await ctrl.checkForUpdates({ manual: false });
    assert.strictEqual(r4.status, 'engine_upgrade_required');
    assert.strictEqual(ctrl.getActiveVersion(), samplePack.packVersion);

    // 2e. Stale cache guard: newer local built-in baseline ignores older cached OTA pack
    const newerCtrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls,
      minDictCount: 1,
      minAttrCount: 1,
      builtinMeta: {
        schemaVersion: 1,
        engineVersion: '0.2.5',
        packVersion: '2027.01.01.000000',
        builtAt: '2027-01-01T00:00:00.000Z'
      },
      env: {}
    });
    assert.strictEqual(newerCtrl.loadCachedPackSync(), null, 'Stale OTA cache older than built-in baseline must be ignored');

    // 2f. ANTIGRAVITY_I18N_NO_OTA=1 completely disables network calls
    const disabledCtrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls,
      fetchText: () => { throw new Error('Should never fetch when NO_OTA=1'); },
      env: { ANTIGRAVITY_I18N_NO_OTA: '1' }
    });
    const rDisabled = await disabledCtrl.checkForUpdates({ manual: false });
    assert.strictEqual(rDisabled.status, 'disabled');

    // 2g. Persisted Chinese <-> English toggle broadcasts to main + eligible plugin subframes only & remembers across restarts
    const langEvents = [];
    const unsubscribe = ctrl.onLanguageChange((enabled) => langEvents.push(enabled));
    assert.strictEqual(ctrl.isI18nEnabled(), true);
    assert.strictEqual(ctrl.t('中文', 'English'), '中文');
    assert.strictEqual(ctrl.getInitialStateScript(), 'window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ = true;\nwindow.__ANTIGRAVITY_I18N_AUTO_MT_ENABLED__ = true;');
    const preToggleMainCount = mainExecs.length;
    const preTogglePluginCount = pluginFrameExecs.length;
    assert.strictEqual(ctrl.setI18nEnabled(false), false);
    assert.strictEqual(ctrl.isI18nEnabled(), false);
    assert.strictEqual(ctrl.t('中文', 'English'), 'English');
    assert.strictEqual(ctrl.getInitialStateScript(), 'window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ = false;\nwindow.__ANTIGRAVITY_I18N_AUTO_MT_ENABLED__ = true;');
    assert.deepStrictEqual(langEvents, [false]);
    assert.strictEqual(mainExecs.length, preToggleMainCount + 1);
    assert(mainExecs[mainExecs.length - 1].includes('__antigravitySetI18nEnabled(false)'));
    assert.strictEqual(pluginFrameExecs.length, preTogglePluginCount + 1);
    assert.strictEqual(extFrameExecs.length, 0);

    const savedState1 = JSON.parse(fs.readFileSync(path.join(tmpCacheDir, 'state.json'), 'utf8'));
    assert.strictEqual(savedState1.i18nEnabled, false, 'state.json must persist i18nEnabled=false');
    const relaunchedOffCtrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls,
      env: {}
    });
    assert.strictEqual(relaunchedOffCtrl.isI18nEnabled(), false, 'New controller after restart must remember English preference');
    assert.strictEqual(relaunchedOffCtrl.t('中文', 'English'), 'English');
    assert.strictEqual(relaunchedOffCtrl.getInitialStateScript(), 'window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ = false;\nwindow.__ANTIGRAVITY_I18N_AUTO_MT_ENABLED__ = true;');

    assert.strictEqual(ctrl.toggleI18nEnabled(), true);
    assert.deepStrictEqual(langEvents, [false, true]);
    assert.strictEqual(ctrl.t('中文', 'English'), '中文');
    assert(mainExecs[mainExecs.length - 1].includes('__antigravitySetI18nEnabled(true)'));
    unsubscribe();

    const relaunchedOnCtrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls,
      env: {}
    });
    assert.strictEqual(relaunchedOnCtrl.isI18nEnabled(), true, 'New controller after toggling back must remember Chinese preference');

    const envDisabledCtrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls,
      env: { ANTIGRAVITY_I18N_DISABLED: '1' }
    });
    assert.strictEqual(envDisabledCtrl.isI18nEnabled(), false);
    assert.strictEqual(envDisabledCtrl.getInitialStateScript(), 'window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ = false;\nwindow.__ANTIGRAVITY_I18N_AUTO_MT_ENABLED__ = true;');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  }
}

async function runGuardProxyAndRestoreVerification() {
  const {
    resolveProxyEndpoints,
    parseWinProxyServer,
    extractAndStripProxyArgs,
    detectActiveProxy,
    buildProxyLaunchConfig
  } = require('./guard_launch');
  const { restoreAsar } = require('./restore_antigravity');
  const { hasAnyPatchArtifacts } = require('./i18n_core');

  // 1. Proxy parsing & launch config helpers
  assert.deepStrictEqual(resolveProxyEndpoints('127.0.0.1:7897'), {
    http: 'http://127.0.0.1:7897',
    socks: 'socks5://127.0.0.1:7897'
  });
  assert.deepStrictEqual(resolveProxyEndpoints('socks5://127.0.0.1:10808'), {
    http: 'http://127.0.0.1:10808',
    socks: 'socks5://127.0.0.1:10808'
  });
  assert.strictEqual(parseWinProxyServer('127.0.0.1:7897'), '127.0.0.1:7897');
  assert.strictEqual(parseWinProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7897'), '127.0.0.1:7897');
  assert.strictEqual(parseWinProxyServer('socks=127.0.0.1:10808'), 'socks5://127.0.0.1:10808');

  const stripped = extractAndStripProxyArgs(['--foo', '--proxy-server=http://127.0.0.1:8888', '--proxy-server', '127.0.0.1:9999', '--bar']);
  assert.deepStrictEqual(stripped, { cleaned: ['--foo', '--bar'], explicitProxy: '127.0.0.1:9999' });

  const activeCfg = buildProxyLaunchConfig(
    { http: 'http://127.0.0.1:7897', socks: 'socks5://127.0.0.1:7897' },
    ['--flag'],
    { ELECTRON_RUN_AS_NODE: '1', PATH: 'x' }
  );
  assert(activeCfg.args.includes('--proxy-server=http://127.0.0.1:7897'));
  assert(activeCfg.args.some((a) => a.startsWith('--proxy-bypass-list=')));
  assert.strictEqual(activeCfg.env.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.strictEqual(activeCfg.env.ALL_PROXY, 'socks5://127.0.0.1:7897');
  assert.strictEqual(activeCfg.env.ELECTRON_RUN_AS_NODE, undefined, 'ELECTRON_RUN_AS_NODE must be stripped before launching GUI exe');

  const directCfg = buildProxyLaunchConfig(null, ['--flag'], {
    ELECTRON_RUN_AS_NODE: '1',
    HTTP_PROXY: 'http://stale:1234',
    https_proxy: 'http://stale:1234',
    ALL_PROXY: 'socks5://stale:1234'
  });
  assert.strictEqual(directCfg.env.HTTP_PROXY, undefined);
  assert.strictEqual(directCfg.env.https_proxy, undefined);
  assert.strictEqual(directCfg.env.ALL_PROXY, undefined);
  assert.strictEqual(directCfg.env.ELECTRON_RUN_AS_NODE, undefined);

  // 2. Real TCP socket probe for detectActiveProxy priority & opt-out
  const tcpServer = net.createServer();
  await new Promise((resolve) => tcpServer.listen(0, '127.0.0.1', resolve));
  const openPort = tcpServer.address().port;
  try {
    const probed = await detectActiveProxy('', {
      env: {},
      readWindowsSystemProxy: () => '',
      fallbackCandidates: ['http://127.0.0.1:1', `http://127.0.0.1:${openPort}`]
    });
    assert.deepStrictEqual(probed, {
      http: `http://127.0.0.1:${openPort}`,
      socks: `socks5://127.0.0.1:${openPort}`
    });

    const sysProxyWin = await detectActiveProxy(`127.0.0.1:${openPort}`, {
      env: {},
      readWindowsSystemProxy: () => `127.0.0.1:${openPort}`,
      fallbackCandidates: ['http://127.0.0.1:1']
    });
    assert.strictEqual(sysProxyWin.http, `http://127.0.0.1:${openPort}`);

    const envOverride = await detectActiveProxy('', {
      env: { ANTIGRAVITY_PROXY: 'http://127.0.0.1:9001' },
      readWindowsSystemProxy: () => `127.0.0.1:${openPort}`
    });
    assert.strictEqual(envOverride.http, 'http://127.0.0.1:9001');

    const envDirect = await detectActiveProxy('', {
      env: { ANTIGRAVITY_PROXY: 'direct' },
      readWindowsSystemProxy: () => `127.0.0.1:${openPort}`
    });
    assert.strictEqual(envDirect, null);

    const autoDisabled = await detectActiveProxy('', {
      env: { ANTIGRAVITY_AUTO_PROXY: '0' },
      readWindowsSystemProxy: () => `127.0.0.1:${openPort}`,
      fallbackCandidates: [`http://127.0.0.1:${openPort}`]
    });
    assert.strictEqual(autoDisabled, null);
  } finally {
    await new Promise((resolve) => tcpServer.close(resolve));
  }

  // 3. Cross-platform path resolution
  const winPaths = resolveInstallPaths({ LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' }, 'win32');
  assert(winPaths.asarPath.endsWith('Programs\\antigravity\\resources\\app.asar'));
  const macPaths = resolveInstallPaths(
    { HOME: '/Users/alice' },
    'darwin',
    { existsSync: (p) => p === '/Applications/Antigravity.app' }
  );
  assert.strictEqual(macPaths.appBundle, '/Applications/Antigravity.app');
  assert.strictEqual(macPaths.asarPath, '/Applications/Antigravity.app/Contents/Resources/app.asar');
  assert.strictEqual(macPaths.exePath, '/Applications/Antigravity.app/Contents/MacOS/Antigravity');
  const linuxPaths = resolveInstallPaths(
    {},
    'linux',
    { existsSync: (p) => p === '/opt/Antigravity/resources' }
  );
  assert.strictEqual(linuxPaths.asarPath, '/opt/Antigravity/resources/app.asar');

  // 4. Restore workflow in isolated temporary directory
  const tmpRestoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-restore-test-'));
  try {
    const origDir = path.join(tmpRestoreRoot, 'orig');
    const patchedDir = path.join(tmpRestoreRoot, 'patched');
    fs.mkdirSync(path.join(origDir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(patchedDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(origDir, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.34.0' }));
    fs.writeFileSync(path.join(origDir, 'dist', 'main.js'), 'console.log("official");');
    fs.writeFileSync(path.join(patchedDir, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.34.0' }));
    fs.writeFileSync(path.join(patchedDir, 'dist', 'main.js'), 'console.log("patched");');
    fs.writeFileSync(path.join(patchedDir, 'dist', 'i18n.js'), '// patched');

    const fakeAsar = path.join(tmpRestoreRoot, 'app.asar');
    const fakeBak = path.join(tmpRestoreRoot, 'app.asar.bak');
    await asar.createPackage(origDir, fakeBak);
    await asar.createPackage(patchedDir, fakeAsar);
    assert.strictEqual(hasAnyPatchArtifacts(fakeAsar), true);
    assert.strictEqual(hasAnyPatchArtifacts(fakeBak), false);

    const restored = await restoreAsar({ asarPath: fakeAsar, backupAsar: fakeBak, platform: 'win32' });
    assert.strictEqual(restored.status, 'restored');
    assert.strictEqual(restored.version, '2.34.0');
    assert.strictEqual(hasAnyPatchArtifacts(fakeAsar), false);
    assert(asar.extractFile(fakeAsar, path.join('dist', 'main.js')).toString('utf8').includes('official'));

    // Without backup when already original -> already_original
    fs.unlinkSync(fakeBak);
    const alreadyOrig = await restoreAsar({ asarPath: fakeAsar, backupAsar: fakeBak, platform: 'win32' });
    assert.strictEqual(alreadyOrig.status, 'already_original');

    // Refuses to restore from a tampered/patched backup
    await asar.createPackage(patchedDir, fakeBak);
    await assert.rejects(
      () => restoreAsar({ asarPath: fakeAsar, backupAsar: fakeBak, platform: 'win32' }),
      /已被修改/
    );
  } finally {
    try { asar.uncacheAll(); } catch (_) {}
    fs.rmSync(tmpRestoreRoot, { recursive: true, force: true });
  }
}

async function runAutoMtVerification() {
  const http = require('http');
  const {
    isEligibleMtText,
    protectDynamicMtTerms,
    restoreDynamicMtTerms,
    createOtaController
  } = require('./ota/i18n_ota_main');
  const preserveList = JSON.parse(fs.readFileSync(path.join(projectRoot, 'assets', 'preserve_list.json'), 'utf8'));

  // 1. Brand/model term masking, restoration, and eligibility guards
  const sampleBody = 'Both Carbon and Argon are now included as part of the entire Gemini entitlement, so you can use them for much longer.';
  const { masked, placeholders } = protectDynamicMtTerms(sampleBody, preserveList);
  assert.deepStrictEqual(placeholders, ['Carbon', 'Argon', 'Gemini']);
  assert.strictEqual(
    masked,
    'Both AGYTERM0X and AGYTERM1X are now included as part of the entire AGYTERM2X entitlement, so you can use them for much longer.'
  );
  const restored = restoreDynamicMtTerms(
    'AGYTERM0X和AGYTERM1X现已包含在整个AGYTERM2X权益中，因此你可以使用它们更长时间。',
    placeholders
  );
  assert.strictEqual(
    restored,
    'Carbon 和 Argon 现已包含在整个 Gemini 权益中，因此你可以使用它们更长时间。'
  );
  assert.strictEqual(restoreDynamicMtTerms('missing placeholder text 中文', placeholders), null);
  assert.strictEqual(restoreDynamicMtTerms('AGYTERM0X and AGYTERM99X 中文', placeholders), null);

  assert.strictEqual(isEligibleMtText(sampleBody), true);
  assert.strictEqual(isEligibleMtText('已经是中文内容'), false);
  assert.strictEqual(isEligibleMtText('SingleWord'), false);
  assert.strictEqual(isEligibleMtText('https://example.com/docs/page'), false);
  assert.strictEqual(isEligibleMtText('C:\\Users\\Alice\\project\\file.js'), false);
  assert.strictEqual(isEligibleMtText('{"key": "value"}'), false);
  assert.strictEqual(isEligibleMtText('word '.repeat(150)), false);

  // 2. Main-process auto-MT controller + mock HTTP (google-gtx & openai) + persistent cache + dedup + toggle
  let gtxCalls = 0;
  let openaiCalls = 0;
  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    if (parsedUrl.pathname === '/gtx') {
      gtxCalls++;
      const q = parsedUrl.searchParams.get('q') || '';
      const out = q.includes('AGYTERM0X') && q.includes('AGYTERM1X') && q.includes('AGYTERM2X')
        ? 'AGYTERM0X和AGYTERM1X现已包含在整个AGYTERM2X权益中，因此你可以使用它们更长时间。'
        : '延迟重试翻译结果：' + q;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([[[out, q]]]));
      return;
    }
    if (parsedUrl.pathname === '/openai') {
      openaiCalls++;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.strictEqual(req.headers.authorization, 'Bearer test-key');
        assert.strictEqual(body.model, 'test-model');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: 'AGYTERM0X已升级完成。' } }]
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-auto-mt-test-'));

  try {
    const broadcastExecs = [];
    const mockWc = {
      isDestroyed: () => false,
      getURL: () => 'https://antigravity.local/app',
      once: () => {},
      executeJavaScript: (code) => { broadcastExecs.push(code); return Promise.resolve(); },
      mainFrame: { framesInSubtree: [] }
    };

    const ctrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls: [`http://127.0.0.1:${port}/unused`],
      mtUrl: `http://127.0.0.1:${port}/gtx`,
      preserveList,
      env: {}
    });
    ctrl.registerWebContents(mockWc);

    // 2a. Concurrent calls deduplicate to 1 HTTP request & persist to dynamic-mt-cache.json
    const [mt1, mt2] = await Promise.all([
      ctrl.translateDynamicText(sampleBody),
      ctrl.translateDynamicText(sampleBody)
    ]);
    assert.strictEqual(mt1.status, 'ok');
    assert.strictEqual(mt1.translated, 'Carbon 和 Argon 现已包含在整个 Gemini 权益中，因此你可以使用它们更长时间。');
    assert.strictEqual(mt2.translated, mt1.translated);
    assert.strictEqual(gtxCalls, 1, 'Concurrent identical requests must deduplicate into 1 HTTP call');

    const diskCache = JSON.parse(fs.readFileSync(path.join(tmpCacheDir, 'dynamic-mt-cache.json'), 'utf8'));
    assert.strictEqual(diskCache.entries[sampleBody].zh, mt1.translated);

    // 2b. New controller after restart serves directly from disk cache with 0 HTTP requests
    const ctrl2 = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls: [`http://127.0.0.1:${port}/unused`],
      mtUrl: `http://127.0.0.1:${port}/gtx`,
      preserveList,
      env: {}
    });
    const mtCached = await ctrl2.translateDynamicText(sampleBody);
    assert.strictEqual(mtCached.status, 'ok');
    assert.strictEqual(mtCached.cached, true);
    assert.strictEqual(mtCached.translated, mt1.translated);
    assert.strictEqual(gtxCalls, 1, 'Restarted controller must serve from disk cache without HTTP request');

    // 2c. OpenAI-compatible POST provider
    const openaiCtrl = createOtaController({
      electron: null,
      cacheDir: fs.mkdtempSync(path.join(tmpCacheDir, 'oa-')),
      baseUrls: [`http://127.0.0.1:${port}/unused`],
      mtProvider: 'openai',
      mtUrl: `http://127.0.0.1:${port}/openai`,
      mtApiKey: 'test-key',
      mtModel: 'test-model',
      preserveList,
      env: {}
    });
    const oaRes = await openaiCtrl.translateDynamicText('Gemini 4 Carbon upgrade is ready for all users.');
    assert.strictEqual(oaRes.status, 'ok');
    assert.strictEqual(oaRes.translated, 'Gemini 4 Carbon 已升级完成。');
    assert.strictEqual(openaiCalls, 1);

    // 2d. Toggle autoMtEnabled persists to state.json, updates getInitialStateScript, and respects NO_OTA / AUTO_MT=0
    const autoMtEvents = [];
    const unsubAuto = ctrl.onAutoMtChange((val) => autoMtEvents.push(val));
    assert.strictEqual(ctrl.setAutoMtEnabled(false), false);
    assert.deepStrictEqual(autoMtEvents, [false]);
    assert(broadcastExecs.some((c) => c.includes('__antigravitySetAutoMtEnabled(false)')));
    assert.strictEqual(
      ctrl.getInitialStateScript(),
      'window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ = true;\nwindow.__ANTIGRAVITY_I18N_AUTO_MT_ENABLED__ = false;'
    );
    const disabledRes = await ctrl.translateDynamicText('Another new announcement message here.');
    assert.strictEqual(disabledRes.status, 'disabled');
    assert.strictEqual(gtxCalls, 1);

    assert.strictEqual(ctrl.toggleAutoMtEnabled(), true);
    assert.deepStrictEqual(autoMtEvents, [false, true]);
    unsubAuto();

    const noOtaCtrl = createOtaController({
      electron: null,
      cacheDir: fs.mkdtempSync(path.join(tmpCacheDir, 'no-ota-')),
      baseUrls: [`http://127.0.0.1:${port}/unused`],
      fetchText: () => { throw new Error('Should never fetch when NO_OTA=1'); },
      env: { ANTIGRAVITY_I18N_NO_OTA: '1' }
    });
    const noOtaMt = await noOtaCtrl.translateDynamicText('Fresh announcement text here.');
    assert.strictEqual(noOtaMt.status, 'disabled');

    const envAutoOffCtrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls: [`http://127.0.0.1:${port}/unused`],
      env: { ANTIGRAVITY_I18N_AUTO_MT: '0' }
    });
    assert.strictEqual(envAutoOffCtrl.isAutoMtEnabled(), false);

    // 3. Renderer VM DOM integration test (whitelist isolation, sync + async MT, [中 | EN] & Auto-MT toggle reversibility)
    const i18nCode = localOnly
      ? fs.readFileSync(path.join(projectRoot, 'build', 'i18n.js'), 'utf8')
      : asar.extractFile(deployedAsar, path.join('dist', 'i18n.js')).toString('utf8');
    const { DomNode, DomElement, makeText } = createMockDomEnv();
    const html = new DomElement('HTML');
    html.isConnected = true;
    const body = new DomElement('BODY');
    html.appendChild(body);
    const rootDiv = new DomElement('DIV');
    rootDiv.id = 'root';
    body.appendChild(rootDiv);

    const ipcRequests = [];
    const sandbox = {
      console, setTimeout, clearTimeout,
      Node: DomNode,
      Element: DomElement,
      NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
      MutationObserver: class { observe() {} },
      requestAnimationFrame: (cb) => { cb(); return 1; },
      window: {
        location: { protocol: 'app:' },
        history: {},
        addEventListener() {},
        antigravityI18nOta: {
          translateDynamicText: (txt) => {
            ipcRequests.push(txt);
            return ctrl2.translateDynamicText(txt);
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
        querySelectorAll: () => [],
        addEventListener: () => {}
      }
    };
    sandbox.window.document = sandbox.document;
    vm.runInNewContext(i18nCode, sandbox);

    // 3a. Non-whitelisted div & user chat message must never trigger auto-MT IPC
    const normalDiv = new DomElement('DIV');
    const normalText = makeText('Some completely arbitrary untranslated sentence in a regular div.');
    normalDiv.appendChild(normalText);
    rootDiv.appendChild(normalDiv);

    const userMsg = new DomElement('DIV');
    userMsg.setAttribute('data-testid', 'user-message-content');
    const userMsgText = makeText('Please explain how Carbon and Argon models work in detail.');
    userMsg.appendChild(userMsgText);
    rootDiv.appendChild(userMsg);
    assert.strictEqual(ipcRequests.length, 0, 'Non-whitelisted containers must never trigger auto-MT');

    // 3b. Whitelisted nux-card: title & button translate synchronously; body triggers 1 async MT call
    const nuxCard = new DomElement('DIV');
    nuxCard.setAttribute('data-testid', 'nux-card');
    const nuxTitle = new DomElement('DIV');
    const nuxTitleText = makeText('Gemini 4 Carbon now available!');
    nuxTitle.appendChild(nuxTitleText);
    const nuxBody = new DomElement('DIV');
    const nuxBodyText = makeText(sampleBody);
    nuxBody.appendChild(nuxBodyText);
    const nuxBtn = new DomElement('BUTTON');
    const nuxBtnText = makeText('Dismiss');
    nuxBtn.appendChild(nuxBtnText);
    nuxCard.appendChild(nuxTitle);
    nuxCard.appendChild(nuxBody);
    nuxCard.appendChild(nuxBtn);
    rootDiv.appendChild(nuxCard);

    assert.strictEqual(nuxTitleText.nodeValue, 'Gemini 4 Carbon 现已开放！');
    assert.strictEqual(nuxBtnText.nodeValue, '忽略');
    assert.strictEqual(ipcRequests.length, 1, 'Only unmatched NUX body should invoke translateDynamicText');
    assert.strictEqual(ipcRequests[0], sampleBody);

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.strictEqual(nuxBodyText.nodeValue, 'Carbon 和 Argon 现已包含在整个 Gemini 权益中，因此你可以使用它们更长时间。');

    // 3c. Global [中 | EN] toggle restores all NUX nodes cleanly and re-applies synchronously from memory cache
    sandbox.window.__antigravitySetI18nEnabled(false);
    assert.strictEqual(nuxTitleText.nodeValue, 'Gemini 4 Carbon now available!');
    assert.strictEqual(nuxBodyText.nodeValue, sampleBody);
    assert.strictEqual(nuxBtnText.nodeValue, 'Dismiss');

    sandbox.window.__antigravitySetI18nEnabled(true);
    assert.strictEqual(nuxTitleText.nodeValue, 'Gemini 4 Carbon 现已开放！');
    assert.strictEqual(nuxBodyText.nodeValue, 'Carbon 和 Argon 现已包含在整个 Gemini 权益中，因此你可以使用它们更长时间。');
    assert.strictEqual(nuxBtnText.nodeValue, '忽略');
    assert.strictEqual(ipcRequests.length, 1, 'Re-enabling Chinese must reuse renderer memory cache without extra IPC');

    // 3d. Auto-MT toggle off restores only auto-MT nodes while preserving local title/button translations
    sandbox.window.__antigravitySetAutoMtEnabled(false);
    assert.strictEqual(nuxBodyText.nodeValue, sampleBody);
    assert.strictEqual(nuxTitleText.nodeValue, 'Gemini 4 Carbon 现已开放！');
    assert.strictEqual(nuxBtnText.nodeValue, '忽略');

    sandbox.window.__antigravitySetAutoMtEnabled(true);
    assert.strictEqual(nuxBodyText.nodeValue, 'Carbon 和 Argon 现已包含在整个 Gemini 权益中，因此你可以使用它们更长时间。');
    assert.strictEqual(ipcRequests.length, 1);

    // 3e. Onboarding / auth-error / persona auto-MT whitelist positive & negative guards
    const authErrBox = new DomElement('DIV');
    authErrBox.setAttribute('data-testid', 'onboarding-auth-code-error');
    const authErrText = makeText('Server returned an unexpected authorization error code.');
    authErrBox.appendChild(authErrText);
    rootDiv.appendChild(authErrBox);
    assert(ipcRequests.includes('Server returned an unexpected authorization error code.'), 'onboarding-auth-code-error must trigger auto-MT');

    const blockedScreen = new DomElement('DIV');
    blockedScreen.setAttribute('data-testid', 'jetbox-access-blocked-screen');
    const blockedMsg = makeText('Your workspace administrator blocked desktop access.');
    blockedScreen.appendChild(blockedMsg);
    rootDiv.appendChild(blockedScreen);
    assert(ipcRequests.includes('Your workspace administrator blocked desktop access.'), 'jetbox-access-blocked-screen must trigger auto-MT');

    const personaDesc = new DomElement('P');
    personaDesc.setAttribute('data-testid', 'persona-description');
    const personaText = makeText('Build software faster with autonomous coding workflows.');
    personaDesc.appendChild(personaText);
    rootDiv.appendChild(personaDesc);
    assert(ipcRequests.includes('Build software faster with autonomous coding workflows.'), 'persona-description must trigger auto-MT');

    const brandShell = new DomElement('DIV');
    brandShell.setAttribute('data-testid', 'onboarding-brand-shell');
    const brandP = new DomElement('P');
    const brandPText = makeText('Unmatched server onboarding guidance message.');
    brandP.appendChild(brandPText);
    const brandMono = new DomElement('SPAN');
    brandMono.className = 'font-mono';
    const brandMonoText = makeText('locations/global/workforcePools/custom-pool');
    brandMono.appendChild(brandMonoText);
    const brandInput = new DomElement('INPUT');
    const brandInputText = makeText('Raw input placeholder value inside shell');
    brandInput.appendChild(brandInputText);
    brandShell.appendChild(brandP);
    brandShell.appendChild(brandMono);
    brandShell.appendChild(brandInput);
    rootDiv.appendChild(brandShell);
    assert(ipcRequests.includes('Unmatched server onboarding guidance message.'), 'p inside onboarding-brand-shell must trigger auto-MT');
    assert(!ipcRequests.includes('locations/global/workforcePools/custom-pool'), '.font-mono inside onboarding-brand-shell must NOT trigger auto-MT');
    assert(!ipcRequests.includes('Raw input placeholder value inside shell'), 'input inside onboarding-brand-shell must NOT trigger auto-MT');

    // 3f. Customizations marketplace & plugin detail auto-MT whitelist positive & negative guards
    const pluginCard = new DomElement('DIV');
    pluginCard.setAttribute('data-testid', 'customization-card');
    const cardTitleWrap = new DomElement('DIV');
    cardTitleWrap.className = 'font-medium text-foreground truncate';
    const cardTitleText = makeText('New Future Brand');
    cardTitleWrap.appendChild(cardTitleText);
    const cardDescWrap = new DomElement('DIV');
    cardDescWrap.className = 'text-sm text-muted-foreground truncate';
    const cardDescText = makeText('Unmatched future plugin description for marketplace cards.');
    cardDescWrap.appendChild(cardDescText);
    pluginCard.appendChild(cardTitleWrap);
    pluginCard.appendChild(cardDescWrap);
    rootDiv.appendChild(pluginCard);
    assert(ipcRequests.includes('Unmatched future plugin description for marketplace cards.'), 'customization-card description must trigger auto-MT');
    assert(!ipcRequests.includes('New Future Brand'), 'customization-card brand name must NOT trigger auto-MT');

    const promptRow = new DomElement('BUTTON');
    promptRow.setAttribute('data-testid', 'plugin-suggested-prompt-row');
    const promptSpan = new DomElement('SPAN');
    const promptText = makeText('Unmatched future suggested prompt for this new plugin.');
    promptSpan.appendChild(promptText);
    promptRow.appendChild(promptSpan);
    rootDiv.appendChild(promptRow);
    assert(ipcRequests.includes('Unmatched future suggested prompt for this new plugin.'), 'plugin-suggested-prompt-row must trigger auto-MT');

    const marketplaceWrap = new DomElement('DIV');
    marketplaceWrap.setAttribute('data-testid', 'customizations-marketplace');
    const shelfSub = new DomElement('P');
    shelfSub.className = 'text-sm text-muted-foreground';
    const shelfSubText = makeText('Unmatched future marketplace shelf subtitle text.');
    shelfSub.appendChild(shelfSubText);
    marketplaceWrap.appendChild(shelfSub);
    rootDiv.appendChild(marketplaceWrap);
    assert(ipcRequests.includes('Unmatched future marketplace shelf subtitle text.'), 'customizations-marketplace shelf subtitle must trigger auto-MT');

    const detailRoot = new DomElement('DIV');
    detailRoot.setAttribute('data-testid', 'plugin-detail');
    const detailDesc = new DomElement('P');
    detailDesc.className = 'text-sm text-muted-foreground';
    const detailDescText = makeText('Unmatched future plugin detail header description.');
    detailDesc.appendChild(detailDescText);
    const readmeMdRoot = new DomElement('DIV');
    readmeMdRoot.setAttribute('data-markdown-root', 'true');
    const readmeP = new DomElement('P');
    readmeP.className = 'text-sm text-muted-foreground';
    const readmePText = makeText('Unmatched plugin README paragraph inside markdown root.');
    readmeP.appendChild(readmePText);
    readmeMdRoot.appendChild(readmeP);
    detailRoot.appendChild(detailDesc);
    detailRoot.appendChild(readmeMdRoot);
    rootDiv.appendChild(detailRoot);
    assert(ipcRequests.includes('Unmatched future plugin detail header description.'), 'plugin-detail header description must trigger auto-MT');
    assert(!ipcRequests.includes('Unmatched plugin README paragraph inside markdown root.'), 'plugin-detail README inside [data-markdown-root] must NOT trigger auto-MT');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  }
}

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

async function runLexicalPromptVerification() {
  const i18nCode = localOnly
    ? fs.readFileSync(path.join(projectRoot, 'build', 'i18n.js'), 'utf8')
    : asar.extractFile(deployedAsar, path.join('dist', 'i18n.js')).toString('utf8');

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

Promise.resolve()
  .then(() => runVerification())
  .then(() => runOtaControllerVerification())
  .then(() => runGuardProxyAndRestoreVerification())
  .then(() => runAutoMtVerification())
  .then(() => runLexicalPromptVerification())
  .then(() => {
    console.log('OTA CONTROLLER & HOT-RELOAD VERIFICATION PASSED!');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
