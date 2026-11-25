'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const SUPPORTED_SCHEMA_VERSION = 1;
const DEFAULT_INITIAL_DELAY_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_FETCH_TIMEOUT_MS = 5000;
const MAX_PACK_BYTES = 4 * 1024 * 1024;
const DEFAULT_BASE_URLS = [
  'https://raw.githubusercontent.com/downey37/antigravity-zh-cn/ota-dist',
  'https://cdn.jsdelivr.net/gh/downey37/antigravity-zh-cn@ota-dist'
];
const DEFAULT_MT_URL = 'https://translate.googleapis.com/translate_a/single';
const MT_CACHE_SCHEMA_VERSION = 1;
const MAX_MT_CACHE_ENTRIES = 500;
const MAX_MT_TEXT_LENGTH = 600;
const MIN_MT_TEXT_LENGTH = 4;
const MT_FAIL_COOLDOWN_MS = 60 * 1000;
const MT_RATE_WINDOW_MS = 60 * 1000;
const MT_MAX_REQ_PER_MIN = 20;

function safeRequireElectron() {
  try {
    return require('electron');
  } catch (_) {
    return null;
  }
}

function parseSemver(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function isNewerPack(candidate, baseline) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (!baseline || typeof baseline !== 'object') return true;
  const cTime = candidate.builtAt ? Date.parse(candidate.builtAt) : NaN;
  const bTime = baseline.builtAt ? Date.parse(baseline.builtAt) : NaN;
  if (!Number.isNaN(cTime) && !Number.isNaN(bTime)) {
    if (cTime !== bTime) return cTime > bTime;
  }
  const cVer = String(candidate.packVersion || '').trim();
  const bVer = String(baseline.packVersion || '').trim();
  if (cVer && bVer && cVer !== bVer) {
    return cVer > bVer;
  }
  return false;
}

function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {}
    throw err;
  }
}

function isPlainObject(val) {
  return Boolean(val && typeof val === 'object' && !Array.isArray(val));
}

function validatePackObject(pack, options = {}) {
  const minDictCount = typeof options.minDictCount === 'number' ? options.minDictCount : 1000;
  const minAttrCount = typeof options.minAttrCount === 'number' ? options.minAttrCount : 100;
  if (!isPlainObject(pack)) return { ok: false, reason: 'pack is not an object' };
  if (pack.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported schemaVersion: ${pack.schemaVersion}` };
  }
  if (typeof pack.packVersion !== 'string' || !pack.packVersion.trim()) {
    return { ok: false, reason: 'missing packVersion' };
  }
  if (!isPlainObject(pack.dictionary) || !isPlainObject(pack.attrDict)) {
    return { ok: false, reason: 'missing dictionary or attrDict' };
  }
  if (!Array.isArray(pack.preserveList)) {
    return { ok: false, reason: 'missing preserveList array' };
  }
  const dictEntries = Object.entries(pack.dictionary);
  const attrEntries = Object.entries(pack.attrDict);
  if (dictEntries.length < minDictCount || attrEntries.length < minAttrCount) {
    return { ok: false, reason: `entry count below safety threshold (dict=${dictEntries.length}, attr=${attrEntries.length})` };
  }
  for (let i = 0; i < dictEntries.length; i++) {
    if (typeof dictEntries[i][1] !== 'string') {
      return { ok: false, reason: `non-string dictionary value at key ${dictEntries[i][0]}` };
    }
  }
  for (let i = 0; i < attrEntries.length; i++) {
    if (typeof attrEntries[i][1] !== 'string') {
      return { ok: false, reason: `non-string attrDict value at key ${attrEntries[i][0]}` };
    }
  }
  if (pack.rules !== undefined) {
    if (!Array.isArray(pack.rules) || pack.rules.length > 200) {
      return { ok: false, reason: 'invalid rules array' };
    }
  }
  return { ok: true, dictCount: dictEntries.length, attrCount: attrEntries.length };
}

function buildNativeContextDictFromPack(pack) {
  if (!pack || !isPlainObject(pack.dictionary)) return null;
  const preserveSet = new Set(Array.isArray(pack.preserveList) ? pack.preserveList : []);
  const exactMap = new Map();
  const lowerMap = new Map();
  for (const [k, v] of Object.entries(pack.dictionary)) {
    if (typeof v !== 'string' || preserveSet.has(k) || k.length > 80 || k.includes('\n')) continue;
    exactMap.set(k, v);
    const lk = k.toLowerCase().trim();
    if (!lowerMap.has(lk)) lowerMap.set(lk, v);
  }
  return { exactMap, lowerMap };
}

function isEligibleSubframeUrl(frameUrl, mainOrigin) {
  if (!frameUrl || typeof frameUrl !== 'string') return false;
  if (frameUrl.startsWith('plugin://') || frameUrl.startsWith('vscode-webview://')) return true;
  if (!mainOrigin || mainOrigin === 'null') return false;
  try {
    return new URL(frameUrl).origin === mainOrigin;
  } catch (_) {
    return false;
  }
}

function normalizeMtText(raw) {
  return String(raw || '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isEligibleMtText(text) {
  const norm = normalizeMtText(text);
  if (!norm || norm.length < MIN_MT_TEXT_LENGTH || norm.length > MAX_MT_TEXT_LENGTH) {
    return false;
  }
  if (/[\u4e00-\u9fff]/.test(norm)) {
    return false;
  }
  if (!/[A-Za-z]{2,}[\s/-]+[A-Za-z]{2,}/.test(norm)) {
    return false;
  }
  if (/^(?:https?:\/\/|[A-Za-z]:\\|\/[\w.-]+\/|\{[\s\S]*\}|\[[\s\S]*\])/.test(norm)) {
    return false;
  }
  return true;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const _PROTECT_TERM_CACHE = typeof WeakMap === 'function' ? new WeakMap() : null;

function getCompiledPreserveMatchers(preserveList) {
  if (!Array.isArray(preserveList) || preserveList.length === 0) return [];
  if (_PROTECT_TERM_CACHE && _PROTECT_TERM_CACHE.has(preserveList)) {
    return _PROTECT_TERM_CACHE.get(preserveList);
  }
  const compiled = [];
  const sorted = preserveList
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .slice()
    .sort((a, b) => b.length - a.length);
  for (let i = 0; i < sorted.length; i++) {
    const term = sorted[i].trim();
    if (!term) continue;
    const flags = term.toLowerCase() === 'antigravity' ? 'gi' : 'g';
    compiled.push(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9])`, flags));
  }
  if (_PROTECT_TERM_CACHE) {
    _PROTECT_TERM_CACHE.set(preserveList, compiled);
  }
  return compiled;
}

function protectDynamicMtTerms(text, preserveList = []) {
  const input = String(text || '');
  const spans = [];
  const collectMatches = (re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(input)) !== null) {
      if (!m[0]) {
        re.lastIndex += 1;
        continue;
      }
      spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  };

  collectMatches(/\b(?:Gemini|Claude|GPT(?:-OSS)?|DeepSeek)\s+\d+(?:\.\d+)?(?:\s+(?:Pro|Ultra|Flash|Nano|Neon|Carbon|Argon|Hydrogen|Opus|Sonnet|Haiku|Mini|Preview|Thinking|Exp|Lite|Fast|\d+[BM]))*\b/gi);
  collectMatches(/\b(?:Claude\s+(?:Opus|Sonnet|Haiku)|GPT-OSS|Google\s+AI\s+(?:Pro|Ultra|Plus)|Google\s+(?:Workspace|Cloud|Drive|Docs|Sheets|Slides|Chat|Chrome)|AI\s+Credits)\b/gi);

  const preserveMatchers = getCompiledPreserveMatchers(preserveList);
  for (let i = 0; i < preserveMatchers.length; i++) {
    collectMatches(preserveMatchers[i]);
  }

  collectMatches(/\b(?:Antigravity|Orchestrator|Gemini|Claude|Carbon|Argon|Hydrogen|Neon|Opus|Sonnet|Haiku|Flash|Swarm|Cascade|MCP|WSL|SSH|API|CLI|IDE|Tokens?)\b/g);

  spans.sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const chosen = [];
  let cursor = 0;
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    if (sp.start >= cursor) {
      chosen.push(sp);
      cursor = sp.end;
    }
  }

  if (chosen.length === 0) {
    return { masked: input, placeholders: [] };
  }

  let masked = '';
  let pos = 0;
  const placeholders = [];
  for (let i = 0; i < chosen.length; i++) {
    const sp = chosen[i];
    masked += input.slice(pos, sp.start);
    masked += `AGYTERM${i}X`;
    placeholders.push(sp.text);
    pos = sp.end;
  }
  masked += input.slice(pos);
  return { masked, placeholders };
}

function restoreDynamicMtTerms(translated, placeholders = []) {
  if (typeof translated !== 'string' || !translated.trim()) return null;
  let out = translated;
  if (Array.isArray(placeholders) && placeholders.length > 0) {
    const seen = new Set();
    const tokenRe = /AGYTERM(\d+)X/gi;
    let m;
    while ((m = tokenRe.exec(out)) !== null) {
      const idx = Number(m[1]);
      if (!Number.isInteger(idx) || idx < 0 || idx >= placeholders.length) {
        return null;
      }
      seen.add(idx);
    }
    if (seen.size !== placeholders.length) {
      return null;
    }
    out = out.replace(/AGYTERM(\d+)X/gi, (_, rawIdx) => placeholders[Number(rawIdx)]);
  }
  out = out
    .replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2')
    .replace(/\s+([，。！？；：、）》」』】])/g, '$1')
    .replace(/([（《「『【])\s+/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (!/[\u4e00-\u9fff]/.test(out)) return null;
  return out;
}

function parseGoogleGtxResponse(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    if (!Array.isArray(parsed) || !Array.isArray(parsed[0])) return null;
    let joined = '';
    for (let i = 0; i < parsed[0].length; i++) {
      const seg = parsed[0][i];
      if (Array.isArray(seg) && typeof seg[0] === 'string') {
        joined += seg[0];
      }
    }
    const trimmed = joined.trim();
    return trimmed || null;
  } catch (_) {
    return null;
  }
}

function parseOpenAiMtResponse(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    const content = parsed && Array.isArray(parsed.choices) && parsed.choices[0] &&
      parsed.choices[0].message && typeof parsed.choices[0].message.content === 'string'
      ? parsed.choices[0].message.content
      : null;
    if (!content) return null;
    const cleaned = content
      .trim()
      .replace(/^```(?:text|markdown)?\s*/i, '')
      .replace(/\s*```$/, '')
      .replace(/^["“]|["”]$/g, '')
      .trim();
    return cleaned || null;
  } catch (_) {
    return null;
  }
}

function nodeHttpFetchText(urlStr, headers, timeoutMs, reqOptions = {}, redirectDepth = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      return reject(err);
    }
    const method = String((reqOptions && reqOptions.method) || 'GET').toUpperCase();
    const body = reqOptions && reqOptions.body != null ? String(reqOptions.body) : null;
    const reqHeaders = {
      'Accept-Encoding': 'identity',
      'User-Agent': 'antigravity-zh-cn-ota/1',
      ...(headers || {})
    };
    if (body !== null && reqHeaders['Content-Length'] === undefined && reqHeaders['content-length'] === undefined) {
      reqHeaders['Content-Length'] = Buffer.byteLength(body, 'utf8');
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      parsed,
      {
        method,
        headers: reqHeaders,
        timeout: timeoutMs
      },
      (res) => {
        if (method === 'GET' && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectDepth < 3) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsed).toString();
          return nodeHttpFetchText(nextUrl, headers, timeoutMs, reqOptions, redirectDepth + 1).then(resolve, reject);
        }
        const chunks = [];
        let total = 0;
        res.on('error', reject);
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_PACK_BYTES) {
            req.destroy(new Error('Response exceeds max allowed size'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            etag: res.headers.etag || '',
            text: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (body !== null) {
      req.write(body, 'utf8');
    }
    req.end();
  });
}

function createOtaController(options = {}) {
  const electronMod = options.electron !== undefined ? options.electron : safeRequireElectron();
  const env = options.env || process.env;
  const minDictCount = typeof options.minDictCount === 'number' ? options.minDictCount : 1000;
  const minAttrCount = typeof options.minAttrCount === 'number' ? options.minAttrCount : 100;
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_FETCH_TIMEOUT_MS;
  const initialDelayMs = typeof options.initialDelayMs === 'number' ? options.initialDelayMs : DEFAULT_INITIAL_DELAY_MS;
  const pollIntervalMs = typeof options.pollIntervalMs === 'number'
    ? options.pollIntervalMs
    : (Number(env.ANTIGRAVITY_I18N_OTA_INTERVAL_MS) > 0 ? Number(env.ANTIGRAVITY_I18N_OTA_INTERVAL_MS) : DEFAULT_POLL_INTERVAL_MS);

  const metaPath = options.metaPath || path.join(__dirname, 'i18n_meta.json');
  let builtinMeta = options.builtinMeta || {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    engineVersion: '0.3.0',
    packVersion: '0.0.0',
    builtAt: '1970-01-01T00:00:00.000Z'
  };
  if (!options.builtinMeta) {
    try {
      if (fs.existsSync(metaPath)) {
        builtinMeta = { ...builtinMeta, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) };
      }
    } catch (_) {}
  }

  function resolveCacheDir() {
    if (options.cacheDir) return options.cacheDir;
    if (electronMod && electronMod.app && typeof electronMod.app.getPath === 'function') {
      try {
        return path.join(electronMod.app.getPath('userData'), 'i18n-cache');
      } catch (_) {}
    }
    return path.join(os.tmpdir(), 'antigravity-i18n-cache');
  }

  function resolveBaseUrls() {
    if (Array.isArray(options.baseUrls) && options.baseUrls.length > 0) {
      return options.baseUrls.map((u) => String(u).replace(/\/+$/, ''));
    }
    const override = String(env.ANTIGRAVITY_I18N_OTA_URL || '').trim();
    if (override) {
      return override
        .split(',')
        .map((s) => s.trim().replace(/\/+$/, ''))
        .filter(Boolean);
    }
    return DEFAULT_BASE_URLS.slice();
  }

  function isOtaDisabled() {
    const flag = String(env.ANTIGRAVITY_I18N_NO_OTA || '').trim().toLowerCase();
    return flag === '1' || flag === 'true' || flag === 'yes';
  }

  function isI18nInitiallyDisabled() {
    const flag = String(env.ANTIGRAVITY_I18N_DISABLED || '').trim().toLowerCase();
    return flag === '1' || flag === 'true' || flag === 'yes';
  }

  function getAutoMtEnvOverride() {
    const raw = env.ANTIGRAVITY_I18N_AUTO_MT;
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const flag = String(raw).trim().toLowerCase();
    if (flag === '0' || flag === 'false' || flag === 'no' || flag === 'off') return false;
    if (flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on') return true;
    return null;
  }

  const cacheDir = resolveCacheDir();
  const packCachePath = path.join(cacheDir, 'dict-pack.json');
  const stateCachePath = path.join(cacheDir, 'state.json');
  const mtCachePath = path.join(cacheDir, 'dynamic-mt-cache.json');

  let state = {
    etag: '',
    packVersion: '',
    builtAt: '',
    lastCheckedAt: '',
    lastSource: '',
    notifiedEngineVersion: '',
    i18nEnabled: true,
    autoMtEnabled: true
  };
  let activePack = null;
  let activeApplyScript = null;
  let activeNativeContextDict = null;
  let initializedCache = false;
  let stateLoaded = false;
  let mtCacheLoaded = false;
  const mtCacheMap = new Map();
  const mtInFlight = new Map();
  const mtFailCooldown = new Map();
  const mtReqTimestamps = [];
  let backgroundStarted = false;
  let initialTimer = null;
  let pollTimer = null;
  let inFlightCheck = null;
  let inFlightManual = false;
  const trackedWebContents = new Set();
  const languageChangeListeners = new Set();
  const autoMtChangeListeners = new Set();

  function loadStateSync() {
    if (stateLoaded) return;
    stateLoaded = true;
    try {
      if (fs.existsSync(stateCachePath)) {
        const parsed = JSON.parse(fs.readFileSync(stateCachePath, 'utf8'));
        if (isPlainObject(parsed)) {
          state = { ...state, ...parsed };
        }
      }
    } catch (_) {}
  }

  function saveStateSync() {
    try {
      atomicWriteFileSync(stateCachePath, JSON.stringify(state, null, 2) + '\n');
    } catch (_) {}
  }

  loadStateSync();
  let i18nEnabled = isI18nInitiallyDisabled()
    ? false
    : (typeof state.i18nEnabled === 'boolean' ? state.i18nEnabled : true);
  const autoMtEnvOverride = getAutoMtEnvOverride();
  let autoMtEnabled = autoMtEnvOverride !== null
    ? autoMtEnvOverride
    : (typeof state.autoMtEnabled === 'boolean' ? state.autoMtEnabled : true);

  function setActivePack(pack) {
    activePack = pack;
    activeApplyScript = pack
      ? `if (window.__antigravityApplyOtaPack) { window.__antigravityApplyOtaPack(${JSON.stringify(pack)}); }`
      : null;
    activeNativeContextDict = pack ? buildNativeContextDictFromPack(pack) : null;
  }

  function loadCachedPackSync() {
    if (initializedCache) return activePack;
    initializedCache = true;
    loadStateSync();
    try {
      if (!fs.existsSync(packCachePath)) return null;
      const raw = fs.readFileSync(packCachePath, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > MAX_PACK_BYTES) return null;
      const parsed = JSON.parse(raw);
      const valid = validatePackObject(parsed, { minDictCount, minAttrCount });
      if (!valid.ok) return null;
      if (parsed.minEngineVersion && compareSemver(builtinMeta.engineVersion, parsed.minEngineVersion) < 0) {
        return null;
      }
      if (!isNewerPack(parsed, builtinMeta)) {
        return null;
      }
      setActivePack(parsed);
      return activePack;
    } catch (_) {
      return null;
    }
  }

  function getActiveVersion() {
    loadCachedPackSync();
    return (activePack && activePack.packVersion) || builtinMeta.packVersion || 'builtin';
  }

  function getActiveMeta() {
    loadCachedPackSync();
    if (activePack) {
      return {
        packVersion: activePack.packVersion,
        builtAt: activePack.builtAt || '',
        engineVersion: builtinMeta.engineVersion
      };
    }
    return builtinMeta;
  }

  function getApplyScript() {
    loadCachedPackSync();
    return activeApplyScript;
  }

  function getNativeContextDict() {
    loadCachedPackSync();
    return activeNativeContextDict;
  }

  async function defaultFetchText(urlStr, reqHeaders, reqOptions = {}) {
    const netFetch = electronMod && electronMod.net && typeof electronMod.net.fetch === 'function'
      ? electronMod.net.fetch.bind(electronMod.net)
      : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);

    const method = String((reqOptions && reqOptions.method) || 'GET').toUpperCase();
    const body = reqOptions && reqOptions.body != null ? String(reqOptions.body) : undefined;

    if (netFetch && typeof AbortController !== 'undefined') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const fetchOpts = {
          method,
          headers: reqHeaders || {},
          signal: controller.signal
        };
        if (body !== undefined) {
          fetchOpts.body = body;
        }
        const res = await netFetch(urlStr, fetchOpts);
        const status = res.status;
        const etag = res.headers && typeof res.headers.get === 'function' ? (res.headers.get('etag') || '') : '';
        if (status === 304) {
          return { status: 304, etag, text: '' };
        }
        const contentLenRaw = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : '';
        const contentLen = contentLenRaw ? Number(contentLenRaw) : NaN;
        if (!Number.isNaN(contentLen) && contentLen > MAX_PACK_BYTES) {
          throw new Error('Response exceeds max allowed size');
        }
        let text;
        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          const chunks = [];
          let totalBytes = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                totalBytes += value.byteLength || value.length || 0;
                if (totalBytes > MAX_PACK_BYTES) {
                  try { await reader.cancel(); } catch (_) {}
                  throw new Error('Response exceeds max allowed size');
                }
                chunks.push(Buffer.from(value));
              }
            }
          } finally {
            if (typeof reader.releaseLock === 'function') {
              try { reader.releaseLock(); } catch (_) {}
            }
          }
          text = Buffer.concat(chunks).toString('utf8');
        } else {
          text = await res.text();
          if (Buffer.byteLength(text, 'utf8') > MAX_PACK_BYTES) {
            throw new Error('Response exceeds max allowed size');
          }
        }
        return { status, etag, text };
      } finally {
        clearTimeout(timer);
      }
    }
    return nodeHttpFetchText(urlStr, reqHeaders, timeoutMs, reqOptions);
  }

  const fetchText = typeof options.fetchText === 'function' ? options.fetchText : defaultFetchText;

  function applyPackToWebContents(wc, scriptStr) {
    if (!wc || !scriptStr) return;
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return;
    try {
      if (typeof wc.executeJavaScript === 'function') {
        Promise.resolve(wc.executeJavaScript(scriptStr)).catch(() => {});
      }
      const mainFrame = wc.mainFrame;
      if (mainFrame && Array.isArray(mainFrame.framesInSubtree)) {
        let mainOrigin = '';
        try {
          if (typeof wc.getURL === 'function') mainOrigin = new URL(wc.getURL()).origin;
        } catch (_) {}
        for (let i = 0; i < mainFrame.framesInSubtree.length; i++) {
          const frame = mainFrame.framesInSubtree[i];
          if (!frame || frame === mainFrame) continue;
          if (isEligibleSubframeUrl(frame.url, mainOrigin) && typeof frame.executeJavaScript === 'function') {
            Promise.resolve(frame.executeJavaScript(scriptStr)).catch(() => {});
          }
        }
      }
    } catch (_) {}
  }

  function applyCachedPackToFrame(frame) {
    const scriptStr = getApplyScript();
    if (!scriptStr || !frame || typeof frame.executeJavaScript !== 'function') return;
    Promise.resolve(frame.executeJavaScript(scriptStr)).catch(() => {});
  }

  function applyCachedPackToWebContents(wc) {
    const scriptStr = getApplyScript();
    if (!scriptStr) return;
    applyPackToWebContents(wc, scriptStr);
  }

  function broadcastActivePack() {
    if (!activeApplyScript) return;
    for (const wc of trackedWebContents) {
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) {
        trackedWebContents.delete(wc);
        continue;
      }
      applyPackToWebContents(wc, activeApplyScript);
    }
  }

  function isI18nEnabled() {
    return i18nEnabled;
  }

  function t(zh, en) {
    return i18nEnabled ? zh : en;
  }

  function getInitialStateScript() {
    return (
      `window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ = ${i18nEnabled ? 'true' : 'false'};\n` +
      `window.__ANTIGRAVITY_I18N_AUTO_MT_ENABLED__ = ${autoMtEnabled ? 'true' : 'false'};`
    );
  }

  function broadcastAutoMtState(enabled) {
    const scriptStr = `if (window.__antigravitySetAutoMtEnabled) { window.__antigravitySetAutoMtEnabled(${enabled ? 'true' : 'false'}); }`;
    for (const wc of trackedWebContents) {
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) {
        trackedWebContents.delete(wc);
        continue;
      }
      applyPackToWebContents(wc, scriptStr);
    }
  }

  function isAutoMtEnabled() {
    return autoMtEnabled;
  }

  function setAutoMtEnabled(nextEnabled) {
    const normalized = Boolean(nextEnabled);
    if (normalized === autoMtEnabled) return autoMtEnabled;
    autoMtEnabled = normalized;
    state.autoMtEnabled = normalized;
    saveStateSync();
    broadcastAutoMtState(autoMtEnabled);
    for (const listener of autoMtChangeListeners) {
      try {
        listener(autoMtEnabled);
      } catch (_) {}
    }
    return autoMtEnabled;
  }

  function toggleAutoMtEnabled() {
    return setAutoMtEnabled(!autoMtEnabled);
  }

  function onAutoMtChange(fn) {
    if (typeof fn !== 'function') return () => {};
    autoMtChangeListeners.add(fn);
    return () => autoMtChangeListeners.delete(fn);
  }

  const mtCacheDebounceMs = typeof options.mtCacheDebounceMs === 'number'
    ? Math.max(0, options.mtCacheDebounceMs)
    : (electronMod && electronMod.app ? 800 : 0);
  let mtSaveTimer = null;
  let mtCacheDirty = false;
  let beforeQuitBound = false;

  function recordMtFailCooldown(norm) {
    const now = Date.now();
    if (mtFailCooldown.size >= MAX_MT_CACHE_ENTRIES) {
      for (const [k, until] of mtFailCooldown.entries()) {
        if (until <= now) mtFailCooldown.delete(k);
      }
      while (mtFailCooldown.size >= MAX_MT_CACHE_ENTRIES) {
        const oldestKey = mtFailCooldown.keys().next().value;
        if (oldestKey === undefined) break;
        mtFailCooldown.delete(oldestKey);
      }
    }
    mtFailCooldown.set(norm, now + MT_FAIL_COOLDOWN_MS);
  }

  function loadMtCacheSync() {
    if (mtCacheLoaded) return;
    mtCacheLoaded = true;
    try {
      if (!fs.existsSync(mtCachePath)) return;
      const raw = fs.readFileSync(mtCachePath, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > MAX_PACK_BYTES) return;
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed) || parsed.schemaVersion !== MT_CACHE_SCHEMA_VERSION || !isPlainObject(parsed.entries)) {
        return;
      }
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (!k || !isPlainObject(v) || typeof v.zh !== 'string' || !v.zh.trim()) continue;
        mtCacheMap.set(k, {
          zh: v.zh,
          ts: typeof v.ts === 'number' ? v.ts : 0,
          provider: typeof v.provider === 'string' ? v.provider : ''
        });
      }
    } catch (_) {}
  }

  function saveMtCacheSync() {
    try {
      if (mtCacheMap.size > MAX_MT_CACHE_ENTRIES) {
        const sorted = Array.from(mtCacheMap.entries()).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
        const toRemove = mtCacheMap.size - MAX_MT_CACHE_ENTRIES;
        for (let i = 0; i < toRemove; i++) {
          mtCacheMap.delete(sorted[i][0]);
        }
      }
      const entries = {};
      for (const [k, v] of mtCacheMap.entries()) {
        entries[k] = v;
      }
      atomicWriteFileSync(
        mtCachePath,
        JSON.stringify({ schemaVersion: MT_CACHE_SCHEMA_VERSION, entries })
      );
      mtCacheDirty = false;
    } catch (_) {}
  }

  function flushMtCacheSync() {
    if (mtSaveTimer) {
      clearTimeout(mtSaveTimer);
      mtSaveTimer = null;
    }
    if (mtCacheDirty) {
      saveMtCacheSync();
    }
  }

  function scheduleMtCacheSave() {
    mtCacheDirty = true;
    if (mtCacheDebounceMs <= 0) {
      saveMtCacheSync();
      return;
    }
    if (!beforeQuitBound && electronMod && electronMod.app && typeof electronMod.app.once === 'function') {
      beforeQuitBound = true;
      electronMod.app.once('before-quit', flushMtCacheSync);
    }
    if (mtSaveTimer) {
      clearTimeout(mtSaveTimer);
    }
    mtSaveTimer = setTimeout(() => {
      mtSaveTimer = null;
      if (mtCacheDirty) saveMtCacheSync();
    }, mtCacheDebounceMs);
    if (mtSaveTimer && typeof mtSaveTimer.unref === 'function') {
      mtSaveTimer.unref();
    }
  }

  function getEffectivePreserveList() {
    loadCachedPackSync();
    if (activePack && Array.isArray(activePack.preserveList) && activePack.preserveList.length > 0) {
      return activePack.preserveList;
    }
    if (Array.isArray(builtinMeta.preserveList) && builtinMeta.preserveList.length > 0) {
      return builtinMeta.preserveList;
    }
    if (Array.isArray(options.preserveList)) {
      return options.preserveList;
    }
    return [];
  }

  function isWithinMtRateLimit() {
    const now = Date.now();
    while (mtReqTimestamps.length > 0 && now - mtReqTimestamps[0] > MT_RATE_WINDOW_MS) {
      mtReqTimestamps.shift();
    }
    if (mtReqTimestamps.length >= MT_MAX_REQ_PER_MIN) {
      return false;
    }
    mtReqTimestamps.push(now);
    return true;
  }

  async function translateDynamicText(rawText) {
    if (!autoMtEnabled) {
      return { status: 'disabled', translated: '' };
    }
    const norm = normalizeMtText(rawText);
    if (!isEligibleMtText(norm)) {
      return { status: 'ineligible', translated: '' };
    }
    loadMtCacheSync();
    if (mtCacheMap.has(norm)) {
      const hit = mtCacheMap.get(norm);
      if (hit && hit.zh) {
        return { status: 'ok', translated: hit.zh, cached: true, provider: hit.provider || '' };
      }
    }
    if (isOtaDisabled()) {
      return { status: 'disabled', translated: '' };
    }
    const failUntil = mtFailCooldown.get(norm) || 0;
    if (failUntil > Date.now()) {
      return { status: 'cooldown', translated: '' };
    }
    if (mtInFlight.has(norm)) {
      return mtInFlight.get(norm);
    }
    if (!isWithinMtRateLimit()) {
      return { status: 'rate_limited', translated: '' };
    }

    const work = (async () => {
      try {
        const preserveList = getEffectivePreserveList();
        const { masked, placeholders } = protectDynamicMtTerms(norm, preserveList);
        const provider = String(options.mtProvider || env.ANTIGRAVITY_I18N_MT_PROVIDER || 'google-gtx').trim().toLowerCase();
        let rawTranslated = null;

        if (provider === 'openai') {
          const mtUrl = String(options.mtUrl || env.ANTIGRAVITY_I18N_MT_URL || '').trim();
          if (!mtUrl) {
            return { status: 'error', translated: '', error: 'Missing ANTIGRAVITY_I18N_MT_URL for openai provider' };
          }
          const apiKey = String(options.mtApiKey || env.ANTIGRAVITY_I18N_MT_API_KEY || '').trim();
          const model = String(options.mtModel || env.ANTIGRAVITY_I18N_MT_MODEL || 'gpt-4o-mini').trim();
          const headers = { 'Content-Type': 'application/json' };
          if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
          const payload = JSON.stringify({
            model,
            temperature: 0,
            messages: [
              {
                role: 'system',
                content: 'Translate the English desktop UI announcement into concise, natural Simplified Chinese. Preserve all tokens matching AGYTERM<digits>X verbatim without altering or translating them. Output only the translated text.'
              },
              { role: 'user', content: masked }
            ]
          });
          const res = await fetchText(mtUrl, headers, { method: 'POST', body: payload });
          if (res.status < 200 || res.status >= 300) {
            throw new Error(`HTTP ${res.status} from openai MT endpoint`);
          }
          rawTranslated = parseOpenAiMtResponse(res.text);
        } else {
          const baseMtUrl = String(options.mtUrl || env.ANTIGRAVITY_I18N_MT_URL || DEFAULT_MT_URL).trim();
          const sep = baseMtUrl.includes('?') ? '&' : '?';
          const reqUrl = `${baseMtUrl}${sep}client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(masked)}`;
          const res = await fetchText(reqUrl, { Accept: 'application/json' });
          if (res.status < 200 || res.status >= 300) {
            throw new Error(`HTTP ${res.status} from google-gtx MT endpoint`);
          }
          rawTranslated = parseGoogleGtxResponse(res.text);
        }

        const restored = restoreDynamicMtTerms(rawTranslated, placeholders);
        if (!restored || restored === norm) {
          recordMtFailCooldown(norm);
          return { status: 'error', translated: '' };
        }
        mtCacheMap.set(norm, { zh: restored, ts: Date.now(), provider });
        scheduleMtCacheSave();
        return { status: 'ok', translated: restored, cached: false, provider };
      } catch (err) {
        recordMtFailCooldown(norm);
        return {
          status: 'error',
          translated: '',
          error: err && err.message ? err.message : String(err)
        };
      } finally {
        mtInFlight.delete(norm);
      }
    })();

    mtInFlight.set(norm, work);
    return work;
  }

  function broadcastLanguageState(enabled) {
    const scriptStr = `if (window.__antigravitySetI18nEnabled) { window.__antigravitySetI18nEnabled(${enabled ? 'true' : 'false'}); }`;
    for (const wc of trackedWebContents) {
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) {
        trackedWebContents.delete(wc);
        continue;
      }
      applyPackToWebContents(wc, scriptStr);
    }
  }

  function setI18nEnabled(nextEnabled) {
    const normalized = Boolean(nextEnabled);
    if (normalized === i18nEnabled) return i18nEnabled;
    i18nEnabled = normalized;
    state.i18nEnabled = normalized;
    saveStateSync();
    broadcastLanguageState(i18nEnabled);
    for (const listener of languageChangeListeners) {
      try {
        listener(i18nEnabled);
      } catch (_) {}
    }
    return i18nEnabled;
  }

  function toggleI18nEnabled() {
    return setI18nEnabled(!i18nEnabled);
  }

  function onLanguageChange(fn) {
    if (typeof fn !== 'function') return () => {};
    languageChangeListeners.add(fn);
    return () => languageChangeListeners.delete(fn);
  }

  function registerWebContents(wc) {
    if (!wc || trackedWebContents.has(wc)) return;
    trackedWebContents.add(wc);
    if (typeof wc.once === 'function') {
      wc.once('destroyed', () => {
        trackedWebContents.delete(wc);
      });
    }
  }

  function notifyEngineUpgradeBackground(manifest) {
    const targetVer = String(manifest.engineVersion || manifest.minEngineVersion || '').trim();
    if (!targetVer || state.notifiedEngineVersion === targetVer) return;
    state.notifiedEngineVersion = targetVer;
    saveStateSync();
    try {
      if (electronMod && electronMod.Notification && electronMod.Notification.isSupported && electronMod.Notification.isSupported()) {
        const minVer = manifest.minEngineVersion || targetVer;
        const n = new electronMod.Notification({
          title: t('Antigravity 汉化引擎有新版本', 'Antigravity i18n Engine Update Available'),
          body: t(
            `最新云端词库需要汉化引擎 v${minVer} 及以上（当前 v${builtinMeta.engineVersion}），点击左上角“Antigravity → 检查汉化更新”或托盘菜单“检查汉化更新”可前往更新。`,
            `The latest Cloud OTA pack requires i18n engine v${minVer}+ (current: v${builtinMeta.engineVersion}). Use "Help → Check i18n Updates" or the tray menu to update.`
          )
        });
        n.show();
      }
    } catch (_) {}
  }

  async function showManualDialog(result) {
    const dlgTitle = t('检查汉化更新', 'Check i18n Updates');
    const okBtn = t('确定', 'OK');
    if (options.onManualDialog) {
      try { await options.onManualDialog(result, { title: dlgTitle, okBtn }); } catch (_) {}
    }
    if (!electronMod || !electronMod.dialog || typeof electronMod.dialog.showMessageBox !== 'function') return;
    const focusedWin = electronMod.BrowserWindow && typeof electronMod.BrowserWindow.getFocusedWindow === 'function'
      ? electronMod.BrowserWindow.getFocusedWindow()
      : null;
    const showBox = (opts) => (focusedWin
      ? electronMod.dialog.showMessageBox(focusedWin, opts)
      : electronMod.dialog.showMessageBox(opts));
    try {
      if (result.status === 'disabled') {
        await showBox({
          type: 'info',
          title: dlgTitle,
          message: t('已禁用在线词库热更新', 'Cloud OTA Updates Disabled'),
          detail: t(
            '检测到环境变量 ANTIGRAVITY_I18N_NO_OTA 已启用，当前仅使用本地内置汉化词库。',
            'ANTIGRAVITY_I18N_NO_OTA is enabled; only the built-in local dictionary is active.'
          ),
          buttons: [okBtn]
        });
        return;
      }
      if (result.status === 'updated') {
        const notesLine = result.manifest && result.manifest.notes
          ? t(`\n更新说明：${result.manifest.notes}`, `\nRelease notes: ${result.manifest.notes}`)
          : '';
        await showBox({
          type: 'info',
          title: dlgTitle,
          message: t('已同步最新汉化词库', 'Localization Pack Updated'),
          detail: t(
            `版本：v${result.packVersion}（主词条 ${result.dictCount} 条，属性词条 ${result.attrCount} 条）\n当前窗口界面已实时刷新，无需重启。${notesLine}`,
            `Version: v${result.packVersion} (${result.dictCount} dict entries, ${result.attrCount} attr entries)\nApplied live without restarting.${notesLine}`
          ),
          buttons: [okBtn]
        });
        return;
      }
      if (result.status === 'up_to_date') {
        await showBox({
          type: 'info',
          title: dlgTitle,
          message: t('当前已是最新汉化词库', 'Localization Pack Is Up to Date'),
          detail: t(
            `当前词库版本：v${result.packVersion}\n引擎版本：v${builtinMeta.engineVersion}`,
            `Pack version: v${result.packVersion}\nEngine version: v${builtinMeta.engineVersion}`
          ),
          buttons: [okBtn]
        });
        return;
      }
      if (result.status === 'engine_upgrade_required') {
        const target = result.manifest.minEngineVersion || result.manifest.engineVersion;
        const resp = await showBox({
          type: 'info',
          title: dlgTitle,
          message: t(
            `发现新版汉化引擎 (v${result.manifest.engineVersion || target})`,
            `New i18n Engine Available (v${result.manifest.engineVersion || target})`
          ),
          detail: t(
            `最新云端词库需要汉化引擎 v${target} 及以上（当前本地版本为 v${builtinMeta.engineVersion}）。\n请下载最新汉化补丁并重新执行一键更新，在此之前本地现有汉化不受影响。`,
            `The latest Cloud OTA pack requires i18n engine v${target}+ (current: v${builtinMeta.engineVersion}).\nPlease download and apply the latest patch; your current localization remains active in the meantime.`
          ),
          buttons: [t('前往下载更新', 'Download Update'), t('稍后再说', 'Later')],
          defaultId: 0,
          cancelId: 1
        });
        if (resp && resp.response === 0 && result.manifest.releaseUrl && electronMod.shell && electronMod.shell.openExternal) {
          await electronMod.shell.openExternal(result.manifest.releaseUrl);
        }
        return;
      }
      await showBox({
        type: 'warning',
        title: dlgTitle,
        message: t('检查汉化更新失败', 'Failed to Check for i18n Updates'),
        detail: t(
          `无法从云端拉取词库清单，请确认网络或代理连接正常后重试。\n\n错误详情：${result.error || '未知网络错误'}`,
          `Unable to fetch the OTA manifest. Please check your network or proxy settings and try again.\n\nDetails: ${result.error || 'Unknown network error'}`
        ),
        buttons: [okBtn]
      });
    } catch (_) {}
  }

  async function runCheckInternal(opts = {}) {
    const manual = Boolean(opts.manual);
    loadCachedPackSync();

    if (isOtaDisabled()) {
      const res = { status: 'disabled', packVersion: getActiveVersion() };
      if (manual) await showManualDialog(res);
      return res;
    }

    const baseUrls = resolveBaseUrls();
    const currentMeta = getActiveMeta();
    const errors = [];

    for (let i = 0; i < baseUrls.length; i++) {
      const baseUrl = baseUrls[i];
      const cacheBust = manual ? `?t=${Date.now()}` : '';
      const manifestUrl = `${baseUrl}/manifest.json${cacheBust}`;
      const headers = {};
      if (!manual && state.etag && state.lastSource === baseUrl) {
        headers['If-None-Match'] = state.etag;
      }

      try {
        const mRes = await fetchText(manifestUrl, headers);
        if (mRes.status === 304) {
          state.lastCheckedAt = new Date().toISOString();
          saveStateSync();
          const res = { status: 'up_to_date', source: baseUrl, packVersion: getActiveVersion() };
          if (manual) await showManualDialog(res);
          return res;
        }
        if (mRes.status < 200 || mRes.status >= 300) {
          throw new Error(`HTTP ${mRes.status} for manifest`);
        }

        const manifest = JSON.parse(mRes.text);
        if (!isPlainObject(manifest) || typeof manifest.packVersion !== 'string') {
          throw new Error('Malformed manifest.json');
        }

        const schemaMismatch = typeof manifest.schemaVersion === 'number' && manifest.schemaVersion > SUPPORTED_SCHEMA_VERSION;
        const engineTooOld = Boolean(manifest.minEngineVersion && compareSemver(builtinMeta.engineVersion, manifest.minEngineVersion) < 0);
        if (schemaMismatch || engineTooOld) {
          state.lastCheckedAt = new Date().toISOString();
          saveStateSync();
          const res = { status: 'engine_upgrade_required', source: baseUrl, manifest, packVersion: getActiveVersion() };
          if (manual) {
            await showManualDialog(res);
          } else {
            notifyEngineUpgradeBackground(manifest);
          }
          return res;
        }

        if (!isNewerPack(manifest, currentMeta)) {
          if (mRes.etag) state.etag = mRes.etag;
          state.lastSource = baseUrl;
          state.lastCheckedAt = new Date().toISOString();
          saveStateSync();
          const res = { status: 'up_to_date', source: baseUrl, packVersion: getActiveVersion(), manifest };
          if (manual) await showManualDialog(res);
          return res;
        }

        const expectedSha = String(manifest.sha256 || '').trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(expectedSha)) {
          throw new Error('Missing or invalid sha256 in manifest');
        }

        const safePackFile = path.basename(String(manifest.packFile || 'dict-pack.json'));
        const packUrl = `${baseUrl}/${safePackFile}${cacheBust}`;
        const pRes = await fetchText(packUrl, {});
        if (pRes.status < 200 || pRes.status >= 300) {
          throw new Error(`HTTP ${pRes.status} for ${safePackFile}`);
        }

        const actualSha = crypto.createHash('sha256').update(pRes.text, 'utf8').digest('hex');
        if (actualSha !== expectedSha) {
          throw new Error(`SHA-256 mismatch (expected ${expectedSha.slice(0, 12)}, got ${actualSha.slice(0, 12)})`);
        }

        const parsedPack = JSON.parse(pRes.text);
        const valid = validatePackObject(parsedPack, { minDictCount, minAttrCount });
        if (!valid.ok) {
          throw new Error(`Invalid dict-pack: ${valid.reason}`);
        }
        if (parsedPack.minEngineVersion && compareSemver(builtinMeta.engineVersion, parsedPack.minEngineVersion) < 0) {
          throw new Error(`Pack requires engine >= ${parsedPack.minEngineVersion}`);
        }

        atomicWriteFileSync(packCachePath, pRes.text);
        setActivePack(parsedPack);
        state.etag = mRes.etag || '';
        state.packVersion = parsedPack.packVersion;
        state.builtAt = parsedPack.builtAt || manifest.builtAt || '';
        state.lastSource = baseUrl;
        state.lastCheckedAt = new Date().toISOString();
        saveStateSync();

        broadcastActivePack();

        const res = {
          status: 'updated',
          source: baseUrl,
          packVersion: parsedPack.packVersion,
          dictCount: valid.dictCount,
          attrCount: valid.attrCount,
          manifest
        };
        if (manual) await showManualDialog(res);
        return res;
      } catch (err) {
        errors.push(`${baseUrl}: ${err && err.message ? err.message : String(err)}`);
      }
    }

    const res = {
      status: 'error',
      packVersion: getActiveVersion(),
      error: errors.join('; ')
    };
    if (manual) await showManualDialog(res);
    return res;
  }

  function checkForUpdates(opts = {}) {
    const manual = Boolean(opts && opts.manual);
    if (inFlightCheck) {
      if (manual && !inFlightManual) {
        inFlightManual = true;
        return inFlightCheck.then((res) => showManualDialog(res).then(() => res)).finally(() => {
          inFlightManual = false;
        });
      }
      return inFlightCheck;
    }
    inFlightManual = manual;
    inFlightCheck = runCheckInternal(opts).finally(() => {
      inFlightCheck = null;
      inFlightManual = false;
    });
    return inFlightCheck;
  }

  function startBackgroundSync() {
    loadCachedPackSync();
    if (backgroundStarted || isOtaDisabled()) return;
    backgroundStarted = true;
    initialTimer = setTimeout(() => {
      initialTimer = null;
      checkForUpdates({ manual: false }).catch(() => {});
    }, initialDelayMs);
    if (initialTimer && typeof initialTimer.unref === 'function') initialTimer.unref();

    pollTimer = setInterval(() => {
      checkForUpdates({ manual: false }).catch(() => {});
    }, pollIntervalMs);
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  function stopBackgroundSync() {
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    flushMtCacheSync();
    backgroundStarted = false;
  }

  return {
    SUPPORTED_SCHEMA_VERSION,
    builtinMeta,
    cacheDir,
    loadCachedPackSync,
    getActiveVersion,
    getApplyScript,
    getNativeContextDict,
    registerWebContents,
    applyCachedPackToWebContents,
    applyCachedPackToFrame,
    checkForUpdates,
    startBackgroundSync,
    stopBackgroundSync,
    flushMtCacheSync,
    isI18nEnabled,
    setI18nEnabled,
    toggleI18nEnabled,
    onLanguageChange,
    isAutoMtEnabled,
    setAutoMtEnabled,
    toggleAutoMtEnabled,
    onAutoMtChange,
    translateDynamicText,
    getInitialStateScript,
    t
  };
}

let defaultController = null;
function getDefaultController() {
  if (!defaultController) {
    defaultController = createOtaController();
  }
  return defaultController;
}

module.exports = {
  SUPPORTED_SCHEMA_VERSION,
  DEFAULT_BASE_URLS,
  DEFAULT_MT_URL,
  compareSemver,
  isNewerPack,
  validatePackObject,
  normalizeMtText,
  isEligibleMtText,
  protectDynamicMtTerms,
  restoreDynamicMtTerms,
  parseGoogleGtxResponse,
  parseOpenAiMtResponse,
  createOtaController,
  getDefaultController,
  registerWebContents: (wc) => getDefaultController().registerWebContents(wc),
  applyCachedPackToWebContents: (wc) => getDefaultController().applyCachedPackToWebContents(wc),
  applyCachedPackToFrame: (frame) => getDefaultController().applyCachedPackToFrame(frame),
  getNativeContextDict: () => getDefaultController().getNativeContextDict(),
  checkForUpdates: (opts) => getDefaultController().checkForUpdates(opts),
  startBackgroundSync: () => getDefaultController().startBackgroundSync(),
  isI18nEnabled: () => getDefaultController().isI18nEnabled(),
  setI18nEnabled: (enabled) => getDefaultController().setI18nEnabled(enabled),
  toggleI18nEnabled: () => getDefaultController().toggleI18nEnabled(),
  onLanguageChange: (fn) => getDefaultController().onLanguageChange(fn),
  isAutoMtEnabled: () => getDefaultController().isAutoMtEnabled(),
  setAutoMtEnabled: (enabled) => getDefaultController().setAutoMtEnabled(enabled),
  toggleAutoMtEnabled: () => getDefaultController().toggleAutoMtEnabled(),
  onAutoMtChange: (fn) => getDefaultController().onAutoMtChange(fn),
  translateDynamicText: (text) => getDefaultController().translateDynamicText(text),
  getInitialStateScript: () => getDefaultController().getInitialStateScript(),
  t: (zh, en) => getDefaultController().t(zh, en)
};
