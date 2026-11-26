const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { verifyVersionConsistency } = require('../release_version');
const { makeEl, makeTextNode, loadEngineInSandbox } = require('./mock_dom');
const { runDomLifecycleVerification, runMutationConvergenceVerification } = require('./test_dom_lifecycle');

function runTranslationRulesVerification({ i18nCode, projectRoot, pkgVersion = 'local', asarEntriesCount = 0, smoke = false }) {
  const dictPath = path.join(projectRoot, 'assets', 'dictionary.json');
  if (smoke) {
    new vm.Script(i18nCode);
    const api = loadEngineInSandbox(i18nCode);
    assert.strictEqual(api.translateString('Settings'), '设置');
    const optNone = makeEl({ testid: 'group-by-option-none' });
    assert.strictEqual(api.translateString('None', optNone), '不分组');
    const thinkingEl = makeEl({ testid: 'thinking-level-select' });
    assert.strictEqual(api.translateString('None', thinkingEl), '关闭思考');
    const verCheck = verifyVersionConsistency(projectRoot);
    assert.strictEqual(verCheck.ok, true, `Version metadata consistency failed:\n - ${verCheck.errors.join('\n - ')}`);
    console.log(`SMOKE VERIFY PASSED! version=v${pkgVersion}, patch=v${verCheck.patchVersion}, baseline=v${verCheck.clientVersion}, EXACT_DICT=${Object.keys(api.EXACT_DICT).length}, asarEntries=${asarEntriesCount}`);
    return;
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
    ['Updated 下午2:52', '更新于 下午2:52'],
    ['Updated 11月26日', '更新于 11月26日'],
    ['Updated 11月26日, 14:52', '更新于 11月26日 14:52'],
    ['Updated 2026年11月26日, 14:52', '更新于 2026年11月26日 14:52'],
    ['Updated 11月26日, 下午2:52', '更新于 11月26日 下午2:52'],
    ['Updated 11/26, 14:52', '更新于 11/26 14:52'],
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
  assert.strictEqual(
    api.translateString('Applies to /btw and messages sent after this turn'),
    '适用于 /btw 及本轮之后发送的消息'
  );
  assert.strictEqual(
    api.translateString('Applies to messages sent after this turn'),
    '适用于本轮之后发送的消息'
  );
  assert.strictEqual(
    api.translateString('Select model, current: Orchestrator Gemini 4 Neon High. Applies to /btw and messages sent after this turn'),
    '选择模型，当前：Orchestrator Gemini 4 Neon 高。适用于 /btw 及本轮之后发送的消息'
  );
  assert.strictEqual(
    api.translateString('Select model, current: Gemini 4 Neon Medium. Applies to messages sent after this turn'),
    '选择模型，当前：Gemini 4 Neon 中。适用于本轮之后发送的消息'
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
    const attrProbe = makeEl({ tag: 'BUTTON', attrs: { 'aria-label': en } });
    api.translateElementAttrs(attrProbe);
    assert.strictEqual(attrProbe.getAttribute('aria-label'), zh, `Onboarding/Auth attr check failed for: ${en}`);
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

  // 6b. Runtime status, execution progress, elapsed duration, timers, step-plan, browser actions, & split hover-card waiting count
  const toolGroupElapsedEl = makeEl({
    tag: 'SPAN',
    cls: 'shrink-0 pl-1.5 text-muted-foreground tabular-nums',
    attrs: { 'data-testid': 'tool-group-elapsed', 'data-screenshot-volatile': 'true' }
  });
  for (const [en, zh] of [
    ['5s', '5 秒'],
    ['1m 2s', '1 分 2 秒'],
    ['1h 2m 3s', '1 小时 2 分 3 秒'],
    ['2m', '2 分'],
    ['1h 2m', '1 小时 2 分']
  ]) {
    assert.strictEqual(api.translateString(en, toolGroupElapsedEl), zh, `tool-group-elapsed mismatch for ${en}`);
  }
  assert.strictEqual(api.translateString('5s', sidebarTimeEl), '5 秒前', 'Sidebar 5s must remain relative timestamp');
  assert.strictEqual(api.translateString('47m', sidebarTimeEl), '47 分钟前', 'Sidebar 47m must remain relative timestamp');
  assert.strictEqual(api.translateString('5m', runningDurationEl), '5 分钟', 'running-row 5m must stay 分钟');
  assert.strictEqual(api.translateString('1h 23m', runningDurationEl), '1 小时 23 分钟', 'running-row 1h 23m must stay 小时 分钟');

  const toolGroupEl = makeEl({ testid: 'tool-group-collapsible' });
  const ephemeralStatusEl = makeEl({ testid: 'ephemeral-tool-status' });
  const agentLoadingEl = makeEl({ testid: 'agent-loading' });
  const queuedStatusEl = makeEl({ testid: 'queued-messages-status' });

  for (const ctxEl of [toolGroupEl, ephemeralStatusEl, agentLoadingEl]) {
    assert.strictEqual(api.translateString('Working', ctxEl), '正在处理');
    assert.strictEqual(api.translateString('Working...', ctxEl), '正在处理...');
    assert.strictEqual(api.translateString('Compacting · 35s', ctxEl), '正在压缩上下文 · 35 秒');
    assert.strictEqual(api.translateString('Compacting · 1m 2s', ctxEl), '正在压缩上下文 · 1 分 2 秒');
    assert.strictEqual(api.translateString('Editing app.js', ctxEl), '正在编辑 app.js');
    assert.strictEqual(api.translateString('Editing file', ctxEl), '正在编辑文件');
    assert.strictEqual(api.translateString('Editing artifact', ctxEl), '正在编辑产物');
    assert.strictEqual(api.translateString('Reading package.json', ctxEl), '正在读取 package.json');
    assert.strictEqual(api.translateString('Listing scripts', ctxEl), '正在列出 scripts');
    assert.strictEqual(api.translateString('Searching query', ctxEl), '正在搜索 query');
    assert.strictEqual(api.translateString('Running git status check', ctxEl), '正在运行 git status check');
    assert.strictEqual(api.translateString('Running command', ctxEl), '正在运行命令');
    assert.strictEqual(api.translateString('Running 2 commands', ctxEl), '正在运行 2 条命令');
  }
  assert.strictEqual(api.translateString('Waiting on Agent', queuedStatusEl), '正在等待 Agent');
  assert.strictEqual(
    api.translateString('Editing app.js', makeEl({ tag: 'DIV' })),
    'Editing app.js',
    'Dynamic Editing <target> must not fire outside runtime status context'
  );

  for (const [en, zh] of [
    ['Thinking for 5s', '正在思考（5 秒）'],
    ['Thinking for 1m 2s', '正在思考（1 分 2 秒）'],
    ['Thinking (15s)...', '正在思考（15 秒）...'],
    ['Thought for 12s', '已思考 12 秒'],
    ['Worked for 12s', '已运行 12 秒'],
    ['Worked for 5m · 3 updates', '已运行 5 分钟 · 3 条更新'],
    ['Worked for 12s · 1 update', '已运行 12 秒 · 1 条更新'],
    ['1 update', '1 条更新'],
    ['3 updates', '3 条更新'],
    ['Explored file', '已浏览文件'],
    ['Explored files', '已浏览文件'],
    ['Explored artifact', '已浏览产物'],
    ['Explored artifacts', '已浏览产物'],
    ['Ran commands', '已运行命令'],
    ['Edited file', '已编辑文件'],
    ['Edited files', '已编辑文件'],
    ['Edited artifact', '已编辑产物'],
    ['Edited artifacts', '已编辑产物'],
    ['Explored files, ran command', '已浏览文件，已运行命令'],
    ['Explored files, ran commands, edited files', '已浏览文件，已运行命令，已编辑文件'],
    ['Ran commands, edited artifact', '已运行命令，已编辑产物'],
    ['Starting 2 subagents', '正在启动 2 个子智能体'],
    ['Started 2 subagents', '已启动 2 个子智能体'],
    ['Waiting for subagent', '正在等待子智能体'],
    ['Waiting for timer', '正在等待计时器'],
    ['Waiting for 2 timers', '正在等待 2 个计时器'],
    ['Waiting for deploy timer', '正在等待 deploy 计时器'],
    ['Waiting for timer · 30s left', '正在等待计时器 · 剩余 30 秒'],
    ['Waiting for timer · 1m 2s left', '正在等待计时器 · 剩余 1 分 2 秒'],
    ['30s left', '剩余 30 秒'],
    ['5m left', '剩余 5 分钟'],
    ['1h 2m left', '剩余 1 小时 2 分钟'],
    ['1d 2h 3m left', '剩余 1 天 2 小时 3 分钟'],
    ['2 subagents running', '2 个子智能体运行中'],
    ['3 subagents/tasks running', '3 个子智能体/任务运行中'],
    ['1 subagent blocked', '1 个子智能体已阻塞'],
    ['Waiting for timer, 2 subagents running, 1 blocked', '正在等待计时器，2 个子智能体运行中，1 项已阻塞'],
    ['Cancelled', '已取消'],
    ['Not started', '未开始'],
    ['2/5 steps', '2/5 步'],
    ['2/5 steps · 1 failed', '2/5 步 · 1 项失败'],
    ['2/5 steps · 1 skipped', '2/5 步 · 1 项跳过'],
    ['2/5 steps · 1 failed · 2 skipped', '2/5 步 · 1 项失败 · 2 项跳过'],
    ['2/5 steps. Show plan', '2/5 步。显示计划'],
    ['2/5 steps. Hide plan', '2/5 步。隐藏计划'],
    ['Plan, 2 of 5 steps done', '计划，已完成 2/5 步'],
    ['Model unavailable, retrying in 5s (attempt 1/3)', '模型暂不可用，5 秒后重试（第 1/3 次尝试）'],
    ['Model unavailable, retrying (attempt 2/3)', '模型暂不可用，正在重试（第 2/3 次尝试）'],
    ['Using browser · Clicking', '正在使用浏览器 · 正在点击'],
    ['Using browser · Reading page (12s)', '正在使用浏览器 · 正在读取页面（12 秒）'],
    ['Using browser · Thinking (15s)...', '正在使用浏览器 · 正在思考（15 秒）...'],
    ['Using browser · Thinking...', '正在使用浏览器 · 思考中...'],
    ['Using browser · Opening github.com', '正在使用浏览器 · 正在打开 github.com'],
    ['Using browser · Pressing Enter', '正在使用浏览器 · 正在按下 Enter'],
    ['Opening page', '正在打开页面'],
    ['Opening github.com', '正在打开 github.com'],
    ['Going back', '正在后退'],
    ['Going forward', '正在前进'],
    ['Reloading page', '正在刷新页面'],
    ['Double-clicking', '正在双击'],
    ['Hovering', '正在悬停'],
    ['Typing', '正在输入'],
    ['Pressing Enter', '正在按下 Enter'],
    ['Pressing key', '正在按键'],
    ['Scrolling up', '正在向上滚动'],
    ['Scrolling down', '正在向下滚动'],
    ['Scrolling left', '正在向左滚动'],
    ['Scrolling right', '正在向右滚动'],
    ['Selecting option', '正在选择选项'],
    ['Switching tabs', '正在切换标签页'],
    ['Failed to execute', '执行失败'],
    ['Waiting for approval to run command: npm test', '正在等待批准运行命令：npm test'],
    ['Waiting for approval to edit file: app.js', '正在等待批准编辑文件：app.js'],
    ['Waiting for approval to read file: app.js', '正在等待批准读取文件：app.js'],
    ['Waiting for tool permission approval — click Open in full conversation (↗) to approve', '正在等待工具权限批准 — 点击「在完整会话中打开 (↗)」以批准'],
    ['Sending input to command', '正在向命令发送 input'],
    ['Sent input to command', '已向命令发送 input'],
    ['Rejected sending input to command', '已拒绝向命令发送 input']
  ]) {
    assert.strictEqual(api.translateString(en), zh, `Runtime status mismatch for "${en}"`);
  }

  const hoverStatusRow = makeEl({
    testid: 'sidebar-agent-hover-card-status',
    children: [
      makeEl({
        tag: 'SPAN',
        cls: 'text-muted-foreground tabular-nums',
        children: [makeTextNode('2'), makeTextNode(' waiting')]
      })
    ]
  });
  api.translateNode(hoverStatusRow);
  assert.strictEqual(hoverStatusRow.children[0].children[1].nodeValue, ' 项等待中');

  const slotOutSpan = makeEl({
    tag: 'SPAN',
    attrs: { 'data-slot-out': 'Working' },
    parent: toolGroupEl
  });
  api.translateNode(slotOutSpan);
  assert.strictEqual(slotOutSpan.getAttribute('data-slot-out'), '正在处理');

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

  // 7.5 P0/P1/P2 regressions: Delete context priority, Upgrade to Pro tail, within it. / files changed split isolation, & Chinese fast-path perf
  const sidecarDetailEl = makeEl({ testid: 'sidecar-detail' });
  assert.strictEqual(api.translateString('Delete conversation', sidecarDetailEl), '删除会话');
  assert.strictEqual(api.translateString('Delete all', sidecarDetailEl), '全部删除');
  assert.strictEqual(api.translateString('Delete automation', sidecarDetailEl), '删除自动化任务');
  assert.strictEqual(api.translateString('Delete Daily summary', sidecarDetailEl), '删除 Daily summary');

  assert.strictEqual(api.translateString('Upgrade to Pro.'), '升级到 Pro。');
  assert.strictEqual(api.translateString('You have hit your weekly limit. Upgrade to Pro.'), '你已达到每周配额上限。升级到 Pro。');

  assert.strictEqual(api.translateString('within it.'), 'within it.');
  const delParent = makeEl({
    tag: 'P',
    children: [
      makeTextNode('This will permanently delete '),
      makeEl({ tag: 'STRONG', text: 'my-ws' }),
      makeTextNode(' '),
      makeTextNode('within it.')
    ]
  });
  const withinNode = delParent.children[3];
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(withinNode, 'within it.', delParent), '。');

  assert.strictEqual(api.translateString('files changed'), '已更改文件');
  const fcNum = makeEl({ tag: 'SPAN', text: '3' });
  const fcText = makeTextNode('files changed');
  makeEl({ tag: 'SPAN', children: [fcNum, fcText] });
  assert.strictEqual(api.SPLIT_TEXT_TRANSLATOR(fcText, 'files changed', fcText.parentElement), ' 个文件已更改');

  const zhStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    assert.strictEqual(api.translateString('这是一段不需要翻译的纯中文内容'), '这是一段不需要翻译的纯中文内容');
  }
  const zhMs = performance.now() - zhStart;
  assert(zhMs < 50, `Pure Chinese fast-path too slow: ${zhMs.toFixed(2)}ms for 1000 calls`);

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

module.exports = { runTranslationRulesVerification };
