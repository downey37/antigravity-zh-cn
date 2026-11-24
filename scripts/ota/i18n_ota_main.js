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

function nodeHttpFetchText(urlStr, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      return reject(err);
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      parsed,
      {
        method: 'GET',
        headers: {
          'Accept-Encoding': 'identity',
          'User-Agent': 'antigravity-zh-cn-ota/1',
          ...(headers || {})
        },
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (!headers || !headers._redirectDepth || headers._redirectDepth < 3)) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsed).toString();
          const nextHeaders = { ...(headers || {}), _redirectDepth: ((headers && headers._redirectDepth) || 0) + 1 };
          return nodeHttpFetchText(nextUrl, nextHeaders, timeoutMs).then(resolve, reject);
        }
        const chunks = [];
        let total = 0;
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

  const cacheDir = resolveCacheDir();
  const packCachePath = path.join(cacheDir, 'dict-pack.json');
  const stateCachePath = path.join(cacheDir, 'state.json');

  let state = {
    etag: '',
    packVersion: '',
    builtAt: '',
    lastCheckedAt: '',
    lastSource: '',
    notifiedEngineVersion: ''
  };
  let activePack = null;
  let activeApplyScript = null;
  let activeNativeContextDict = null;
  let initializedCache = false;
  let backgroundStarted = false;
  let initialTimer = null;
  let pollTimer = null;
  let inFlightCheck = null;
  let inFlightManual = false;
  const trackedWebContents = new Set();

  function loadStateSync() {
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

  async function defaultFetchText(urlStr, reqHeaders) {
    const netFetch = electronMod && electronMod.net && typeof electronMod.net.fetch === 'function'
      ? electronMod.net.fetch.bind(electronMod.net)
      : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);

    if (netFetch && typeof AbortController !== 'undefined') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await netFetch(urlStr, {
          method: 'GET',
          headers: reqHeaders || {},
          signal: controller.signal
        });
        const status = res.status;
        const etag = res.headers && typeof res.headers.get === 'function' ? (res.headers.get('etag') || '') : '';
        if (status === 304) {
          return { status: 304, etag, text: '' };
        }
        const text = await res.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_PACK_BYTES) {
          throw new Error('Response exceeds max allowed size');
        }
        return { status, etag, text };
      } finally {
        clearTimeout(timer);
      }
    }
    return nodeHttpFetchText(urlStr, reqHeaders, timeoutMs);
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
        const n = new electronMod.Notification({
          title: 'Antigravity 汉化引擎有新版本',
          body: `最新云端词库需要汉化引擎 v${manifest.minEngineVersion} 及以上（当前 v${builtinMeta.engineVersion}），点击左上角“Antigravity → 检查汉化更新”或托盘菜单“检查汉化更新”可前往更新。`
        });
        n.show();
      }
    } catch (_) {}
  }

  async function showManualDialog(result) {
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
          title: '检查汉化更新',
          message: '已禁用在线词库热更新',
          detail: '检测到环境变量 ANTIGRAVITY_I18N_NO_OTA 已启用，当前仅使用本地内置汉化词库。',
          buttons: ['确定']
        });
        return;
      }
      if (result.status === 'updated') {
        const notesLine = result.manifest && result.manifest.notes ? `\n更新说明：${result.manifest.notes}` : '';
        await showBox({
          type: 'info',
          title: '检查汉化更新',
          message: '已同步最新汉化词库',
          detail: `版本：v${result.packVersion}（主词条 ${result.dictCount} 条，属性词条 ${result.attrCount} 条）\n当前窗口界面已实时刷新，无需重启。${notesLine}`,
          buttons: ['确定']
        });
        return;
      }
      if (result.status === 'up_to_date') {
        await showBox({
          type: 'info',
          title: '检查汉化更新',
          message: '当前已是最新汉化词库',
          detail: `当前词库版本：v${result.packVersion}\n引擎版本：v${builtinMeta.engineVersion}`,
          buttons: ['确定']
        });
        return;
      }
      if (result.status === 'engine_upgrade_required') {
        const target = result.manifest.minEngineVersion || result.manifest.engineVersion;
        const resp = await showBox({
          type: 'info',
          title: '检查汉化更新',
          message: `发现新版汉化引擎 (v${result.manifest.engineVersion || target})`,
          detail: `最新云端词库需要汉化引擎 v${target} 及以上（当前本地版本为 v${builtinMeta.engineVersion}）。\n请下载最新汉化补丁并重新执行一键更新，在此之前本地现有汉化不受影响。`,
          buttons: ['前往下载更新', '稍后再说'],
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
        title: '检查汉化更新',
        message: '检查汉化更新失败',
        detail: `无法从云端拉取词库清单，请确认网络或代理连接正常后重试。\n\n错误详情：${result.error || '未知网络错误'}`,
        buttons: ['确定']
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
    stopBackgroundSync
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
  compareSemver,
  isNewerPack,
  validatePackObject,
  createOtaController,
  getDefaultController,
  registerWebContents: (wc) => getDefaultController().registerWebContents(wc),
  applyCachedPackToWebContents: (wc) => getDefaultController().applyCachedPackToWebContents(wc),
  applyCachedPackToFrame: (frame) => getDefaultController().applyCachedPackToFrame(frame),
  getNativeContextDict: () => getDefaultController().getNativeContextDict(),
  checkForUpdates: (opts) => getDefaultController().checkForUpdates(opts),
  startBackgroundSync: () => getDefaultController().startBackgroundSync()
};
