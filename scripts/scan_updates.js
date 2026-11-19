const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const asar = require('@electron/asar');
const { createDynamicRules } = require('./engine/dynamic_rules');

const projectRoot = path.resolve(__dirname, '..');
const assetsDir = path.join(projectRoot, 'assets');
const baselineDir = path.join(assetsDir, 'baseline');
const buildDir = path.join(projectRoot, 'build');
const defaultInstallDir = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'resources')
  : path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'antigravity', 'resources');
const installDir = process.env.ANTIGRAVITY_RESOURCES || defaultInstallDir;

const args = process.argv.slice(2);
const forceRefresh = args.includes('--refresh');

function getInstalledVersion() {
  const bakAsar = path.join(installDir, 'app.asar.bak');
  const activeAsar = path.join(installDir, 'app.asar');
  const target = fs.existsSync(bakAsar) ? bakAsar : activeAsar;
  if (!fs.existsSync(target)) return { version: 'unknown', asarPath: null };
  try {
    const pkg = JSON.parse(asar.extractFile(target, 'package.json').toString('utf8'));
    return { version: pkg.version || 'unknown', asarPath: target };
  } catch (_) {
    return { version: 'unknown', asarPath: target };
  }
}

function refreshBaselineFromCache(installedVersion) {
  const cacheDir = path.join(process.env.APPDATA || '', 'Antigravity', 'Cache', 'Cache_Data');
  if (!fs.existsSync(cacheDir)) {
    console.log('[Scan] 未找到 Chromium Cache_Data 目录，继续使用当前 assets/baseline/bundle_main.js');
    return false;
  }

  const candidates = fs.readdirSync(cacheDir)
    .filter((f) => f.startsWith('f_'))
    .map((f) => {
      const full = path.join(cacheDir, f);
      const st = fs.statSync(full);
      return { f, full, size: st.size, mtimeMs: st.mtimeMs };
    })
    .filter((x) => x.size > 1500000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const item of candidates) {
    const buf = fs.readFileSync(item.full);
    if (buf[0] !== 0x1f || buf[1] !== 0x8b) continue;
    try {
      const decoded = zlib.gunzipSync(buf).toString('utf8');
      if (decoded.length > 4000000 && decoded.includes('Closure Library') && decoded.includes('group-by-submenu-trigger')) {
        fs.mkdirSync(baselineDir, { recursive: true });
        const outBundle = path.join(baselineDir, 'bundle_main.js');
        fs.writeFileSync(outBundle, decoded, 'utf8');
        fs.writeFileSync(path.join(baselineDir, 'version.json'), JSON.stringify({
          version: installedVersion,
          bundleSize: Buffer.byteLength(decoded, 'utf8'),
          extractedAt: new Date().toISOString(),
          source: `Cache_Data/${item.f}`
        }, null, 2) + '\n', 'utf8');
        console.log(`[Scan] 已从 Cache_Data/${item.f} 刷新 v${installedVersion} 前端基线 (${(decoded.length / 1048576).toFixed(2)} MB)`);
        return true;
      }
    } catch (_) {}
  }
  console.log('[Scan] Cache_Data 中未匹配到新的 renderer bundle，保留现有 baseline。');
  return false;
}

function normalizeKey(s) {
  return String(s)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createMatcher() {
  const dict = JSON.parse(fs.readFileSync(path.join(assetsDir, 'dictionary.json'), 'utf8'));
  const attrDict = JSON.parse(fs.readFileSync(path.join(assetsDir, 'attr_dict.json'), 'utf8'));
  const preserveList = JSON.parse(fs.readFileSync(path.join(assetsDir, 'preserve_list.json'), 'utf8'));
  const preserveSet = new Set(preserveList);

  const lowerExact = new Map();
  const normExact = new Map();
  for (const [k, v] of Object.entries(dict)) {
    lowerExact.set(k.toLowerCase().trim(), v);
    const nk = normalizeKey(k);
    if (nk) normExact.set(nk.toLowerCase(), v);
  }
  for (const [k, v] of Object.entries(attrDict)) {
    const nk = normalizeKey(k);
    if (nk && !normExact.has(nk.toLowerCase())) normExact.set(nk.toLowerCase(), v);
  }

  function lookupExact(trimmed, norm) {
    if (Object.prototype.hasOwnProperty.call(dict, trimmed)) return dict[trimmed];
    if (Object.prototype.hasOwnProperty.call(attrDict, trimmed)) return attrDict[trimmed];
    const l = trimmed.toLowerCase();
    if (lowerExact.has(l)) return lowerExact.get(l);
    if (norm && normExact.has(norm.toLowerCase())) return normExact.get(norm.toLowerCase());
    return null;
  }

  const { DYNAMIC_RULES } = createDynamicRules({ normalizeKey, lookupExact });

  return function isCovered(raw) {
    const norm = normalizeKey(raw);
    if (!norm) return true;
    if (preserveSet.has(raw) || preserveSet.has(norm)) return true;
    if (lookupExact(raw, norm)) return true;
    for (const [re, rep] of DYNAMIC_RULES) {
      if (re.test(norm) && norm.replace(re, rep) !== norm) return true;
    }
    if (norm.endsWith('...') || norm.endsWith('.') || norm.endsWith(':')) {
      const stem = norm.replace(/(?:\.\.\.|[.:])$/, '').trim();
      if (stem && lookupExact(stem, stem)) return true;
    }
    return false;
  };
}

function isLikelyUiText(s) {
  if (!s || s.length < 2 || s.length > 180) return false;
  if (!/[A-Za-z]{2,}/.test(s)) return false;
  if (/^(?:https?:\/\/|mailto:|plugin:|vscode-|data:|file:\/\/|\/[a-z0-9_./-]+|\.[a-z0-9-]+|#)/i.test(s)) return false;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(s)) return false; // testids & css tokens
  if (/^[a-z]+(?:[A-Z][a-z0-9]+)+$/.test(s)) return false; // camelCase
  if (/^[A-Z0-9_]{3,}$/.test(s)) return false; // ENUM_CONSTANTS
  if (/^[a-z0-9_]+\.[a-z0-9_.]+$/i.test(s)) return false; // dotted keys like jetski.onboarding...
  if (/(?:^|\s)(?:text-|bg-|border-|flex-|grid-|px-|py-|pl-|pr-|pt-|pb-|gap-|rounded-|items-|justify-|overflow-|w-\[|h-\[|max-h-|min-h-|max-w-|min-w-|h-\d|w-\d|aria-|group-|can-hover:|starting:|motion-reduce:|duration-|ease-|transition-|shadow-|focus-|hover:|active:|disabled:|dark:|block |inline-flex |relative |absolute |whitespace-|select-none|pointer-events-|shrink-0|truncate)/.test(s)) return false;
  if (/(?:\)\s*return\b|===\s*|!==\s*|==\s*!=|[{}();]|=>)/.test(s)) return false;
  if (/\\n|\\t/.test(s)) return false;
  // Require either space/punctuation or Title Case word
  return /\s/.test(s) || /^[A-Z][a-z]{2,}/.test(s);
}

function scanRendererBundle() {
  const bundlePath = path.join(baselineDir, 'bundle_main.js');
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`未找到基线文件: ${bundlePath}`);
  }
  const src = fs.readFileSync(bundlePath, 'utf8');
  const isCovered = createMatcher();

  const patterns = [
    { kind: 'uiProp', re: /\b(?:title|label|placeholder|aria-label|tooltip|tooltipText|header|description|subtitle|emptyText|buttonText|confirmLabel|cancelLabel|heading|message)\s*:\s*"([^"\\]{2,180})"/g },
    { kind: 'quotedProp', re: /"(?:aria-label|placeholder|title|data-tooltip-content)"\s*:\s*"([^"\\]{2,180})"/g },
    { kind: 'jsxChild', re: /createElement\([A-Za-z0-9_.$"]+,[^,]{1,400}(?:,\s*[A-Za-z0-9_.$()+?:"\s]{0,60})*,\s*"([^"\\]{2,180})"\)/g },
    { kind: 'jsxMultiArg', re: /createElement\([^)]{1,400},\s*"([A-Z][^"\\]{1,180})"/g },
    { kind: 'ternaryLabel', re: /\?\s*"([A-Z][^"\\]{1,120})"\s*:\s*"([A-Z][^"\\]{1,120})"/g }
  ];

  const found = new Map();
  for (const { kind, re } of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) {
      const vals = kind === 'ternaryLabel' ? [m[1], m[2]] : [m[1]];
      for (const v of vals) {
        if (!isLikelyUiText(v)) continue;
        if (isCovered(v)) continue;
        const entry = found.get(v) || { text: v, hits: 0, kinds: new Set() };
        entry.hits += 1;
        entry.kinds.add(kind);
        found.set(v, entry);
      }
    }
  }

  return [...found.values()]
    .map((x) => ({ text: x.text, hits: x.hits, kinds: [...x.kinds] }))
    .sort((a, b) => b.hits - a.hits || a.text.localeCompare(b.text));
}

function main() {
  const { version } = getInstalledVersion();
  const verFile = path.join(baselineDir, 'version.json');
  const baselineInfo = fs.existsSync(verFile) ? JSON.parse(fs.readFileSync(verFile, 'utf8')) : { version: 'none' };

  console.log(`[Scan] 安装版 Antigravity 版本: v${version} | 当前基线: v${baselineInfo.version}`);
  if (forceRefresh || (version !== 'unknown' && baselineInfo.version !== version)) {
    refreshBaselineFromCache(version);
  }

  const untranslated = scanRendererBundle();
  fs.mkdirSync(buildDir, { recursive: true });
  const reportPath = path.join(buildDir, 'untranslated_scan_report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    scannedVersion: version,
    scannedAt: new Date().toISOString(),
    candidateCount: untranslated.length,
    candidates: untranslated
  }, null, 2) + '\n', 'utf8');

  console.log(`[Scan] 扫描完成！共发现 ${untranslated.length} 条未覆盖候选 UI 字符串，完整报告已保存至:\n       ${reportPath}`);
  console.log('\n=== 高频候选（前 40 条）===');
  for (const item of untranslated.slice(0, 40)) {
    console.log(`  [${item.hits}x | ${item.kinds.join(',')}] ${JSON.stringify(item.text)}`);
  }
}

main();
