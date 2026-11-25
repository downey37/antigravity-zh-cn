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

  function translateModelParenEffort(str) {
    const s = String(str || '').trim();
    if (!s) return null;
    const dotMatch = s.match(/^(.+?)\s*\u00b7\s*(.+)$/);
    const head = dotMatch ? dotMatch[1].trim() : s;
    const tailRaw = dotMatch ? dotMatch[2].trim() : '';
    const tailZh = tailRaw ? (lookupExact(tailRaw, normalizeKey(tailRaw)) || tailRaw) : '';

    const statusMatch = head.match(/^(.+?)\s*\((unavailable|latest)\)$/i);
    const core = statusMatch ? statusMatch[1].trim() : head;
    const statusZh = statusMatch
      ? (statusMatch[2].toLowerCase() === 'unavailable' ? '不可用' : '最新')
      : '';

    let coreZh = core;
    const m = core.match(/^(.+?)\s*\((Extra\s+High|XHigh|Minimal|Low|Medium|High|Extra|Max)(?:\s+Thinking)?\)$/i);
    if (m) {
      const base = m[1].trim();
      const effZh = translateEffortLevel(m[2]);
      if (base && effZh) {
        coreZh = `${base} (${effZh})`;
      }
    }

    let out = statusZh ? `${coreZh} (${statusZh})` : coreZh;
    if (tailRaw) {
      out = `${out} \u00b7 ${tailZh}`;
    }
    return out !== s ? out : null;
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

  function translateClockTime(raw) {
    const s = String(raw || '').trim();
    const hm = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (hm) {
      const hour = Number(hm[1]);
      const min = hm[2];
      const isAm = hm[3].toUpperCase() === 'AM';
      if (hour === 12) {
        if (isAm) return `凌晨 00:${min}`;
        return min === '00' ? '中午 12:00' : `下午 12:${min}`;
      }
      if (isAm) {
        return `${hour <= 5 ? '凌晨' : '上午'} ${hm[1]}:${min}`;
      }
      return `${hour >= 6 && hour <= 11 ? '晚上' : '下午'} ${hm[1]}:${min}`;
    }
    const h = s.match(/^(\d{1,2})\s*(AM|PM)$/i);
    if (h) {
      const hour = Number(h[1]);
      const isAm = h[2].toUpperCase() === 'AM';
      if (hour === 12) {
        return isAm ? '凌晨 0 点' : '中午 12 点';
      }
      if (isAm) {
        return `${hour <= 5 ? '凌晨' : '上午'} ${h[1]} 点`;
      }
      return `${hour >= 6 && hour <= 11 ? '晚上' : '下午'} ${h[1]} 点`;
    }
    return s;
  }

  function translateClockTimeList(raw) {
    const s = String(raw || '').trim();
    if (!s) return s;
    const tzMatch = s.match(/^(.+?)(?:\s+(GMT[+-]\d+(?::\d+)?|UTC|(?!AM$|PM$)[A-Z]{2,5}))$/);
    const timePart = tzMatch ? tzMatch[1].trim() : s;
    const tzPart = tzMatch ? tzMatch[2].trim() : '';
    const items = timePart
      .split(/\s*(?:,\s*|\band\b)\s*/i)
      .map((part) => part.trim())
      .filter(Boolean)
      .map(translateClockTime);
    const joined = items.join('、');
    return tzPart ? `${joined} ${tzPart}` : joined;
  }

  const SCHEDULE_SHORT_DAY_MAP = {
    sunday: '周日', sundays: '周日', sun: '周日',
    monday: '周一', mondays: '周一', mon: '周一',
    tuesday: '周二', tuesdays: '周二', tue: '周二', tues: '周二',
    wednesday: '周三', wednesdays: '周三', wed: '周三',
    thursday: '周四', thursdays: '周四', thu: '周四', thur: '周四', thurs: '周四',
    friday: '周五', fridays: '周五', fri: '周五',
    saturday: '周六', saturdays: '周六', sat: '周六'
  };

  function translateScheduleDaysPhrase(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const low = s.toLowerCase();
    if (low === 'weekdays') return '每工作日';
    if (low === 'weekends') return '每周末';
    const singlePlural = low.match(/^(sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays)$/);
    if (singlePlural) {
      return `每${SCHEDULE_SHORT_DAY_MAP[singlePlural[1]]}`;
    }
    const parts = s
      .replace(/,\s*and\s+/gi, ', ')
      .split(/\s*(?:,\s*|\band\b)\s*/i)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    const mapped = [];
    for (const part of parts) {
      const zh = SCHEDULE_SHORT_DAY_MAP[part.toLowerCase()];
      if (!zh) return null;
      mapped.push(zh);
    }
    return `每${mapped.join('、')}`;
  }

  function translateScheduleSummary(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (/^Custom schedule$/i.test(s)) return '自定义计划';

    let m = s.match(/^Daily at\s+(.+)$/i);
    if (m) return `每天 ${translateClockTimeList(m[1])}`;

    m = s.match(/^Weekly on\s+(.+?)\s+at\s+(.+)$/i);
    if (m) return `每周${translateScheduleDay(m[1]).replace(/^星期/, '')} ${translateClockTimeList(m[2])}`;

    m = s.match(/^Monthly on the\s+(.+?)\s+at\s+(.+)$/i);
    if (m) return `每月 ${translateScheduleDay(m[1])} ${translateClockTimeList(m[2])}`;

    m = s.match(/^Every\s+(\d+)\s+minutes?(?:\s+on\s+(.+))?$/i);
    if (m) {
      const daysZh = m[2] ? translateScheduleDaysPhrase(m[2]) : '';
      if (m[2] && !daysZh) return null;
      return `${daysZh}每 ${m[1]} 分钟`;
    }

    m = s.match(/^Every\s+(\d+)\s+hours?(?:\s+on\s+(.+))?$/i);
    if (m) {
      const daysZh = m[2] ? translateScheduleDaysPhrase(m[2]) : '';
      if (m[2] && !daysZh) return null;
      return `${daysZh}每 ${m[1]} 小时`;
    }

    m = s.match(/^Every hour,\s*(\d{1,2}\s*(?:AM|PM))\s+to\s+(\d{1,2}\s*(?:AM|PM))(?:,\s*on\s+(.+))?$/i);
    if (m) {
      const daysZh = m[3] ? translateScheduleDaysPhrase(m[3]) : '';
      if (m[3] && !daysZh) return null;
      return `${daysZh}每小时（${translateClockTime(m[1])}至${translateClockTime(m[2])}）`;
    }

    m = s.match(/^Every hour(?:\s+at\s+:(\d{2}))?(?:\s+on\s+(.+))?$/i);
    if (m) {
      const daysZh = m[2] ? translateScheduleDaysPhrase(m[2]) : '';
      if (m[2] && !daysZh) return null;
      const base = m[1] ? `每小时第 ${m[1]} 分` : '每小时';
      return `${daysZh}${base}`;
    }

    m = s.match(/^(.+?)\s+at\s+(.+)$/i);
    if (m) {
      const daysZh = translateScheduleDaysPhrase(m[1]);
      if (daysZh) {
        return `${daysZh} ${translateClockTimeList(m[2])}`;
      }
    }

    return null;
  }

  function translateRequiredBlockerItem(raw) {
    const trimmed = String(raw || '').trim();
    const map = {
      title: '标题',
      name: '名称',
      'unique title': '不重复的标题',
      'unique name': '不重复的名称',
      instructions: '指令说明',
      trigger: '触发器',
      project: '项目',
      'available run location': '可用的运行位置',
      'account connection': '账号连接'
    };
    const low = trimmed.toLowerCase();
    return map[low] || lookupExact(trimmed, normalizeKey(trimmed)) || trimmed;
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
    if (!m) return `${prefix || ''}${suffix || ''}`;
    const p = prefix || '';
    const s = suffix || '';
    const pNoSpace = !p || /[\s（《【“‘：，。！？、；）]$/.test(p);
    const sNoSpace = !s || /^[\s。！？，、；：）》】”’.!?,;:)]/.test(s);
    const leadSpace = !pNoSpace && (/[A-Za-z0-9]$/.test(p) || /^[A-Za-z0-9/]/.test(m)) ? ' ' : '';
    const tailSpace = !sNoSpace && (/^[A-Za-z0-9]/.test(s) || /[A-Za-z0-9]$/.test(m)) ? ' ' : '';
    return `${p}${leadSpace}${m}${tailSpace}${s}`;
  }

  const MONTH_NUM_MAP = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
  };

  function formatEnDateToZh(rawDate) {
    const s = String(rawDate || '').replace(/[.\s]+$/g, '').trim();
    if (!s) return s;
    const mdy = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
    if (mdy) {
      const mNum = MONTH_NUM_MAP[mdy[1].toLowerCase()];
      if (mNum) return `${mdy[3]}年${mNum}月${mdy[2]}日`;
    }
    const dmy = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})$/);
    if (dmy) {
      const mNum = MONTH_NUM_MAP[dmy[2].toLowerCase()];
      if (mNum) return `${dmy[3]}年${mNum}月${dmy[1]}日`;
    }
    const md = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/);
    if (md) {
      const mNum = MONTH_NUM_MAP[md[1].toLowerCase()];
      if (mNum) return `${mNum}月${md[2]}日`;
    }
    const dm = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?$/);
    if (dm) {
      const mNum = MONTH_NUM_MAP[dm[2].toLowerCase()];
      if (mNum) return `${mNum}月${dm[1]}日`;
    }
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) {
      return `${iso[1]}年${Number(iso[2])}月${Number(iso[3])}日`;
    }
    return s;
  }

  const EXACT_PLAN_MAP = {
    'free': '免费版',
    'free plan': '免费套餐',
    'free tier': '免费套餐',
    'free users': '免费用户',
    'free users and google ai plus users': '免费用户和 Google AI Plus 用户',
    'free and google ai plus users': '免费用户和 Google AI Plus 用户',
    'free and google ai plus plans': '免费版和 Google AI Plus 套餐',
    'antigravity starter quota': 'Antigravity 入门配额',
    'starter quota': '入门配额',
    'enterprise gateway': '企业网关',
    'your current plan': '你当前的套餐',
    'your plan': '你当前的套餐',
    'current plan': '当前套餐',
    'higher tier': '更高级别套餐',
    'higher plan': '更高级别套餐',
    'highest tier': '最高级别套餐',
    'highest plan': '最高级别套餐',
    'free trial': '免费试用期',
    'your organization': '你的组织',
    'your administrator': '你的管理员',
    'eligible accounts': '符合条件的账号',
    'eligible users': '符合条件的用户',
    'google ai plan': 'Google AI 套餐',
    'google ai plans': 'Google AI 套餐',
    'google ai plus': 'Google AI Plus',
    'google ai pro': 'Google AI Pro',
    'google ai ultra': 'Google AI Ultra',
    'google ai ultra 5x': 'Google AI Ultra 5x',
    'google ai ultra 20x': 'Google AI Ultra 20x',
    'google ai enterprise': 'Google AI Enterprise',
    'antigravity business': 'Antigravity Business',
    'gemini enterprise': 'Gemini Enterprise',
    'google workspace': 'Google Workspace',
    'google cloud standard': 'Google Cloud Standard',
    'google cloud enterprise': 'Google Cloud Enterprise',
    'google ai pro (trial)': 'Google AI Pro（试用版）',
    'google ai pro (promotional)': 'Google AI Pro（促销版）',
    'google ai ultra (trial)': 'Google AI Ultra（试用版）',
    'google ai ultra (promotional)': 'Google AI Ultra（促销版）',
    'google ai pro or above': 'Google AI Pro 或更高级别套餐',
    'google ai ultra 5x or above': 'Google AI Ultra 5x 或更高级别套餐',
    'pro or above': 'Pro 或更高级别套餐',
    'ultra 5x or above': 'Ultra 5x 或更高级别套餐'
  };

  const KNOWN_TIER_TOKEN_RE = /^(?:(?:google\s+ai\s+)?(?:plus|pro|ultra(?:\s+(?:5x|20x))?|enterprise)|antigravity\s+business|gemini\s+enterprise|google\s+workspace|google\s+cloud(?:\s+(?:standard|enterprise))?|google\s+ai|free|enterprise|business|standard|5x|20x)(?:\s*\((?:trial|promotional)\))?$/i;

  function translateTierToken(tok, hasUserOrPlanSuffix) {
    const t = String(tok || '').trim();
    const low = t.toLowerCase();
    if (low === 'free') return hasUserOrPlanSuffix ? '免费' : '免费版';
    if (low === 'enterprise') return '企业版';
    if (low === 'business') return '企业版';
    const paren = t.match(/^(.+?)\s*\((trial|promotional)\)$/i);
    if (paren) {
      const tag = paren[2].toLowerCase() === 'trial' ? '试用版' : '促销版';
      return `${paren[1].trim()}（${tag}）`;
    }
    return t;
  }

  function translatePlanOrAudience(raw, strict = false) {
    const orig = String(raw || '').replace(/[.\s]+$/g, '').trim();
    if (!orig) return strict ? null : orig;
    const stripped = orig.replace(/^(?:a|an|the)\s+/i, '').trim();
    const lowFull = stripped.toLowerCase();
    const allowBare = strict === 'allowBare';
    if (Object.prototype.hasOwnProperty.call(EXACT_PLAN_MAP, lowFull)) {
      if (strict && !allowBare && lowFull === 'free') return null;
      return EXACT_PLAN_MAP[lowFull];
    }

    // 处理形如 "X users and Y users" 的并列用户群体
    const multiUsers = stripped.match(/^(.+?)\s+users?\s+(and|or)\s+(.+?)\s+users?$/i);
    if (multiUsers) {
      const left = translatePlanOrAudience(`${multiUsers[1]} users`, true);
      const right = translatePlanOrAudience(`${multiUsers[3]} users`, true);
      if (left && right) {
        const conj = multiUsers[2].toLowerCase() === 'and' ? '和' : '或';
        return joinZhSegment(left, conj, right);
      }
    }

    let rem = stripped;
    let suffix = '';
    const suffixRules = [
      [/\s+plan\s+subscribers$/i, '订阅用户'],
      [/\s+tier\s+subscribers$/i, '订阅用户'],
      [/\s+subscribers$/i, '订阅用户'],
      [/\s+subscriptions?$/i, '订阅'],
      [/\s+plans?$/i, '套餐'],
      [/\s+tiers?$/i, '套餐'],
      [/\s+users?$/i, '用户'],
      [/\s+accounts?$/i, '账号'],
      [/\s+members?$/i, '会员']
    ];
    for (const [re, zh] of suffixRules) {
      if (re.test(rem)) {
        suffix = zh;
        rem = rem.replace(re, '').trim();
        break;
      }
    }

    let prefix = '';
    const prefixRules = [
      [/^(?:paid,?\s+non-trial|non-trial,?\s+paid)(?:\s+|$)/i, '正式付费（非试用）'],
      [/^non-trial(?:\s+|$)/i, '非试用'],
      [/^supported\s+paid(?:\s+|$)/i, '受支持的付费'],
      [/^paid(?:\s+|$)/i, '付费'],
      [/^trial\s+and\s+promotional(?:\s+|$)/i, '试用和促销'],
      [/^promotional\s+and\s+trial(?:\s+|$)/i, '促销和试用'],
      [/^trial\s+or\s+promotional(?:\s+|$)/i, '试用或促销'],
      [/^promotional\s+or\s+trial(?:\s+|$)/i, '促销或试用'],
      [/^free\s+trial(?:\s+|$)/i, '免费试用'],
      [/^promotional(?:\s+|$)/i, '促销'],
      [/^trial(?:\s+|$)/i, '试用'],
      [/^eligible(?:\s+|$)/i, '符合条件的']
    ];
    for (const [re, zh] of prefixRules) {
      if (re.test(rem)) {
        prefix = zh;
        rem = rem.replace(re, '').trim();
        break;
      }
    }

    // 仅由修饰语 + 后缀组成（如 "paid subscribers" / "paid plan subscribers" / "trial and promotional plans"）
    if (!rem) {
      if (prefix && suffix) return `${prefix}${suffix}`;
      return strict ? null : orig;
    }

    // 处理 "X or above"
    const orAboveMatch = rem.match(/^(.+?)\s+or\s+above$/i);
    if (orAboveMatch && KNOWN_TIER_TOKEN_RE.test(orAboveMatch[1].trim())) {
      const baseZh = translateTierToken(orAboveMatch[1], Boolean(suffix));
      const tail = suffix ? `或更高级别${suffix}` : '或更高级别套餐';
      return joinZhSegment(prefix, baseZh, tail);
    }

    // 拆解并列套餐列表（如 "Pro and Ultra" / "Plus, Pro, and Ultra" / "Google AI Pro or Ultra"）
    const parts = rem
      .replace(/,\s*(and|or)\s+/gi, ' $1 ')
      .split(/\s*(?:,\s*|\s+(?:and|or)\s+)\s*/i)
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length > 0 && parts.every((p) => KNOWN_TIER_TOKEN_RE.test(p))) {
      // 严格模式下防止孤立通用词（如 "available for free" / "requires standard"）误触发
      if (strict && !allowBare && !suffix && !prefix && parts.length === 1) {
        if (!/^(?:google\s+ai|antigravity\s+business|gemini\s+enterprise|google\s+workspace|google\s+cloud|ultra\s+(?:5x|20x))/i.test(parts[0])) {
          return null;
        }
      }
      if (strict && allowBare && !suffix && !prefix && parts.length === 1 && /^(?:standard|business|5x|20x)$/i.test(parts[0])) {
        return null;
      }
      // 保留原始连接词（and -> 和，or -> 或，多于两项前面用顿号）
      const hasOr = /\bor\b/i.test(rem);
      const lastConj = hasOr ? '或' : '和';
      const zhParts = parts.map((p) => translateTierToken(p, Boolean(suffix)));
      let coreZh;
      if (zhParts.length === 1) {
        coreZh = zhParts[0];
      } else if (zhParts.length === 2) {
        const conjPad = /[A-Za-z0-9]$/.test(zhParts[0]) ? ` ${lastConj}` : lastConj;
        const rightPad = /^[A-Za-z0-9]/.test(zhParts[1]) ? ` ${zhParts[1]}` : zhParts[1];
        coreZh = `${zhParts[0]}${conjPad}${rightPad}`;
      } else {
        const head = zhParts.slice(0, -1).join('、');
        const last = zhParts[zhParts.length - 1];
        const conjPad = /[A-Za-z0-9]$/.test(head) ? ` ${lastConj}` : lastConj;
        const rightPad = /^[A-Za-z0-9]/.test(last) ? ` ${last}` : last;
        coreZh = `${head}${conjPad}${rightPad}`;
      }
      // 特殊处理 "Enterprise accounts" -> "企业账号"
      if (!prefix && coreZh === '企业版' && suffix === '账号') {
        return '企业账号';
      }
      return joinZhSegment(prefix, coreZh, suffix);
    }

    if (strict) return null;
    if (prefix || suffix) {
      return joinZhSegment(prefix, rem, suffix);
    }
    return orig;
  }

  const KNOWN_MODEL_PREFIX_RE = /^(?:Claude|Gemini|Sonnet|Opus|Haiku|GPT(?:-OSS)?|Orchestrator|Argon|Carbon|Hydrogen|Neon|Flash)\b/i;

  function translateModelItem(raw) {
    const s = String(raw || '').trim();
    const low = s.toLowerCase();
    if (low === 'this model') return '此模型';
    if (low === 'these models') return '这些模型';
    if (low === 'another model' || low === 'another available model') return '其他可用模型';
    if (low === 'a newer model') return '更新的模型';
    if (low === 'newer models') return '更新的模型';
    const trailingModels = s.match(/^(.+?)\s+models$/i);
    if (trailingModels && KNOWN_MODEL_PREFIX_RE.test(trailingModels[1])) {
      return `${trailingModels[1].trim()} 模型`;
    }
    return s;
  }

  function translateModelList(raw) {
    const s = String(raw || '').replace(/[.\s]+$/g, '').trim();
    if (!s) return s;
    const hasOr = /\bor\b/i.test(s);
    const hasAnd = /\band\b/i.test(s);
    if (!hasOr && !hasAnd && !s.includes(',')) {
      return translateModelItem(s);
    }
    const parts = s
      .replace(/,\s*(and|or)\s+/gi, ' $1 ')
      .split(/\s*(?:,\s*|\s+(?:and|or)\s+)\s*/i)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length <= 1) return translateModelItem(s);
    const zhParts = parts.map((p) => translateModelItem(p));
    const conj = hasOr ? '或' : '和';
    if (zhParts.length === 2) {
      const leftPad = /[A-Za-z0-9]$/.test(zhParts[0]) ? ` ${conj}` : conj;
      const rightPad = /^[A-Za-z0-9]/.test(zhParts[1]) ? ` ${zhParts[1]}` : zhParts[1];
      return `${zhParts[0]}${leftPad}${rightPad}`;
    }
    const head = zhParts.slice(0, -1).join('、');
    const last = zhParts[zhParts.length - 1];
    const leftPad = /[A-Za-z0-9]$/.test(head) ? ` ${conj}` : conj;
    const rightPad = /^[A-Za-z0-9]/.test(last) ? ` ${last}` : last;
    return `${head}${leftPad}${rightPad}`;
  }

  const BENEFIT_PHRASE_MAP = {
    'better quality': '更高质量',
    'higher quality': '更高质量',
    'the highest quality': '最高质量',
    'highest quality': '最高质量',
    'same quality': '同等质量',
    'similar quality': '相近质量',
    'comparable quality': '相近质量',
    'better performance': '更佳性能',
    'improved performance': '更佳性能',
    'higher performance': '更强性能',
    'stronger performance': '更强性能',
    'similar performance': '相近性能',
    'comparable performance': '相近性能',
    'faster performance': '更快性能',
    'faster responses': '更快响应',
    'faster response': '更快响应',
    'faster speed': '更快速度',
    'higher speed': '更快速度',
    'speed and efficiency': '更高速度与效率',
    'lower quota usage': '更低配额消耗',
    'less quota usage': '更低配额消耗',
    'lower quota use': '更低配额消耗',
    'less quota use': '更低配额消耗',
    'reduced quota usage': '更低配额消耗',
    'lower token usage': '更少 Token 消耗',
    'less token usage': '更少 Token 消耗',
    'fewer tokens': '更少 Token 消耗',
    'lower cost': '更低成本',
    'lower costs': '更低成本',
    'lower latency': '更低延迟',
    'higher limits': '更高配额上限',
    'higher rate limits': '更高请求速率上限',
    'higher quota': '更高配额'
  };

  function translateSwitchReason(raw) {
    const s = String(raw || '').replace(/[.\s]+$/g, '').trim();
    const low = s.toLowerCase();
    const map = {
      'speed and efficiency in execution tasks': '以获得更高效的任务执行体验',
      'your hardest, long-horizon tasks': '以处理最具挑战性的长周期任务',
      'most deep reasoning and complex problems': '以处理大多数深度推理与复杂问题',
      'deep reasoning': '以进行深度推理',
      'complex tasks': '以处理复杂任务',
      'complex problems': '以处理复杂问题',
      'everyday tasks': '以处理日常任务',
      'everyday coding': '以处理日常编程',
      'advanced workflows': '以处理高级工作流',
      'best results': '以获得最佳效果',
      'the best results': '以获得最佳效果'
    };
    if (Object.prototype.hasOwnProperty.call(map, low)) return map[low];
    if (Object.prototype.hasOwnProperty.call(BENEFIT_PHRASE_MAP, low)) {
      return `以获得${BENEFIT_PHRASE_MAP[low]}`;
    }
    const combo = low.match(/^(.+?)\s+(?:with|and|at)\s+(.+)$/);
    if (combo) {
      const left = BENEFIT_PHRASE_MAP[combo[1].trim()];
      const right = BENEFIT_PHRASE_MAP[combo[2].trim()];
      if (left && right) {
        return `以获得${left}与${right}`;
      }
    }
    return null;
  }

  function lookupSentenceExact(rawSentence) {
    const trimmed = String(rawSentence || '').trim();
    if (!trimmed) return null;
    const norm = normalizeKey(trimmed);
    const direct = lookupExact(trimmed, norm);
    if (direct) return direct;
    if (norm.endsWith('.')) {
      const stem = norm.slice(0, -1).trim();
      const stemHit = stem ? lookupExact(stem, stem) : null;
      if (stemHit) {
        return /[。！？.!?]$/.test(stemHit) ? stemHit : `${stemHit}。`;
      }
    }
    return null;
  }

  function translateNoticeSubject(raw) {
    const s = String(raw || '').trim();
    const low = s.toLowerCase();
    if (low === 'third-party model access' || low === 'access to third-party models') return '第三方模型访问权限';
    if (low === 'third-party models') return '第三方模型';
    if (low === 'this model') return '此模型';
    if (low === 'these models') return '这些模型';
    if (KNOWN_MODEL_PREFIX_RE.test(s) && (/\b(?:and|or)\b/i.test(s) || s.includes(',') || /\bmodels$/i.test(s))) {
      return translateModelList(s);
    }
    if (KNOWN_MODEL_PREFIX_RE.test(s)) {
      const parenZh = translateModelParenEffort(s);
      if (parenZh) return parenZh;
    }
    return s;
  }

  function translateUpgradeGoal(raw) {
    const s = String(raw || '').replace(/[.\s]+$/g, '').trim();
    const low = s.toLowerCase();
    const map = {
      'higher rate limits': '更高的请求速率上限',
      'the highest rate limits': '最高的请求速率上限',
      'highest rate limits': '最高的请求速率上限',
      'higher limits': '更高的配额上限',
      'higher usage limits': '更高的用量上限',
      'higher quotas': '更高的配额',
      'higher quota': '更高的配额',
      'the highest limits': '最高的配额上限',
      'the highest quotas': '最高的配额',
      'this model': '此模型',
      'these models': '这些模型',
      'third-party models': '第三方模型',
      'third-party model access': '第三方模型访问权限',
      'access to third-party models': '第三方模型访问权限',
      'access to this model': '此模型的使用权限',
      'all models': '全部模型',
      'additional models': '更多模型',
      'more models': '更多模型'
    };
    if (Object.prototype.hasOwnProperty.call(map, low)) return map[low];
    if (/^(?:Claude|Gemini|Sonnet|Opus|GPT|Orchestrator|Argon|Carbon|Hydrogen|Neon)\b/i.test(s)) return s;
    return null;
  }

  function translateLimitPhrase(rawKind, hasRate) {
    const k = String(rawKind || '').trim().toLowerCase();
    const mult = k.match(/^(\d+)x(?:\s+higher)?$/);
    if (mult) {
      return hasRate ? `${mult[1]} 倍更高的请求速率上限` : `${mult[1]} 倍更高的基础配额`;
    }
    if (k === 'minimum base') return hasRate ? '最低基础请求速率上限' : '最低基础配额';
    if (k === 'base') return hasRate ? '基础请求速率上限' : '基础配额';
    if (k === 'standard') return hasRate ? '标准请求速率上限' : '标准配额';
    if (k === 'higher') return hasRate ? '更高的请求速率上限' : '更高的配额';
    if (k === 'highest') return hasRate ? '最高的请求速率上限' : '最高的配额';
    return rawKind;
  }

  function translatePlanOrModelSentence(rawSentence) {
    const s = String(rawSentence || '').trim();
    if (!s || /[\u4e00-\u9fff]/.test(s)) return null;
    if (/[.!?]\s+/.test(s)) return null;

    // 1. "{Model} is currently (only) available to/on/for {Audience/Plan}."
    let m = s.match(/^(.+?)\s+(?:is|are)\s+currently\s+(?:only\s+)?available\s+(?:to|on|for)\s+(.+?)\.?$/i);
    if (m) {
      const subj = translateNoticeSubject(m[1]);
      const aud = translatePlanOrAudience(m[2], false);
      return joinZhSegment(joinZhSegment('', subj, '目前仅面向'), aud, '开放。');
    }

    // 2. "{Model} is now available on/to/for {Audience/Plan}."
    m = s.match(/^(.+?)\s+(?:is|are)\s+now\s+available\s+(?:on|to|for)\s+(.+?)\.?$/i);
    if (m) {
      const subj = translateNoticeSubject(m[1]);
      const aud = translatePlanOrAudience(m[2], true);
      if (aud) {
        return joinZhSegment(joinZhSegment('', subj, '现已面向'), aud, '开放。');
      }
    }

    // 3. "{Model} [is/are] now available (in Antigravity)[.!]"
    m = s.match(/^((?:Claude|Gemini|Sonnet|Opus|Haiku|GPT(?:-OSS)?|Orchestrator|Argon|Carbon|Hydrogen|Neon|Flash)\b[^.!?]*?)\s+(?:(?:is|are)\s+)?now\s+available(\s+in\s+Antigravity)?([.!])?$/i);
    if (m) {
      const punct = m[3] === '!' ? '！' : '。';
      return m[2] ? `${m[1].trim()} 现已在 Antigravity 中开放${punct}` : `${m[1].trim()} 现已开放${punct}`;
    }

    // 4. "{Model/Third-party} is/are (currently) only available to/on/for {Audience/Plan}."
    m = s.match(/^(.+?)\s+(?:is|are)\s+(currently\s+)?only\s+available\s+(?:to|on|for)\s+(.+?)\.?$/i);
    if (m) {
      const subj = translateNoticeSubject(m[1]);
      const aud = translatePlanOrAudience(m[3], false);
      const prefix = joinZhSegment('', subj, m[2] ? '目前仅面向' : '仅面向');
      return joinZhSegment(prefix, aud, '开放。');
    }

    // 4.5 "For {KnownPlan}, {Model} quota is separate." & "Higher {Model} quota (...) is available on {KnownPlan}."（须早于通用 is available on 规则）
    m = s.match(/^For\s+(.+?),\s+(.+?)\s+quota\s+is\s+separate\.?$/i);
    if (m) {
      const planZh = translatePlanOrAudience(m[1], true);
      if (planZh) return joinZhSegment('对于', planZh, `，${m[2].trim()} 配额独立计算。`);
    }
    m = s.match(/^Higher\s+(.+?)\s+quota\s+\(included\s+as\s+part\s+of\s+the\s+larger\s+(.+?)\s+quota\s+bucket\)\s+is\s+available\s+on\s+(.+?)\.?$/i);
    if (m) {
      const planZh = translatePlanOrAudience(m[3], true);
      if (planZh) return joinZhSegment('', planZh, `提供更高的 ${m[1].trim()} 配额（包含在更大的 ${m[2].trim()} 总配额池中）。`);
    }

    // 5. "{Model/Third-party} is/are available on/to/for {KnownPlan}."
    m = s.match(/^(.+?)\s+(?:is|are)\s+available\s+(?:to|on|for)\s+(.+?)\.?$/i);
    if (m) {
      const aud = translatePlanOrAudience(m[2], true);
      if (aud) {
        const subj = translateNoticeSubject(m[1]);
        return joinZhSegment(joinZhSegment('', subj, '面向'), aud, '开放。');
      }
    }

    // 6. "{Subject} will no longer be available [on/for {Plan}] [in Antigravity] starting on/from/after/on {Date}."
    m = s.match(/^(.+?)\s+will\s+no\s+longer\s+be\s+available(?:\s+(?:on|for)\s+(.+?))?(?:\s+in\s+(Antigravity))?\s+(starting\s+on|starting|from|after|on)\s+(.+?)\.?$/i);
    if (m) {
      const subj = translateNoticeSubject(m[1]);
      const planRaw = m[2] ? m[2].trim() : '';
      const planZh = planRaw ? translatePlanOrAudience(planRaw, false) : '';
      const inApp = Boolean(m[3]);
      const prep = m[4].toLowerCase();
      const dateZh = formatEnDateToZh(m[5]);
      const timeClause = prep === 'after'
        ? `${dateZh}后，`
        : joinZhSegment('自', dateZh, '起，');
      if (planZh) {
        return `${timeClause}${joinZhSegment(planZh, '将不再提供', subj)}。`;
      }
      if (inApp) {
        return `${timeClause}${joinZhSegment('Antigravity 将不再提供', subj, '。')}`;
      }
      return `${timeClause}${joinZhSegment('', subj, '将不再可用。')}`;
    }

    // 7. "{Subject} will no longer be / is no longer available [on/for {Plan}] [in Antigravity]."
    m = s.match(/^(.+?)\s+(will\s+no\s+longer\s+be|(?:is|are)\s+no\s+longer)\s+available(?:\s+(?:on|for)\s+(.+?))?(?:\s+in\s+(Antigravity))?\.?$/i);
    if (m) {
      const subj = translateNoticeSubject(m[1]);
      const isFuture = /^will/i.test(m[2]);
      const verb = isFuture ? '将不再' : '已不再';
      const planZh = m[3] ? translatePlanOrAudience(m[3], true) : null;
      if (m[3] && !planZh) return null;
      if (planZh) {
        return `${joinZhSegment(planZh, `${verb}提供`, subj)}。`;
      }
      if (m[4]) {
        return `${joinZhSegment(`Antigravity ${verb}提供`, subj, '。')}`;
      }
      return joinZhSegment('', subj, `${verb}可用。`);
    }

    // 8. "{Subject} is/are (currently) not available/unavailable on/for {KnownPlan}."
    m = s.match(/^(.+?)\s+(?:is|are)\s+(currently\s+)?(?:not\s+available|unavailable)\s+(?:on|for)\s+(.+?)\.?$/i);
    if (m) {
      const planZh = translatePlanOrAudience(m[3], true);
      if (planZh) {
        const subj = translateNoticeSubject(m[1]);
        const cur = m[2] ? '目前' : '';
        return joinZhSegment(joinZhSegment('', subj, `${cur}在`), planZh, '中不可用。');
      }
    }

    // 9. "{Subject} is/are (currently) not available/unavailable in your region."
    m = s.match(/^(.+?)\s+(?:is|are)\s+(?:currently\s+)?(?:not\s+available|unavailable)\s+in\s+your\s+region\.?$/i);
    if (m) {
      const subj = translateNoticeSubject(m[1]);
      return joinZhSegment('', subj, '目前在你所在的地区暂不可用。');
    }

    // 10. "{Subject} is/has been disabled by your administrator/organization."
    m = s.match(/^(.+?)\s+(?:is|has\s+been)\s+disabled\s+by\s+your\s+(administrator|organization)\.?$/i);
    if (m) {
      const subj = translateNoticeSubject(m[1]);
      const who = m[2].toLowerCase() === 'administrator' ? '管理员' : '组织';
      return joinZhSegment('', subj, `已被你的${who}禁用。`);
    }

    // 11. "{Subject} requires {KnownPlan/Subscription} [to use/access]."
    m = s.match(/^(.+?)\s+requires?\s+(.+?)(?:\s+to\s+(?:use|access))?\.?$/i);
    if (m) {
      const planZh = translatePlanOrAudience(m[2], true);
      if (planZh) {
        const subj = translateNoticeSubject(m[1]);
        return joinZhSegment(joinZhSegment('', subj, '需要'), planZh, '才能使用。');
      }
    }

    // 12. "{Model} will be removed/deprecated/retired/sunset [from Antigravity] on/after/by {Date}."
    m = s.match(/^(.+?)\s+(?:will\s+be|(?:is|are)\s+being)\s+(removed|deprecated|retired|sunset)(?:\s+from\s+(Antigravity))?\s+(on|after|by)\s+(.+?)\.?$/i);
    if (m) {
      const model = translateNoticeSubject(m[1]);
      const act = m[2].toLowerCase();
      const prep = m[4].toLowerCase();
      const dateZh = formatEnDateToZh(m[5]);
      const dateClause = prep === 'after' ? `${dateZh}后` : prep === 'by' ? `${dateZh}前` : dateZh;
      const prepZh = prep === 'by' ? '将在' : '将于';
      if (act === 'removed' && m[3]) {
        return joinZhSegment(joinZhSegment('', model, prepZh), dateClause, '从 Antigravity 中移除。');
      }
      const actZh = act === 'removed' ? '移除。' : act === 'deprecated' ? '弃用。' : act === 'sunset' ? '下线。' : '停用。';
      const fromApp = m[3] ? '从 Antigravity ' : '';
      return joinZhSegment(joinZhSegment('', model, prepZh), dateClause, `${fromApp}${actZh}`);
    }

    // 12b. "{Model} is/are/will be leaving / will leave / leaves [Antigravity] on/after/starting/by {Date}."
    m = s.match(/^(.+?)\s+(?:(?:is|are|will\s+be)\s+leaving|will\s+leave|leaves)(?:\s+(Antigravity))?\s+(starting\s+on|starting|on|after|by)\s+(.+?)\.?$/i);
    if (m) {
      const model = translateNoticeSubject(m[1]);
      const inApp = Boolean(m[2]);
      const prep = m[3].toLowerCase();
      const dateZh = formatEnDateToZh(m[4]);
      const fromApp = inApp ? '从 Antigravity ' : '';
      if (prep.startsWith('starting')) {
        return `${joinZhSegment('自', dateZh, '起，')}${joinZhSegment('', model, `将${fromApp}下线。`)}`;
      }
      const dateClause = prep === 'after' ? `${dateZh}后` : prep === 'by' ? `${dateZh}前` : dateZh;
      const prepZh = prep === 'by' ? '将在' : '将于';
      return joinZhSegment(joinZhSegment('', model, prepZh), dateClause, `${fromApp}下线。`);
    }

    // 12c. "{Model} is/are scheduled to leave / for removal / to be removed/retired/deprecated [from Antigravity] on/after/by {Date}."
    m = s.match(/^(.+?)\s+(?:is|are)\s+scheduled\s+(to\s+leave|for\s+removal|to\s+be\s+(?:removed|retired|deprecated|sunset))(?:\s+(?:from\s+)?(Antigravity))?\s+(on|after|by)\s+(.+?)\.?$/i);
    if (m) {
      const model = translateNoticeSubject(m[1]);
      const kind = m[2].toLowerCase();
      const inApp = Boolean(m[3]);
      const prep = m[4].toLowerCase();
      const dateZh = formatEnDateToZh(m[5]);
      const dateClause = prep === 'after' ? `${dateZh}后` : prep === 'by' ? `${dateZh}前` : dateZh;
      const tail = kind.includes('leave') || kind.includes('sunset')
        ? `${inApp ? '从 Antigravity ' : ''}下线。`
        : kind.includes('remov')
          ? (inApp ? '从 Antigravity 中移除。' : '移除。')
          : kind.includes('deprecat')
            ? `${inApp ? '从 Antigravity ' : ''}弃用。`
            : `${inApp ? '从 Antigravity ' : ''}停用。`;
      return joinZhSegment(joinZhSegment('', model, '计划于'), dateClause, tail);
    }

    // 12d. "{Model} is leaving / will be removed/retired/deprecated [from Antigravity] soon."
    m = s.match(/^(.+?)\s+(?:(?:is|are)\s+(leaving)|(?:will\s+be|(?:is|are)\s+being)\s+(removed|deprecated|retired|sunset))(?:\s+(?:from\s+)?(Antigravity))?(?:\s+soon)?\.?$/i);
    if (m && (/\bsoon\.?$/i.test(s) || /^.+\s+(?:is|are)\s+being\s+(?:removed|deprecated|retired|sunset)/i.test(s))) {
      const model = translateNoticeSubject(m[1]);
      const act = (m[2] || m[3] || '').toLowerCase();
      const inApp = Boolean(m[4]);
      const tail = act === 'leaving' || act === 'sunset'
        ? `${inApp ? '从 Antigravity ' : ''}下线。`
        : act === 'removed'
          ? (inApp ? '从 Antigravity 中移除。' : '移除。')
          : act === 'deprecated'
            ? `${inApp ? '从 Antigravity ' : ''}弃用。`
            : `${inApp ? '从 Antigravity ' : ''}停用。`;
      return joinZhSegment('', model, `即将${tail}`);
    }

    // 12e. 无主语简短退市提示："Leaving [Antigravity] [on] {Date}." / "Scheduled for removal on {Date}." / "Available until {Date}."
    m = s.match(/^(Leaving|Retiring|Deprecating|Removing)(?:\s+(?:from\s+)?(Antigravity))?\s+(?:(on|after|by)\s+)?(.+?)\.?$/i);
    if (m) {
      const rawDate = m[4].replace(/[.\s]+$/g, '').trim();
      const dateZh = formatEnDateToZh(rawDate);
      if (dateZh !== rawDate) {
        const act = m[1].toLowerCase();
        const inApp = Boolean(m[2]);
        const prep = (m[3] || 'on').toLowerCase();
        const dateClause = prep === 'after' ? `${dateZh}后` : prep === 'by' ? `${dateZh}前` : dateZh;
        const prepZh = prep === 'by' ? '将在' : '将于';
        const tail = act === 'leaving'
          ? `${inApp ? '从 Antigravity ' : ''}下线。`
          : act === 'removing'
            ? (inApp ? '从 Antigravity 中移除。' : '移除。')
            : act === 'deprecating'
              ? `${inApp ? '从 Antigravity ' : ''}弃用。`
              : `${inApp ? '从 Antigravity ' : ''}停用。`;
        return joinZhSegment(prepZh, dateClause, tail);
      }
    }
    m = s.match(/^Scheduled\s+(to\s+leave|for\s+removal|to\s+be\s+(?:removed|retired|deprecated))(?:\s+(?:from\s+)?(Antigravity))?\s+(on|after|by)\s+(.+?)\.?$/i);
    if (m) {
      const kind = m[1].toLowerCase();
      const inApp = Boolean(m[2]);
      const prep = m[3].toLowerCase();
      const dateZh = formatEnDateToZh(m[4]);
      const dateClause = prep === 'after' ? `${dateZh}后` : prep === 'by' ? `${dateZh}前` : dateZh;
      const tail = kind.includes('leave')
        ? `${inApp ? '从 Antigravity ' : ''}下线。`
        : kind.includes('remov')
          ? (inApp ? '从 Antigravity 中移除。' : '移除。')
          : kind.includes('deprecat')
            ? `${inApp ? '从 Antigravity ' : ''}弃用。`
            : `${inApp ? '从 Antigravity ' : ''}停用。`;
      return joinZhSegment('计划于', dateClause, tail);
    }
    m = s.match(/^(?:(.+?)\s+(?:is|are|will\s+remain|will\s+be)\s+)?available\s+until\s+(.+?)\.?$/i);
    if (m) {
      const dateZh = formatEnDateToZh(m[2]);
      if (dateZh !== m[2].replace(/[.\s]+$/g, '').trim()) {
        if (m[1]) {
          const model = translateNoticeSubject(m[1]);
          return joinZhSegment(joinZhSegment('', model, '将可用至'), dateZh, '。');
        }
        return joinZhSegment('可用至', dateZh, '。');
      }
    }

    // 12f. 模型替代与会话自动迁移提示
    m = s.match(/^(.+?)\s+(is\s+being|will\s+be|has\s+been|is)\s+replaced\s+by\s+((?:Claude|Gemini|Sonnet|Opus|Haiku|GPT(?:-OSS)?|Orchestrator|Argon|Carbon|Hydrogen|Neon|Flash)\b[^.!?]*?)(?:\s+(on|starting\s+on|starting)\s+(.+?))?\.?$/i);
    if (m) {
      const subj = translateNoticeSubject(m[1]);
      const verb = /^has/i.test(m[2]) ? '已由' : '将由';
      const target = translateModelList(m[3]);
      if (m[5]) {
        const dateZh = formatEnDateToZh(m[5]);
        const datePrefix = /^starting/i.test(m[4]) ? `自 ${dateZh}起由` : `将于 ${dateZh}由`;
        return joinZhSegment(joinZhSegment('', subj, datePrefix), target, '替代。');
      }
      return joinZhSegment(joinZhSegment('', subj, verb), target, '替代。');
    }
    m = s.match(/^Replaced\s+by\s+((?:Claude|Gemini|Sonnet|Opus|Haiku|GPT(?:-OSS)?|Orchestrator|Argon|Carbon|Hydrogen|Neon|Flash)\b[^.!?]*?)\.?$/i);
    if (m) {
      return joinZhSegment('已由', translateModelList(m[1]), '替代。');
    }
    m = s.match(/^(?:After\s+(.+?),\s+)?(?:(existing|active|new)\s+)?(?:conversations|chats|sessions)(?:\s+using\s+(.+?))?\s+will\s+(automatically\s+)?(?:switch|migrate|default|move|be\s+routed)\s+to\s+((?:Claude|Gemini|Sonnet|Opus|Haiku|GPT(?:-OSS)?|Orchestrator|Argon|Carbon|Hydrogen|Neon|Flash)\b[^.!?]*?)\.?$/i);
    if (m) {
      const afterPrefix = m[1] ? `${formatEnDateToZh(m[1])}后，` : '';
      const adj = m[2] ? ({ existing: '现有', active: '当前活跃的', new: '新建' }[m[2].toLowerCase()] || '') : '';
      const usingPart = m[3] ? joinZhSegment('使用', translateNoticeSubject(m[3]), '的') : '';
      const autoZh = m[4] ? '自动' : '';
      const target = translateModelList(m[5]);
      return `${afterPrefix}${adj}${usingPart}会话将${autoZh}${joinZhSegment('切换到', target, '。')}`;
    }

    // 13. "{Users/Plans} receive(s) [the] {limitKind} [rate] limits [on Antigravity]."
    m = s.match(/^(.+?)\s+receive(?:s)?\s+(?:the\s+)?(minimum\s+base|base|standard|higher|highest|\d+x(?:\s+higher)?)\s+(rate\s+)?limits(?:\s+on\s+(.+?))?\.?$/i);
    if (m) {
      const subjRaw = m[1].trim();
      const subjZh = /^you$/i.test(subjRaw) ? '你' : translatePlanOrAudience(subjRaw, true);
      if (subjZh) {
        const limitZh = translateLimitPhrase(m[2], Boolean(m[3]));
        const app = m[4] ? m[4].trim() : '';
        if (app) {
          return `${joinZhSegment(subjZh, `在 ${app} 上享有`, limitZh)}。`;
        }
        return `${joinZhSegment(subjZh, '享有', limitZh)}。`;
      }
    }

    // 14. "You (currently) have [the] {limitKind} [rate] limits [on Antigravity]."
    m = s.match(/^You\s+(?:currently\s+)?have\s+(?:the\s+)?(minimum\s+base|base|standard|higher|highest|\d+x(?:\s+higher)?)\s+(rate\s+)?limits(?:\s+on\s+(.+?))?\.?$/i);
    if (m) {
      const limitZh = translateLimitPhrase(m[1], Boolean(m[2]));
      const app = m[3] ? m[3].trim() : '';
      return app ? `你在 ${app} 上享有${limitZh}。` : `你当前享有${limitZh}。`;
    }

    // 15. "(You can) Upgrade to {KnownPlan} to {verb} {Goal}."
    m = s.match(/^(You\s+can\s+)?upgrade\s+to\s+(.+?)\s+to\s+(receive|get|unlock|access|continue\s+using)\s+(.+?)\.?$/i);
    if (m) {
      const planZh = translatePlanOrAudience(m[2], true);
      const goalZh = translateUpgradeGoal(m[4]);
      if (planZh && goalZh) {
        const canPrefix = m[1] ? '你可以升级到' : '升级到';
        const verbLow = m[3].toLowerCase();
        const verbZh = verbLow === 'continue using' ? '以继续使用'
          : verbLow === 'access' ? '以使用'
          : verbLow === 'unlock' ? '以解锁'
          : '以获取';
        return joinZhSegment(joinZhSegment(canPrefix, planZh, verbZh), goalZh, '。');
      }
    }

    // 16. "This/Your account is ineligible/not eligible for higher rate limits [through {Plan}] [at this time]."
    m = s.match(/^(This|Your)\s+account\s+is\s+(?:ineligible|not\s+eligible)\s+for\s+higher\s+rate\s+limits(?:\s+through\s+(.+?))?(?:\s+at\s+this\s+time)?\.?$/i);
    if (m) {
      const subj = m[1].toLowerCase() === 'your' ? '你的账号' : '此账号';
      const throughZh = m[2] ? translatePlanOrAudience(m[2], false) : '';
      return throughZh
        ? joinZhSegment(`${subj}目前无法通过`, throughZh, '获取更高的请求速率上限。')
        : `${subj}目前无法获取更高的请求速率上限。`;
    }

    // 17. "Google Workspace accounts are (currently) ineligible for {Plan}."
    m = s.match(/^Google\s+Workspace\s+accounts\s+are\s+(?:currently\s+)?(?:ineligible|not\s+eligible)\s+for\s+(.+?)\.?$/i);
    if (m) {
      const planZh = translatePlanOrAudience(m[1], true);
      if (planZh) return joinZhSegment('Google Workspace 账号目前无法订阅', planZh, '。');
    }

    // 18. "{KnownPlans} do not include {Third-party / Model}."
    m = s.match(/^(.+?)\s+do\s+not\s+include\s+(.+?)\.?$/i);
    if (m) {
      const planZh = translatePlanOrAudience(m[1], true);
      const goalZh = translateUpgradeGoal(m[2]);
      if (planZh && goalZh) return `${joinZhSegment(planZh, '不包含', goalZh)}。`;
    }

    // 19. "Your (current) plan is managed by your organization/administrator."
    m = s.match(/^Your\s+(?:current\s+)?plan\s+is\s+managed\s+by\s+your\s+(organization|administrator)\.?$/i);
    if (m) {
      const who = m[1].toLowerCase() === 'administrator' ? '管理员' : '组织';
      return `你当前的套餐由你的${who}管理。`;
    }

    // 20. "Contact your (organization) administrator to upgrade your plan / for higher rate limits / to request access."
    m = s.match(/^Contact\s+your\s+(?:organization\s+)?administrator\s+(to\s+upgrade\s+your\s+plan|for\s+higher\s+rate\s+limits|to\s+request\s+access)\.?$/i);
    if (m) {
      const tail = m[1].toLowerCase();
      if (tail.includes('upgrade')) return '请联系你的管理员升级套餐。';
      if (tail.includes('rate limits')) return '请联系你的管理员获取更高的请求速率上限。';
      return '请联系你的管理员申请访问权限。';
    }

    // 21. "You('re| are) (currently) on {KnownPlan} [available on Antigravity]."
    m = s.match(/^You(?:'re|\s+are)\s+(?:currently\s+)?on\s+(.+?)(?:\s+available\s+on\s+(Antigravity))?\.?$/i);
    if (m) {
      const planZh = translatePlanOrAudience(m[1], true);
      if (planZh) {
        return m[2]
          ? joinZhSegment(`你当前使用的是 ${m[2]}`, planZh, '。')
          : joinZhSegment('你当前使用的是', planZh, '。');
      }
    }

    // 22. 配额未使用 / 满额 / 刷新周期单句
    m = s.match(/^You\s+(?:have\s+not|haven't)\s+used\s+any\s+of\s+your\s+(weekly|monthly|daily|\d+-hour)\s+limit\.?$/i);
    if (m) {
      return `你尚未使用任何${prefixSpaceIfAscii(translateLimitKind(m[1]))}。`;
    }
    m = s.match(/^(?:You\s+have\s+full|Your)\s+(weekly|monthly|daily|\d+-hour)\s+(?:limit|quota)(?:\s+remaining|\s+is\s+full)\.?$/i);
    if (m) {
      return `你的${prefixSpaceIfAscii(translateLimitKind(m[1]))}当前为满额状态。`;
    }
    m = s.match(/^Your\s+(weekly|monthly|daily|\d+-hour)\s+limit\s+(will\s+fully\s+refresh|will\s+refresh|refreshes|resets)\s+in\s+(.+?)\.?$/i);
    if (m) {
      const resetVerb = /fully/i.test(m[2]) ? '完全重置' : '重置';
      return `你的${prefixSpaceIfAscii(translateLimitKind(m[1]))}将在${prefixSpaceIfAscii(translateDuration(m[3]))}后${resetVerb}。`;
    }

    // 24. "(Please) Switch / Consider switching / Migrate / Try / Use / We recommend {Model(s)} [instead] [for ...]."
    m = s.match(/^(Please\s+switch|Switch|Consider\s+switching|Please\s+migrate|Migrate|Transition)\s+to\s+((?:Claude|Gemini|Sonnet|Opus|Haiku|GPT(?:-OSS)?|Orchestrator|Argon|Carbon|Hydrogen|Neon|Flash|another\s+available\s+model|another\s+model|a\s+newer\s+model|newer\s+models)\b[^.!?]*?)(?:\s+instead)?(?:\s+for\s+([^.!?]+))?\.?$/i);
    if (m) {
      const rawLead = m[1].toLowerCase();
      const lead = rawLead.startsWith('consider') ? '建议切换到'
        : rawLead.includes('migrate') || rawLead.includes('transition') ? '请迁移到'
        : '请切换到';
      const target = translateModelList(m[2]);
      const reasonZh = m[3] ? translateSwitchReason(m[3]) : null;
      if (m[3] && !reasonZh) return null;
      const tail = reasonZh ? `${reasonZh}。` : '。';
      return joinZhSegment(lead, target, tail);
    }
    m = s.match(/^(Please\s+try|Try|Please\s+use|Use)\s+((?:Claude|Gemini|Sonnet|Opus|Haiku|GPT(?:-OSS)?|Orchestrator|Argon|Carbon|Hydrogen|Neon|Flash)\b[^.!?]*?)(?:\s+(instead))?(?:\s+for\s+([^.!?]+))?\.?$/i);
    if (m) {
      const isTry = /try/i.test(m[1]);
      const isInstead = Boolean(m[3]);
      const lead = isTry ? (isInstead ? '建议改用' : '建议尝试') : (isInstead ? '请改用' : '请使用');
      const target = translateModelList(m[2]);
      const reasonZh = m[4] ? translateSwitchReason(m[4]) : null;
      if (m[4] && !reasonZh) return null;
      const tail = reasonZh ? `${reasonZh}。` : '。';
      return joinZhSegment(lead, target, tail);
    }
    m = s.match(/^We\s+recommend\s+(?:(switching\s+to|migrating\s+to|using|trying)\s+)?((?:Claude|Gemini|Sonnet|Opus|Haiku|GPT(?:-OSS)?|Orchestrator|Argon|Carbon|Hydrogen|Neon|Flash)\b[^.!?]*?)(?:\s+instead)?(?:\s+for\s+([^.!?]+))?\.?$/i);
    if (m) {
      const act = (m[1] || '').toLowerCase();
      const lead = act.startsWith('switch') ? '建议切换到'
        : act.startsWith('migrat') ? '建议迁移到'
        : act.startsWith('try') ? '建议尝试'
        : '推荐使用';
      const target = translateModelList(m[2]);
      const reasonZh = m[3] ? translateSwitchReason(m[3]) : null;
      if (m[3] && !reasonZh) return null;
      const tail = reasonZh ? `${reasonZh}。` : '。';
      return joinZhSegment(lead, target, tail);
    }

    // 25. 自动化模型不可用时的回退 / 失败提示
    m = s.match(/^Runs\s+use\s+(.+?)\s+instead\.?$/i);
    if (m) {
      const fallbackModel = translateModelParenEffort(m[1]) || m[1].trim();
      return joinZhSegment('运行时将改用', fallbackModel, '。');
    }
    if (/^Runs\s+will\s+fail\s+until\s+you\s+pick\s+another\s+model\.?$/i.test(s)) {
      return '在你选择其他模型前，任务运行将会失败。';
    }

    return null;
  }

  function translatePlanOrModelNotice(text) {
    const s = String(text || '').trim();
    if (!s || /[\u4e00-\u9fff]/.test(s)) return null;

    // 可选前缀："Leaving Soon — ..." / "Leaving soon: ..."
    const badgeLead = s.match(/^(Leaving\s+Soon|Retiring\s+Soon|Deprecated|Notice)\s*([—–\-:])\s*(.+)$/i);
    if (badgeLead) {
      const badgeKey = badgeLead[1].toLowerCase();
      const badgeZh = badgeKey === 'leaving soon' ? '即将下线'
        : badgeKey === 'retiring soon' ? '即将停用'
        : badgeKey === 'deprecated' ? '已弃用'
        : '提示';
      const bodyZh = translatePlanOrModelNotice(badgeLead[3]);
      if (bodyZh) {
        const sep = badgeLead[2] === ':' ? '：' : ' — ';
        return `${badgeZh}${sep}${bodyZh}`;
      }
    }

    const single = translatePlanOrModelSentence(s);
    if (single) return single;

    // 多句组合提示：同时支持“动态句式 + 静态词库句（如模型原有说明 + Leaving on Nov 30.）”混合拼接
    if (/[.!?]\s+/.test(s)) {
      const parts = s.split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2 && parts.length <= 4) {
        const translated = [];
        let hasDynamicHit = false;
        for (const p of parts) {
          let hit = translatePlanOrModelSentence(p);
          if (hit) {
            hasDynamicHit = true;
          } else {
            const exactHit = /\s/.test(p) ? lookupSentenceExact(p) : null;
            if (!exactHit) return null;
            hit = exactHit;
          }
          translated.push(hit);
        }
        if (hasDynamicHit) {
          return translated.map((seg, idx) => (
            idx < translated.length - 1 && !/[。！？.!?]$/.test(seg) ? `${seg}。` : seg
          )).join('');
        }
      }
    }
    return null;
  }

  function translateQuotaTextParts(text) {
    let out = String(text)
      .replace(/You need\s+(.+?)\s+AI Credits to send messages\.\s*To continue using\s+(.+?)\s+now,\s*purchase more AI Credits\.?/gi, (_, need, model) => {
        const needZh = need.trim().replace(/^at least\s+/i, '至少 ').replace(/^more$/i, '更多');
        const modelZh = /^this model$/i.test(model.trim()) ? '此模型' : model.trim();
        return `发送消息还需要${needZh} AI 额度。如需立即继续使用 ${modelZh}，请购买更多 AI 额度。`;
      })
      .replace(/Your plan's baseline quota will refresh on\s+(.+?)\./gi, (_, d) => `你当前套餐的基础配额将于 ${d.trim()} 重置。`)
      .replace(/To continue using this model now,\s*enable AI Credit overages\.?/gi, '如需立即继续使用此模型，请开启 AI 额度超额使用。')
      .replace(/(?:If|If you(?:'re| are))\s+on a supported paid plan,\s*you can use AI credits in the interim(?:\s+or\s+upgrade to a higher tier)?\.?/gi, (m) =>
        /upgrade to a higher tier/i.test(m)
          ? '如果你使用的是受支持的付费套餐，在此期间可使用 AI 额度，或升级到更高级别套餐。'
          : '如果你使用的是受支持的付费套餐，在此期间可使用 AI 额度。'
      );

    // 尾部若拼接了任意订阅套餐的 upgradeSubscriptionText，交由统一套餐翻译器处理
    const tailMatch = out.match(/^([\s\S]*?[。！？])\s*([A-Za-z][\s\S]+)$/);
    if (tailMatch) {
      const tailZh = translatePlanOrModelNotice(tailMatch[2]) || lookupExact(tailMatch[2].trim(), normalizeKey(tailMatch[2]));
      if (tailZh) {
        out = `${tailMatch[1]}${tailZh}`;
      }
    } else if (!/[\u4e00-\u9fff]/.test(out)) {
      const wholeZh = translatePlanOrModelNotice(out);
      if (wholeZh) out = wholeZh;
    }

    return out
      .replace(/([。！？])\s+/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function translateQuotaTail(tail) {
    const trimmed = tail ? tail.trim() : '';
    if (!trimmed) return '';
    return lookupExact(trimmed, normalizeKey(trimmed)) || translatePlanOrModelNotice(trimmed) || translateQuotaTextParts(trimmed);
  }

  const AUTH_RPC_CODE_MAP = {
    unavailable: '服务不可用',
    deadline_exceeded: '请求超时',
    unauthenticated: '未通过身份验证',
    permission_denied: '权限不足',
    canceled: '已取消',
    cancelled: '已取消',
    internal: '内部错误',
    invalid_argument: '参数无效',
    failed_precondition: '前置条件不满足',
    resource_exhausted: '配额已耗尽',
    not_found: '未找到',
    aborted: '操作中止',
    unknown: '未知错误'
  };

  const OAUTH_CODE_ZH_MAP = {
    access_denied: '访问被拒绝 (access_denied)',
    invalid_grant: '授权已失效或无效 (invalid_grant)',
    invalid_request: '请求无效 (invalid_request)',
    server_error: '服务器错误 (server_error)',
    temporarily_unavailable: '服务暂时不可用 (temporarily_unavailable)'
  };

  function translateAuthErrorDetail(raw) {
    const s = String(raw || '').trim();
    if (!s) return raw;
    const norm = normalizeKey(s);
    const exact = lookupExact(s, norm);
    if (exact) return exact;

    const rpcMatch = norm.match(/^\[(unavailable|deadline_exceeded|unauthenticated|permission_denied|canceled|cancelled|internal|invalid_argument|failed_precondition|resource_exhausted|not_found|aborted|unknown)\]\s+(.+)$/i);
    if (rpcMatch) {
      const codeZh = AUTH_RPC_CODE_MAP[rpcMatch[1].toLowerCase()] || rpcMatch[1];
      const innerZh = translateAuthErrorDetail(rpcMatch[2]);
      return `[${codeZh}] ${innerZh}`;
    }

    const oauthCode = OAUTH_CODE_ZH_MAP[norm.toLowerCase()];
    if (oauthCode) return oauthCode;

    if (/^(?:Rpc failed due to xhr error|Failed to fetch|NetworkError\b[^.]*)\.?$/i.test(norm)) {
      return '网络请求失败（请检查网络连接或代理设置）';
    }
    if (/^(?:context deadline exceeded|Client\.Timeout exceeded[^.]*|i\/o timeout|operation timed out|connection timed out|TLS handshake timeout)\.?$/i.test(norm)) {
      return '网络连接超时（请检查网络或代理设置）';
    }
    if (/^connection refused\.?$/i.test(norm)) {
      return '连接被拒绝（本地或远程服务未响应）';
    }
    if (/^connection reset by peer\.?$/i.test(norm)) {
      return '连接被对端重置（请检查网络或代理设置）';
    }
    if (/^no such host\.?$/i.test(norm)) {
      return '域名解析失败（请检查 DNS、网络或代理设置）';
    }
    if (/^(?:network is unreachable|network is down|no route to host)\.?$/i.test(norm)) {
      return '网络不可达（请检查网络连接或代理设置）';
    }
    if (/^proxy authentication required\.?$/i.test(norm)) {
      return '需要代理身份验证';
    }
    if (/^(?:Remote instance is unreachable|InstanceUnreachableError)\.?$/i.test(norm)) {
      return '无法连接到远程实例';
    }

    let m = norm.match(/^(.+?)\s+is not (?:currently )?available in your (?:country|region|location)(?: or region)?\.?$/i);
    if (m) {
      return `${m[1].trim()} 目前暂不支持你所在的地区。`;
    }
    m = norm.match(/^(?:This|Your) account is not eligible(?!.*higher rate limits)(?:\s+(?:to use|for)\s+(.+?))?\.?$/i);
    if (m) {
      return m[1] ? `此账号暂不符合使用 ${m[1].trim()} 的条件。` : '此账号暂不符合使用条件。';
    }
    m = norm.match(/^(?:This|Your) account is not supported(?:\s+by\s+(.+?))?\.?$/i);
    if (m) {
      return m[1] ? `暂不支持使用此账号登录 ${m[1].trim()}。` : '暂不支持使用此账号登录。';
    }
    m = norm.match(/^(?:Your\s+)?(?:Workspace\s+)?(?:organization|administrator)\s+has\s+disabled\s+(.+?)\.?$/i);
    if (m) {
      return `你的组织管理员已禁用 ${m[1].trim()}。`;
    }
    m = norm.match(/^You must be at least (\d+) years old to use\s+(.+?)\.?$/i);
    if (m) {
      return `使用 ${m[2].trim()} 需要年满 ${m[1]} 周岁。`;
    }

    // 复合错误串中常见的网络错误尾缀替换
    const replaced = norm
      .replace(/\bRpc failed due to xhr error\b/gi, '网络请求失败（请检查网络连接或代理设置）')
      .replace(/\bFailed to fetch\b/gi, '网络请求失败（请检查网络连接或代理设置）')
      .replace(/\bcontext deadline exceeded\b/gi, '请求超时（context deadline exceeded）')
      .replace(/\bClient\.Timeout exceeded(?: while awaiting headers)?\b/gi, '请求超时')
      .replace(/\bi\/o timeout\b/gi, 'I/O 超时')
      .replace(/\boperation timed out\b/gi, '操作超时')
      .replace(/\bconnection timed out\b/gi, '连接超时')
      .replace(/\bTLS handshake timeout\b/gi, 'TLS 握手超时')
      .replace(/\bconnection refused\b/gi, '连接被拒绝')
      .replace(/\bconnection reset by peer\b/gi, '连接被对端重置')
      .replace(/\bno such host\b/gi, '域名解析失败')
      .replace(/\bnetwork is unreachable\b/gi, '网络不可达')
      .replace(/\bnetwork is down\b/gi, '网络已断开')
      .replace(/\bno route to host\b/gi, '无法路由到主机')
      .replace(/\bproxy authentication required\b/gi, '需要代理身份验证')
      .replace(/\bRemote instance is unreachable\b/gi, '无法连接到远程实例');
    return replaced !== norm ? replaced : s;
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
    [/^Your quota for\s+(.+?)\s+has been reached\.\s+Switch to another available model to continue\.?(.*)$/i, (_, model, tail) => `你在 ${model} 的配额已用尽，请切换到其他可用模型以继续。${translateQuotaTail(tail)}`.trim()],
    [/^Your quota for\s+(.+?)\s+will reset on\s+(.+?)\.\s+Switch to another available model to continue\.?(.*)$/i, (_, model, date, tail) => `你在 ${model} 的配额将于 ${date} 重置，请切换到其他可用模型以继续。${translateQuotaTail(tail)}`.trim()],
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
    [/^(.+?)\s+(Weekly|Daily|Monthly|Five[- ]Hour|(\d+)-hour)\s+Limit(\s+Remaining)?$/i, (_, model, kind, hours, rem) => {
      const low = kind.toLowerCase();
      const tail = rem ? '剩余配额' : '配额';
      const suffix = low === 'weekly' ? `每周${tail}`
        : low === 'daily' ? `每日${tail}`
        : low === 'monthly' ? `每月${tail}`
        : low.startsWith('five') ? `5 小时${tail}`
        : `${hours} 小时${tail}`;
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
      const parenTranslated = translateModelParenEffort(raw);
      if (parenTranslated) return `选择模型，当前：${parenTranslated}`;
      const effortTranslated = translateModelWithEffort(raw);
      return `选择模型，当前：${effortTranslated || raw}`;
    }],
    [/^Agent permissions preset selector,\s*current:\s*(.+)$/i, (_, p) => `智能体权限预设选择器，当前：${lookupExact(p.trim(), normalizeKey(p.trim())) || p.trim()}`],
    [/^Agent permissions preset:\s*(.+?),\s*(.+)$/i, (_, p, reason) => `智能体权限预设：${lookupExact(p.trim(), normalizeKey(p.trim())) || p.trim()}，${lookupExact(reason.trim(), normalizeKey(reason.trim())) || reason.trim()}`],
    [/^(\d+)\s+hidden hosts?$/i, '$1 个已隐藏的主机'],
    [/^Where the agent runs,\s*current:\s*(.+?)\s*\((.+)\)$/i, (_, loc, busy) => `智能体运行位置，当前：${lookupExact(loc.trim(), normalizeKey(loc.trim())) || loc.trim()}（${lookupExact(busy.trim(), normalizeKey(busy.trim())) || busy.trim()}）`],
    [/^Where the agent runs,\s*current:\s*(.+)$/i, (_, loc) => `智能体运行位置，当前：${lookupExact(loc.trim(), normalizeKey(loc.trim())) || loc.trim()}`],
    [/^Model:\s*(.+?),\s*(Model cannot be changed while the agent is running)$/i, (_, model, reason) => `模型：${translateModelWithEffort(model.trim()) || translateModelParenEffort(model.trim()) || model.trim()}，${lookupExact(reason.trim(), normalizeKey(reason.trim())) || reason.trim()}`],
    [/^You have (\d+) conversations in progress\.\s*Updating will interrupt them,\s*and they will automatically resume once the update completes\.$/i, '你有 $1 个正在进行的会话。更新会暂时中断它们，并在更新完成后自动恢复。'],
    [/^You have (\d+) conversations in progress\.\s*Updating will cancel them and you'll need to manually restart them\.$/i, '你有 $1 个正在进行的会话。更新将取消它们，之后你需要手动重新启动。'],
    [/^All (\d+) will be revoked\.\s*The plugin will ask before doing this again\.$/i, '将撤销全部 $1 项权限。插件下次执行此类操作前会再次询问你。'],
    [/^Revoke all:\s*(.+)$/i, '全部撤销：$1'],
    [/^Revoke:\s*(.+)$/i, '撤销：$1'],
    [/^Allowed in\s+(.+)$/i, '在 $1 中允许'],
    [/^Resolved\s+"(.+)"$/i, '已解决“$1”'],
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
      return `${joinZhSegment('管理', targetZh, '')}${nounZh}、智能体设置及权限`;
    }],
    [/^Manage\s+(.+?)\s+(resources|folders)\s+and settings\.?$/i, (_, target, noun) => {
      const targetZh = translateEntityNoun(target);
      const nounZh = noun.toLowerCase() === 'resources' ? '资源' : '文件夹';
      return `${joinZhSegment('管理', targetZh, '')}${nounZh}与设置`;
    }],
    [/^Manage\s+(.+?)\s+app settings\.?$/i, '管理 $1 应用设置'],
    [/^Agent settings and permissions for conversations outside of\s+(.+?)\.?$/i, (_, target) => joinZhSegment('配置未归属于任何', translateEntityNoun(target), '的独立会话的智能体设置与权限策略')],
    [/^Settings for conversations outside of\s+(.+?)\.?$/i, (_, target) => joinZhSegment('在', translateEntityNoun(target), '之外创建的独立会话设置')],
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
    [/^Welcome to\s+(.+?)!$/i, '欢迎使用 $1！'],
    [/^Select\s+(.+?)\s+Theme$/i, '选择 $1 主题'],
    [/^Hey\s+([A-Za-z0-9._-]{1,32})!$/i, (_, name) => name.toLowerCase() === 'there' ? '你好！' : `你好，${name}！`],
    [/^You're signing in on\s+(.+?)\.\s+Your sign-in stays on that machine\.?$/i, '你正在 $1 上登录。登录状态将仅保留在该主机上。'],
    [/^Sign-ins to\s+(.+?)\s+are kept in the cloud with your account\.?$/i, '你在 $1 的登录凭据会随你的账号保存在云端。'],
    [/^Authenticated as\s+(.+)$/i, '已登录为 $1'],
    [/^Sign-in failed:\s*(.+)$/i, (_, detail) => `登录失败：${translateAuthErrorDetail(detail)}`],
    [/^Authentication failed:\s*(.+)$/i, (_, detail) => `身份验证失败：${translateAuthErrorDetail(detail)}`],
    [/^(?:Failed|Unable) to sign in(?::\s*(.+)|\.?)$/i, (_, detail) => detail ? `登录失败：${translateAuthErrorDetail(detail)}` : '登录失败'],
    [/^(?:Failed|Unable) to authenticate(?::\s*(.+)|\.?)$/i, (_, detail) => detail ? `身份验证失败：${translateAuthErrorDetail(detail)}` : '身份验证失败'],
    [/^OAuth callback error\s*\(([^)]+)\):\s*(.+)$/i, (_, code, detail) => `OAuth 回调错误 (${code})：${translateAuthErrorDetail(detail)}`],
    [/^OAuth callback error:\s*(.+)$/i, (_, detail) => `OAuth 回调错误：${translateAuthErrorDetail(detail)}`],
    [/^OAuth token exchange failed:\s*(.+)$/i, (_, detail) => `OAuth 令牌交换失败：${translateAuthErrorDetail(detail)}`],
    [/^OAuth callback server failed:\s*(.+)$/i, (_, detail) => `OAuth 回调服务启动失败：${translateAuthErrorDetail(detail)}`],
    [/^OAuth token refresh failed:\s*(.+)$/i, (_, detail) => `OAuth 令牌刷新失败：${translateAuthErrorDetail(detail)}`],
    [/^OAuth error:\s*(.+)$/i, (_, detail) => `OAuth 错误：${translateAuthErrorDetail(detail)}`],
    [/^OAuth2 flow failed for\s+(.+?):\s*(.+)$/i, (_, target, detail) => `${target} 的 OAuth2 登录流程失败：${translateAuthErrorDetail(detail)}`],
    [/^OAuth credentials definitively rejected by server \((.+)\)$/i, (_, detail) => `服务器已拒绝 OAuth 凭据 (${translateAuthErrorDetail(detail)})`],
    [/^OAuth credentials definitively rejected during validation \((.+)\)$/i, (_, detail) => `验证时服务器已拒绝 OAuth 凭据 (${translateAuthErrorDetail(detail)})`],
    [/^Failed to exchange authorization code:\s*(.+)$/i, (_, detail) => `交换授权码失败：${translateAuthErrorDetail(detail)}`],
    [/^Failed to refresh token for\s+(.+?):\s*(.+)$/i, (_, target, detail) => `刷新 ${target} 令牌失败：${translateAuthErrorDetail(detail)}`],
    [/^\[(unavailable|deadline_exceeded|unauthenticated|permission_denied|canceled|cancelled|internal|invalid_argument|failed_precondition|resource_exhausted|not_found|aborted|unknown)\]\s+(.+)$/i, (m) => translateAuthErrorDetail(m)],
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
    [/^Keep:\s*(.+)$/i, (_, sched) => {
      const trimmed = sched.trim();
      return `保留当前：${translateScheduleSummary(trimmed) || lookupExact(trimmed, normalizeKey(trimmed)) || trimmed}`;
    }],
    [/^(?:Daily at|Weekly on|Monthly on the|Every\s+(?:\d+\s+(?:minutes?|hours?)|hour\b)|(?:Weekdays|Weekends|(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)(?:day)?s?(?:\s*(?:,\s*|\s+and\s+)(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)(?:day)?s?)*)\s+at\b).+$/i, (m) => translateScheduleSummary(m) || m],
    [/^Next run\s+today\s+around\s+(.+)$/i, (_, time) => `下次运行：今天约 ${translateClockTimeList(time)}`],
    [/^Next run\s+tomorrow\s+around\s+(.+)$/i, (_, time) => `下次运行：明天约 ${translateClockTimeList(time)}`],
    [/^Next run\s+on\s+(.+?)\s+around\s+(.+)$/i, (_, day, time) => `下次运行：${translateScheduleDay(day)} 约 ${translateClockTimeList(time)}`],
    [/^(Today|Tomorrow|Yesterday)\s+(\d{1,2}:\d{2}\s*(?:AM|PM))$/i, (_, rel, time) => {
      const relMap = { today: '今天', tomorrow: '明天', yesterday: '昨天' };
      return `${relMap[rel.toLowerCase()] || rel} ${translateClockTime(time)}`;
    }],
    [/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d{1,2}:\d{2}\s*(?:AM|PM))$/i, (_, day, time) => `${translateScheduleDay(day)} ${translateClockTime(time)}`],
    [/^([A-Za-z]{3,9}\s+\d{1,2}(?:,\s*\d{4})?),\s*(\d{1,2}:\d{2}\s*(?:AM|PM))$/i, (_, date, time) => `${formatEnDateToZh(date)} ${translateClockTime(time)}`],
    [/^Required to (create|save|continue):\s*(.+)$/i, (_, act, list) => {
      const actMap = { create: '创建', save: '保存', continue: '继续' };
      const items = list.split(',').map(translateRequiredBlockerItem).filter(Boolean);
      return `${actMap[act.toLowerCase()] || act}前需填写：${items.join('、')}`;
    }],
    [/^Step\s+(\d+)\s+of\s+(\d+)$/i, '第 $1 / $2 步'],
    [/^Failed:\s*(.+)$/i, (_, err) => `失败：${lookupExact(err.trim(), normalizeKey(err.trim())) || err.trim()}`],
    [/^Triggered\s+([^.!?]{1,100})$/i, '已触发 $1'],
    [/^Connect an account for\s+(.+?)\s+so the agent can run automations\.?$/i, '为 $1 连接账号以便智能体运行自动化任务。'],
    [/^Credentials expire in\s+(.+?)\.\s*Refresh credentials to keep this automation running\.?$/i, (_, d) => `凭据将在 ${translateDuration(d)} 后过期。请刷新凭据以保持此自动化任务正常运行`],

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
    [/^Your Plan:\s*(.+)$/i, (_, plan) => {
      const trimmed = plan.trim();
      const translated = lookupExact(trimmed, normalizeKey(trimmed)) || translatePlanOrAudience(trimmed, 'allowBare') || trimmed;
      return `当前套餐：${translated}`;
    }],
    [/^Upgrade to\s+(.+)$/i, (m, plan) => {
      const translated = translatePlanOrAudience(plan, 'allowBare');
      return translated ? joinZhSegment('升级到', translated, '') : m;
    }],
    [/^Sorry,\s*this account is ineligible to use\s+(.+?)\.?$/i, '抱歉，此账号无法使用 $1'],
    [/^Further action is required to use\s+(.+?)\.?$/i, '需要进一步操作才能使用 $1'],
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
    [/^Waiting on @([A-Za-z0-9_-]+)$/i, '等待 @$1 响应'],
    [/^Go to #(\d+) on the Board$/i, '跳转到消息板 #$1'],
    [/^Posted in #([A-Za-z0-9_-]+);\s*click to show only #\1$/i, '发布于 #$1；点击仅显示 #$1'],
    [/^Narrator read up to #(\d+) of (\d+)$/i, '记录员已读至 #$1 / $2'],
    [/^Latest action:\s*(.+)$/i, '最新操作：$1'],

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

    // 模型标签说明 (i) 与不同订阅套餐提示动态模板（统一术语与多句组合支持）
    [/^(.+?)\s+that may offload routine steps to\s+(.+?)\.\s*Same\s+(.+?)-level quality,\s*fewer tokens used\.?$/i, '$1，可将常规步骤分流至 $2。同等 $3 级质量，消耗更少 Token。'],
    [/^(?=.*\b(?:available|unavailable|removed|removal|removing|deprecated|deprecating|retired|retiring|sunset|leaving|leaves|leave|replaced|until|subscribers?|plans?|tiers?|rate\s+limits?|base\s+limits?|quota|limit|ineligible|not\s+eligible|third-party|upgrade\s+to|managed\s+by|administrator|switch(?:ing)?\s+to|migrat(?:e|ing)\s+to|transition\s+to|recommend|try|use|instead|do\s+not\s+include|requires?)\b)[\s\S]+$/i, (m) => translatePlanOrModelNotice(m) || m],
    [/^(?=.*(?:Rpc failed due to xhr error|Failed to fetch|NetworkError\b|context deadline exceeded|Client\.Timeout exceeded|i\/o timeout|operation timed out|connection timed out|TLS handshake timeout|connection refused|connection reset by peer|no such host|network is unreachable|network is down|no route to host|proxy authentication required|Remote instance is unreachable|InstanceUnreachableError|is not (?:currently )?available in your (?:country|region|location)|(?:This|Your) account is not eligible|(?:This|Your) account is not supported|(?:organization|administrator)\s+has\s+disabled|must be at least \d+ years old to use))[\s\S]+$/i, (m) => translateAuthErrorDetail(m)],

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
    translateClockTime,
    translateCompactRelativeTime,
    translateCompactDuration,
    translateEffortLevel,
    translateModelWithEffort,
    translateModelParenEffort,
    translateLimitKind,
    translateScope,
    translateEntityNoun,
    translateQuotaTextParts
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createDynamicRules };
}
