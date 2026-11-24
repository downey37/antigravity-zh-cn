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
    assert(ipcCode.includes('i18n-ota:toggle-language') && ipcCode.includes('i18n-ota:get-language-enabled'), 'ipcHandlers.js must register language toggle IPC handlers');
    assert(ipcCode.includes('isI18nEnabled'), 'ipcHandlers.js must respect isI18nEnabled for context menu and notifications');
    const preloadCode = asar.extractFile(deployedAsar, path.join('dist', 'preload.js')).toString('utf8');
    assert(preloadCode.includes('antigravityI18nOta') && preloadCode.includes('i18n-ota:check-updates') && preloadCode.includes('toggleLanguage') && preloadCode.includes('i18n-ota:toggle-language'), 'preload.js must expose antigravityI18nOta checkForUpdates and toggleLanguage bridge');
    const mainCode = asar.extractFile(deployedAsar, path.join('dist', 'main.js')).toString('utf8');
    assert(mainCode.includes('antigravity-i18n-check-update') && mainCode.includes('antigravity-i18n-toggle-lang') && mainCode.includes('检查汉化更新') && mainCode.includes('临时切换为英文'), 'main.js must add OTA check and language toggle items to Windows tray menu');
    const trayCode = asar.extractFile(deployedAsar, path.join('dist', 'tray.js')).toString('utf8');
    assert(trayCode.includes('_syncTrayLabels') && trayCode.includes('onLanguageChange'), 'tray.js must subscribe to onLanguageChange for tray labels');
    assert(asar.statFile(deployedAsar, path.join('dist', 'native_context_dict.json')), 'app.asar must include dist/native_context_dict.json');
    assert(asar.statFile(deployedAsar, path.join('dist', 'i18n_ota.js')), 'app.asar must include dist/i18n_ota.js');
    assert(asar.statFile(deployedAsar, path.join('dist', 'i18n_meta.json')), 'app.asar must include dist/i18n_meta.json');
    const embeddedMeta = JSON.parse(asar.extractFile(deployedAsar, path.join('dist', 'i18n_meta.json')).toString('utf8'));
    assert.strictEqual(embeddedMeta.schemaVersion, 1, 'dist/i18n_meta.json must have schemaVersion 1');
    assert(menuCode.includes('translateMenuRecursively') && menuCode.includes('antigravity-i18n-check-update') && menuCode.includes('antigravity-i18n-toggle-lang') && menuCode.includes('onLanguageChange'), 'menu.js must include translateMenuRecursively, OTA check, language toggle item, and onLanguageChange listener');
    const getCodeIdx = utilsCode.indexOf('function _getAntigravityI18nCode');
    const createWinIdx = utilsCode.indexOf('function createWindow');
    assert(
      getCodeIdx !== -1 &&
      createWinIdx !== -1 &&
      getCodeIdx < createWinIdx &&
      !utilsCode.includes('http://localhost:') &&
      utilsCode.includes('frameOrigin === mainOrigin') &&
      utilsCode.includes('_getAntigravityI18nOta') &&
      utilsCode.includes('applyCachedPackToWebContents') &&
      utilsCode.includes('getInitialStateScript'),
      'utils.js must define module-level _getAntigravityI18nCode / _getAntigravityI18nOta caches, sync initial enabled state, and use exact frameOrigin matching'
    );
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
    for (const rel of ['dist/utils.js', 'dist/menu.js', 'dist/tray.js', 'dist/main.js', 'dist/preload.js', 'dist/updater.js', 'dist/provisionSplash.js', 'dist/ipcHandlers.js', 'dist/webviewPopupSecurity.js', 'dist/ideInstall/wizardHtml.js', 'dist/languageServer.js', 'dist/i18n_ota.js']) {
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
    '选择 Orchestrator 使用的模型。用更强、更聪明的 Orchestrator 模型搭配更快、更实惠的执行器模型，可在消耗更少 Token 的情况下获得高质量结果。'
  );
  assert.strictEqual(api.translateString('Orchestrator Model'), 'Orchestrator 模型');
  assert.strictEqual(
    api.translateString('Plans the work, makes design decisions, and reviews the result. Pick a top-tier model. You can also pick one per conversation from the Orchestrator row in the model menu.'),
    '负责规划工作、做出设计决策并审查结果。建议选择顶级模型。你也可以在模型选择器的“Orchestrator”行中为每个会话单独选择。'
  );
  assert.strictEqual(api.translateString('Executor Model'), '执行器模型');
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
    '将常规步骤分流给更快的执行器。同等质量，消耗更少 Token。'
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

  const customModelItem = makeEl({ testid: 'model-selector-custom-item', parent: modelPanel });
  assert.strictEqual(api.translateString('My Custom Model (Medium)', customModelItem), 'My Custom Model (Medium)');

  assert.strictEqual(api.translateString('GPT-OSS 120B (Medium)'), 'GPT-OSS 120B (Medium)');
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

  // 9. Version & README/baseline metadata consistency
  const verCheck = verifyVersionConsistency(projectRoot);
  assert.strictEqual(
    verCheck.ok,
    true,
    `Version metadata consistency failed:\n - ${verCheck.errors.join('\n - ')}`
  );

  console.log(`ALL VERIFY CHECKS PASSED! version=v${pkgVersion}, patch=v${verCheck.patchVersion}, baseline=v${verCheck.clientVersion}, EXACT_DICT=${Object.keys(api.EXACT_DICT).length}, ATTR_DICT=${Object.keys(api.ATTR_DICT).length}, asarEntries=${asarEntriesCount}`);
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

  // 11. Windows custom title-menu-bar ("Antigravity" dropdown) injects "检查汉化更新" and "临时切换为英文" right below "检查更新"
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
  assert.strictEqual(injectedToggleBtns.length, 1, 'Windows Antigravity title menu must inject exactly one 临时切换为英文 item');
  assert.strictEqual(injectedToggleBtns[0].textContent, '临时切换为英文');
  assert.strictEqual(popup.children.length, 4);
  // Click dispatches Escape to close React menu & triggers IPC checkForUpdates
  injectedBtns[0]._listeners.click[0]({ stopPropagation() {} });
  assert.strictEqual(otaMenuClickedCount, 1);
  assert.strictEqual(dispatchedDocEvents.some((e) => e.key === 'Escape'), true);

  // 12. In-app temporary Chinese <-> English toggle restores original English nodes/attrs losslessly & skips new mutations while disabled
  assert.strictEqual(sandbox.window.__antigravityIsI18nEnabled(), true);
  injectedToggleBtns[0]._listeners.click[0]({ stopPropagation() {} });
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
  assert.strictEqual(injectedToggleBtns[0].textContent, 'Switch to 简体中文');

  const whileEnglishSpan = new DomElement('SPAN');
  const whileEnglishText = makeText('Add Resource');
  whileEnglishSpan.appendChild(whileEnglishText);
  rootDiv.appendChild(whileEnglishSpan);
  assert.strictEqual(whileEnglishText.nodeValue, 'Add Resource', 'New nodes added in temporary English mode must remain English');

  // Toggle back to Simplified Chinese
  injectedToggleBtns[0]._listeners.click[0]({ stopPropagation() {} });
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
  assert.strictEqual(injectedToggleBtns[0].textContent, '临时切换为英文');
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

    // 2g. Session-scoped Chinese <-> English toggle broadcasts to main + eligible plugin subframes only
    const langEvents = [];
    const unsubscribe = ctrl.onLanguageChange((enabled) => langEvents.push(enabled));
    assert.strictEqual(ctrl.isI18nEnabled(), true);
    assert.strictEqual(ctrl.getInitialStateScript(), 'window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ = true;');
    const preToggleMainCount = mainExecs.length;
    const preTogglePluginCount = pluginFrameExecs.length;
    assert.strictEqual(ctrl.setI18nEnabled(false), false);
    assert.strictEqual(ctrl.isI18nEnabled(), false);
    assert.strictEqual(ctrl.getInitialStateScript(), 'window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ = false;');
    assert.deepStrictEqual(langEvents, [false]);
    assert.strictEqual(mainExecs.length, preToggleMainCount + 1);
    assert(mainExecs[mainExecs.length - 1].includes('__antigravitySetI18nEnabled(false)'));
    assert.strictEqual(pluginFrameExecs.length, preTogglePluginCount + 1);
    assert.strictEqual(extFrameExecs.length, 0);

    assert.strictEqual(ctrl.toggleI18nEnabled(), true);
    assert.deepStrictEqual(langEvents, [false, true]);
    assert(mainExecs[mainExecs.length - 1].includes('__antigravitySetI18nEnabled(true)'));
    unsubscribe();

    const envDisabledCtrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls,
      env: { ANTIGRAVITY_I18N_DISABLED: '1' }
    });
    assert.strictEqual(envDisabledCtrl.isI18nEnabled(), false);
    assert.strictEqual(envDisabledCtrl.getInitialStateScript(), 'window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ = false;');
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

Promise.resolve()
  .then(() => runVerification())
  .then(() => runOtaControllerVerification())
  .then(() => runGuardProxyAndRestoreVerification())
  .then(() => {
    console.log('OTA CONTROLLER & HOT-RELOAD VERIFICATION PASSED!');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
