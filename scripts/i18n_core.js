process.noAsar = true;

const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const { resolveInstallPaths, resignMacAppIfNeeded } = require('./runtime_paths');

const resolvedPaths = resolveInstallPaths();
const installDir = resolvedPaths.installDir;
const asarPath = resolvedPaths.asarPath;
const appBundle = resolvedPaths.appBundle;
const projectRoot = path.resolve(__dirname, '..');
const buildDir = path.join(projectRoot, 'build');

function readPatchMeta() {
  let patchVersion = 'unknown';
  let baselineVersion = 'unknown';
  try {
    patchVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version || 'unknown';
  } catch (_) {}
  try {
    baselineVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, 'assets', 'baseline', 'version.json'), 'utf8')).version || 'unknown';
  } catch (_) {}
  return { patchVersion, baselineVersion };
}

function hasAnyPatchArtifacts(targetAsar = asarPath) {
  if (!fs.existsSync(targetAsar)) return false;
  try {
    try { asar.uncache(targetAsar); } catch (_) {}
    try {
      if (asar.statFile(targetAsar, path.join('dist', 'i18n.js'))) return true;
    } catch (_) {}
    try {
      if (asar.extractFile(targetAsar, path.join('dist', 'menu.js')).includes('translateMenuRecursively')) return true;
    } catch (_) {}
    try {
      if (asar.extractFile(targetAsar, path.join('dist', 'utils.js')).includes('_getAntigravityI18nCode')) return true;
    } catch (_) {}
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * 极速检测 app.asar 是否处于已完整注入汉化状态
 */
function isAsarPatched(targetAsar = asarPath) {
  if (!fs.existsSync(targetAsar)) return false;
  try {
    try { asar.uncache(targetAsar); } catch (_) {}
    const i18nStat = asar.statFile(targetAsar, path.join('dist', 'i18n.js'));
    if (!i18nStat) return false;
    const otaStat = asar.statFile(targetAsar, path.join('dist', 'i18n_ota.js'));
    if (!otaStat) return false;
    const menuBuf = asar.extractFile(targetAsar, path.join('dist', 'menu.js'));
    if (
      !menuBuf.includes('translateMenuRecursively') ||
      !menuBuf.includes('antigravity-i18n-check-update') ||
      !menuBuf.includes('antigravity-i18n-toggle-lang') ||
      !menuBuf.includes('antigravity-i18n-toggle-auto-mt')
    ) return false;
    const utilsBuf = asar.extractFile(targetAsar, path.join('dist', 'utils.js'));
    if (
      !utilsBuf.includes('__antigravityTranslateAll') ||
      !utilsBuf.includes('did-frame-finish-load') ||
      !utilsBuf.includes('did-navigate-in-page') ||
      !utilsBuf.includes('_getAntigravityI18nOta') ||
      !utilsBuf.includes('getInitialStateScript')
    ) return false;
    const updaterBuf = asar.extractFile(targetAsar, path.join('dist', 'updater.js'));
    if (!updaterBuf.includes('spawnAutoPatcherOnUpdate') || !updaterBuf.includes('_I18N_UPDATE_STEPS')) return false;
    const mainBuf = asar.extractFile(targetAsar, path.join('dist', 'main.js'));
    if (!mainBuf.includes('function _i18nT(') || !mainBuf.includes('antigravity-i18n-toggle-lang')) return false;
    const i18nBuf = asar.extractFile(targetAsar, path.join('dist', 'i18n.js'));
    return i18nBuf.includes('antigravity-i18n-titlebar-toggle') && i18nBuf.includes('__antigravitySetAutoMtEnabled');
  } catch (_) {
    return false;
  }
}

function injectI18nTHelper(code, relOtaPath = './i18n_ota') {
  if (code.includes('function _i18nT(')) return code;
  const helper = `\nfunction _i18nT(zh, en) { try { const ota = require(${JSON.stringify(relOtaPath)}); return !ota || typeof ota.isI18nEnabled !== 'function' || ota.isI18nEnabled() ? zh : en; } catch (_) { return zh; } }\n`;
  if (code.startsWith('"use strict";') || code.startsWith("'use strict';")) {
    return code.replace(/^(['"])use strict\1;/, `$&${helper}`);
  }
  return `${helper}${code}`;
}

function patchFile(baseDir, relPath, transform) {
  const filePath = path.join(baseDir, relPath);
  if (!fs.existsSync(filePath)) return false;
  const orig = fs.readFileSync(filePath, 'utf8');
  const next = transform(orig);
  if (typeof next === 'string' && next !== orig) {
    fs.writeFileSync(filePath, next, 'utf8');
    return true;
  }
  return false;
}

function applyPairs(code, pairs) {
  let next = code;
  for (const [pattern, replacement] of pairs) {
    next = next.replace(pattern, replacement);
  }
  return next;
}

function detectUnpackedDirs(targetAsar) {
  const dirs = new Set();
  try {
    for (const rawEntry of asar.listPackage(targetAsar)) {
      const clean = rawEntry.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!clean) continue;
      try {
        const st = asar.statFile(targetAsar, path.normalize(clean), false);
        if (st && st.unpacked && !st.files) {
          const parts = clean.split('/');
          if (parts[0] === 'node_modules' && parts.length >= 2) {
            dirs.add(parts[1].startsWith('@') && parts.length >= 3 ? `node_modules/${parts[1]}/${parts[2]}` : `node_modules/${parts[1]}`);
          } else {
            dirs.add(parts[0]);
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  if (dirs.size === 0) {
    dirs.add('node_modules/chrome-devtools-mcp');
  }
  return [...dirs];
}

function deployAsarSafely(srcPath, destPath, platform = process.platform) {
  const tmpDest = `${destPath}.tmp.${process.pid}`;
  try {
    fs.copyFileSync(srcPath, tmpDest);
    fs.renameSync(tmpDest, destPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
    } catch (_) {}
    const code = err && err.code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      const hint = platform === 'win32'
        ? '请先在 Antigravity 窗口内按 Ctrl + Q（或右键系统托盘图标 -> 退出）彻底关闭客户端后重试。'
        : '请先完全退出 Antigravity 客户端（Cmd + Q），若安装目录需要管理员权限请使用 sudo 重新运行。';
      throw new Error(`无法写入 ${destPath} (${code})。${hint}`);
    }
    throw err;
  }
}

/**
 * 纯内联、零外部进程、极速自动注入汉化补丁
 */
async function patchAsar() {
  const startTime = Date.now();
  const { patchVersion, baselineVersion } = readPatchMeta();
  console.log('==========================================');
  console.log(`  Antigravity 简体中文补丁 v${patchVersion} (适配基线 v${baselineVersion})`);
  console.log('==========================================');

  if (!fs.existsSync(asarPath)) {
    throw new Error(`未找到目标 app.asar: ${asarPath}`);
  }

  fs.mkdirSync(buildDir, { recursive: true });
  const tempDir = path.join(buildDir, '.temp-patch-dir');
  const buildUnpackedDir = path.join(buildDir, 'app.asar.unpacked');
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  try {
  const backupAsar = resolvedPaths.backupAsar;
  let sourceAsar = asarPath;
  let currentVersion = 'unknown';
  try {
    currentVersion = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8')).version || 'unknown';
  } catch (_) {}

  if (currentVersion !== 'unknown' && baselineVersion !== 'unknown' && currentVersion !== baselineVersion) {
    console.log(`[提示] 当前安装的 Antigravity 为 v${currentVersion}，本补丁适配基线为 v${baselineVersion}；若发现少量新增英文，可运行 npm run scan 扫漏跟版。`);
  }

  const hasPatchedFiles = hasAnyPatchArtifacts(asarPath);
  if (hasPatchedFiles && fs.existsSync(backupAsar) && !hasAnyPatchArtifacts(backupAsar)) {
    try {
      const bakVersion = JSON.parse(asar.extractFile(backupAsar, 'package.json').toString('utf8')).version || 'unknown';
      if (bakVersion === currentVersion) {
        sourceAsar = backupAsar;
        console.log(` - 检测到同版本干净备份 (${backupAsar})，将从原版重新生成纯净补丁`);
      }
    } catch (_) {}
  } else if (!hasPatchedFiles) {
    try {
      fs.copyFileSync(asarPath, backupAsar);
      console.log(' - 已备份官方原版至 app.asar.bak');
    } catch (_) {}
  }

  console.log('[1/4] 正在解包官方客户端核心...');
  asar.extractAll(asarPath, tempDir);
  if (sourceAsar === backupAsar) {
    const oldI18n = path.join(tempDir, 'dist', 'i18n.js');
    if (fs.existsSync(oldI18n)) fs.unlinkSync(oldI18n);
    for (const rawEntry of asar.listPackage(backupAsar)) {
      const posixRel = rawEntry.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!posixRel.startsWith('dist/')) continue;
      const asarRel = path.normalize(posixRel);
      try {
        const st = asar.statFile(backupAsar, asarRel, false);
        if (st && !st.files && !st.unpacked) {
          const dest = path.join(tempDir, asarRel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, asar.extractFile(backupAsar, asarRel));
        }
      } catch (_) {}
    }
  }

  let version = currentVersion;
  const pkgPath = path.join(tempDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || version;
    } catch (_) {}
  }
  console.log(` - 核心版本: v${version}`);

  console.log('[2/4] 正在动态植入核心钩子...');

  // 1. 注入 utils.js (模块级缓存 + DOM-ready 零延迟引擎加载 + OTA 词库热同步 + 会话内中英切换 + 内部/插件 subframe 注入)
  patchFile(tempDir, 'dist/utils.js', (code) => {
    if (
      code.includes('did-frame-finish-load') &&
      code.includes('did-navigate-in-page') &&
      code.includes('__antigravityTranslateAll') &&
      code.includes('_getAntigravityI18nCode') &&
      code.includes('_getAntigravityI18nOta') &&
      code.includes('getInitialStateScript') &&
      code.indexOf('function _getAntigravityI18nCode') < code.indexOf('function createWindow')
    ) {
      return code;
    }
    const moduleCacheHelper = `
let _cachedAntigravityI18nCode = null;
function _getAntigravityI18nCode() {
    if (_cachedAntigravityI18nCode === null) {
        const i18nPath = path_1.default.join(__dirname, 'i18n.js');
        if (fs.existsSync(i18nPath)) {
            _cachedAntigravityI18nCode = fs.readFileSync(i18nPath, 'utf8');
        }
    }
    return _cachedAntigravityI18nCode;
}
let _cachedAntigravityI18nOta = undefined;
function _getAntigravityI18nOta() {
    if (_cachedAntigravityI18nOta === undefined) {
        try {
            _cachedAntigravityI18nOta = require('./i18n_ota');
        } catch (_) {
            _cachedAntigravityI18nOta = null;
        }
    }
    return _cachedAntigravityI18nOta;
}
`;
    const hook = `
    const _i18nWc = typeof hubContents !== 'undefined' ? hubContents : win.webContents;
    if (_i18nWc) {
        const _i18nOta = _getAntigravityI18nOta();
        if (_i18nOta) {
            _i18nOta.registerWebContents(_i18nWc);
            _i18nOta.startBackgroundSync();
        }
        _i18nWc.on('dom-ready', () => {
            if (_i18nWc.isDestroyed && _i18nWc.isDestroyed()) return;
            const code = _getAntigravityI18nCode();
            if (code) {
                const ota = _getAntigravityI18nOta();
                const initFlag = ota && typeof ota.getInitialStateScript === 'function' ? ota.getInitialStateScript() : '';
                _i18nWc.executeJavaScript(initFlag ? \`\${initFlag}\\n\${code}\` : code)
                    .then(() => {
                        const otaNow = _getAntigravityI18nOta();
                        if (otaNow) otaNow.applyCachedPackToWebContents(_i18nWc);
                    })
                    .catch(console.error);
            }
        });
        _i18nWc.on('did-finish-load', () => {
            if (_i18nWc.isDestroyed && _i18nWc.isDestroyed()) return;
            const ota = _getAntigravityI18nOta();
            const enabledFlag = ota && typeof ota.isI18nEnabled === 'function' ? ota.isI18nEnabled() : true;
            _i18nWc.executeJavaScript(\`
                if (window.__antigravitySetI18nEnabled) {
                    window.__antigravitySetI18nEnabled(\${enabledFlag ? 'true' : 'false'});
                    \${enabledFlag ? 'if (window.__antigravityTranslateAll) window.__antigravityTranslateAll();' : ''}
                    { ran: true, packVersion: window.__ANTIGRAVITY_I18N_PACK_VERSION__ || '' };
                } else if (window.__antigravityTranslateAll) {
                    window.__antigravityTranslateAll();
                    { ran: true, packVersion: window.__ANTIGRAVITY_I18N_PACK_VERSION__ || '' };
                } else {
                    { ran: false, packVersion: '' };
                }
            \`).then((res) => {
                if ((!res || !res.ran) && !(_i18nWc.isDestroyed && _i18nWc.isDestroyed())) {
                    const code = _getAntigravityI18nCode();
                    if (code) {
                        const otaNow = _getAntigravityI18nOta();
                        const initFlag = otaNow && typeof otaNow.getInitialStateScript === 'function' ? otaNow.getInitialStateScript() : '';
                        return _i18nWc.executeJavaScript(initFlag ? \`\${initFlag}\\n\${code}\` : code).then(() => {
                            const otaAfter = _getAntigravityI18nOta();
                            if (otaAfter) otaAfter.applyCachedPackToWebContents(_i18nWc);
                        });
                    }
                } else if (res && res.ran) {
                    const otaAfter = _getAntigravityI18nOta();
                    const activeVer = otaAfter && typeof otaAfter.getActiveVersion === 'function' ? otaAfter.getActiveVersion() : '';
                    if (otaAfter && (!activeVer || res.packVersion !== activeVer)) {
                        otaAfter.applyCachedPackToWebContents(_i18nWc);
                    }
                }
            }).catch(console.error);
        });
        _i18nWc.on('did-navigate-in-page', () => {
            if (_i18nWc.isDestroyed && _i18nWc.isDestroyed()) return;
            const ota = _getAntigravityI18nOta();
            const enabledFlag = ota && typeof ota.isI18nEnabled === 'function' ? ota.isI18nEnabled() : true;
            if (!enabledFlag) return;
            _i18nWc.executeJavaScript(\`
                if (window.__antigravityTranslateAll) {
                    window.__antigravityTranslateAll();
                    setTimeout(() => {
                        if (window.__antigravityIsI18nEnabled && window.__antigravityIsI18nEnabled() && window.__antigravityTranslateAll) {
                            window.__antigravityTranslateAll();
                        }
                    }, 320);
                }
            \`).catch(() => {});
        });
        _i18nWc.on('did-frame-finish-load', (_event, isMainFrame, frameProcessId, frameRoutingId) => {
            if (isMainFrame || (_i18nWc.isDestroyed && _i18nWc.isDestroyed())) return;
            try {
                const { webFrameMain } = require('electron');
                const frame = webFrameMain && webFrameMain.fromId(frameProcessId, frameRoutingId);
                const frameUrl = frame && frame.url ? frame.url : '';
                let mainOrigin = '';
                let frameOrigin = '';
                try { mainOrigin = new URL(_i18nWc.getURL()).origin; } catch (_) {}
                try { frameOrigin = new URL(frameUrl).origin; } catch (_) {}
                if (
                    frameUrl.startsWith('plugin://') ||
                    frameUrl.startsWith('vscode-webview://') ||
                    (mainOrigin && mainOrigin !== 'null' && frameOrigin === mainOrigin)
                ) {
                    const i18nCode = _getAntigravityI18nCode();
                    if (i18nCode) {
                        const ota = _getAntigravityI18nOta();
                        const initFlag = ota && typeof ota.getInitialStateScript === 'function' ? ota.getInitialStateScript() : '';
                        frame.executeJavaScript(initFlag ? \`\${initFlag}\\n\${i18nCode}\` : i18nCode)
                            .then(() => {
                                const otaNow = _getAntigravityI18nOta();
                                if (otaNow) otaNow.applyCachedPackToFrame(frame);
                            })
                            .catch(() => {});
                    }
                }
            } catch (_) {}
        });
    }`;
    let next = code;
    if (!next.includes('function _getAntigravityI18nCode')) {
      next = next.replace(
        /(const\s+fs\s*=\s*__importStar\(require\("fs"\)\);)/,
        `$1\n${moduleCacheHelper}`
      );
    }
    const hubLoadRe = /void\s+loadHubWindowUrl\(win,\s*url(?:,\s*\{[^}]*\})?\);/;
    if (hubLoadRe.test(next)) {
      return next.replace(hubLoadRe, (matched) => `${hook}\n    ${matched}`);
    }
    return next.replace(/void\s+win\.loadURL\(url\);/, (matched) => `${hook}\n    ${matched}`);
  });
  const utilsPatched = fs.readFileSync(path.join(tempDir, 'dist', 'utils.js'), 'utf8');
  if (
    utilsPatched.includes('__antigravityTranslateAll') &&
    utilsPatched.includes('did-frame-finish-load') &&
    utilsPatched.includes('did-navigate-in-page') &&
    utilsPatched.includes('_getAntigravityI18nOta') &&
    utilsPatched.includes('getInitialStateScript')
  ) {
    console.log(' - utils.js 零延迟引擎、OTA 热同步与插件框架注入完成');
  } else {
    console.warn(' [警告] utils.js 注入钩子未命中，请检查官方代码是否变更！');
  }

  // 2. 注入 menu.js (系统菜单栏递归中英切换 + 异步 WSL 菜单兼容 + OTA 手动检查入口 + 临时切换语言入口)
  if (patchFile(tempDir, 'dist/menu.js', (code) => {
    const otaMenuItemCode = `
    addItemToSubmenu(menu, 'Help', 1, new electron_1.MenuItem({
        id: 'antigravity-i18n-check-update',
        label: _isMenuI18nEnabled() ? '检查汉化更新' : 'Check i18n Updates',
        click: async () => {
            try {
                const ota = require('./i18n_ota');
                await ota.checkForUpdates({ manual: true });
            } catch (err) {
                console.error('[Antigravity-i18n] 手动检查汉化更新失败:', err);
            }
        },
    }));
    addItemToSubmenu(menu, 'Help', 2, new electron_1.MenuItem({
        id: 'antigravity-i18n-toggle-lang',
        label: _isMenuI18nEnabled() ? '切换为英文原文 (关闭汉化)' : '切换为简体中文 (开启汉化)',
        click: () => {
            try {
                require('./i18n_ota').toggleI18nEnabled();
            } catch (err) {
                console.error('[Antigravity-i18n] 切换显示语言失败:', err);
            }
        },
    }));
    addItemToSubmenu(menu, 'Help', 3, new electron_1.MenuItem({
        id: 'antigravity-i18n-toggle-auto-mt',
        type: 'checkbox',
        checked: _isMenuAutoMtEnabled(),
        label: _isMenuI18nEnabled() ? '自动翻译动态公告' : 'Auto-Translate Announcements',
        click: () => {
            try {
                require('./i18n_ota').toggleAutoMtEnabled();
            } catch (err) {
                console.error('[Antigravity-i18n] 切换自动翻译动态公告失败:', err);
            }
        },
    }));`;
    const menuHook = `
const MENU_I18N = {
    'File': '文件', 'Edit': '编辑', 'View': '视图', 'Window': '窗口', 'Help': '帮助',
    'New Window': '新建窗口', 'Close Window': '关闭窗口', 'Undo': '撤销', 'Redo': '重做',
    'Cut': '剪切', 'Copy': '复制', 'Paste': '粘贴', 'Paste and Match Style': '粘贴并匹配样式',
    'Delete': '删除', 'Select All': '全选', 'Reload': '重新加载', 'Force Reload': '强制重新加载',
    'Toggle Developer Tools': '开发者工具', 'Actual Size': '实际大小', 'Reset Zoom': '重置缩放',
    'Zoom In': '放大', 'Zoom Out': '缩小', 'Toggle Full Screen': '切换全屏', 'Toggle Fullscreen': '切换全屏',
    'Minimize': '最小化', 'Maximize': '最大化', 'Unmaximize': '还原窗口', 'Toggle Maximize': '最大化/还原',
    'Zoom': '缩放', 'Front': '前置全部窗口', 'Bring All to Front': '前置全部窗口',
    'Docs': '文档', 'Connect to WSL': '连接到 WSL', 'Reopen Locally': '在本地重新打开',
    'About Antigravity': '关于 Antigravity', 'Check for Updates': '检查更新',
    'Check for Updates...': '检查更新...', 'Checking for Updates...': '正在检查更新...',
    'Update Available': '有可用更新', 'Downloading Update...': '正在下载更新...',
    'Restart to Update': '重启以更新', 'Update Ready to Install': '更新已就绪',
    'Services': '服务', 'Hide Antigravity': '隐藏 Antigravity',
    'Hide Others': '隐藏其他', 'Show All': '显示全部', 'Quit Antigravity': '退出 Antigravity', 'Quit': '退出'
};
const MENU_ZH_TO_EN = Object.fromEntries(Object.entries(MENU_I18N).map(([en, zh]) => [zh, en]));
const MENU_CUSTOM_LABELS = {
    'antigravity-i18n-check-update': { zh: '检查汉化更新', en: 'Check i18n Updates' },
    'antigravity-i18n-toggle-lang': { zh: '切换为英文原文 (关闭汉化)', en: '切换为简体中文 (开启汉化)' },
    'antigravity-i18n-toggle-auto-mt': { zh: '自动翻译动态公告', en: 'Auto-Translate Announcements' }
};
function _isMenuI18nEnabled() {
    try {
        const ota = require('./i18n_ota');
        return !ota || typeof ota.isI18nEnabled !== 'function' || ota.isI18nEnabled();
    } catch (_) {
        return true;
    }
}
function _isMenuAutoMtEnabled() {
    try {
        const ota = require('./i18n_ota');
        return !ota || typeof ota.isAutoMtEnabled !== 'function' || ota.isAutoMtEnabled();
    } catch (_) {
        return true;
    }
}
function translateMenuRecursively(menu, enabled = true) {
    if (!menu || !menu.items) return;
    menu.items.forEach((item) => {
        if (item.id && Object.prototype.hasOwnProperty.call(MENU_CUSTOM_LABELS, item.id)) {
            item.label = enabled ? MENU_CUSTOM_LABELS[item.id].zh : MENU_CUSTOM_LABELS[item.id].en;
            if (item.id === 'antigravity-i18n-toggle-auto-mt') {
                item.checked = _isMenuAutoMtEnabled();
            }
        } else if (item.label) {
            if (!item.__antigravityOrigLabel) {
                if (Object.prototype.hasOwnProperty.call(MENU_I18N, item.label)) {
                    item.__antigravityOrigLabel = item.label;
                    item.__antigravityZhLabel = MENU_I18N[item.label];
                } else if (Object.prototype.hasOwnProperty.call(MENU_ZH_TO_EN, item.label)) {
                    item.__antigravityOrigLabel = MENU_ZH_TO_EN[item.label];
                    item.__antigravityZhLabel = item.label;
                }
            }
            if (item.__antigravityOrigLabel && item.__antigravityZhLabel) {
                item.label = enabled ? item.__antigravityZhLabel : item.__antigravityOrigLabel;
            }
        }
        if (item.submenu) translateMenuRecursively(item.submenu, enabled);
    });
}
let _menuLangSubscribed = false;
function _ensureMenuLangSubscription() {
    if (_menuLangSubscribed) return;
    _menuLangSubscribed = true;
    try {
        const ota = require('./i18n_ota');
        if (ota && typeof ota.onLanguageChange === 'function') {
            ota.onLanguageChange((enabled) => {
                try {
                    const cur = electron_1.Menu.getApplicationMenu();
                    if (cur) {
                        translateMenuRecursively(cur, enabled);
                        electron_1.Menu.setApplicationMenu(cur);
                    }
                } catch (_) {}
            });
        }
        if (ota && typeof ota.onAutoMtChange === 'function') {
            ota.onAutoMtChange(() => {
                try {
                    const cur = electron_1.Menu.getApplicationMenu();
                    if (cur) {
                        translateMenuRecursively(cur, _isMenuI18nEnabled());
                        electron_1.Menu.setApplicationMenu(cur);
                    }
                } catch (_) {}
            });
        }
    } catch (_) {}
}
`;
    if (code.includes('MENU_I18N')) {
      if (
        code.includes('antigravity-i18n-toggle-lang') &&
        code.includes('切换为英文原文') &&
        code.includes('antigravity-i18n-toggle-auto-mt')
      ) {
        return code;
      }
      let upgraded = applyPairs(code, [
        [/'Toggle Full Screen':\s*'全屏模式'/g, "'Toggle Full Screen': '切换全屏'"],
        [/'Toggle Fullscreen':\s*'全屏模式'/g, "'Toggle Fullscreen': '切换全屏'"],
        [/'Zoom':\s*'最大化\/缩放'/g, "'Zoom': '缩放'"],
        [/'Docs':\s*'文档指南'/g, "'Docs': '文档'"],
        [/'Update Available':\s*'发现可用更新'/g, "'Update Available': '有可用更新'"],
        [/label:\s*'文档指南'/g, "label: '文档'"],
        [/'临时切换为英文'/g, "'切换为英文原文 (关闭汉化)'"],
        [/'Switch to 简体中文'/g, "'切换为简体中文 (开启汉化)'"],
        [/updater_1\.updateActions\[menuItem\.label\]/g, 'updater_1.updateActions[menuItem.__antigravityOrigLabel || menuItem.label]']
      ]);
      if (!upgraded.includes('antigravity-i18n-toggle-lang')) {
        const useHelper = upgraded.includes('_isMenuI18nEnabled');
        const toggleLabelExpr = useHelper ? "(_isMenuI18nEnabled() ? '切换为英文原文 (关闭汉化)' : '切换为简体中文 (开启汉化)')" : "'切换为英文原文 (关闭汉化)'";
        if (upgraded.includes('antigravity-i18n-check-update')) {
          upgraded = upgraded.replace(
            /(addItemToSubmenu\(menu,\s*'Help',\s*1,\s*new electron_1\.MenuItem\(\{[\s\S]*?antigravity-i18n-check-update[\s\S]*?\}\)\);)/,
            `$1\n    addItemToSubmenu(menu, 'Help', 2, new electron_1.MenuItem({\n        id: 'antigravity-i18n-toggle-lang',\n        label: ${toggleLabelExpr},\n        click: () => {\n            try {\n                require('./i18n_ota').toggleI18nEnabled();\n            } catch (err) {\n                console.error('[Antigravity-i18n] 切换显示语言失败:', err);\n            }\n        },\n    }));`
          );
        } else {
          upgraded = upgraded.replace(
            /(addItemToSubmenu\(menu,\s*'Help',\s*0,\s*new electron_1\.MenuItem\(\{[\s\S]*?\}\)\);)/,
            `$1${otaMenuItemCode}`
          );
        }
      }
      if (!upgraded.includes('antigravity-i18n-toggle-auto-mt')) {
        if (!upgraded.includes('_isMenuAutoMtEnabled')) {
          upgraded = upgraded.replace(
            /(function\s+_isMenuI18nEnabled\(\)\s*\{[\s\S]*?\n\})/,
            `$1\nfunction _isMenuAutoMtEnabled() {\n    try {\n        const ota = require('./i18n_ota');\n        return !ota || typeof ota.isAutoMtEnabled !== 'function' || ota.isAutoMtEnabled();\n    } catch (_) {\n        return true;\n    }\n}`
          );
        }
        if (upgraded.includes('MENU_CUSTOM_LABELS') && !upgraded.includes('antigravity-i18n-toggle-auto-mt')) {
          upgraded = upgraded.replace(
            /('antigravity-i18n-toggle-lang':\s*\{[^}]+\},?)/,
            `$1\n    'antigravity-i18n-toggle-auto-mt': { zh: '自动翻译动态公告', en: 'Auto-Translate Announcements' },`
          );
        }
        if (upgraded.includes('translateMenuRecursively') && !upgraded.includes("item.id === 'antigravity-i18n-toggle-auto-mt'")) {
          upgraded = upgraded.replace(
            /(item\.label\s*=\s*enabled\s*\?\s*MENU_CUSTOM_LABELS\[item\.id\]\.zh\s*:\s*MENU_CUSTOM_LABELS\[item\.id\]\.en;)/,
            `$1\n            if (item.id === 'antigravity-i18n-toggle-auto-mt') {\n                item.checked = _isMenuAutoMtEnabled();\n            }`
          );
        }
        if (upgraded.includes('_ensureMenuLangSubscription') && !upgraded.includes('onAutoMtChange')) {
          upgraded = upgraded.replace(
            /(ota\.onLanguageChange\([\s\S]*?\n\s*\}\);)/,
            `$1\n        if (ota && typeof ota.onAutoMtChange === 'function') {\n            ota.onAutoMtChange(() => {\n                try {\n                    const cur = electron_1.Menu.getApplicationMenu();\n                    if (cur) {\n                        translateMenuRecursively(cur, _isMenuI18nEnabled());\n                        electron_1.Menu.setApplicationMenu(cur);\n                    }\n                } catch (_) {}\n            });\n        }`
          );
        }
        const autoMtMenuItem = `    addItemToSubmenu(menu, 'Help', 3, new electron_1.MenuItem({\n        id: 'antigravity-i18n-toggle-auto-mt',\n        type: 'checkbox',\n        checked: _isMenuAutoMtEnabled(),\n        label: _isMenuI18nEnabled() ? '自动翻译动态公告' : 'Auto-Translate Announcements',\n        click: () => {\n            try {\n                require('./i18n_ota').toggleAutoMtEnabled();\n            } catch (err) {\n                console.error('[Antigravity-i18n] 切换自动翻译动态公告失败:', err);\n            }\n        },\n    }));`;
        if (upgraded.includes('antigravity-i18n-toggle-lang')) {
          upgraded = upgraded.replace(
            /(addItemToSubmenu\(menu,\s*'Help',\s*2,\s*new electron_1\.MenuItem\(\{[\s\S]*?antigravity-i18n-toggle-lang[\s\S]*?\}\)\);)/,
            `$1\n${autoMtMenuItem}`
          );
        } else {
          console.warn(' [警告] menu.js 原地升级未找到 antigravity-i18n-toggle-lang 锚点，跳过 auto-mt 菜单项注入。');
        }
      }
      return upgraded;
    }
    return applyPairs(code, [
      [/(exports\.setupApplicationMenu\s*=\s*setupApplicationMenu;)/, `$1\n${menuHook}`],
      [/label:\s*'New Window'/g, "label: '新建窗口'"],
      [/label:\s*'Docs'/g, "label: '文档'"],
      [/(addItemToSubmenu\(menu,\s*'Help',\s*0,\s*new electron_1\.MenuItem\(\{[\s\S]*?\}\)\);)/, `$1${otaMenuItemCode}`],
      [/label:\s*'Connect to WSL'/g, "label: '连接到 WSL'"],
      [/label:\s*'Reopen Locally'/g, "label: '在本地重新打开'"],
      [/updater_1\.updateActions\[menuItem\.label\]/g, 'updater_1.updateActions[menuItem.__antigravityOrigLabel || menuItem.label]'],
      [/appMenu\.items\.find\(\(item\)\s*=>\s*item\.label\s*===\s*submenuLabel\)/g, "appMenu.items.find((item) => item.label === submenuLabel || (MENU_I18N[submenuLabel] && item.label === MENU_I18N[submenuLabel]))"],
      [/electron_1\.Menu\.setApplicationMenu\(menu\);/g, "{ _ensureMenuLangSubscription(); translateMenuRecursively(menu, _isMenuI18nEnabled()); electron_1.Menu.setApplicationMenu(menu); }"]
    ]);
  })) {
    console.log(' - menu.js 菜单递归中英切换、WSL 子菜单与 OTA 更新入口注入完成');
  }

  // 3. 注入 tray.js (托盘动态文案与中英即时切换联动)
  if (patchFile(tempDir, 'dist/tray.js', (code) => {
    if (code.includes('_syncTrayLabels') && code.includes('切换为英文原文')) return code;
    const trayHelpers = `
let _i18nLastAgentCount = 0;
let _trayLangSubscribed = false;
function _isTrayI18nEnabled() {
    try {
        const ota = require('./i18n_ota');
        return !ota || typeof ota.isI18nEnabled !== 'function' || ota.isI18nEnabled();
    } catch (_) {
        return true;
    }
}
function _formatTrayAgentLabel(count, enabled) {
    if (enabled) {
        return count > 0 ? \`\${count} 个智能体正在运行\` : '暂无运行中的智能体';
    }
    return (count > 0 ? \`\${count}\` : 'No') + ' agent' + (count === 1 ? '' : 's') + ' running';
}
function _syncTrayLabels(enabled) {
    if (!tray || !contextMenu || !Array.isArray(contextMenu.items)) return;
    const countItem = contextMenu.items.find((item) => item.id === 'running-agents');
    if (countItem) countItem.label = _formatTrayAgentLabel(_i18nLastAgentCount, enabled);
    const openItem = contextMenu.items.find((item) => item.id === 'antigravity-tray-open');
    if (openItem) openItem.label = enabled ? \`打开 \${electron_1.app.getName()}\` : \`Open \${electron_1.app.getName()}\`;
    const otaItem = contextMenu.items.find((item) => item.id === 'antigravity-i18n-check-update');
    if (otaItem) otaItem.label = enabled ? '检查汉化更新' : 'Check i18n Updates';
    const toggleItem = contextMenu.items.find((item) => item.id === 'antigravity-i18n-toggle-lang');
    if (toggleItem) toggleItem.label = enabled ? '切换为英文原文 (关闭汉化)' : '切换为简体中文 (开启汉化)';
    const quitItem = contextMenu.items.find((item) => item.id === 'antigravity-tray-quit');
    if (quitItem) quitItem.label = enabled ? '退出' : 'Quit';
    tray.setContextMenu(contextMenu);
}
function _ensureTrayLangSubscription() {
    if (_trayLangSubscribed) return;
    _trayLangSubscribed = true;
    try {
        const ota = require('./i18n_ota');
        if (ota && typeof ota.onLanguageChange === 'function') {
            ota.onLanguageChange((enabled) => _syncTrayLabels(enabled));
        }
    } catch (_) {}
}
`;
    return applyPairs(code, [
      [/(let\s+contextMenu\s*=\s*null;)/, `$1\n${trayHelpers}`],
      [/(contextMenu\s*=\s*electron_1\.Menu\.buildFromTemplate\(actions\);\s*tray\.setContextMenu\(contextMenu\);)/, `$1\n    _syncTrayLabels(_isTrayI18nEnabled());\n    _ensureTrayLangSubscription();`],
      [/countItem\.label\s*=\s*\(count > 0 \? `\$\{count\}` : 'No'\)\s*\+\s*' agent'\s*\+\s*\(count === 1 \? '' : 's'\)\s*\+\s*' running';/, "_i18nLastAgentCount = count;\n            countItem.label = _formatTrayAgentLabel(count, _isTrayI18nEnabled());"],
      [/'当前无运行中的智能体'/g, "'暂无运行中的智能体'"]
    ]);
  })) {
    console.log(' - tray.js 托盘文字与中英切换联动注入完成');
  }

  // 4. 注入 main.js (托盘初始项、系统弹窗与托盘右键“检查汉化更新 / 切换为英文原文”入口，全部动态接入 _i18nT)
  if (patchFile(tempDir, 'dist/main.js', (code) => {
    if (code.includes('function _i18nT(')) return code;
    let next = injectI18nTHelper(code, './i18n_ota');
    next = applyPairs(next, [
      [/label:\s*'New Window'/g, "label: _i18nT('新建窗口', 'New Window')"],
      [/label:\s*'(?:No agents running|当前无运行中的智能体)'/g, "label: _i18nT('暂无运行中的智能体', 'No agents running')"],
      [/(\{\s*)label:\s*`Open \$\{electron_1\.app\.getName\(\)\}`/g, "$1id: 'antigravity-tray-open',\n                label: _i18nT(`打开 ${electron_1.app.getName()}`, `Open ${electron_1.app.getName()}`)"],
      [/(\{\s*)label:\s*'Quit'(\s*,\s*click:\s*\(\)\s*=>\s*\{)/g, "$1id: 'antigravity-tray-quit',\n                label: _i18nT('退出', 'Quit')$2"],
      [/buttons:\s*\['Cancel',\s*'Quit'\]/g, "buttons: [_i18nT('取消', 'Cancel'), _i18nT('退出', 'Quit')]"],
      [/title:\s*'Confirm Quit'/g, "title: _i18nT('确认退出', 'Confirm Quit')"],
      [/message:\s*'Are you sure you want to quit\?'/g, "message: _i18nT('确定要退出吗？', 'Are you sure you want to quit?')"],
      [/detail:\s*'There may be agents or background tasks running\.'/g, "detail: _i18nT('当前可能有智能体或后台任务正在运行。', 'There may be agents or background tasks running.')"],
      [/showErrorBox\('Binary not found'/g, "showErrorBox(_i18nT('未找到核心程序', 'Binary not found')"],
      [/title:\s*'WSL distro not found'/g, "title: _i18nT('未找到 WSL 发行版', 'WSL distro not found')"],
      [/message:\s*`(?:The WSL distro "\$\{WSL_DISTRO\}" is no longer installed\.|WSL 发行版“\$\{WSL_DISTRO\}”已不再安装。)`/g, "message: _i18nT(`WSL 发行版“${WSL_DISTRO}”未安装或已被卸载。`, `The WSL distro \"${WSL_DISTRO}\" is no longer installed.`)"],
      [/detail:\s*'Antigravity opened on Windows instead\.'/g, "detail: _i18nT('已改为在 Windows 本地打开 Antigravity。', 'Antigravity opened on Windows instead.')"],
      [/showErrorBox\('WSL setup failed'/g, "showErrorBox(_i18nT('WSL 配置失败', 'WSL setup failed')"],
      [/showErrorBox\('Startup failed'/g, "showErrorBox(_i18nT('启动失败', 'Startup failed')"]
    ]);
    if (!next.includes('antigravity-i18n-check-update')) {
      const trayOtaItems = `{
                id: 'antigravity-i18n-check-update',
                label: _i18nT('检查汉化更新', 'Check i18n Updates'),
                click: () => {
                    try {
                        void require('./i18n_ota').checkForUpdates({ manual: true });
                    } catch (err) {
                        console.error('[Antigravity-i18n] 托盘检查汉化更新失败:', err);
                    }
                },
            },
            {
                id: 'antigravity-i18n-toggle-lang',
                label: _i18nT('切换为英文原文 (关闭汉化)', '切换为简体中文 (开启汉化)'),
                click: () => {
                    try {
                        require('./i18n_ota').toggleI18nEnabled();
                    } catch (err) {
                        console.error('[Antigravity-i18n] 托盘切换显示语言失败:', err);
                    }
                },
            },
            `;
      next = next.replace(
        /(\{\s*id:\s*'antigravity-tray-quit',\s*label:\s*[^,]+,)/,
        `${trayOtaItems}$1`
      );
    }
    return next;
  })) {
    console.log(' - main.js 托盘初始项、动态系统弹窗与中英切换入口注入完成');
  }

  // 4.5 注入 preload.js（本地与 SSH 远程窗口均暴露安全的语言切换 IPC 通道，本地窗口额外暴露 OTA 手动检查）
  if (patchFile(tempDir, 'dist/preload.js', (code) => {
    let next = code;
    if (!next.includes("exposeInMainWorld('desktopMic', remoteDesktopMic);\n    electron_1.contextBridge.exposeInMainWorld('antigravityI18nOta'")) {
      next = next.replace(
        /(electron_1\.contextBridge\.exposeInMainWorld\('desktopMic',\s*remoteDesktopMic\);)/,
        `$1\n    electron_1.contextBridge.exposeInMainWorld('antigravityI18nOta', {\n        toggleLanguage: () => electron_1.ipcRenderer.invoke('i18n-ota:toggle-language'),\n        getLanguageEnabled: () => electron_1.ipcRenderer.invoke('i18n-ota:get-language-enabled'),\n        translateDynamicText: (text) => electron_1.ipcRenderer.invoke('i18n-ota:translate-dynamic', text),\n        getAutoMtEnabled: () => electron_1.ipcRenderer.invoke('i18n-ota:get-auto-mt-enabled'),\n        toggleAutoMt: () => electron_1.ipcRenderer.invoke('i18n-ota:toggle-auto-mt'),\n    });`
      );
    }
    if (!next.includes("exposeInMainWorld('electronUpdater', updaterAPI);\n    electron_1.contextBridge.exposeInMainWorld('antigravityI18nOta'")) {
      next = next.replace(
        /(electron_1\.contextBridge\.exposeInMainWorld\('electronUpdater',\s*updaterAPI\);)/,
        `$1\n    electron_1.contextBridge.exposeInMainWorld('antigravityI18nOta', {\n        checkForUpdates: () => electron_1.ipcRenderer.invoke('i18n-ota:check-updates'),\n        toggleLanguage: () => electron_1.ipcRenderer.invoke('i18n-ota:toggle-language'),\n        getLanguageEnabled: () => electron_1.ipcRenderer.invoke('i18n-ota:get-language-enabled'),\n        translateDynamicText: (text) => electron_1.ipcRenderer.invoke('i18n-ota:translate-dynamic', text),\n        getAutoMtEnabled: () => electron_1.ipcRenderer.invoke('i18n-ota:get-auto-mt-enabled'),\n        toggleAutoMt: () => electron_1.ipcRenderer.invoke('i18n-ota:toggle-auto-mt'),\n    });`
      );
    }
    return next;
  })) {
    console.log(' - preload.js 本地与远程窗口 OTA / 语言切换桥接注入完成');
  }

  // 5. 注入 updater.js（保持 MenuUpdateStep 英文键名并动态翻译菜单文案、更新弹窗及自愈唤醒钩子）
  const autoPatchPathLiteral = JSON.stringify(path.join(__dirname, 'auto_patch_on_update.js'));
  const preferredNodeLiteral = JSON.stringify(!process.versions.electron ? process.execPath : '');
  patchFile(tempDir, 'dist/updater.js', (code) => {
    if (code.includes('function _i18nT(')) return code;
    let next = injectI18nTHelper(code, './i18n_ota');
    const stepMapDef = `const _I18N_UPDATE_STEPS = {
    'Check for Updates': '检查更新',
    'Checking for Updates...': '正在检查更新...',
    'Downloading Update...': '正在下载更新...',
    'Restart to Update': '重启以更新',
};
`;
    next = applyPairs(next, [
      [/(function\s+updateMenuState\s*\(step\)\s*\{)/, `${stepMapDef}$1`],
      [/(function\s+updateMenuState\s*\(step\)\s*\{[\s\S]*?if\s*\(item\)\s*\{\s*\r?\n\s*)item\.label\s*=\s*step;/, `$1item.__antigravityOrigLabel = step;\n            item.__antigravityZhLabel = _I18N_UPDATE_STEPS[step] || step;\n            item.label = _i18nT(item.__antigravityZhLabel, step);`],
      [/title:\s*'Check for Updates'/g, "title: _i18nT('检查更新', 'Check for Updates')"],
      [/message:\s*'No updates available'/g, "message: _i18nT('当前已是最新版本', 'No updates available')"],
      [/buttons:\s*\['OK'\]/g, "buttons: [_i18nT('确定', 'OK')]"]
    ]);
    if (!next.includes('spawnAutoPatcherOnUpdate')) {
      const spawnHelper = `let _autoPatcherSpawned = false;
function spawnAutoPatcherOnUpdate(shouldRelaunch = true) {
    if (_autoPatcherSpawned) return;
    _autoPatcherSpawned = true;
    try {
        const fs = require('fs');
        const { spawn } = require('child_process');
        const patcherScript = ${autoPatchPathLiteral};
        if (!fs.existsSync(patcherScript)) return;
        const args = [patcherScript, '--watch-after-quit', String(process.pid)];
        if (!shouldRelaunch) {
            args.push('--no-relaunch');
        }
        const preferredNode = ${preferredNodeLiteral};
        const candidates = [];
        if (preferredNode && fs.existsSync(preferredNode)) {
            candidates.push({ cmd: preferredNode, extraEnv: null });
        }
        candidates.push({ cmd: 'node', extraEnv: null });
        candidates.push({ cmd: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } });
        const trySpawn = (index) => {
            if (index >= candidates.length) return;
            const { cmd, extraEnv } = candidates[index];
            try {
                const opts = { detached: true, stdio: 'ignore', windowsHide: true };
                if (extraEnv) opts.env = { ...process.env, ...extraEnv };
                const child = spawn(cmd, args, opts);
                child.once('error', () => trySpawn(index + 1));
                child.unref();
            } catch (_) {
                trySpawn(index + 1);
            }
        };
        trySpawn(0);
    } catch (e) {
        console.error('Failed to spawn auto patcher:', e);
    }
}
`;
      next = next.replace(
        /((?:async\s+)?function\s+quitAndInstall\s*\()/,
        `${spawnHelper}$1`
      );
      next = next.replace(
        /(electron_updater_1\.autoUpdater\.quitAndInstall\([^)]*\);)/g,
        `spawnAutoPatcherOnUpdate(true);\n            $1`
      );
      next = next.replace(
        /(electron_updater_1\.autoUpdater\.autoInstallOnAppQuit\s*=\s*[\s\S]*?;)/,
        `$1\n    electron_1.app.once('will-quit', () => { if (lastState && lastState.type === types_1.UpdateState.Ready) spawnAutoPatcherOnUpdate(false); });`
      );
    }
    return next;
  });
  const updaterPatched = fs.readFileSync(path.join(tempDir, 'dist', 'updater.js'), 'utf8');
  if (updaterPatched.includes('auto_patch_on_update.js') && updaterPatched.includes('spawnAutoPatcherOnUpdate') && updaterPatched.includes('_I18N_UPDATE_STEPS')) {
    console.log(' - updater.js 动态更新文案及自愈唤醒钩子注入完成');
  } else {
    console.warn(' [警告] updater.js 自愈唤醒钩子未命中，请检查官方代码是否变更！');
  }

  // 6. 注入 WSL 配置页、IPC 对话框 / 更新通道 / 通知、安全弹窗与安装向导（全部动态响应 _i18nT）
  if (patchFile(tempDir, 'dist/provisionSplash.js', (code) => {
    if (code.includes('function _i18nT(')) return code;
    return injectI18nTHelper(code, './i18n_ota').replace(
      /<div>Setting up WSL: \$\{escapeHtml\(distro\)\}<\/div>/g,
      "<div>${_i18nT(`正在配置 WSL：${escapeHtml(distro)}`, `Setting up WSL: ${escapeHtml(distro)}`)}</div>"
    );
  })) {
    console.log(' - provisionSplash.js WSL 配置页面动态汉化完成');
  }

  patchFile(tempDir, 'dist/ipcHandlers.js', (code) => {
    if (code.includes('function _i18nT(')) return code;
    let next = injectI18nTHelper(code, './i18n_ota');
    next = applyPairs(next, [
      [/'Cannot open folder'/g, "_i18nT('无法打开文件夹', 'Cannot open folder')"],
      [/'Folder is on the Windows filesystem'/g, "_i18nT('文件夹位于 Windows 文件系统中', 'Folder is on the Windows filesystem')"],
      [/'Open workspaces'/g, "_i18nT('打开工作区', 'Open workspaces')"],
      [/'Open workspace'/g, "_i18nT('打开工作区', 'Open workspace')"],
      [/'Select Download Folder'/g, "_i18nT('选择下载文件夹', 'Select Download Folder')"],
      [
        /(localOnly\('updater:quit-and-install',\s*\(\)\s*=>\s*\{[\s\S]*?)electron_updater_1\.autoUpdater\.quitAndInstall\(\);(\s*\}\);)/,
        '$1(0, updater_1.quitAndInstall)();$2'
      ]
    ]);
    if (!next.includes('i18n-ota:check-updates')) {
      next = next.replace(
        /(localOnly\('updater:check-for-updates',\s*\(\)\s*=>\s*\{[\s\S]*?\}\);)/,
        `$1\n    localOnly('i18n-ota:check-updates', () => {\n        try {\n            return require('./i18n_ota').checkForUpdates({ manual: true });\n        } catch (err) {\n            console.error('[Antigravity-i18n] IPC 检查汉化更新失败:', err);\n            return { status: 'error', error: String((err && err.message) || err) };\n        }\n    });\n    electron_1.ipcMain.handle('i18n-ota:toggle-language', () => {\n        try {\n            return { enabled: require('./i18n_ota').toggleI18nEnabled() };\n        } catch (err) {\n            console.error('[Antigravity-i18n] IPC 切换显示语言失败:', err);\n            return { enabled: true, error: String((err && err.message) || err) };\n        }\n    });\n    electron_1.ipcMain.handle('i18n-ota:get-language-enabled', () => {\n        try {\n            return { enabled: require('./i18n_ota').isI18nEnabled() };\n        } catch (_) {\n            return { enabled: true };\n        }\n    });\n    electron_1.ipcMain.handle('i18n-ota:translate-dynamic', (_event, text) => {\n        try {\n            return require('./i18n_ota').translateDynamicText(text);\n        } catch (err) {\n            return { status: 'error', translated: '', error: String((err && err.message) || err) };\n        }\n    });\n    electron_1.ipcMain.handle('i18n-ota:get-auto-mt-enabled', () => {\n        try {\n            return { enabled: require('./i18n_ota').isAutoMtEnabled() };\n        } catch (_) {\n            return { enabled: true };\n        }\n    });\n    electron_1.ipcMain.handle('i18n-ota:toggle-auto-mt', () => {\n        try {\n            return { enabled: require('./i18n_ota').toggleAutoMtEnabled() };\n        } catch (err) {\n            return { enabled: true, error: String((err && err.message) || err) };\n        }\n    });`
      );
    }
    if (!next.includes('translateContextMenuLabel')) {
      const ctxMenuHelper = `let _nativeContextDict = null;
let _nativeContextLower = null;
function translateContextMenuLabel(rawLabel) {
    if (typeof rawLabel !== 'string' || !rawLabel) return '';
    try {
        if (!_nativeContextDict) {
            const dictFile = path.join(__dirname, 'native_context_dict.json');
            _nativeContextDict = new Map();
            _nativeContextLower = new Map();
            if (fsSync.existsSync(dictFile)) {
                const parsed = JSON.parse(fsSync.readFileSync(dictFile, 'utf8'));
                for (const [k, v] of Object.entries(parsed)) {
                    _nativeContextDict.set(k, v);
                    const lk = k.toLowerCase().trim();
                    if (!_nativeContextLower.has(lk)) _nativeContextLower.set(lk, v);
                }
            }
        }
        const trimmed = rawLabel.trim();
        let otaMaps = null;
        try {
            const ota = require('./i18n_ota');
            if (ota && typeof ota.isI18nEnabled === 'function' && !ota.isI18nEnabled()) return rawLabel;
            otaMaps = ota && typeof ota.getNativeContextDict === 'function' ? ota.getNativeContextDict() : null;
        } catch (_) {}
        const exactMap = (otaMaps && otaMaps.exactMap) || _nativeContextDict;
        const lowerMap = (otaMaps && otaMaps.lowerMap) || _nativeContextLower;
        if (exactMap.has(trimmed)) return exactMap.get(trimmed);
        const low = trimmed.toLowerCase();
        if (lowerMap.has(low)) return lowerMap.get(low);
        const defMatch = trimmed.match(/^(.+?)\\s+\\(Default\\)$/i);
        if (defMatch) {
            const base = defMatch[1].trim();
            const baseZh = exactMap.get(base) || lowerMap.get(base.toLowerCase()) || base;
            return \`\${baseZh}（默认）\`;
        }
    } catch (_) {}
    return rawLabel;
}
`;
      next = next.replace(
        /(function\s+buildContextMenuTemplate\(items,\s*onSelect\)\s*\{)/,
        `${ctxMenuHelper}$1`
      );
      next = next.replace(
        /(function\s+buildContextMenuTemplate[\s\S]*?return\s+items\.map\(\(item\)\s*=>\s*\{[\s\S]*?\}\);\r?\n\})/,
        (block) => block.replace(/label:\s*item\.label\s*\?\?\s*''/g, "label: translateContextMenuLabel(item.label ?? '')")
      );
    }
    if (!next.includes('translateNativeNotificationText')) {
      const notifHelper = `    function translateNativeNotificationText(s) {
        if (typeof s !== 'string') return s;
        try {
            const ota = require('./i18n_ota');
            if (ota && typeof ota.isI18nEnabled === 'function' && !ota.isI18nEnabled()) return s;
        } catch (_) {}
        const t = s.trim();
        const exact = {
            'Requesting your permission in Terminal:': '请求终端执行权限：',
            'Requesting your permission to open URL:': '请求打开链接权限：',
            'The agent has questions for you:': '智能体有多个问题需要你确认：',
            'The agent has a question for you:': '智能体有一个问题需要你确认：',
            'Click to respond to the questions.': '点击回复这些问题。',
            'Click to respond to the question.': '点击回复此问题。',
            'Requesting your permission:': '请求你的授权：',
            'Action requires your attention': '需要你的操作',
            'The agent is waiting for your input.': '智能体正在等待你的输入。',
            'Agent finished': '智能体已完成'
        };
        if (Object.prototype.hasOwnProperty.call(exact, t)) return exact[t];
        if (t.startsWith('Agent finished: ')) return '智能体已完成：' + t.slice('Agent finished: '.length);
        if (t.startsWith('Command: ')) return '命令：' + t.slice('Command: '.length);
        if (t.startsWith('URL: ')) return '链接：' + t.slice('URL: '.length);
        return s;
    }
`;
      const notifRegex = /(electron_1\.ipcMain\.handle\('notification:send',\s*\(event,\s*options\)\s*=>\s*\{[\s\S]*?const\s+label\s*=\s*[^\n]+;\r?\n)([\s\S]*?const\s+remoteTitle\s*=\s*truncate\()options\?\.title(,\s*MAX_NOTIFICATION_TITLE\);\r?\n\s*const\s+notification\s*=\s*new\s+electron_1\.Notification\(\{\r?\n\s*title:\s*remote\r?\n\s*\?\s*truncate\(remoteTitle\s*\?\s*`\$\{label\}:\s*\$\{remoteTitle\}`\s*:\s*label,\s*MAX_NOTIFICATION_TITLE\)\r?\n\s*:\s*)options\.title(,\r?\n\s*body:\s*remote\r?\n\s*\?\s*truncate\()options\?\.body(,\s*MAX_NOTIFICATION_BODY\)\r?\n\s*:\s*)options\.body(,)/;
      next = next.replace(notifRegex, (_m, head, mid1, mid2, mid3, mid4, tail) => {
        return `${notifHelper}    ${head}        const rawTitle = translateNativeNotificationText(options?.title);\n        const rawBody = translateNativeNotificationText(options?.body);\n${mid1}rawTitle${mid2}rawTitle${mid3}rawBody${mid4}rawBody${tail}`;
      });
    } else {
      next = applyPairs(next, [
        [/'智能体有多个问题需要您确认：'/g, "'智能体有多个问题需要你确认：'"],
        [/'智能体有一个问题需要您确认：'/g, "'智能体有一个问题需要你确认：'"],
        [/'请求您的授权：'/g, "'请求你的授权：'"],
        [/'需要您处理的操作'/g, "'需要你的操作'"],
        [/'智能体正在等待您的输入。'/g, "'智能体正在等待你的输入。'"]
      ]);
    }
    return next;
  });
  const ipcPatched = fs.readFileSync(path.join(tempDir, 'dist', 'ipcHandlers.js'), 'utf8');
  if (ipcPatched.includes('translateNativeNotificationText') && ipcPatched.includes('updater_1.quitAndInstall')) {
    console.log(' - ipcHandlers.js 原生对话框、更新通道与系统通知汉化完成');
  } else {
    console.warn(' [警告] ipcHandlers.js 部分钩子未命中，请检查官方代码是否变更！');
  }

  if (patchFile(tempDir, 'dist/webviewPopupSecurity.js', (code) => {
    if (code.includes('function _i18nT(')) return code;
    let next = injectI18nTHelper(code, './i18n_ota');
    next = applyPairs(next, [
      [
        /const\s+POPUP_TITLE_SECURITY_LABELS\s*=\s*\{[\s\S]*?\};/,
        `const POPUP_TITLE_SECURITY_LABELS = {\n    secure: '',\n    get insecure() { return _i18nT('不安全', 'Not secure'); },\n    get dangerous() { return _i18nT('⚠ 不安全', '⚠ Not secure'); },\n    neutral: '',\n};`
      ],
      [
        /const\s+NOT_SECURE_SUMMARY\s*=\s*\[[\s\S]*?\];[\s\S]*?const\s+SECURITY_LEVEL_SUMMARIES\s*=\s*\{[\s\S]*?\};/,
        `const SECURITY_LEVEL_SUMMARIES = {\n    get secure() {\n        return [\n            _i18nT('连接安全', 'Connection is secure'),\n            _i18nT('你的信息（例如密码或信用卡号）在发送到此网站时会保持私密。', 'Your information (for example, passwords or credit card numbers) is private when it is sent to this site.'),\n        ];\n    },\n    get insecure() {\n        return [\n            _i18nT('你与该网站的连接不安全', 'Your connection to this site is not secure'),\n            _i18nT('请勿在此网站上输入任何敏感信息（例如密码或信用卡信息），否则可能会被攻击者窃取。', 'You should not enter any sensitive information on this site (for example, passwords or credit cards), because it could be stolen by attackers.'),\n        ];\n    },\n    get dangerous() { return this.insecure; },\n    get neutral() {\n        return [_i18nT('此页面暂无连接安全信息', 'Connection security information is not available for this page')];\n    },\n};`
      ],
      [/'Certificate is valid'/g, "_i18nT('证书有效', 'Certificate is valid')"],
      [/'Certificate details'/g, "_i18nT('证书详情', 'Certificate details')"],
      [/`Error: \$\{state\.certificateError\}`/g, "_i18nT(`错误：${state.certificateError}`, `Error: ${state.certificateError}`)"],
      [/`Issued to: \$\{certificate\.subjectName\}`/g, "_i18nT(`颁发给：${certificate.subjectName}`, `Issued to: ${certificate.subjectName}`)"],
      [/`Issued by: \$\{certificate\.issuer\}`/g, "_i18nT(`颁发者：${certificate.issuer}`, `Issued by: ${certificate.issuer}`)"],
      [/`Valid from: \$\{formatDate\(certificate\.validFromMs\)\}`/g, "_i18nT(`生效时间：${formatDate(certificate.validFromMs)}`, `Valid from: ${formatDate(certificate.validFromMs)}`)"],
      [/`Valid until: \$\{formatDate\(certificate\.validToMs\)\}`/g, "_i18nT(`有效期至：${formatDate(certificate.validToMs)}`, `Valid until: ${formatDate(certificate.validToMs)}`)"],
      [/`Protocol: \$\{certificate\.protocol\}`/g, "_i18nT(`协议：${certificate.protocol}`, `Protocol: ${certificate.protocol}`)"],
      [/:\s*'unknown'/g, ": _i18nT('未知', 'unknown')"],
      [/'This page'/g, "_i18nT('此页面', 'This page')"],
      [/'Connection info…'/g, "_i18nT('连接信息...', 'Connection info…')"],
      [/'Connection info'/g, "_i18nT('连接信息', 'Connection info')"],
      [/buttons:\s*\['OK'\]/g, "buttons: [_i18nT('确定', 'OK')]"]
    ]);
    return next;
  })) {
    console.log(' - webviewPopupSecurity.js 安全弹窗文案动态汉化完成');
  }

  if (patchFile(tempDir, path.join('dist', 'ideInstall', 'wizardHtml.js'), (code) => {
    if (code.includes('function _i18nT(')) return code;
    return applyPairs(injectI18nTHelper(code, '../i18n_ota'), [
      [/>Welcome to Antigravity</g, ">${_i18nT('欢迎使用 Antigravity', 'Welcome to Antigravity')}<"],
      [/>Setting up…</g, ">${_i18nT('正在配置...', 'Setting up…')}<"],
      [/>Setting up\.\.\.</g, ">${_i18nT('正在配置...', 'Setting up...')}<"],
      [/>Welcome to the new Antigravity!</g, ">${_i18nT('欢迎体验全新 Antigravity！', 'Welcome to the new Antigravity!')}<"],
      [/<p>Antigravity has been redesigned to put agents first with new capabilities\. If you'd still like a code editor, you can download it as a separate app named <b>Antigravity IDE<\/b>\.<\/p>/g, "<p>${_i18nT('Antigravity 已全新重构，以智能体为核心并提供全新能力。如果你仍需要传统代码编辑器，可单独下载 <b>Antigravity IDE</b> 应用。', 'Antigravity has been redesigned to put agents first with new capabilities. If you\\'d still like a code editor, you can download it as a separate app named <b>Antigravity IDE</b>.')}</p>"],
      [/>Download the Antigravity IDE</g, ">${_i18nT('下载 Antigravity IDE', 'Download the Antigravity IDE')}<"],
      [/>Explore the new Antigravity</g, ">${_i18nT('探索全新 Antigravity', 'Explore the new Antigravity')}<"]
    ]);
  })) {
    console.log(' - ideInstall/wizardHtml.js IDE 安装引导页动态汉化完成');
  }

  // 7. 注入 languageServer.js (Go 核心进程可选代理隔离注入，仅当显式配置 ANTIGRAVITY_PROXY 时生效)
  if (patchFile(tempDir, 'dist/languageServer.js', (lsCode) => {
    if (lsCode.includes('ANTIGRAVITY_PROXY_INJECTED')) return lsCode;
    const proxyHook = `
        // ANTIGRAVITY_PROXY_INJECTED: 仅当显式设置有效的 ANTIGRAVITY_PROXY 时为 Go 后台核心注入局部代理；设为 direct/none/off/false/0 时强制清空代理走直连
        const _agyRawProxy = (process.env.ANTIGRAVITY_PROXY || '').trim();
        if (/^(?:none|direct|off|false|0)$/i.test(_agyRawProxy)) {
          delete env.HTTP_PROXY;
          delete env.HTTPS_PROXY;
          delete env.ALL_PROXY;
          delete env.http_proxy;
          delete env.https_proxy;
          delete env.all_proxy;
        } else if (_agyRawProxy) {
          const _agyIsSocks = /^socks\\d*:\\/\\//i.test(_agyRawProxy);
          const _agyDefaultProxy = _agyIsSocks
              ? _agyRawProxy
              : (/^https?:\\/\\//i.test(_agyRawProxy) ? _agyRawProxy : \`http://\${_agyRawProxy}\`);
          const _agyDefaultSocks = _agyIsSocks
              ? _agyRawProxy
              : (/^https?:\\/\\//i.test(_agyRawProxy) ? _agyRawProxy.replace(/^https?:\\/\\//i, 'socks5://') : \`socks5://\${_agyRawProxy}\`);
          const _agyDefaultBypass = process.env.ANTIGRAVITY_NO_PROXY || 'localhost,127.0.0.1,::1';
          env.HTTP_PROXY = env.HTTP_PROXY || env.http_proxy || _agyDefaultProxy;
          env.HTTPS_PROXY = env.HTTPS_PROXY || env.https_proxy || _agyDefaultProxy;
          env.ALL_PROXY = env.ALL_PROXY || env.all_proxy || _agyDefaultSocks;
          env.NO_PROXY = env.NO_PROXY || env.no_proxy || _agyDefaultBypass;
          env.http_proxy = env.HTTP_PROXY;
          env.https_proxy = env.HTTPS_PROXY;
          env.all_proxy = env.ALL_PROXY;
          env.no_proxy = env.NO_PROXY;
        }
`;
    return lsCode.replace(
      /(const\s+env\s*=\s*\{\s*\.\.\.process\.env,\s*\.\.\.(?:loginShellEnv|\(0,\s*shell_env_1\.shellEnvSync\)\(\))\s*\};)/,
      `$1${proxyHook}`
    );
  })) {
    console.log(' - languageServer.js 后台可选代理注入完成（默认关闭，配置 ANTIGRAVITY_PROXY 后生效）');
  }

  // 7.5 注入其余主进程原生弹窗与 SSH 远程页面 (deviceChooser / webauthn / cablev2 / remote/*，全部动态接入 _i18nT)
  let extraMainPatched = 0;
  if (patchFile(tempDir, 'dist/deviceChooser.js', (code) => {
    if (code.includes('function _i18nT(')) return code;
    return applyPairs(injectI18nTHelper(code, './i18n_ota'), [
      [
        /const\s+KIND_NOUNS\s*=\s*\{[\s\S]*?\};/,
        `const KIND_NOUNS = {\n    get hid() { return _i18nT('HID 设备', 'HID device'); },\n    get usb() { return _i18nT('USB 设备', 'USB device'); },\n    get serial() { return _i18nT('串口设备', 'serial port'); },\n};`
      ],
      [/'Unknown device'/g, "_i18nT('未知设备', 'Unknown device')"],
      [/title:\s*'Connect a device'/g, "title: _i18nT('连接设备', 'Connect a device')"],
      [/`\$\{origin\} wants to connect to a \$\{KIND_NOUNS\[kind\]\}`/g, "_i18nT(`${origin} 请求连接 ${KIND_NOUNS[kind]}`, `${origin} wants to connect to a ${KIND_NOUNS[kind]}`)"],
      [/'Select a device:'/g, "_i18nT('请选择设备：', 'Select a device:')"],
      [/'No compatible devices found\.'/g, "_i18nT('未找到兼容设备。', 'No compatible devices found.')"],
      [/,\s*'Cancel'\]/g, ", _i18nT('取消', 'Cancel')]"]
    ]);
  })) extraMainPatched++;

  if (patchFile(tempDir, 'dist/webauthn.js', (code) => {
    if (code.includes('function _i18nT(')) return code;
    return applyPairs(injectI18nTHelper(code, './i18n_ota'), [
      [/details\.relyingPartyId\s*\|\|\s*'this site'/g, "details.relyingPartyId || _i18nT('此网站', 'this site')"],
      [/title:\s*'Choose a Passkey'/g, "title: _i18nT('选择通行密钥', 'Choose a Passkey')"],
      [/message:\s*`Sign in to \$\{rpLabel\}`/g, "message: _i18nT(`登录 ${rpLabel}`, `Sign in to ${rpLabel}`)"],
      [/detail:\s*'Select a passkey account to continue:'/g, "detail: _i18nT('请选择通行密钥账号以继续：', 'Select a passkey account to continue:')"],
      [/buttons:\s*\[\.\.\.accountLabels,\s*'Cancel'\]/g, "buttons: [...accountLabels, _i18nT('取消', 'Cancel')]"]
    ]);
  })) extraMainPatched++;

  if (patchFile(tempDir, 'dist/cablev2.js', (code) => {
    if (code.includes('function _i18nT(')) return code;
    return applyPairs(injectI18nTHelper(code, './i18n_ota'), [
      [/<title>Passkeys<\/title>/g, "<title>${_i18nT('通行密钥', 'Passkeys')}</title>"],
      [/<h1 class="sheet-title">Passkeys<\/h1>/g, "<h1 class=\"sheet-title\">${_i18nT('通行密钥', 'Passkeys')}</h1>"],
      [/<p class="mechanism-header">Use your phone or tablet<\/p>/g, "<p class=\"mechanism-header\">${_i18nT('使用手机或平板电脑', 'Use your phone or tablet')}</p>"],
      [/Scan this QR code with the camera on the device that has your passkey for \$\{safeRpId\}/g, "${_i18nT(`使用存有 ${safeRpId} 通行密钥的设备摄像头扫描此二维码`, `Scan this QR code with the camera on the device that has your passkey for ${safeRpId}`)}"],
      [/>Cancel<\/button>/g, ">${_i18nT('取消', 'Cancel')}</button>"],
      [/'Connecting to your device…'/g, "_i18nT('正在连接到你的设备...', 'Connecting to your device…')"],
      [/'Verify on your device to continue…'/g, "_i18nT('请在你的设备上完成验证以继续...', 'Verify on your device to continue…')"]
    ]);
  })) extraMainPatched++;

  if (patchFile(tempDir, path.join('dist', 'remote', 'disconnectedPage.js'), (code) => {
    if (code.includes('function _i18nT(')) return code;
    return applyPairs(injectI18nTHelper(code, '../i18n_ota'), [
      [
        /const\s+BUTTON_LABELS\s*=\s*\{[\s\S]*?\};/,
        `const BUTTON_LABELS = {\n    get reconnect() { return _i18nT('重新连接', 'Reconnect'); },\n    get stop() { return _i18nT('停止服务端', 'Stop Server'); },\n    get close() { return _i18nT('关闭', 'Close'); },\n};`
      ],
      [/'Restarting…'/g, "_i18nT('正在重启...', 'Restarting…')"],
      [/'Reconnecting…'/g, "_i18nT('正在重新连接...', 'Reconnecting…')"],
      [/'Disconnected'/g, "_i18nT('连接已断开', 'Disconnected')"],
      [/`Restarting the Antigravity server on \$\{host\}…`/g, "_i18nT(`正在重启 ${host} 上的 Antigravity 服务端...`, `Restarting the Antigravity server on ${host}…`)"],
      [/`Reconnecting to \$\{host\}…`/g, "_i18nT(`正在重新连接到 ${host}...`, `Reconnecting to ${host}…`)"],
      [/`Disconnected from \$\{host\}`/g, "_i18nT(`已断开与 ${host} 的连接`, `Disconnected from ${host}`)"],
      [/'This window opens it again once it has started\.'/g, "_i18nT('启动完成后此窗口将自动重新打开。', 'This window opens it again once it has started.')"],
      [/`Its server on \$\{host\} stopped, and its agents with it\.`/g, "_i18nT(`${host} 上的服务端已停止，对应的智能体也随之停止。`, `Its server on ${host} stopped, and its agents with it.`)"],
      [/`Its agents on \$\{host\} stopped with it\.`/g, "_i18nT(`${host} 上的智能体也随之停止。`, `Its agents on ${host} stopped with it.`)"],
      [/`Agents keep running on \$\{host\}\.`/g, "_i18nT(`智能体仍会继续在 ${host} 上运行。`, `Agents keep running on ${host}.`)"],
      [/`Agents keep running on \$\{host\} unless its server stopped\.`/g, "_i18nT(`除非服务端已停止，否则智能体仍会继续在 ${host} 上运行。`, `Agents keep running on ${host} unless its server stopped.`)"],
      [/>Reconnect<\/a>/g, ">${_i18nT('重新连接', 'Reconnect')}</a>"],
      [/>Close<\/a>/g, ">${_i18nT('关闭', 'Close')}</a>"]
    ]);
  })) extraMainPatched++;

  if (patchFile(tempDir, path.join('dist', 'remote', 'signInCallback.js'), (code) => {
    if (code.includes('function _i18nT(')) return code;
    return applyPairs(injectI18nTHelper(code, '../i18n_ota'), [
      [
        /const\s+SIGNED_IN\s*=\s*page\('You have successfully authenticated\.',\s*'You can close this tab and return to Antigravity\.'\);/,
        "function getSignedInPage() { return page(_i18nT('登录成功', 'You have successfully authenticated.'), _i18nT('已完成身份验证，你可以关闭此标签页并返回 Antigravity。', 'You can close this tab and return to Antigravity.')); }"
      ],
      [/respondPage\(res,\s*200,\s*SIGNED_IN\)/g, 'respondPage(res, 200, getSignedInPage())'],
      [/"Sign-in didn't finish"/g, "_i18nT('登录未完成', \"Sign-in didn't finish\")"],
      [/`Antigravity couldn't reach \$\{host\} to finish signing in\. `\s*\+\s*\r?\n\s*'Sign in again from Antigravity\.'/g, "_i18nT(`Antigravity 无法连接到 ${host} 以完成登录。请从 Antigravity 重新发起登录。`, `Antigravity couldn't reach ${host} to finish signing in. Sign in again from Antigravity.`)"],
      [/'This sign-in came back from another server than the sign-in page you '\s*\+\s*\r?\n\s*`agreed to, so Antigravity didn't pass it on to \$\{host\}\.`/g, "_i18nT(`此次登录来自与你同意的登录页不同的服务器，因此 Antigravity 未将其传递给 ${host}。`, `This sign-in came back from another server than the sign-in page you agreed to, so Antigravity didn't pass it on to ${host}.`)"],
      [/`Antigravity on \$\{host\} couldn't finish signing in \(HTTP \$\{status\}\)\. `\s*\+\s*\r?\n\s*'Sign in again from Antigravity\.'/g, "_i18nT(`${host} 上的 Antigravity 无法完成登录 (HTTP ${status})。请从 Antigravity 重新发起登录。`, `Antigravity on ${host} couldn't finish signing in (HTTP ${status}). Sign in again from Antigravity.`)"]
    ]);
  })) extraMainPatched++;

  if (patchFile(tempDir, path.join('dist', 'remote', 'sshPrompts.js'), (code) => {
    if (code.includes('function _i18nT(')) return code;
    return applyPairs(injectI18nTHelper(code, '../i18n_ota'), [
      [/<p class="context">Connecting to <span id="label"><\/span><\/p>/g, "<p class=\"context\">${_i18nT('正在连接到 ', 'Connecting to ')}<span id=\"label\"></span></p>"],
      [/Asked again: your last answer may not have worked\./g, "${_i18nT('再次提示：你上次的输入可能未通过验证。', 'Asked again: your last answer may not have worked.')}"],
      [/That's too long\./g, "${_i18nT('输入内容过长。', \"That's too long.\")}"],
      [/>Cancel<\/button><button id="continue"([^>]*)>Continue<\/button>/g, ">${_i18nT('取消', 'Cancel')}</button><button id=\"continue\"$1>${_i18nT('继续', 'Continue')}</button>"],
      [/return TOUCH_TITLE;/g, "return _i18nT('请触碰你的安全密钥', TOUCH_TITLE);"],
      [/confirm \? \['Yes', 'No'\] : \['Cancel'\]/g, "confirm ? [_i18nT('是', 'Yes'), _i18nT('否', 'No')] : [_i18nT('取消', 'Cancel')]"]
    ]);
  })) extraMainPatched++;

  if (patchFile(tempDir, path.join('dist', 'remote', 'sshPromptPreload.js'), (code) => {
    if (code.includes('function _i18nT(')) return code;
    return applyPairs(injectI18nTHelper(code, '../i18n_ota'), [
      [/asks\.textContent = `\$\{label\} asks:`;/g, "asks.textContent = _i18nT(`${label} 请求确认：`, `${label} asks:`);"]
    ]);
  })) extraMainPatched++;

  if (patchFile(tempDir, path.join('dist', 'remote', 'sshErrorText.js'), (code) => {
    if (code.includes('function _i18nT(')) return code;
    return applyPairs(injectI18nTHelper(code, '../i18n_ota'), [
      [/`Error code: \$\{err\.code\}\\nLogs: \$\{logPath\(\)\}`/g, "_i18nT(`错误代码：${err.code}\\n日志：${logPath()}`, `Error code: ${err.code}\\nLogs: ${logPath()}`)"],
      [/`\$\{label\} reported: \$\{text\}`/g, "_i18nT(`${label} 返回：${text}`, `${label} reported: ${text}`)"],
      [/'The connection was closed before it finished\.'/g, "_i18nT('连接尚未完成即已断开。', 'The connection was closed before it finished.')"],
      [/`Windows SSH hosts aren't supported yet\. \$\{sshArgs_1\.LINUX_HOST_NEEDED\}`/g, "_i18nT(`暂不支持 Windows SSH 主机。${sshArgs_1.getLinuxHostNeeded ? sshArgs_1.getLinuxHostNeeded() : sshArgs_1.LINUX_HOST_NEEDED}`, `Windows SSH hosts aren't supported yet. ${sshArgs_1.LINUX_HOST_NEEDED}`)"],
      [/`\$\{text\}\\nLogs: \$\{logPath\(\)\}`/g, "_i18nT(`${text}\\n日志：${logPath()}`, `${text}\\nLogs: ${logPath()}`)"]
    ]);
  })) extraMainPatched++;

  if (patchFile(tempDir, path.join('dist', 'remote', 'sshArgs.js'), (code) => {
    if (code.includes('function _i18nT(')) return code;
    return applyPairs(injectI18nTHelper(code, '../i18n_ota'), [
      [
        /(exports\.LINUX_HOST_NEEDED\s*=\s*'[^']+';)/,
        "$1\nfunction getLinuxHostNeeded() { return _i18nT('Antigravity 需要 glibc 2.26 及以上版本的 x64 或 arm64 Linux 主机。', exports.LINUX_HOST_NEEDED); }\nexports.getLinuxHostNeeded = getLinuxHostNeeded;"
      ],
      [/`Couldn't connect to the SSH host \(\$\{String\(code\)\}\)\.`/g, "_i18nT(`无法连接到 SSH 主机 (${String(code)})。`, `Couldn't connect to the SSH host (${String(code)}).`)"],
      [
        /const\s+AUTH_FAILED_TEXT\s*=\s*\{[\s\S]*?\};/,
        `const AUTH_FAILED_TEXT = {\n    get yes() { return _i18nT('SSH 身份验证失败。请检查密码、验证码或密钥后重试。', 'SSH authentication failed. Check your password, code or keys, then try again.'); },\n    get onReconnect() { return _i18nT('SSH 身份验证失败。请点击“重新连接”再次登录。', 'SSH authentication failed. Click Reconnect to sign in again.'); },\n    get no() { return _i18nT('SSH 身份验证失败。Antigravity 在 Windows 上暂不支持密码或验证码交互提示：请先通过 ssh-agent 配置密钥登录后重试。', \"SSH authentication failed. Antigravity can't answer password or code prompts on Windows yet: set up key-based login with ssh-agent, then try again.\"); },\n};`
      ],
      [/"That SSH host isn't valid\. Enter an alias from your SSH config or a host like user@host or user@host:2222\."/g, "_i18nT('该 SSH 主机地址无效。请输入 SSH 配置中的别名，或形如 user@host / user@host:2222 的地址。', \"That SSH host isn't valid. Enter an alias from your SSH config or a host like user@host or user@host:2222.\")"],
      [/"The host's SSH key is unknown or has changed\. Save it with ssh in a terminal\. If it changed, ask the host's owner first: the connection may be intercepted\."/g, "_i18nT('该主机的 SSH 密钥未知或已变更。请先在终端中使用 ssh 保存密钥；如果密钥发生变更，请先向主机管理员确认，连接可能正被拦截。', \"The host's SSH key is unknown or has changed. Save it with ssh in a terminal. If it changed, ask the host's owner first: the connection may be intercepted.\")"],
      [/"The host's SSH key has changed or isn't trusted\. If it changed, ask the host's owner first: the connection may be intercepted\."/g, "_i18nT('该主机的 SSH 密钥已变更或未受信任。如果密钥发生变更，请先向主机管理员确认，连接可能正被拦截。', \"The host's SSH key has changed or isn't trusted. If it changed, ask the host's owner first: the connection may be intercepted.\")"],
      [/`Couldn't connect to the SSH host\. Check its name, your network and ssh config \(e\.g\. a ProxyCommand\), and that ssh to it works in a terminal\$\{prompts === 'no' \? ' without a prompt' : ''\}\.`/g, "_i18nT(`无法连接到 SSH 主机。请检查主机名、网络和 SSH 配置（例如 ProxyCommand），并确认在终端中可执行 ssh 连接${prompts === 'no' ? '且无需交互提示' : ''}。`, `Couldn't connect to the SSH host. Check its name, your network and ssh config (e.g. a ProxyCommand), and that ssh to it works in a terminal${prompts === 'no' ? ' without a prompt' : ''}.`)"],
      [/"SSH can't use your SSH config file\. Fix the problem ssh reports, or choose another config file\."/g, "_i18nT('SSH 无法使用你的配置文件。请修复 ssh 提示的问题，或选择其他配置文件。', \"SSH can't use your SSH config file. Fix the problem ssh reports, or choose another config file.\")"],
      [/'SSH port forwarding failed\. Make sure the server allows TCP forwarding \(AllowTcpForwarding\) for your account, then try again\.'/g, "_i18nT('SSH 端口转发失败。请确认服务器允许你的账号使用 TCP 转发（AllowTcpForwarding）后重试。', 'SSH port forwarding failed. Make sure the server allows TCP forwarding (AllowTcpForwarding) for your account, then try again.')"],
      [/`The SSH host isn't supported\. \$\{exports\.LINUX_HOST_NEEDED\} Windows and macOS hosts aren't supported yet\.`/g, "_i18nT(`不支持此 SSH 主机。${getLinuxHostNeeded()}暂不支持 Windows 与 macOS 主机。`, `The SSH host isn't supported. ${exports.LINUX_HOST_NEEDED} Windows and macOS hosts aren't supported yet.`)"],
      [/'Another host that shares your home directory runs the Antigravity server\. Connect to that host, or connect again and choose Take Over\.'/g, "_i18nT('共享同一主目录的另一台主机正在运行 Antigravity 服务端。请改为连接到该主机，或重新连接并选择“接管”。', 'Another host that shares your home directory runs the Antigravity server. Connect to that host, or connect again and choose Take Over.')"],
      [/"Couldn't install the Antigravity server on the SSH host\. Make sure it has free disk space, and that it or this computer can download from the internet\."/g, "_i18nT('无法在 SSH 主机上安装 Antigravity 服务端。请确保磁盘空间充足，且该主机或本机可正常访问互联网下载组件。', \"Couldn't install the Antigravity server on the SSH host. Make sure it has free disk space, and that it or this computer can download from the internet.\")"],
      [/`The Antigravity server failed to start on the SSH host\. See its log in ~\/\$\{types_1\.REMOTE_INSTALL_ROOT\}\/data on that host\.`/g, "_i18nT(`SSH 主机上的 Antigravity 服务端启动失败。请查看该主机 ~/${types_1.REMOTE_INSTALL_ROOT}/data 目录下的日志。`, `The Antigravity server failed to start on the SSH host. See its log in ~/${types_1.REMOTE_INSTALL_ROOT}/data on that host.`)"],
      [/'The Antigravity server on the SSH host stopped\. Reconnect to start it again\.'/g, "_i18nT('SSH 主机上的 Antigravity 服务端已停止。请重新连接以再次启动。', 'The Antigravity server on the SSH host stopped. Reconnect to start it again.')"],
      [/'The SSH connection closed\. Check your network connection, then reconnect\.'/g, "_i18nT('SSH 连接已关闭。请检查网络连接后重新连接。', 'The SSH connection closed. Check your network connection, then reconnect.')"],
      [/'The connection was cancelled\.'/g, "_i18nT('连接已取消。', 'The connection was cancelled.')"],
      [/"Couldn't connect to the SSH host\. Try ssh to it in a terminal, and see the Antigravity log for details\."/g, "_i18nT('无法连接到 SSH 主机。请尝试在终端中执行 ssh 连接，并查看 Antigravity 日志了解详情。', \"Couldn't connect to the SSH host. Try ssh to it in a terminal, and see the Antigravity log for details.\")"]
    ]);
  })) extraMainPatched++;

  if (patchFile(tempDir, path.join('dist', 'remote', 'remoteManager.js'), (code) => {
    if (code.includes('function _i18nT(')) return code;
    return applyPairs(injectI18nTHelper(code, '../i18n_ota'), [
      [/title:\s*'Choose an SSH config file'/g, "title: _i18nT('选择 SSH 配置文件', 'Choose an SSH config file')"],
      [/title:\s*'Choose another SSH config file'/g, "title: _i18nT('选择其他 SSH 配置文件', 'Choose another SSH config file')"],
      [/title:\s*'SSH connection failed'/g, "title: _i18nT('SSH 连接失败', 'SSH connection failed')"],
      [/buttons:\s*\['Choose Another File…',\s*'Cancel'\]/g, "buttons: [_i18nT('选择其他文件...', 'Choose Another File…'), _i18nT('取消', 'Cancel')]"],
      [/buttons:\s*\['Stop Server',\s*'Cancel'\]/g, "buttons: [_i18nT('停止服务端', 'Stop Server'), _i18nT('取消', 'Cancel')]"],
      [/title:\s*'Stop SSH server'/g, "title: _i18nT('停止 SSH 服务端', 'Stop SSH server')"],
      [/`Stop the Antigravity server on \$\{entry\.label\}\?`/g, "_i18nT(`确定要停止 ${entry.label} 上的 Antigravity 服务端吗？`, `Stop the Antigravity server on ${entry.label}?`)"],
      [/'Agents running on this host will stop and its window will close\. '\s*\+\s*\r?\n\s*'The server starts again the next time you connect\.'/g, "_i18nT('此主机上正在运行的智能体将会停止，对应窗口也会关闭。下次连接时将自动重新启动服务端。', 'Agents running on this host will stop and its window will close. The server starts again the next time you connect.')"],
      [/'Could not stop the SSH server'/g, "_i18nT('无法停止 SSH 服务端', 'Could not stop the SSH server')"],
      [/`Not connected to \$\{label\}`/g, "_i18nT(`尚未连接到 ${label}`, `Not connected to ${label}`)"],
      [/'Reconnect first, then stop its server\.'/g, "_i18nT('请先重新连接，然后再停止其服务端。', 'Reconnect first, then stop its server.')"],
      [/buttons:\s*\['Sign In',\s*'Cancel'\]/g, "buttons: [_i18nT('登录', 'Sign In'), _i18nT('取消', 'Cancel')]"],
      [/title:\s*'Sign in'/g, "title: _i18nT('登录', 'Sign in')"],
      [/`Sign in to your organization for \$\{entry\.label\}\?`/g, "_i18nT(`是否为 ${entry.label} 登录你的组织？`, `Sign in to your organization for ${entry.label}?`)"],
      [/'Continue only if you just chose to sign in with your organization '\s*\+\s*\r?\n\s*`in this window\. \$\{entry\.label\} will get access to your `\s*\+\s*\r?\n\s*"organization's Google Cloud account\.\\n"/g, "_i18nT(`仅当你刚刚在此窗口中主动选择使用组织账号登录时才继续。${entry.label} 将获得你组织的 Google Cloud 账号访问权限。\\n`, `Continue only if you just chose to sign in with your organization in this window. ${entry.label} will get access to your organization's Google Cloud account.\\n`)"],
      [/`Workforce pool: \$\{names\[1\]\}  Provider: \$\{names\[2\]\}`/g, "_i18nT(`员工身份池：${names[1]}  身份提供商：${names[2]}`, `Workforce pool: ${names[1]}  Provider: ${names[2]}`)"],
      [/`Identity provider: \$\{provider\}`/g, "_i18nT(`身份提供商：${provider}`, `Identity provider: ${provider}`)"]
    ]);
  })) extraMainPatched++;
  if (extraMainPatched > 0) {
    console.log(` - 其余主进程弹窗与远程页面补丁完成 (${extraMainPatched} 个模块)`);
  }

  // 8. 编译并写入前端 i18n 引擎、主进程 OTA 热更新模块与原生菜单字典至打包临时目录
  const { buildEngine, cleanDictObject } = require('./build_clean_engine');
  const { engineScript, dictCount, builtinMeta } = buildEngine();
  console.log(`[3/4] 正在内联生成 ${dictCount || '全量'} 词条确定性引擎与 OTA 热更模块...`);
  fs.writeFileSync(path.join(tempDir, 'dist', 'i18n.js'), engineScript, 'utf8');
  const preserveList = JSON.parse(fs.readFileSync(path.join(projectRoot, 'assets', 'preserve_list.json'), 'utf8'));
  fs.writeFileSync(path.join(tempDir, 'dist', 'i18n_meta.json'), JSON.stringify({ ...builtinMeta, preserveList }, null, 2) + '\n', 'utf8');
  const otaMainSrc = path.join(__dirname, 'ota', 'i18n_ota_main.js');
  if (!fs.existsSync(otaMainSrc)) {
    throw new Error(`未找到主进程 OTA 模块: ${otaMainSrc}`);
  }
  fs.copyFileSync(otaMainSrc, path.join(tempDir, 'dist', 'i18n_ota.js'));
  const rawDict = JSON.parse(fs.readFileSync(path.join(projectRoot, 'assets', 'dictionary.json'), 'utf8'));
  const cleanedDict = cleanDictObject(rawDict, preserveList);
  const nativeMenuDict = {};
  for (const [k, v] of Object.entries(cleanedDict)) {
    if (k.length <= 80 && !k.includes('\n')) nativeMenuDict[k] = v;
  }
  fs.writeFileSync(path.join(tempDir, 'dist', 'native_context_dict.json'), JSON.stringify(nativeMenuDict), 'utf8');

  // 9. 打包至 build/app.asar 并部署安装目录，清理多余 build/app.asar.unpacked
  console.log('[4/4] 正在打包并部署生产核心...');
  const outputAsar = path.join(buildDir, 'app.asar');
  const unpackedDirs = detectUnpackedDirs(asarPath);
  const unpackGlob = unpackedDirs.length === 1 ? unpackedDirs[0] : `{${unpackedDirs.join(',')}}`;
  await asar.createPackageWithOptions(tempDir, outputAsar, {
    unpackDir: unpackGlob
  });

  deployAsarSafely(outputAsar, asarPath);
  try { asar.uncacheAll(); } catch (_) {}
  resignMacAppIfNeeded(appBundle);

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('==========================================');
  console.log(`  成功！Antigravity v${version} 汉化完成 [补丁 v${patchVersion}] (耗时: ${duration}s) `);
  console.log('==========================================');
  } finally {
    try {
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
    try {
      if (fs.existsSync(buildUnpackedDir)) fs.rmSync(buildUnpackedDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

if (require.main === module) {
  patchAsar().catch((err) => {
    console.error('[错误] 补丁执行失败:', err);
    process.exit(1);
  });
}

module.exports = {
  hasAnyPatchArtifacts,
  isAsarPatched,
  patchAsar,
  asarPath,
  installDir
};
