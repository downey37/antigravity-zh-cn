/**
 * 动态正则模板规则构建器（供渲染端零延迟引擎与离线扫描脚本共同复用）。
 * @param {{ normalizeKey: (s: string) => string, lookupExact: (trimmed: string, norm: string) => string | null }} helpers
 */
function createDynamicRules(helpers) {
  const { normalizeKey, lookupExact } = helpers;

  function prefixSpaceIfAscii(text) {
    return /^[A-Za-z0-9]/.test(text) ? ` ${text}` : text;
  }

  function translateDuration(d) {
    return String(d)
      .replace(/[.,]+$/g, '')
      .replace(/,/g, ' ')
      .replace(/\band\b/gi, ' ')
      .replace(/\b(?:less than|under)\s+(?:a|an|1)\s+minutes?\b/gi, '不到 1 分钟')
      .replace(/\bless than\s+(\d+)\s+minutes?\b/gi, '不到 $1 分钟')
      .replace(/\ba\s+few\s+seconds\b/gi, '几秒')
      .replace(/\b(\d+)\s*(?:years?|yrs?|y)\b/gi, '$1 年')
      .replace(/\b(\d+)\s*(?:months?|mo)\b/gi, '$1 个月')
      .replace(/\b(\d+)\s*(?:weeks?|w)\b/gi, '$1 周')
      .replace(/\b(\d+)\s*(?:days?|d)\b/gi, '$1 天')
      .replace(/\b(\d+)\s*(?:hours?|hrs?|h)\b/gi, '$1 小时')
      .replace(/\b(\d+)\s*(?:minutes?|mins?|m)\b/gi, '$1 分钟')
      .replace(/\b(\d+)\s*(?:seconds?|secs?|s)\b/gi, '$1 秒')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function translateRelativeUnit(unit) {
    const low = String(unit || '').toLowerCase();
    if (low === 'mo' || low.startsWith('month')) return '个月';
    if (low.startsWith('y')) return '年';
    if (low.startsWith('w')) return '周';
    if (low.startsWith('d')) return '天';
    if (low.startsWith('h')) return '小时';
    if (low.startsWith('m')) return '分钟';
    if (low.startsWith('s')) return '秒';
    return unit;
  }

  function translateCompactRelativeTime(str) {
    const s = String(str || '').trim();
    if (s === 'now') return '刚刚';
    const m = s.match(/^(\d+)\s*(mo|[smhdwy])$/);
    if (!m) return null;
    return `${m[1]} ${translateRelativeUnit(m[2])}前`;
  }

  function translateCompactDuration(str) {
    const s = String(str || '').trim();
    if (!/^\d+\s*(?:mo|[smhdwy])(?:\s+\d+\s*(?:mo|[smhdwy]))*$/.test(s)) {
      return null;
    }
    return translateDuration(s);
  }

  const EFFORT_LEVEL_MAP = {
    minimal: '极简',
    low: '低',
    medium: '中',
    high: '高',
    extra: '超高',
    'extra high': '超高',
    xhigh: '超高',
    max: '最高'
  };

  function translateEffortLevel(effort) {
    const key = String(effort || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return EFFORT_LEVEL_MAP[key] || null;
  }

  function translateModelWithEffort(str) {
    const s = String(str || '').trim();
    if (!s) return null;

    // 1. 纯思考深度（可选附带上下文窗口后缀），如 "Extra High" / "Extra High · 1M"
    const pureMatch = s.match(/^(Extra\s+High|XHigh|Minimal|Low|Medium|High|Extra|Max)(?:\s*\u00b7\s*(.+))?$/i);
    if (pureMatch) {
      const effZh = translateEffortLevel(pureMatch[1]);
      if (!effZh) return null;
      if (pureMatch[2]) {
        const ctxRaw = pureMatch[2].trim();
        const ctxZh = lookupExact(ctxRaw, normalizeKey(ctxRaw)) || ctxRaw;
        return `${effZh} \u00b7 ${ctxZh}`;
      }
      return effZh;
    }

    // 2. "模型名 + 思考深度"（可选附带上下文窗口后缀），如 "Gemini 4 Neon Extra High" / "Orchestrator Gemini 4 Neon Extra High · 1M"
    const modelMatch = s.match(/^(.+?)\s+(Extra\s+High|XHigh|Minimal|Low|Medium|High|Extra|Max)(?:\s*\u00b7\s*(.+))?$/i);
    if (!modelMatch) return null;
    const base = modelMatch[1].trim();
    const effZh = translateEffortLevel(modelMatch[2]);
    if (!base || !effZh) return null;
    if (modelMatch[3]) {
      const ctxRaw = modelMatch[3].trim();
      const ctxZh = lookupExact(ctxRaw, normalizeKey(ctxRaw)) || ctxRaw;
      return `${base} ${effZh} \u00b7 ${ctxZh}`;
    }
    return `${base} ${effZh}`;
  }

  function translateLimitKind(kind) {
    const low = String(kind || '').trim().toLowerCase();
    if (low === 'weekly') return '每周配额';
    if (low === 'monthly') return '每月配额';
    if (low === 'daily') return '每日配额';
    const hourMatch = low.match(/^(\d+)-hour$/);
    if (hourMatch) return `${hourMatch[1]} 小时配额`;
    return String(kind || '').trim();
  }

  function translateScope(scope) {
    const nk = normalizeKey(scope);
    const map = {
      'your plan': '你当前的套餐',
      'your organization': '你的组织',
      'enterprise accounts': '企业账号',
      'google ai pro accounts': 'Google AI Pro 账号',
      'google ai ultra accounts': 'Google AI Ultra 账号',
      'google ai plus accounts': 'Google AI Plus 账号',
      'antigravity business accounts': 'Antigravity Business 账号'
    };
    const low = nk.toLowerCase();
    const res = map[low] || lookupExact(scope, nk) || scope;
    return prefixSpaceIfAscii(res);
  }

  function translateScheduleDay(raw) {
    const clean = String(raw || '').trim();
    const weekMap = {
      monday: '星期一', mon: '周一',
      tuesday: '星期二', tue: '周二', tues: '周二',
      wednesday: '星期三', wed: '周三',
      thursday: '星期四', thu: '周四', thur: '周四', thurs: '周四',
      friday: '星期五', fri: '周五',
      saturday: '星期六', sat: '周六',
      sunday: '星期日', sun: '周日'
    };
    const low = clean.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(weekMap, low)) return weekMap[low];
    const ord = clean.match(/^(\d{1,2})(?:st|nd|rd|th)$/i);
    if (ord) return `${ord[1]} 日`;
    const monthMap = { jan: '1月', feb: '2月', mar: '3月', apr: '4月', may: '5月', jun: '6月', jul: '7月', aug: '8月', sep: '9月', oct: '10月', nov: '11月', dec: '12月' };
    const md = clean.match(/^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/i);
    if (md) return `${monthMap[md[1].slice(0, 3).toLowerCase()] || md[1]}${md[2]}日`;
    return clean;
  }

  function translateEntityNoun(word) {
    const clean = String(word || '').replace(/\.$/, '').trim();
    const low = clean.toLowerCase();
    if (low === 'project' || low === 'projects') return '项目';
    if (low === 'workspace' || low === 'workspaces') return '工作区';
    if (low === 'automation' || low === 'automations') return '自动化任务';
    if (low === 'worktree' || low === 'worktrees') return '工作树';
    if (low === 'workflow' || low === 'workflows') return '工作流';
    if (low === 'environment' || low === 'environments') return '环境';
    if (low === 'conversation' || low === 'conversations') return '会话';
    if (low === 'rule' || low === 'rules') return '规则';
    if (low === 'skill' || low === 'skills') return '技能';
    if (low === 'agent' || low === 'agents') return '智能体';
    if (low === 'plugin' || low === 'plugins') return '插件';
    if (low === 'hook' || low === 'hooks') return '钩子';
    if (low === 'artifact' || low === 'artifacts') return '产物';
    if (low === 'sidecar' || low === 'sidecars') return '后台服务';
    return lookupExact(clean, normalizeKey(clean)) || clean;
  }

  function translateFailedTarget(word) {
    const clean = String(word || '').replace(/\.$/, '').trim();
    const low = clean.toLowerCase();
    const mediaMap = {
      image: '图片',
      video: '视频',
      audio: '音频',
      file: '文件',
      directory: '目录',
      folder: '文件夹'
    };
    if (Object.prototype.hasOwnProperty.call(mediaMap, low)) return mediaMap[low];
    return translateEntityNoun(clean);
  }

  function isKnownFailedTarget(raw) {
    const clean = String(raw || '').replace(/\.$/, '').trim();
    if (!clean || /[\u4e00-\u9fff]/.test(clean)) return false;
    if (/^(?:"[^"]+"|'[^']+'|“[^”]+”)$/.test(clean)) return true;
    if (translateFailedTarget(clean) !== clean) return true;
    // 允许明确的本地文件路径或 URL（非普通英文短语/句号分隔句）
    if (/^(?:https?:\/\/|\/)[^\s]+$/i.test(clean)) return true;
    return false;
  }

  function isSafeDynamicTarget(raw) {
    const s = String(raw || '').trim();
    if (!s || /[\u4e00-\u9fff]/.test(s)) return false;
    if (/^(?:"[^"]+"|'[^']+'|“[^”]+”)$/.test(s)) return true;
    const nk = normalizeKey(s);
    if (translateEntityNoun(s) !== s.replace(/\.$/, '').trim() || lookupExact(s, nk)) {
      return true;
    }
    if (s.length > 60 || /[.!?]\s+/.test(s)) return false;
    if (/\b(?:a|an|the|your|my|our|their|this|that|these|those|some|any|all|not|no|from|into|onto|upon|for|with|without|about|please|try|again|if|when|where|which|who|what|you|we|they|it|is|are|was|were|be|been|can|could|may|might|will|would|should|shared)\b/i.test(s)) {
      return false;
    }
    // 多个纯小写英文词（如 "file diff" / "image frame"）通常是静态 UI 短语而非动态名称，交给精确词典与扫漏器处理
    if (/^[a-z]+(?:\s+[a-z]+)+$/.test(s)) return false;
    return true;
  }

  function translateTargetOrKeep(raw) {
    const trimmed = String(raw || '').trim();
    return lookupExact(trimmed, normalizeKey(trimmed)) || trimmed;
  }

  function translatePermissionTarget(raw) {
    const clean = String(raw || '').trim();
    const map = {
      'read access to this path': '读取此路径',
      'write access to this path': '写入此路径',
      'reading this url': '读取此 URL',
      'executing actions on this url': '在此 URL 上执行操作',
      'browser downloads from this site': '从此站点进行浏览器下载',
      'running this command': '运行此命令',
      'running this command outside the sandbox': '在沙盒外运行此命令',
      'using this mcp tool': '使用此 MCP 工具',
      'a one-time administrator (uac) elevation': '一次性管理员权限 (UAC) 提权',
      'access to this resource': '访问此资源'
    };
    const low = clean.toLowerCase();
    return map[low] || lookupExact(clean, normalizeKey(clean)) || clean;
  }

  const CONVERSATION_VERB_MAP = {
    pin: '置顶会话',
    unpin: '取消置顶会话',
    archive: '归档会话',
    unarchive: '取消归档会话',
    restore: '还原会话',
    delete: '删除会话',
    rename: '重命名会话',
    move: '移动会话',
    star: '标星会话',
    unstar: '取消标星会话',
    'mark as unread': '将会话标记为未读',
    'set permissions for': '设置会话权限'
  };

  function joinZhSegment(prefix, mid, suffix) {
    const m = String(mid || '').trim();
    if (!m) return `${prefix}${suffix || ''}`;
    const leadSpace = prefix && (/[A-Za-z0-9]$/.test(prefix) || /^[A-Za-z0-9/]/.test(m)) ? ' ' : '';
    const tailSpace = suffix && (/^[A-Za-z0-9]/.test(suffix) || /[A-Za-z0-9]$/.test(m)) ? ' ' : '';
    return `${prefix}${leadSpace}${m}${tailSpace}${suffix || ''}`;
  }

  function translateQuotaTextParts(text) {
    return String(text)
      .replace(/You need\s+(.+?)\s+AI Credits to send messages\.\s*To continue using\s+(.+?)\s+now,\s*purchase more AI Credits\.?/gi, (_, need, model) => {
        const needZh = need.trim().replace(/^at least\s+/i, '至少 ').replace(/^more$/i, '更多');
        const modelZh = /^this model$/i.test(model.trim()) ? '此模型' : model.trim();
        return `发送消息还需要${needZh} AI 额度。如需立即继续使用 ${modelZh}，请购买更多 AI 额度。`;
      })
      .replace(/Your plan's baseline quota will refresh on\s+(.+?)\./gi, (_, d) => `你当前套餐的基础配额将于 ${d.trim()} 刷新。`)
      .replace(/To continue using this model now,\s*enable AI Credit overages\.?/gi, '如需立即继续使用此模型，请开启 AI 额度超额使用。')
      .replace(/You can upgrade to a Google AI Ultra plan to receive higher rate limits\.?/gi, '你可以升级到 Google AI Ultra 套餐以获取更高的请求速率上限。')
      .replace(/Free users and Google AI Plus users receive the minimum base limits on Antigravity\.\s*You can upgrade to Google AI Pro or above to receive higher rate limits\.?/gi, '免费用户和 Google AI Plus 用户在 Antigravity 上享有最低基础额度。你可以升级到 Google AI Pro 或更高级别套餐以获取更高的请求速率上限。')
      .replace(/You can upgrade to Google AI Pro or above to receive higher rate limits\.?/gi, '你可以升级到 Google AI Pro 或更高级别套餐以获取更高的请求速率上限。')
      .replace(/(?:If|If you(?:'re| are))\s+on a supported paid plan,\s*you can use AI credits in the interim(?:\s+or\s+upgrade to a higher tier)?\.?/gi, (m) =>
        /upgrade to a higher tier/i.test(m)
          ? '如果你使用的是受支持的付费套餐，在此期间可使用 AI 额度，或升级至更高级别套餐。'
          : '如果你使用的是受支持的付费套餐，在此期间可使用 AI 额度。'
      )
      .replace(/([。！？])\s+/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function translateQuotaTail(tail) {
    const trimmed = tail ? tail.trim() : '';
    if (!trimmed) return '';
    return lookupExact(trimmed, normalizeKey(trimmed)) || translateQuotaTextParts(trimmed);
  }

  const DYNAMIC_RULES = [
    // 文件变更、代码行统计、会话数、预算与工具计数
    [/^(\d+)\s+files?\s+changed$/i, '$1 个文件已更改'],
    [/^(\d+)\s+lines?\s+added,\s+(\d+)\s+lines?\s+removed$/i, '新增 $1 行，删除 $2 行'],
    [/^(\d+)\s+active conversations?\s+and\s+(\d+)\s+archived conversations?\.?$/i, '$1 个活跃会话和 $2 个已归档会话'],
    [/^(\d+)\s+active conversations?\.?$/i, '$1 个活跃会话'],
    [/^(\d+)\s+archived conversations?\.?$/i, '$1 个已归档会话'],
    [/^(\d+)\s+pinned\s+conversations?$/i, '$1 个置顶会话'],
    [/^Marked\s+(\d+)\s+conversations?\s+as read$/i, '已将 $1 个会话标为已读'],
    [/^Sort and filter conversations\s*\((\d+)\s+active\)$/i, '排序与筛选会话（$1 个活跃）'],
    [/^No more older messages,\s+showing\s+(\d+)\s+of\s+(\d+)$/i, '没有更早的消息，显示 $1 / $2 条'],
    [/^Showing first\s+(\d+)\s+references$/i, '仅显示前 $1 个引用'],
    [/^(\d+(?:\.\d+)?%?)\s+of the customization budget is available\.?$/i, '自定义配置预算剩余 $1 可用。'],
    [/^%\s+of the customization budget is available\.?$/i, '% 的自定义配置预算可用。'],
    [/^(\d+)\s+rules?\s+exceeded the rules budget and\s+(?:was|were)\s+demoted from full inline content to a file-path pointer\.$/i, '$1 条规则超出规则预算，已从完整内联内容降级为文件路径指针。'],
    [/^(\d+)\s+items?\s+in\s+(.+?)\s+exceeded the customization budget and\s+(?:was|were)\s+excluded from context\.$/i, '$2 中的 $1 项配置超出自定义预算，已从上下文中排除。'],
    [/^Exceeded the rules token budget\.\s+Full rule content\s+\(([\d,]+)\s+tokens?\)\s+was replaced with a lightweight file-path pointer in context\.$/i, '已超出规则 Token 预算。完整规则内容（$1 个 Token）已在上下文中替换为轻量级文件路径指针。'],
    [/^All tools in this MCP server\s+\(([\d,]+)\s+tokens?\)\s+exceeded the customization budget and were excluded from context\.$/i, '此 MCP 服务中的所有工具（$1 个 Token）已超出自定义配置预算并从上下文中排除。'],
    [/^(\d+)\s+tools?\s+in this MCP server\s+\(([\d,]+)\s+tokens?\)\s+exceeded the customization budget and were excluded from context\.$/i, '此 MCP 服务中的 $1 个工具（$2 个 Token）已超出自定义配置预算并从上下文中排除。'],
    [/^Exceeded the customization token budget\s+\(([\d,]+)\s+tokens?\)\s+and was excluded from context\.$/i, '已超出自定义配置 Token 预算（$1 个 Token）并从上下文中排除。'],
    [/^(\d+)\s+rules?\s+exceed(?:ed|s)?\s+(?:the\s+)?(?:rules\s+)?budget(.*)$/i, '有 $1 条规则超出了规则预算$2'],
    [/^(\d+)\s+rules?\s+(?:are\s+)?over\s+(?:the\s+)?(?:rules\s+)?budget(.*)$/i, '有 $1 条规则超出了预算$2'],
    [/^(\d+)\s+of\s+(\d+)\s+tools?\s+enabled$/i, '已启用 $1 / $2 个工具'],
    [/^(\d+)\s+tools?\s+enabled$/i, '已启用 $1 个工具'],
    [/^(\d+)\s+tools?\s+disabled$/i, '已禁用 $1 个工具'],

    // 排队发送与快捷键提示
    [/^(.+?)\s+Queues after the turn$/i, '$1 当前轮次结束后排队发送'],
    [/^(.+?)\s+Sends immediately$/i, '$1 立即发送'],
    [/^(.+?)\s+On empty prompt,\s*sends next in queue$/i, '$1 提示词为空时发送队列中的下一条'],
    [/^Recording shortcut for\s+(.+?)\.\s+Press keys to bind,\s+Enter to save,\s+Escape to cancel\.?$/i, '正在录制 $1 的快捷键。请按键绑定，按 Enter 保存，按 Escape 取消。'],
    [/^Remove shortcut\s+(.+?)\s+for\s+(.+)$/i, '移除 $2 的快捷键 $1'],
    [/^Shortcut\s+(.+?)\s+for\s+(.+)$/i, '$2 的快捷键 $1'],
    [/^Skip\s*\((.+?)\),\s*Skip All\s*\((.+?)\)$/i, '跳过 ($1)，全部跳过 ($2)'],
    [/^Submit\s*\((.+)\)$/i, '提交 ($1)'],

    // 思考、运行耗时、步骤、子智能体、轮次
    [/^Thinking for\s+(\d+)\s*s$/i, '正在思考（$1 秒）'],
    [/^Thinking for\s+(.+)$/i, (_, d) => `正在思考（${translateDuration(d)}）`],
    [/^Thought for\s+(\d+)\s*s$/i, '已思考 $1 秒'],
    [/^Thought for\s+(.+)$/i, (_, d) => `已思考 ${translateDuration(d)}`],
    [/^Still thinking,\s+(\d+)\s+seconds?$/i, '仍在思考（已用时 $1 秒）'],
    [/^Worked for\s+(.+?)\s*·\s*(.+)$/i, (_, d, v) => `已运行 ${translateDuration(d)} · ${v}`],
    [/^Worked for\s+(.+)$/i, (_, d) => `已运行 ${translateDuration(d)}`],
    [/^Ran\s+(\d+)\s+commands?$/i, '已运行 $1 条命令'],
    [/^Running\s+(\d+)\s+commands?$/i, '正在运行 $1 条命令'],
    [/^Explored\s+(\d+)\s+files?$/i, '已浏览 $1 个文件'],
    [/^Show\s+(\d+)\s+breakdowns?$/i, '显示 $1 项用量明细'],
    [/^Show\s+(\d+)\s+earlier\s+steps?$/i, '显示更早的 $1 个步骤'],
    [/^Show\s+(\d+)\s+more\s+subagents?$/i, '显示另外 $1 个子智能体'],
    [/^Turn\s+(\d+)\s+of\s+(\d+)$/i, '第 $1 / $2 轮'],
    [/^Turn\s+(\d+)$/i, '第 $1 轮'],
    [/^Side Question:\s*(.+)$/i, '临时提问：$1'],
    [/^Open Subagent:\s*(.+)$/i, '打开子智能体：$1'],
    [/^Open conversation\s+(.+)$/i, '打开会话 $1'],
    [/^Moved conversation\s+(.+)$/i, '已移动会话 $1'],
    [/^Unnamed Agent\s+(\d+)$/i, '未命名智能体 $1'],
    [/^Unnamed skill\s+(\d+)$/i, '未命名技能 $1'],
    [/^UI Extension\s+(\d+)$/i, 'UI 扩展 $1'],
    [/^User uploaded media\s+(\d+)$/i, '用户上传的媒体 $1'],
    [/^Version\s+(v?\d[\w.\-+]*)$/i, '版本 $1'],
    [/^See all\s*\((\d+)\)$/i, '查看全部 ($1)'],
    [/^Send all\s*\((\d+)\)$/i, '全部发送 ($1)'],
    [/^Stop\s+(\d+)\s+selected$/i, '停止所选的 $1 项'],
    [/^Stop\s+(.+?)\?$/i, (m, t) => isSafeDynamicTarget(t) ? `停止 ${translateTargetOrKeep(t)}？` : m],
    [/^Stop\s+(.+)$/i, (m, t) => isSafeDynamicTarget(t) ? `停止 ${translateTargetOrKeep(t)}` : m],

    // 计划执行、Git 提交、命令、浏览器工具、语音
    [/^Proceed with implementation plan and\s+(\d+)\s+comments?$/i, '按实现计划继续并附带 $1 条批注'],
    [/^Publish\s+(.+?)\s+to origin$/i, '将 $1 发布到 origin'],
    [/^Published\s+(.+?)\s+to origin\.?$/i, '已将 $1 发布到 origin。'],
    [/^Push\s+(\d+)\s+commits?\s+to\s+(.+)$/i, '将 $1 个提交推送到 $2'],
    [/^Pushed\s+(\d+)\s+commits?\s+to\s+(.+?)\.?$/i, '已将 $1 个提交推送到 $2。'],
    [/^Pushed to\s+(.+?)\.?$/i, '已推送到 $1。'],
    [/^View Diff for\s+(.+)$/i, '查看 $1 的差异'],
    [/^Unfold lines\s+(.+)$/i, '展开第 $1 行'],
    [/^Waiting for command completion\s*\(up to\s+(\d+)\s+seconds\)$/i, '等待命令完成（最多 $1 秒）'],
    [/^Waiting for your input:\s*(.+)$/i, '等待你的输入：$1'],
    [/^Wants to run:\s*(.+)$/i, '请求运行：$1'],
    [/^Running:\s*(.+)$/i, '正在运行：$1'],
    [/^Ran command:\s*(.+)$/i, '已运行命令：$1'],
    [/^Started "(.+?)"\.?$/i, '已启动“$1”。'],
    [/^Restarted "(.+?)"\.?$/i, '已重启“$1”。'],
    [/^Used MCP tool:\s*(.+)$/i, '已使用 MCP 工具：$1'],
    [/^Used tool:\s*(.+)$/i, '已使用工具：$1'],
    [/^Searched for "(.+?)"$/i, '已搜索“$1”'],
    [/^Searched web:\s*"(.+?)"$/i, '已网页搜索：“$1”'],
    [/^Search Google for "(.+?)"$/i, '使用 Google 搜索“$1”'],
    [/^Searched for files:\s*(.+)$/i, '已搜索文件：$1'],
    [/^Read URL:\s*(.+)$/i, '已读取网址：$1'],
    [/^Opened browser:\s*(.+)$/i, '已打开浏览器：$1'],
    [/^Using browser\s*·\s*(.+?)\s+\((\d+)s\)$/i, '正在使用浏览器 · $1（$2 秒）'],
    [/^Using browser\s*·\s*(.+)$/i, '正在使用浏览器 · $1'],
    [/^Using browser\s+\((\d+)s\)$/i, '正在使用浏览器（$1 秒）'],
    [/^Web app:\s*(.+)$/i, 'Web 应用：$1'],
    [/^MCP App:\s*(.+)$/i, 'MCP 应用：$1'],
    [/^Started voice chat\s*·\s*(.*)$/i, '已开始语音对话 · $1'],
    [/^Stopped voice chat\s*·\s*(.*)$/i, '已结束语音对话 · $1'],

    // 配额、套餐、额度、隐私与引导文案
    [/^Your quota for\s+(.+?)\s+has been reached\.\s+Switch to another available model to continue\.?(.*)$/i, (_, model, tail) => `你在 ${model} 的配额已用尽，请切换至其他可用模型以继续。${translateQuotaTail(tail)}`.trim()],
    [/^Your quota for\s+(.+?)\s+will reset on\s+(.+?)\.\s+Switch to another available model to continue\.?(.*)$/i, (_, model, date, tail) => `你在 ${model} 的配额将于 ${date} 重置，请切换至其他可用模型以继续。${translateQuotaTail(tail)}`.trim()],
    [/^You have used some of your\s+(weekly|monthly|daily|\d+-hour)\s+limit,\s*it will fully refresh in\s+(.+)$/i, (_, kind, d) => `你已使用部分${prefixSpaceIfAscii(translateLimitKind(kind))}，将在${prefixSpaceIfAscii(translateDuration(d))}后完全重置。`],
    [/^You have hit your\s+(weekly|monthly|daily|\d+-hour)\s+limit,\s*(?:the|your)\s+(weekly|monthly|daily|\d+-hour)\s+limit\s+does not currently apply\.\s+(?:Your\s+(weekly|monthly|daily|\d+-hour)\s+limit|It)\s+(will\s+fully\s+refresh|will\s+refresh|refreshes)\s+in\s+(.+?)(?:\.(?:\s+(.*))?|$)/i, (_, hitKind, suppressedKind, refreshKind, verb, d, tail) => {
      const hitZh = prefixSpaceIfAscii(translateLimitKind(hitKind));
      const suppressedZh = prefixSpaceIfAscii(translateLimitKind(suppressedKind));
      const refreshSubject = refreshKind ? `你的${prefixSpaceIfAscii(translateLimitKind(refreshKind))}` : '它';
      const resetVerb = /fully/i.test(verb) ? '完全重置' : '重置';
      return `你已达到${hitZh}上限，当前不适用${suppressedZh}限制。${refreshSubject}将在${prefixSpaceIfAscii(translateDuration(d))}后${resetVerb}。${translateQuotaTail(tail)}`.trim();
    }],
    [/^You have hit your\s+(weekly|monthly|daily|\d+-hour)\s+limit,\s*it\s+(will\s+fully\s+refresh|will\s+refresh|refreshes)\s+in\s+(.+?)(?:\.(?:\s+(.*))?|$)/i, (_, kind, verb, d, tail) => {
      const kindZh = prefixSpaceIfAscii(translateLimitKind(kind));
      const resetVerb = /fully/i.test(verb) ? '完全重置' : '重置';
      return `你已达到${kindZh}上限，将在${prefixSpaceIfAscii(translateDuration(d))}后${resetVerb}。${translateQuotaTail(tail)}`.trim();
    }],
    [/^You have hit your\s+(weekly|monthly|daily|\d+-hour)\s+limit(?:\.(?:\s+(.*))?|$)/i, (_, kind, tail) => `你已达到${prefixSpaceIfAscii(translateLimitKind(kind))}上限。${translateQuotaTail(tail)}`.trim()],
    [/^(.+?)\s+(Weekly|Daily|Monthly|(\d+)-hour)\s+Limit(?:\s+Remaining)?$/i, (_, model, kind, hours) => {
      const low = kind.toLowerCase();
      const suffix = low === 'weekly' ? '每周配额'
        : low === 'daily' ? '每日配额'
        : low === 'monthly' ? '每月配额'
        : `${hours} 小时配额`;
      return `${model.trim()} ${suffix}`;
    }],
    [/^(\d+)\s*([smhd])\s+limit$/i, (_, n, u) => `${n} ${({ s: '秒', m: '分钟', h: '小时', d: '天' }[u.toLowerCase()] || u)}配额`],
    [/^(?:(Daily|Weekly)|(\d+)\s*([smhd]))\s+limit,\s*resets in\s+(.+)$/i, (_, kind, n, u, d) => {
      const limitLabel = kind
        ? (kind.toLowerCase() === 'daily' ? '每日配额' : '每周配额')
        : `${n} ${({ s: '秒', m: '分钟', h: '小时', d: '天' }[u.toLowerCase()] || u)}配额`;
      const timeText = /^<\s*1\s*m$/i.test(d.trim()) ? '1 分钟内' : `${translateDuration(d)} 后`;
      return `${limitLabel}，将在 ${timeText}重置`;
    }],
    [/^(\d+(?:\.\d+)?)%\s+left$/i, '$1% 剩余'],
    [/^Resets in\s+(.+)$/i, (_, d) => /^<\s*1\s*m$/i.test(d.trim()) ? '将在 1 分钟内重置' : `将在 ${translateDuration(d)} 后重置`],
    [/^Work locally on\s+(.+)$/i, '在本地操作：$1'],
    [/^Automatically create a new\s+(.+?)\s+workspace when the conversation starts$/i, '启动会话时自动创建新的 $1 工作区'],
    [/^Worktree from\s+(.+?),\s+and reuse\s+(.+)$/i, '从 $1 创建工作树，并复用 $2'],
    [/^Worktree from\s+(.+)$/i, '从 $1 创建工作树'],
    [/^Work in\s+(.+)$/i, '运行于 $1'],
    [/^Select Worktree\s*\((.+)\)$/i, '选择工作树 ($1)'],
    [/^(Extra\s+High|XHigh|Minimal|Low|Medium|High|Extra|Max)\s*·\s*(.+)$/i, (_, eff, ctx) => {
      const effZh = translateEffortLevel(eff) || eff;
      const ctxRaw = ctx.trim();
      return `${effZh} · ${lookupExact(ctxRaw, normalizeKey(ctxRaw)) || ctxRaw}`;
    }],
    [/^Select model,\s*current:\s*(.+)$/i, (_, current) => {
      const raw = current.trim();
      const exact = lookupExact(raw, normalizeKey(raw));
      if (exact) return `选择模型，当前：${exact}`;
      const countMatch = raw.match(/^(\d+)\s+models\s+selected$/i);
      if (countMatch) return `选择模型，当前：已选 ${countMatch[1]} 个模型`;
      const effortTranslated = translateModelWithEffort(raw);
      return `选择模型，当前：${effortTranslated || raw}`;
    }],
    [/^Agent permissions preset selector,\s*current:\s*(.+)$/i, (_, p) => `智能体权限预设选择器，当前：${lookupExact(p.trim(), normalizeKey(p.trim())) || p.trim()}`],
    [/^Agent permissions preset:\s*(.+?),\s*(.+)$/i, (_, p, reason) => `智能体权限预设：${lookupExact(p.trim(), normalizeKey(p.trim())) || p.trim()}，${lookupExact(reason.trim(), normalizeKey(reason.trim())) || reason.trim()}`],
    [/^(.+?)\s+needs?\s+the terminal sandbox,\s*which isn't available on this host\.$/i, (_, names) => {
      const translatedNames = names
        .split(/\s+and\s+/i)
        .map((part) => {
          const trimmedPart = part.trim();
          return lookupExact(trimmedPart, normalizeKey(trimmedPart)) || trimmedPart;
        })
        .join('和');
      return `${translatedNames}预设需要终端沙盒，当前主机暂不支持。`;
    }],
    [/^(\d+)\s+models\s+selected$/i, '已选 $1 个模型'],
    [/^You need\s+.+?\s+AI Credits to send messages\..*$/i, (match) => translateQuotaTextParts(match)],
    [/^Your plan's baseline quota will refresh on\s+.*$/i, (match) => translateQuotaTextParts(match)],
    [/^(?:If|If you(?:'re| are))\s+on a supported paid plan,\s*you can use AI credits in the interim(?:\s+or\s+upgrade to a higher tier)?\.?$/i, (match) => translateQuotaTextParts(match)],
    [/^When toggled on,\s+(.+?)\s+collects usage data to help Google enhance performance and features\.?$/i, '开启后，$1 会收集使用数据以帮助 Google 改进性能和功能。'],
    [/^When toggled on,\s+(.+?)\s+will use your AI credits to fulfill model requests once you're out of model quota\.\s+(.+?)\s+will always use your model quota first before using AI credits\.?$/i, '开启后，当模型配额用尽时，$1 将使用你的 AI 额度来完成模型请求。$2 会始终优先使用你的模型配额。'],
    [/^Receive product updates,\s*tips,\s*and promotions from Google\s+(.+?)\s+via email\.?$/i, '通过电子邮件接收来自 Google $1 的产品更新、使用技巧和优惠活动。'],
    [/^Welcome back,\s+(.+?)\.\s+Where should we pick up\?$/i, '欢迎回来，$1。我们从哪里继续？'],
    [/^Welcome back,\s+(.+?)(?:!|\.)?$/i, '欢迎回来，$1！'],
    [/^Good to see you,\s+(.+?)\.\s+What's next\?$/i, '很高兴见到你，$1。接下来要做什么？'],
    [/^Good to see you,\s+(.+?)(?:!|\.)?$/i, '很高兴见到你，$1！'],
    [/^Hey\s+(.+?),\s+what should we build today\?$/i, '嗨 $1，今天想做点什么？'],
    [/^Help us improve\s+(.+?)\.?$/i, '帮助我们改进 $1。'],
    [/^Build with\s+(.+?)\s+Plugins$/i, '使用 $1 插件构建'],
    [/^Choose\s+(.+?)'s Voice$/i, '选择 $1 的语音音色'],
    [/^Release channel:\s*(.+)$/i, '发布渠道：$1'],
    [/^Send feedback as\s+(.+)$/i, '以 $1 的身份发送反馈'],
    [/^Learn more about\s+(.+)$/i, '了解更多关于 $1'],
    [/^By using this app,\s+you agree to its\s+(.+)$/i, '使用此应用即表示你同意其 $1'],
    [/^Select model with\s+(.+)$/i, '使用 $1 选择模型'],

    // 项目管理与权限规则
    [/^Manage\s+(.+?)\s+(resources|folders),\s*agent settings,\s*and permissions\.?$/i, (_, target, noun) => {
      const targetZh = translateEntityNoun(target);
      const nounZh = noun.toLowerCase() === 'resources' ? '资源' : '文件夹';
      return `${joinZhSegment('管理', targetZh, '')}${nounZh}、智能体设置及权限。`;
    }],
    [/^Manage\s+(.+?)\s+(resources|folders)\s+and settings\.?$/i, (_, target, noun) => {
      const targetZh = translateEntityNoun(target);
      const nounZh = noun.toLowerCase() === 'resources' ? '资源' : '文件夹';
      return `${joinZhSegment('管理', targetZh, '')}${nounZh}与设置。`;
    }],
    [/^Manage\s+(.+?)\s+app settings\.?$/i, '管理 $1 应用设置。'],
    [/^Agent settings and permissions for conversations outside of\s+(.+?)\.?$/i, (_, target) => joinZhSegment('配置未归属于任何', translateEntityNoun(target), '的独立会话的智能体设置与权限策略。')],
    [/^Settings for conversations outside of\s+(.+?)\.?$/i, (_, target) => joinZhSegment('在', translateEntityNoun(target), '之外创建的独立会话设置。')],
    [/^Permanently delete\s+(.+?)\s+including\s+(\d+)\s+active conversations?\.?$/i, '永久删除 $1 及其包含的 $2 个活跃会话。'],
    [/^Permanently delete\s+(.+?)\s+including\s+(\d+)\s+conversations?\.?$/i, '永久删除 $1 及其包含的 $2 个会话。'],
    [/^Permanently delete\s+(.+?)\.?$/i, '永久删除 $1。'],
    [/^Reset\s+(\d+)\s+overrides?\.?$/i, '重置 $1 项覆盖设置'],
    [/^Reset\s+(.+?)\s+to default$/i, '将 $1 重置为默认'],
    [/^Yes,\s*(?:and\s*)?(?:always allow|始终允许)\s*'(.*)'\s*in this conversation$/i, '是，在此会话中始终允许“$1”'],
    [/^Yes,\s*(?:and\s*)?(?:always allow|始终允许)\s*'(.*)'\s*in this project$/i, '是，在此项目中始终允许“$1”'],
    [/^Yes,\s*(?:and\s*)?(?:always allow|始终允许)\s*'(.*)'$/i, '是，始终允许“$1”'],
    [/^Yes,\s*save rule for\s*'(.*)'\s*globally$/i, '是，全局保存“$1”的规则'],
    [/^Yes,\s*save rule for\s*'(.*)'\s*in this conversation$/i, '是，在此会话中保存规则“$1”'],
    [/^Yes,\s*save rule for\s*'(.*)'\s*in this project$/i, '是，在此项目中保存规则“$1”'],
    [/^Yes,\s*allow\s+(.+?)\s+in this conversation$/i, '是，在此会话中允许 $1'],
    [/^Yes,\s*allow downloads from\s+(.+?)\s+for this run$/i, '是，本次运行允许来自 $1 的下载'],
    [/^Yes,\s*allow downloads from\s+(.+?)\s+in this conversation$/i, '是，在此会话中允许来自 $1 的下载'],
    [/^Yes,\s*always allow downloads from\s+(.+)$/i, '是，始终允许来自 $1 的下载'],
    [/^Yes,\s*always allow\s+(.+)$/i, '是，始终允许 $1'],
    [/^Save rule to always allow\s+(.+?)\?$/i, (_, t) => `是否保存规则以始终允许${prefixSpaceIfAscii(translatePermissionTarget(t))}？`],
    [/^Allow\s+(.+?)\?$/i, (_, t) => `是否允许${prefixSpaceIfAscii(translatePermissionTarget(t))}？`],
    [/^Review permissions for\s+(.+)$/i, '查看 $1 的权限'],

    // 插件、账号、MCP 与自动化调度
    [/^Set up\s+(.+)$/i, (m, t) => isSafeDynamicTarget(t) ? `配置 ${translateTargetOrKeep(t)}` : m],
    [/^Reconnect\s+(.+)$/i, (m, t) => isSafeDynamicTarget(t) ? `重新连接 ${translateTargetOrKeep(t)}` : m],
    [/^Switch environment\s*\((.+)\)$/i, '切换环境 ($1)'],
    [/^Open the\s+(.+?)\s+plugin$/i, '打开 $1 插件'],
    [/^Managed by the\s+(.+?)\s+automation$/i, '由“$1”自动化任务托管'],
    [/^Managed by the\s+(.+?)\s+plugin$/i, '由“$1”插件托管'],
    [/^Signed in:\s*(.+)$/i, '已登录：$1'],
    [/^Sign in from the\s+(.+?)\s+panel\.?$/i, '请从 $1 面板登录。'],
    [/^Sign in to use\s+(.+?)!$/i, '请登录以使用 $1！'],
    [/^Sign in to\s+(.+?)\s+on this computer$/i, '在此计算机上登录 $1'],
    [/^Sign in to\s+(.+?)\s+remotely$/i, '远程登录 $1'],
    [/^Sign in to\s+(.+)$/i, '登录 $1'],
    [/^Secret for a new\s+(.+?)\s+account$/i, '新 $1 账号的密钥'],
    [/^New secret for\s+(.+)$/i, '$1 的新密钥'],
    [/^Secret for\s+(.+)$/i, '$1 的密钥'],
    [/^Make\s+(.+?)\s+the default\s+(.+?)\s+account$/i, '将 $1 设为默认 $2 账号'],
    [/^MCP server\s+(.+?)\s+requires authentication:\s*sign in to "(.+?)" in the Accounts section of plugin "(.+?)"$/i, 'MCP 服务 $1 需要身份验证：请在插件“$3”的账号部分登录“$2”'],
    [/^MCP server\s+(.+?)\s+requires authentication$/i, 'MCP 服务 $1 需要身份验证'],
    [/^The\s+(.+?)\s+MCP server requires configuration parameters before it can be started\.?$/i, '$1 MCP 服务需要先配置参数才能启动。'],
    [/^The MCP server "(.+?)"(?:\s+from plugin "(.+?)")?\s+failed to start\.?$/i, (_, srv, plugin) => plugin ? `插件“${plugin}”中的 MCP 服务“${srv}”启动失败。` : `MCP 服务“${srv}”启动失败。`],
    [/^Server "(.+?)" not found in config$/i, '配置中未找到服务“$1”'],
    [/^MCP error\s+([^:]+):\s*(.+)$/i, 'MCP 错误 $1：$2'],
    [/^More actions for\s+(.+)$/i, '$1 的更多操作'],
    [/^More for\s+(.+)$/i, (m, t) => isSafeDynamicTarget(t) ? `更多：${translateTargetOrKeep(t)}` : m],
    [/^Toggle\s+(.+)$/i, (m, t) => isSafeDynamicTarget(t) ? `切换 ${translateTargetOrKeep(t)}` : m],
    [/^Open URL in system browser:\s*(.+)$/i, '在系统浏览器中打开 URL：$1'],
    [/^Opens external link:\s*(.+)$/i, '打开外部链接：$1'],
    [/^Open\s+([^\s]+)\s+link\?$/i, '打开 $1 链接？'],
    [/^Daily at\s+(.+)$/i, '每天 $1'],
    [/^Weekly on\s+(.+?)\s+at\s+(.+)$/i, (_, day, time) => `每周${translateScheduleDay(day).replace(/^星期/, '')} ${time}`],
    [/^Monthly on the\s+(.+?)\s+at\s+(.+)$/i, (_, day, time) => `每月 ${translateScheduleDay(day)} ${time}`],
    [/^Every\s+(\d+)\s+minutes?$/i, '每 $1 分钟'],
    [/^Every\s+(\d+)\s+hours?$/i, '每 $1 小时'],
    [/^Next run\s+today\s+around\s+(.+)$/i, '下次运行：今天约 $1'],
    [/^Next run\s+tomorrow\s+around\s+(.+)$/i, '下次运行：明天约 $1'],
    [/^Next run\s+on\s+(.+?)\s+around\s+(.+)$/i, (_, day, time) => `下次运行：${translateScheduleDay(day)} 约 ${time}`],

    // PDF、媒体与表单校验
    [/^Zoom\s+(\d+)%,\s*reset to fit$/i, '缩放 $1%，点击适应页面'],
    [/^Playback speed\s+(.+)$/i, '播放速度 $1'],
    [/^Page\s+(\d+)\s+failed to load$/i, '第 $1 页加载失败'],
    [/^Multiple markers near page\s+(\d+)$/i, '第 $1 页附近有多个标记'],
    [/^Multiple search matches near page\s+(\d+)$/i, '第 $1 页附近有多个搜索匹配项'],
    [/^Search match on page\s+(\d+)$/i, '第 $1 页的搜索匹配项'],
    [/^Render error on page\s+(\d+):?$/i, '第 $1 页渲染错误：'],
    [/^Scroll to:\s*(.+?)\s+on page\s+(\d+)$/i, '滚动到第 $2 页：$1'],
    [/^Microphone blocked\.\s+Allow in\s+(.+?)\.?$/i, '麦克风已被阻止，请在 $1 中允许。'],
    [/^Model unavailable,\s+retrying in\s+(\d+)s(.*)$/i, '模型暂不可用，$1 秒后重试$2'],
    [/^Model unavailable,\s+retrying(.*)$/i, '模型暂不可用，正在重试$1'],
    [/^Recording exceeds 15MB limit\s*\((.+?)\)$/i, '录制大小超过 15MB 限制 ($1)'],
    [/^Total media size exceeds\s+(\d+)MB limit$/i, '媒体总大小超过 $1MB 限制'],
    [/^The folder "(.+?)" does not exist\.\s+Would you like to create it\?$/i, '文件夹“$1”不存在，是否创建？'],
    [/^Please fill in all required fields:\s*(.+)$/i, '请填写所有必填字段：$1'],
    [/^Select at least\s+(\d+)\s+items?$/i, '请至少选择 $1 项'],
    [/^Select at most\s+(\d+)\s+items?$/i, '最多可选择 $1 项'],
    [/^Minimum length is\s+(\d+)$/i, '最小长度为 $1'],
    [/^Maximum length is\s+(\d+)$/i, '最大长度为 $1'],
    [/^Minimum value is\s+(.+)$/i, '最小值为 $1'],
    [/^Maximum value is\s+(.+)$/i, '最大值为 $1'],
    [/^Low contrast ratio\s*\((.+?)\)\.\s+Text may be hard to read\.?$/i, '对比度过低 ($1)，文字可能难以辨认。'],

    // 设置页与模态框动态词条
    [/^Available AI Credits:\s*(.+)$/i, '可用 AI 额度：$1'],
    [/^Your Plan:\s*(.+)$/i, (_, plan) => `当前套餐：${lookupExact(plan, normalizeKey(plan)) || plan}`],
    [/^For\s+(.+?),\s+telemetry is force disabled\.$/i, (_, s) => `${translateScope(s).trim()}已强制禁用遥测。`],
    [/^(?:(.+?)\s+)?For\s+(.+?),\s+this setting is disabled\.\s+This means\s+(.+?)\s+does not collect any of your prompts,\s+content,\s+or model responses,\s+but will still collect general usage patterns\s+\(e\.g\.,\s+feature adoption,\s+active user counts\)\.?$/i, (_, prefix, s, prod) => {
      const p = prefix ? `${lookupExact(prefix.trim(), normalizeKey(prefix.trim())) || prefix.trim()}\n\n` : '';
      return `${p}${translateScope(s).trim()}已禁用此设置。这意味着 ${prod} 不会收集你的任何提示词、内容或模型回复，但仍会收集常规使用模式（例如功能采用率和活跃用户数）。`;
    }],
    [/^For\s+(.+?),\s+this setting is disabled\.$/i, (_, s) => `${translateScope(s).trim()}已禁用此设置。`],
    [/^(?:(.+?)\s+)?Telemetry is turned off for your account\.\s+This means\s+(.+?)\s+does not collect any of your prompts,\s+content,\s+or model responses,\s+but will still collect general usage patterns\s+\(e\.g\.,\s+feature adoption,\s+active user counts\)\.?$/i, (_, prefix, prod) => {
      const p = prefix ? `${lookupExact(prefix.trim(), normalizeKey(prefix.trim())) || prefix.trim()}\n\n` : '';
      return `${p}你的账号已关闭遥测功能。这意味着 ${prod} 不会收集你的任何提示词、内容或模型回复，但仍会收集常规使用模式（例如功能采用率和活跃用户数）。`;
    }],
    [/^(\d+)\s+demoted$/i, '$1 项已降级'],
    [/^(\d+)\s+excluded$/i, '$1 项已排除'],
    [/^(\d+)\s+tools?\s+excluded$/i, '已排除 $1 个工具'],
    [/^(?:\(([\d,]+)\s+tokens?\)|([\d,]+)\s+tokens?)$/i, (_, pNum, rawNum) => pNum ? `（${pNum} 个 Token）` : `${rawNum} 个 Token`],
    [/^No MCP servers found for\s+"(.+?)"$/i, '未找到与“$1”匹配的 MCP 服务'],
    [/^Give each Best of N fork a full clone of your workspace, including its local commit history\. Choosing a winner then gives your workspace that fork's state, so the commits it made are kept\. Forks take longer to create than the default CitC clone\.(?:\s+See\s+(.+?)\.)?$/i, (_, url) => `为每个 Best of N 分支提供工作区的完整克隆（包含本地提交历史）。选定胜出方案后，你的工作区将应用该分支的状态，从而保留其创建的提交。创建分支所需时间会比默认 CitC 克隆更长。${url ? `请参阅 ${url}。` : ''}`],
    [/^Give each Best of N fork its own clone of your Git repository instead of a copy-on-write overlay\. Each fork is then a real repository, so commits it makes are kept when you choose it as the winner\. Forks take longer to create, and the wait grows with the size of your repository\.(?:\s+See\s+(.+?)\.)?$/i, (_, url) => `为每个 Best of N 分支提供独立的 Git 仓库克隆，而非写时复制叠加层。每个分支都是一个真实的仓库，因此你选择它作为胜出方案时会保留其创建的提交。分支创建耗时更长，且等待时间随仓库规模增大而增加。${url ? `请参阅 ${url}。` : ''}`],
    [/^(.+?)\s+\(Experimental\)$/i, (_, label) => `${lookupExact(label, normalizeKey(label)) || label}（实验性）`],
    [/^(\d+)\s+calls?\s*·\s*(.+)$/i, '$1 次通话 · $2'],
    [/^This deletes\s+(\d+)\s+call recordings?\s+\((.+?)\)\s+from your machine\.\s+You can't undo this\.$/i, '此操作将从你的设备上删除 $1 条通话录音（$2），且无法撤销。'],
    [/^Deleted\s+(\d+)\s+recordings?\s+\((.+?)\)$/i, '已删除 $1 条录音（$2）'],
    [/^Failed to delete recordings:\s*(.+)$/i, '删除录音失败：$1'],
    [/^Conflicts with "(.+?)"\s*\(press Enter to replace\)$/i, '与“$1”冲突（按 Enter 替换）'],
    [/^Conflict:\s+also assigned to\s+(.+)$/i, '冲突：也已分配给 $1'],
    [/^Add shortcut for\s+(.+)$/i, '为 $1 添加快捷键'],
    [/^Conflicts with your configured Ask permission:\s*(.+)$/i, '与你配置的询问权限冲突：$1'],
    [/^Requires manual confirmation:\s*(.+)$/i, '需要手动确认：$1'],
    [/^(\d+)\s+selected$/i, '$1 项已选'],
    [/^Select all in\s+(.+)$/i, '全选 $1 中的项目'],
    [/^and\s+(\d+)\s+more$/i, '及另外 $1 项'],
    [/^pid\s+(\d+)$/i, 'PID $1'],
    [/^Stopping\s+(\d+)\s+tasks?(?:\.\s*Closed\s+(\d+)\s+terminals?)?$/i, (_, t, term) => term ? `正在停止 ${t} 个任务。已关闭 ${term} 个终端` : `正在停止 ${t} 个任务`],
    [/^Closed\s+(\d+)\s+terminals?$/i, '已关闭 $1 个终端'],
    [/^Not referenced by any feature\s*\((\d+)\)$/i, '未被任何功能引用（$1）'],
    [/^gates\s+(.+?)\s+\+(\d+)\s+more$/i, '控制功能：$1 及另外 $2 项'],
    [/^gates\s+(.+)$/i, '控制功能：$1'],
    [/^Auth code for\s+(.+)$/i, '$1 的授权码'],
    [/^Add label for\s+(.+)$/i, '为 $1 添加标签'],
    [/^Edit\s+(project|workspace)\s+name$/i, (_, n) => `编辑${translateEntityNoun(n)}名称`],
    [/^Delete\s+(project|workspace)$/i, (_, n) => `删除${translateEntityNoun(n)}`],
    [/^Duplicate\s+(project|workspace)\s+name$/i, (_, n) => `${translateEntityNoun(n)}名称重复`],
    [/^Failed to delete\s+(project|workspace):\s*(.+)$/i, (_, n, err) => `删除${translateEntityNoun(n)}失败：${err}`],
    [/^Failed to save\s+(project|workspace):\s*(.+)$/i, (_, n, err) => `保存${translateEntityNoun(n)}失败：${err}`],
    [/^Cannot add folder:\s*"(.+?)"\s+is not a valid folder location\.$/i, '无法添加文件夹：“$1”不是有效的文件夹位置。'],
    [/^Failed to resolve folder:\s*(.+)$/i, '解析文件夹失败：$1'],

    // Swarm 智能体集群面板及相对时间通用动态词条
    [/^(\d+)\s*(mo|months?|years?|yrs?|weeks?|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[smhdwy])\s+ago$/i, (_, n, u) => `${n} ${translateRelativeUnit(u)}前`],
    [/^read #(\d+)$/i, '已读 #$1'],
    [/^last change:\s*(.+)$/i, '上次变更：$1'],
    [/^(.+?)\s+\(you\)\s*·\s*(.+)$/i, '$1（你）· $2'],
    [/^(\d+)\s+messages?$/i, '$1 条消息'],
    [/^(\d+)\s+unread$/i, '$1 条未读'],
    [/^(\d+)\s+working$/i, '$1 个运行中'],
    [/^(\d+)\s+waiting$/i, '$1 个等待中'],
    [/^(\d+)\s+stopped$/i, '$1 个已停止'],
    [/^(\d+)\s+killed$/i, '$1 个已终止'],

    // 全软件提醒横幅、通知栏、Toast 与动态提示模板
    [/^Agent finished:\s*(.+)$/i, '智能体已完成：$1'],
    [/^Command:\s*(.+)$/i, '命令：$1'],
    [/^URL:\s*(.+)$/i, '链接：$1'],
    [/^(\d+)\s+customizations? failed to load$/i, '$1 项自定义配置加载失败'],
    [/^\+(\d+)\s+more\s*\(Show all\)$/i, '还有 $1 项（显示全部）'],
    [/^(\d+)\s+comments?$/i, '$1 条批注'],
    [/^Start Best-of-(\d+)$/i, '开始 Best-of-$1'],
    [/^Compare responses from\s+(\d+)\s+models side-by-side to find the best result\.$/i, '并排对比来自 $1 个模型的回复，以找出最佳结果。'],
    [/^Preview unavailable\s*[—–-]\s*(.+)$/i, '预览不可用 — $1'],
    [/^Failed to save cloud permission settings:\s*(.+)$/i, '保存云端权限设置失败：$1'],
    [/^Failed to save project Google3 configuration:\s*(.+)$/i, '保存项目 Google3 配置失败：$1'],
    [/^Failed to save project settings:\s*(.+)$/i, '保存项目设置失败：$1'],
    [/^Failed to save project permissions:\s*(.+)$/i, '保存项目权限失败：$1'],
    [/^Failed to save settings:\s*(.+)$/i, '保存设置失败：$1'],
    [/^Failed to unarchive project:\s*(.+)$/i, '取消归档项目失败：$1'],
    [/^Failed to select workspace:\s*(.+)$/i, '选择工作区失败：$1'],
    [/^Failed to create project:\s*(.+)$/i, '创建项目失败：$1'],
    [/^Failed to resolve folder:\s*(.+?)\s*\((.+)\)$/i, '解析文件夹失败：$1 ($2)'],
    [/^Failed to create\s+"(.+?)"\.?$/i, '创建“$1”失败'],
    [/^Failed to create\s+(?!https?:\/\/)(.+?):\s+(.+)$/i, (m, what, err) => isKnownFailedTarget(what) ? `${joinZhSegment('创建', translateFailedTarget(what), '失败')}：${err}` : m],
    [/^Failed to create\s+(.+?)\.?$/i, (m, what) => isKnownFailedTarget(what) ? joinZhSegment('创建', translateFailedTarget(what), '失败') : m],
    [/^Failed to archive\s+(.+?)\.?$/i, (m, what) => isKnownFailedTarget(what) ? joinZhSegment('归档', translateFailedTarget(what), '失败') : m],
    [/^Failed to delete\s+"(.+?)"$/i, '删除“$1”失败'],
    [/^Failed to delete\s+(?!https?:\/\/)(.+?):\s+(.+)$/i, (m, what, err) => isKnownFailedTarget(what) ? `${joinZhSegment('删除', translateFailedTarget(what), '失败')}：${err}` : m],
    [/^Failed to delete\s+(.+?)\.?$/i, (m, what) => isKnownFailedTarget(what) ? joinZhSegment('删除', translateFailedTarget(what), '失败') : m],
    [/^([A-Za-z0-9_.-]+)\s+archived$/i, (m, what) => isKnownFailedTarget(what) ? joinZhSegment('', translateEntityNoun(what), '已归档') : m],
    [/^([A-Za-z0-9_.-]+)\s+deleted$/i, (m, what) => isKnownFailedTarget(what) ? joinZhSegment('', translateEntityNoun(what), '已删除') : m],
    [/^Duplicate\s+(.+?)\s+name$/i, (_, what) => joinZhSegment('', translateEntityNoun(what), '名称重复')],
    [/^Created automation\s+"(.+?)"\.?$/i, '已创建自动化任务“$1”。'],
    [/^Using default\s+(.+?)\s+name$/i, (_, what) => joinZhSegment('正在使用默认', translateEntityNoun(what), '名称')],
    [/^Connected to\s+(.+)$/i, '已连接到 $1'],
    [/^Couldn't connect to\s+(.+)$/i, '无法连接到 $1'],
    [/^This window's agents,\s*files,\s*and terminals are on\s+(.+?)\.?$/i, '此窗口中的智能体、文件和终端均运行在 $1 上。'],
    [/^Couldn't\s+([a-z]+(?:\s+[a-z]+){0,2})\s+conversation$/i, (m, verb) => {
      const zh = CONVERSATION_VERB_MAP[verb.toLowerCase()];
      return zh ? `无法${zh}` : m;
    }],
    [/^Failed to\s+([a-z]+(?:\s+[a-z]+){0,2})\s+conversation$/i, (m, verb) => {
      const zh = CONVERSATION_VERB_MAP[verb.toLowerCase()];
      return zh ? `无法${zh}` : m;
    }],
    [/^Enabled\s+"(.+?)"\.?$/i, '已启用“$1”。'],
    [/^Started\s+"(.+?)"\.?$/i, '已启动“$1”。'],
    [/^Failed to start\s+"(.+?)"\.?$/i, '启动“$1”失败'],
    [/^Restarted\s+"(.+?)"\.?$/i, '已重启“$1”。'],
    [/^Failed to update\s+"(.+?)"$/i, '更新“$1”失败'],
    [/^Failed to save\s+"(.+?)"$/i, '保存“$1”失败'],
    [/^Deleted\s+"(.+?)"\.?$/i, '已删除“$1”。'],
    [/^(.+)\.\s+Starting in local workspace\.$/i, '$1。正在本地工作区中启动。'],
    [/^See\s+(.+?):\s*(https?:\/\/\S+)$/i, '请参阅 $1：$2'],

    // 悬停提示与按钮带参数小字动态规则
    [/^Source\s+(\d+)$/i, '来源 $1'],
    [/^Chunk\s+(\d+)$/i, '片段 $1'],
    [/^(\d+)\s+chunks$/i, '$1 个片段'],
    [/^(\d+)\s+tools$/i, '$1 个工具'],
    [/^\+(\d+)\s+attachments?$/i, '+$1 个附件'],
    [/^(\d+)\s+attachment\(s\)$/i, '$1 个附件'],
    [/^(\d+)\s+Files?\s+With\s+Changes$/i, '$1 个已更改文件'],
    [/^Voice speed,\s*(.+)$/i, '语音倍速：$1'],
    [/^(Live chat|Voice mode),\s*(.+)$/i, (_, mode, status) => `${mode.toLowerCase() === 'live chat' ? '实时语音' : '语音模式'}：${lookupExact(status.trim(), normalizeKey(status.trim())) || status.trim()}`],
    [/^Unmute\s+(.+)$/i, (_, target) => `取消静音 ${lookupExact(target.trim(), normalizeKey(target.trim())) || target.trim()}`],
    [/^Mute\s+(.+)$/i, (_, target) => `静音 ${lookupExact(target.trim(), normalizeKey(target.trim())) || target.trim()}`],
    [/^(?:Send|Queue)\s+Message\s+(Enter|\u23ce)$/i, (m, k) => /^send/i.test(m) ? `发送消息 (${k})` : `排队发送消息 (${k})`],
    [/^Cancel Questionnaire and Stop the Agent\s*\((.+)\)$/i, '取消问卷并停止智能体 ($1)'],
    [/^(Disable|Enable|Toggle)\s+Word\s+Wrap(.*)$/i, (_, act, rest) => `${act.toLowerCase() === 'disable' ? '关闭' : act.toLowerCase() === 'enable' ? '开启' : '切换'}自动换行${rest}`],
    [/^Environment paused\.\s*Click to resume it and load the\s+(.+?)\.?$/i, (_, what) => `${joinZhSegment('环境已暂停，点击恢复并加载', translateEntityNoun(what), '。')}`],
    [/^Failed to load\s+(?!https?:\/\/)(.+?):\s+(.+)$/i, (m, what, err) => isKnownFailedTarget(what) ? `${joinZhSegment('加载', translateFailedTarget(what), '失败')}：${err}` : m],
    [/^Failed to load\s+(.+?)\.?$/i, (m, what) => isKnownFailedTarget(what) ? joinZhSegment('加载', translateFailedTarget(what), '失败') : m],
    [/^Environment:\s*(.+)$/i, '环境：$1'],
    [/^Select Environment\s*\((.+)\)$/i, '选择环境 ($1)'],
    [/^Select project,\s*current:\s*(.+)$/i, '选择项目，当前：$1'],
    [/^(\d+)\s+MCP servers? failed to start$/i, '$1 个 MCP 服务启动失败'],
    [/^(Disable|Enable)\s+(.+?)\s+tool for\s+(.+)$/i, (_, act, tool, target) => `为 ${target} ${act.toLowerCase() === 'disable' ? '禁用' : '启用'} ${tool} 工具`],
    [/^Open\s+(.+?)\s+skill$/i, '打开 $1 技能'],
    [/^Run\s+(.+?)\s+now$/i, '立即运行 $1'],
    [/^Resume\s+(\d+)\s+comment\s+drafts?$/i, '恢复 $1 条批注草稿'],
    [/^Copy\s+(Project|Workspace)\s+Name$/i, (_, n) => `复制${translateEntityNoun(n)}名称`],
    [/^Pause\s+(.+)$/i, (m, t) => isSafeDynamicTarget(t) ? `暂停 ${translateTargetOrKeep(t)}` : m],
    [/^Resume\s+(.+)$/i, (m, t) => isSafeDynamicTarget(t) ? `恢复 ${translateTargetOrKeep(t)}` : m],
    [/^Restart\s+(.+)$/i, (m, t) => isSafeDynamicTarget(t) ? `重启 ${translateTargetOrKeep(t)}` : m],
    [/^Install\s+(.+)$/i, (m, t) => isSafeDynamicTarget(t) ? `安装 ${translateTargetOrKeep(t)}` : m],
    [/^Disconnect\s+(.+)$/i, (m, t) => isSafeDynamicTarget(t) ? `断开与 ${translateTargetOrKeep(t)} 的连接` : m],
    [/^Close\s+(.+)$/i, (m, t) => isSafeDynamicTarget(t) ? `关闭 ${translateTargetOrKeep(t)}` : m],
    [/^Unpin\s+(.+)$/i, (m, t) => isSafeDynamicTarget(t) ? `取消置顶 ${translateTargetOrKeep(t)}` : m],
    [/^Remove\s+(.+?)\s+from Recent$/i, '从最近记录中移除 $1'],
    [/^Removed\s+(.+?)\s+from Recent$/i, '已从最近记录中移除 $1'],
    [/^Couldn't remove\s+(.+?)\s+from Recent$/i, '无法从最近记录中移除 $1'],
    [/^Remove\s+(.+?)\s+from list$/i, '从列表中移除 $1'],
    [/^Remove context from\s+(.+)$/i, '从 $1 移除上下文'],
    [/^Hide\s+(.+?)\s+from this list$/i, '从此列表中隐藏 $1'],
    [/^Show\s+(.+?)\s+in the list again$/i, '重新在列表中显示 $1'],
    [/^Remove\s+(.+)$/i, (m, t) => isSafeDynamicTarget(t) ? `移除 ${translateTargetOrKeep(t)}` : m],
    [/^Copy\s+(.+)$/i, (m, t) => isSafeDynamicTarget(t) ? `复制 ${translateTargetOrKeep(t)}` : m],
    [/^View\s+(\d+)\s+help(?:\s+items?)?\s+and\s+(\d+)\s+side questions?$/i, '查看 $1 项帮助与 $2 个临时提问'],
    [/^View\s+(\d+)\s+help(?:\s+items?)?$/i, '查看 $1 项帮助'],
    [/^View\s+(\d+)\s+side questions?$/i, '查看 $1 个临时提问'],
    [/^(\d+)\s+Help\s*·\s*(\d+)\s+Side Questions?$/i, '$1 项帮助 · $2 个临时提问'],
    [/^(\d+)\s+Help$/i, '$1 项帮助'],
    [/^(\d+)\s+Side Questions?$/i, '$1 个临时提问'],
    [/^Question\s+(\d+)\s+of\s+(\d+)$/i, '第 $1 / $2 个问题'],
    [/^Edit:\s*(.+)$/i, '编辑：$1'],
    [/^Delete:\s*(.+)$/i, '删除：$1'],
    [/^Send now:\s*(.+)$/i, '立即发送：$1'],
    [/^Models within this group:\s*(.+)$/i, '此分组包含的模型：$1'],
    [/^Forked from\s+"(.+?)"$/i, '分支自“$1”'],
    [/^Forked from\s+(.+)$/i, '分支自 $1'],
    [/^(\d+)\s+tasks?\s+running$/i, '$1 个任务运行中'],
    [/^Updated\s+(.+)$/i, (m, rest) => {
      const t = String(rest).trim();
      if (/^now$/i.test(t) || /^just now$/i.test(t)) return '刚刚更新';
      if (/^today$/i.test(t)) return '更新于今天';
      if (t.toLowerCase() === 'yesterday') return '更新于昨天';
      if (/^(?:a\s+)?few\s+seconds\s+ago$/i.test(t)) return '更新于几秒前';
      const agoMatch = t.match(/^(?:(\d+)|(a|an))\s*(mo|months?|years?|yrs?|weeks?|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[smhdwy])\s*ago$/i);
      if (agoMatch) {
        const count = agoMatch[1] || '1';
        return `更新于 ${count} ${translateRelativeUnit(agoMatch[3])}前`;
      }
      if (/^\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM))?$/i.test(t) || /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(t) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t)) {
        return `更新于 ${t}`;
      }
      const monthRe = /(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)/i;
      if (monthRe.test(t) && /\d{1,2}/.test(t)) {
        const monthMap = { jan: '1月', feb: '2月', mar: '3月', apr: '4月', may: '5月', jun: '6月', jul: '7月', aug: '8月', sep: '9月', oct: '10月', nov: '11月', dec: '12月' };
        const formatted = t
          .replace(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i, (_, mon, d, y) => `${y}年${monthMap[mon.slice(0, 3).toLowerCase()] || mon}${d}日`)
          .replace(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?,?\s+(\d{4})\b/i, (_, d, mon, y) => `${y}年${monthMap[mon.slice(0, 3).toLowerCase()] || mon}${d}日`)
          .replace(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i, (_, mon, d) => `${monthMap[mon.slice(0, 3).toLowerCase()] || mon}${d}日`)
          .replace(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\b/i, (_, d, mon) => `${monthMap[mon.slice(0, 3).toLowerCase()] || mon}${d}日`)
          .replace(/(\d{1,2}月\d{1,2}日),\s*/g, '$1 ');
        return `更新于 ${formatted.trim()}`;
      }
      return m;
    }],
    [/^Connect GitHub:\s*(.+)$/i, '连接 GitHub：$1'],
    [/^GitHub:\s*(.+)$/i, 'GitHub：$1'],
    [/^(\d+)\s+members?$/i, '$1 名成员'],
    [/^In review\s*\u00b7\s*Code-Review\s*([+-]?\d+)$/i, '审核中 · 代码评审 $1'],
    [/^Approved\s*\u00b7\s*Code-Review\s*\+(\d+)$/i, '已批准 · 代码评审 +$1'],

    // 模型标签说明 (i) 动态模板
    [/^(.+?)\s+that may offload routine steps to\s+(.+?)\.\s*Same\s+(.+?)-level quality,\s*fewer tokens used\.?$/i, '$1，可将常规步骤分流至 $2。同等 $3 级质量，消耗更少 Token。'],
    [/^(.+?)\s+will be removed from\s+Antigravity\s+on\s+([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})\.?$/i, (_, model, month, day, year) => {
      const mMap = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
      const mNum = mMap[month.toLowerCase()];
      const dateStr = mNum ? `${year}年${mNum}月${day}日` : `${month} ${day}, ${year}`;
      return `${model} 将于 ${dateStr}从 Antigravity 中移除。`;
    }],
    [/^(.+?)\s+will be removed from\s+Antigravity\s+on\s+(.+?)\.?$/i, '$1 将于 $2 从 Antigravity 中移除。'],
    [/^(.+?)\s+is currently available to\s+(.+?)\s+plan subscribers\.?$/i, '$1 目前仅面向 $2 套餐订阅用户开放。'],
    [/^(.+?)\s+is currently only available to\s+(.+?)\.?$/i, '$1 目前仅面向 $2 开放。'],

    // 云端资源接入、Notebook 与草稿计数动态模板
    [/^Add\s+(.+?)\s+resources$/i, '添加 $1 资源'],
    [/^Connect your account to browse\s+(.+?)\.?$/i, '连接你的账号以浏览 $1。'],
    [/^A project's private resources must all belong to one owner \(([^)]+)\)\.?$/i, '同一项目中的私有资源必须全部归属于同一所有者 ($1)。'],
    [/^(Failed to execute|Executing|Executed)\s+notebook(?:\s+cells)?$/i, (m, act) => {
      const cells = /cells$/i.test(m) ? '单元格' : '';
      const low = act.toLowerCase();
      if (low === 'executing') return cells ? `正在执行 Notebook ${cells}` : '正在执行 Notebook';
      if (low === 'executed') return cells ? `已执行 Notebook ${cells}` : '已执行 Notebook';
      return cells ? `执行 Notebook ${cells}失败` : '执行 Notebook 失败';
    }],
    [/^(\d+)\s+Drafts?$/i, '$1 份草稿'],
    [/^(\d+)\s+cookies?$/i, '$1 个 Cookie'],
    [/^Delete cookies for\s+(.+)$/i, '删除 $1 的 Cookie'],
    [/^Adding plugins from\s+(.+)$/i, '正在从 $1 添加插件'],
    [/^Add bundle\s+(.+)$/i, '添加插件包 $1'],
    [/^This plugin in\s+(.+?)\s+may have looser code review\.\s+Review its contents before adding the bundle\.?$/i, '$1 中的此插件代码审查可能较宽松，请在添加插件包前先查看其内容。'],
    [/^These plugins in\s+(.+?)\s+may have looser code review\.\s+Review its contents before adding the bundle\.?$/i, '$1 中的这些插件代码审查可能较宽松，请在添加插件包前先查看其内容。'],
    [/^Running for\s+(\d+\s*[smhd](?:\s+\d+\s*[smhd])*)$/i, (_, d) => `已运行 ${translateDuration(d)}`],
    [/^Up\s+(\d+\s*[smhd](?:\s+\d+\s*[smhd])*)$/, (_, d) => `已运行 ${translateDuration(d)}`]
  ];

  return {
    DYNAMIC_RULES,
    translateDuration,
    translateCompactRelativeTime,
    translateCompactDuration,
    translateEffortLevel,
    translateModelWithEffort,
    translateLimitKind,
    translateScope,
    translateEntityNoun,
    translateQuotaTextParts
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createDynamicRules };
}
