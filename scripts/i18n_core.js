const fs = require('fs');
const os = require('os');
const path = require('path');
const asar = require('@electron/asar');

const defaultInstallDir = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'resources')
  : path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'antigravity', 'resources');
const installDir = process.env.ANTIGRAVITY_RESOURCES || defaultInstallDir;
const asarPath = path.join(installDir, 'app.asar');
const projectRoot = path.resolve(__dirname, '..');
const buildDir = path.join(projectRoot, 'build');

/**
 * 极速检测 app.asar 是否处于已注入汉化状态
 */
function isAsarPatched(targetAsar = asarPath) {
  if (!fs.existsSync(targetAsar)) return false;
  try {
    const i18nStat = asar.statFile(targetAsar, path.join('dist', 'i18n.js'));
    if (!i18nStat) return false;
    const menuBuf = asar.extractFile(targetAsar, path.join('dist', 'menu.js'));
    return menuBuf.includes('translateMenuRecursively');
  } catch (_) {
    return false;
  }
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

/**
 * 纯内联、零外部进程、极速自动注入汉化补丁
 */
async function patchAsar() {
  const startTime = Date.now();
  console.log('==========================================');
  console.log('  Antigravity 高性能极速自愈补丁引擎      ');
  console.log('==========================================');

  if (!fs.existsSync(asarPath)) {
    throw new Error(`未找到目标 app.asar: ${asarPath}`);
  }

  fs.mkdirSync(buildDir, { recursive: true });
  const tempDir = path.join(buildDir, '.temp-patch-dir');
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const backupAsar = path.join(installDir, 'app.asar.bak');
  let sourceAsar = asarPath;
  let currentVersion = 'unknown';
  try {
    currentVersion = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8')).version || 'unknown';
  } catch (_) {}

  const alreadyPatched = isAsarPatched(asarPath);
  if (alreadyPatched && fs.existsSync(backupAsar) && !isAsarPatched(backupAsar)) {
    try {
      const bakVersion = JSON.parse(asar.extractFile(backupAsar, 'package.json').toString('utf8')).version || 'unknown';
      if (bakVersion === currentVersion) {
        sourceAsar = backupAsar;
        console.log(` - 检测到同版本干净备份 (${backupAsar})，将从原版重新生成纯净补丁`);
      }
    } catch (_) {}
  } else if (!alreadyPatched) {
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

  // 1. 注入 utils.js (模块级缓存 + DOM-ready 零延迟引擎加载 + 内部/插件 subframe 注入，严格隔离外部网页与用户本地预览)
  patchFile(tempDir, 'dist/utils.js', (code) => {
    if (
      code.includes('did-frame-finish-load') &&
      code.includes('__antigravityTranslateAll') &&
      code.includes('_getAntigravityI18nCode') &&
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
`;
    const hook = `
    win.webContents.on('dom-ready', () => {
        const code = _getAntigravityI18nCode();
        if (code) {
            win.webContents.executeJavaScript(code).catch(console.error);
        }
    });
    win.webContents.on('did-finish-load', () => {
        win.webContents.executeJavaScript(\`
            if (window.__antigravityTranslateAll) {
                window.__antigravityTranslateAll();
            }
        \`).catch(console.error);
    });
    win.webContents.on('did-frame-finish-load', (_event, isMainFrame, frameProcessId, frameRoutingId) => {
        if (isMainFrame) return;
        try {
            const { webFrameMain } = require('electron');
            const frame = webFrameMain && webFrameMain.fromId(frameProcessId, frameRoutingId);
            const frameUrl = frame && frame.url ? frame.url : '';
            let mainOrigin = '';
            let frameOrigin = '';
            try { mainOrigin = new URL(win.webContents.getURL()).origin; } catch (_) {}
            try { frameOrigin = new URL(frameUrl).origin; } catch (_) {}
            if (
                frameUrl.startsWith('plugin://') ||
                frameUrl.startsWith('vscode-webview://') ||
                (mainOrigin && mainOrigin !== 'null' && frameOrigin === mainOrigin)
            ) {
                const i18nCode = _getAntigravityI18nCode();
                if (i18nCode) {
                    frame.executeJavaScript(i18nCode).catch(() => {});
                }
            }
        } catch (_) {}
    });
    void win.loadURL(url);`;
    let next = code;
    if (!next.includes('function _getAntigravityI18nCode')) {
      next = next.replace(
        /(const\s+fs\s*=\s*__importStar\(require\("fs"\)\);)/,
        `$1\n${moduleCacheHelper}`
      );
    }
    return next.replace(/void\s+win\.loadURL\(url\);/, hook);
  });
  const utilsPatched = fs.readFileSync(path.join(tempDir, 'dist', 'utils.js'), 'utf8');
  if (utilsPatched.includes('__antigravityTranslateAll') && utilsPatched.includes('did-frame-finish-load')) {
    console.log(' - utils.js 零延迟引擎与插件框架注入完成');
  } else {
    console.warn(' [警告] utils.js 注入钩子未命中，请检查官方代码是否变更！');
  }

  // 2. 注入 menu.js (系统菜单栏递归翻译 + 异步 WSL 菜单兼容 + 已打补丁增量升级)
  if (patchFile(tempDir, 'dist/menu.js', (code) => {
    if (code.includes('MENU_I18N')) {
      return applyPairs(code, [
        [/'Toggle Full Screen':\s*'全屏模式'/g, "'Toggle Full Screen': '切换全屏'"],
        [/'Toggle Fullscreen':\s*'全屏模式'/g, "'Toggle Fullscreen': '切换全屏'"],
        [/'Zoom':\s*'最大化\/缩放'/g, "'Zoom': '缩放'"],
        [/'Docs':\s*'文档指南'/g, "'Docs': '文档'"],
        [/'Update Available':\s*'发现可用更新'/g, "'Update Available': '有可用更新'"],
        [/label:\s*'文档指南'/g, "label: '文档'"]
      ]);
    }
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
function translateMenuRecursively(menu) {
    if (!menu || !menu.items) return;
    menu.items.forEach((item) => {
        if (item.label && Object.prototype.hasOwnProperty.call(MENU_I18N, item.label)) item.label = MENU_I18N[item.label];
        if (item.submenu) translateMenuRecursively(item.submenu);
    });
}
`;
    return applyPairs(code, [
      [/(exports\.setupApplicationMenu\s*=\s*setupApplicationMenu;)/, `$1\n${menuHook}`],
      [/label:\s*'New Window'/g, "label: '新建窗口'"],
      [/label:\s*'Docs'/g, "label: '文档'"],
      [/label:\s*'Connect to WSL'/g, "label: '连接到 WSL'"],
      [/label:\s*'Reopen Locally'/g, "label: '在本地重新打开'"],
      [/appMenu\.items\.find\(\(item\)\s*=>\s*item\.label\s*===\s*submenuLabel\)/g, "appMenu.items.find((item) => item.label === submenuLabel || (MENU_I18N[submenuLabel] && item.label === MENU_I18N[submenuLabel]))"],
      [/electron_1\.Menu\.setApplicationMenu\(menu\);/g, "{ translateMenuRecursively(menu); electron_1.Menu.setApplicationMenu(menu); }"]
    ]);
  })) {
    console.log(' - menu.js 菜单递归汉化与 WSL 子菜单修复完成');
  }

  // 3. 注入 tray.js
  if (patchFile(tempDir, 'dist/tray.js', (code) => applyPairs(code, [
    [/\(count > 0 \? `\$\{count\}` : 'No'\)\s*\+\s*' agent'\s*\+\s*\(count === 1 \? '' : 's'\)\s*\+\s*' running'/, "(count > 0 ? `${count} 个智能体正在运行` : '暂无运行中的智能体')"],
    [/'当前无运行中的智能体'/g, "'暂无运行中的智能体'"]
  ]))) {
    console.log(' - tray.js 托盘文字汉化完成');
  }

  // 4. 注入 main.js
  if (patchFile(tempDir, 'dist/main.js', (code) => applyPairs(code, [
    [/label:\s*'New Window'/g, "label: '新建窗口'"],
    [/label:\s*'(?:No agents running|当前无运行中的智能体)'/g, "label: '暂无运行中的智能体'"],
    [/label:\s*`Open \$\{electron_1\.app\.getName\(\)\}`/g, "label: `打开 ${electron_1.app.getName()}`"],
    [/label:\s*'Quit'/g, "label: '退出'"],
    [/buttons:\s*\['Cancel',\s*'Quit'\]/g, "buttons: ['取消', '退出']"],
    [/title:\s*'Confirm Quit'/g, "title: '确认退出'"],
    [/message:\s*'Are you sure you want to quit\?'/g, "message: '确定要退出吗？'"],
    [/detail:\s*'There may be agents or background tasks running\.'/g, "detail: '当前可能有智能体或后台任务正在运行。'"],
    [/showErrorBox\('Binary not found'/g, "showErrorBox('未找到核心程序'"],
    [/title:\s*'WSL distro not found'/g, "title: '未找到 WSL 发行版'"],
    [/message:\s*`(?:The WSL distro "\$\{WSL_DISTRO\}" is no longer installed\.|WSL 发行版“\$\{WSL_DISTRO\}”已不再安装。)`/g, "message: `WSL 发行版“${WSL_DISTRO}”未安装或已被卸载。`"],
    [/detail:\s*'Antigravity opened on Windows instead\.'/g, "detail: '已改为在 Windows 本地打开 Antigravity。'"],
    [/showErrorBox\('WSL setup failed'/g, "showErrorBox('WSL 配置失败'"],
    [/showErrorBox\('Startup failed'/g, "showErrorBox('启动失败'"]
  ]))) {
    console.log(' - main.js 托盘初始项与系统弹窗汉化完成');
  }

  // 5. 注入 updater.js（菜单更新文案 + quitAndInstall / will-quit 自愈唤醒钩子）
  const autoPatchPathLiteral = JSON.stringify(path.join(__dirname, 'auto_patch_on_update.js'));
  const preferredNodeLiteral = JSON.stringify(!process.versions.electron ? process.execPath : '');
  patchFile(tempDir, 'dist/updater.js', (code) => {
    let next = applyPairs(code, [
      [/MenuUpdateStep\["CheckForUpdates"\]\s*=\s*"Check for Updates";/g, 'MenuUpdateStep["CheckForUpdates"] = "检查更新";'],
      [/MenuUpdateStep\["CheckingForUpdates"\]\s*=\s*"Checking for Updates\.\.\.";/g, 'MenuUpdateStep["CheckingForUpdates"] = "正在检查更新...";'],
      [/MenuUpdateStep\["DownloadingUpdate"\]\s*=\s*"Downloading Update\.\.\.";/g, 'MenuUpdateStep["DownloadingUpdate"] = "正在下载更新...";'],
      [/MenuUpdateStep\["RestartToUpdate"\]\s*=\s*"Restart to Update";/g, 'MenuUpdateStep["RestartToUpdate"] = "重启以更新";'],
      [/title:\s*'Check for Updates'/g, "title: '检查更新'"],
      [/message:\s*'No updates available'/g, "message: '当前已是最新版本'"],
      [/buttons:\s*\['OK'\]/g, "buttons: ['确定']"]
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
      const updaterHook = `${spawnHelper}function quitAndInstall() {
    spawnAutoPatcherOnUpdate(true);
    electron_updater_1.autoUpdater.quitAndInstall();
}`;
      next = next.replace(/function\s+quitAndInstall\(\)\s*\{[\s\S]*?electron_updater_1\.autoUpdater\.quitAndInstall\(\);\s*\}/, updaterHook);
      next = next.replace(
        /(electron_updater_1\.autoUpdater\.autoInstallOnAppQuit\s*=\s*electron_1\.app\.isPackaged;)/,
        `$1\n    electron_1.app.once('will-quit', () => { if (lastState && lastState.type === types_1.UpdateState.Ready) spawnAutoPatcherOnUpdate(false); });`
      );
    }
    return next;
  });
  const updaterPatched = fs.readFileSync(path.join(tempDir, 'dist', 'updater.js'), 'utf8');
  if (updaterPatched.includes('auto_patch_on_update.js') && updaterPatched.includes('spawnAutoPatcherOnUpdate')) {
    console.log(' - updater.js 更新文案及自愈唤醒钩子注入完成');
  } else {
    console.warn(' [警告] updater.js 自愈唤醒钩子未命中，请检查官方代码是否变更！');
  }

  // 6. 注入 WSL 配置页、IPC 对话框 / 更新通道 / 通知、安全弹窗与安装向导
  if (patchFile(tempDir, 'dist/provisionSplash.js', (code) => code.replace(
    /<div>Setting up WSL: \$\{escapeHtml\(distro\)\}<\/div>/g,
    '<div>正在配置 WSL：${escapeHtml(distro)}</div>'
  ))) {
    console.log(' - provisionSplash.js WSL 配置页面汉化完成');
  }

  patchFile(tempDir, 'dist/ipcHandlers.js', (code) => {
    let next = applyPairs(code, [
      [/'Cannot open folder'/g, "'无法打开文件夹'"],
      [/'Folder is on the Windows filesystem'/g, "'文件夹位于 Windows 文件系统中'"],
      [/'Open workspaces'/g, "'打开工作区'"],
      [/'Open workspace'/g, "'打开工作区'"],
      [/'Select Download Folder'/g, "'选择下载文件夹'"],
      [
        /(localOnly\('updater:quit-and-install',\s*\(\)\s*=>\s*\{[\s\S]*?)electron_updater_1\.autoUpdater\.quitAndInstall\(\);(\s*\}\);)/,
        '$1(0, updater_1.quitAndInstall)();$2'
      ]
    ]);
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
        if (_nativeContextDict.has(trimmed)) return _nativeContextDict.get(trimmed);
        const low = trimmed.toLowerCase();
        if (_nativeContextLower.has(low)) return _nativeContextLower.get(low);
        const defMatch = trimmed.match(/^(.+?)\\s+\\(Default\\)$/i);
        if (defMatch) {
            const base = defMatch[1].trim();
            const baseZh = _nativeContextDict.get(base) || _nativeContextLower.get(base.toLowerCase()) || base;
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

  if (patchFile(tempDir, 'dist/webviewPopupSecurity.js', (code) => applyPairs(code, [
    [/'(?:Your connection to this site is not secure|您与该网站的连接不安全)'/g, "'你与该网站的连接不安全'"],
    [/'You should not enter any sensitive information on this site \(for '\s*\+\s*\r?\n\s*'example, passwords or credit cards\), because it could be stolen by '\s*\+\s*\r?\n\s*'attackers\.'/g, "'请勿在此网站上输入任何敏感信息（例如密码或信用卡信息），否则可能会被攻击者窃取。'"],
    [/'Connection is secure'/g, "'连接安全'"],
    [/'(?:Your information \(for example, passwords or credit card numbers\) is '\s*\+\s*\r?\n\s*'private when it is sent to this site\.|您的信息（例如密码或信用卡号）在发送到此网站时会保持私密。)'/g, "'你的信息（例如密码或信用卡号）在发送到此网站时会保持私密。'"],
    [/'Connection security information is not available for this page'/g, "'此页面暂无连接安全信息'"],
    [/'⚠ Not secure'/g, "'⚠ 不安全'"],
    [/'Not secure'/g, "'不安全'"],
    [/'Certificate is valid'/g, "'证书有效'"],
    [/'Certificate details'/g, "'证书详情'"],
    [/`Error: \$\{state\.certificateError\}`/g, "`错误：${state.certificateError}`"],
    [/`Issued to: \$\{certificate\.subjectName\}`/g, "`颁发给：${certificate.subjectName}`"],
    [/`Issued by: \$\{certificate\.issuer\}`/g, "`颁发者：${certificate.issuer}`"],
    [/`Valid from: \$\{formatDate\(certificate\.validFromMs\)\}`/g, "`生效时间：${formatDate(certificate.validFromMs)}`"],
    [/`(?:Valid until|过期时间):?\s*\$\{formatDate\(certificate\.validToMs\)\}`/g, "`有效期至：${formatDate(certificate.validToMs)}`"],
    [/`过期时间：\$\{formatDate\(certificate\.validToMs\)\}`/g, "`有效期至：${formatDate(certificate.validToMs)}`"],
    [/`Protocol: \$\{certificate\.protocol\}`/g, "`协议：${certificate.protocol}`"],
    [/:\s*'unknown'/g, ": '未知'"],
    [/'This page'/g, "'此页面'"],
    [/'(?:Connection info…|连接信息…)'/g, "'连接信息...'"],
    [/'Connection info\.\.\.'/g, "'连接信息...'"],
    [/'Connection info'/g, "'连接信息'"],
    [/buttons:\s*\['OK'\]/g, "buttons: ['确定']"]
  ]))) {
    console.log(' - webviewPopupSecurity.js 安全弹窗文案全量汉化完成');
  }

  if (patchFile(tempDir, path.join('dist', 'ideInstall', 'wizardHtml.js'), (code) => applyPairs(code, [
    [/>Welcome to Antigravity</g, '>欢迎使用 Antigravity<'],
    [/>(?:Setting up…|正在配置…)</g, '>正在配置...<'],
    [/>Setting up\.\.\.</g, '>正在配置...<'],
    [/>Welcome to the new Antigravity!</g, '>欢迎体验全新 Antigravity！<'],
    [/<p>(?:Antigravity has been redesigned to put agents first with new capabilities\. If you'd still like a code editor, you can download it as a separate app named <b>Antigravity IDE<\/b>\.|Antigravity 已全新重构，以智能体为核心并提供全新能力。如果您仍需要传统代码编辑器，可将其作为名为 <b>Antigravity IDE<\/b> 的独立应用下载。)<\/p>/g, '<p>Antigravity 已全新重构，以智能体为核心并提供全新能力。如果你仍需要传统代码编辑器，可单独下载 <b>Antigravity IDE</b> 应用。</p>'],
    [/>Download the Antigravity IDE</g, '>下载 Antigravity IDE<'],
    [/>Explore the new Antigravity</g, '>探索全新 Antigravity<']
  ]))) {
    console.log(' - ideInstall/wizardHtml.js IDE 安装引导页全量汉化完成');
  }

  // 7. 注入 languageServer.js (Go 核心进程可选代理隔离注入，仅当显式配置 ANTIGRAVITY_PROXY 时生效)
  if (patchFile(tempDir, 'dist/languageServer.js', (lsCode) => {
    if (lsCode.includes('ANTIGRAVITY_PROXY_INJECTED')) return lsCode;
    const proxyHook = `
        // ANTIGRAVITY_PROXY_INJECTED: 仅当显式设置 ANTIGRAVITY_PROXY 时为 Go 后台核心注入局部代理
        const _agyRawProxy = (process.env.ANTIGRAVITY_PROXY || '').trim();
        if (_agyRawProxy) {
          const _agyDefaultProxy = /^socks\\d*:\\/\\//i.test(_agyRawProxy)
              ? _agyRawProxy.replace(/^socks\\d*:\\/\\//i, 'http://')
              : (/^https?:\\/\\//i.test(_agyRawProxy) ? _agyRawProxy : \`http://\${_agyRawProxy}\`);
          const _agyDefaultSocks = /^socks\\d*:\\/\\//i.test(_agyRawProxy)
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

  // 7.5 注入其余主进程原生弹窗与 SSH 远程页面 (deviceChooser / webauthn / cablev2 / remote/*)
  let extraMainPatched = 0;
  if (patchFile(tempDir, 'dist/deviceChooser.js', (code) => applyPairs(code, [
    [/hid:\s*'HID device'/g, "hid: 'HID 设备'"],
    [/usb:\s*'USB device'/g, "usb: 'USB 设备'"],
    [/serial:\s*'serial port'/g, "serial: '串口设备'"],
    [/'Unknown device'/g, "'未知设备'"],
    [/title:\s*'Connect a device'/g, "title: '连接设备'"],
    [/`\$\{origin\} wants to connect to a \$\{KIND_NOUNS\[kind\]\}`/g, "`${origin} 请求连接 ${KIND_NOUNS[kind]}`"],
    [/'Select a device:'/g, "'请选择设备：'"],
    [/'No compatible devices found\.'/g, "'未找到兼容设备。'"],
    [/,\s*'Cancel'\]/g, ", '取消']"]
  ]))) extraMainPatched++;

  if (patchFile(tempDir, 'dist/webauthn.js', (code) => applyPairs(code, [
    [/details\.relyingPartyId\s*\|\|\s*'this site'/g, "details.relyingPartyId || '此网站'"],
    [/title:\s*'Choose a Passkey'/g, "title: '选择通行密钥'"],
    [/message:\s*`Sign in to \$\{rpLabel\}`/g, "message: `登录 ${rpLabel}`"],
    [/detail:\s*'Select a passkey account to continue:'/g, "detail: '请选择通行密钥账号以继续：'"],
    [/buttons:\s*\[\.\.\.accountLabels,\s*'Cancel'\]/g, "buttons: [...accountLabels, '取消']"]
  ]))) extraMainPatched++;

  if (patchFile(tempDir, 'dist/cablev2.js', (code) => applyPairs(code, [
    [/<title>Passkeys<\/title>/g, '<title>通行密钥</title>'],
    [/<h1 class="sheet-title">Passkeys<\/h1>/g, '<h1 class="sheet-title">通行密钥</h1>'],
    [/<p class="mechanism-header">Use your phone or tablet<\/p>/g, '<p class="mechanism-header">使用手机或平板电脑</p>'],
    [/Scan this QR code with the camera on the device that has your passkey for \$\{safeRpId\}/g, '使用存有 ${safeRpId} 通行密钥的设备摄像头扫描此二维码'],
    [/>Cancel<\/button>/g, '>取消</button>'],
    [/'(?:Connecting to your device…|正在连接到您的设备…)'/g, "'正在连接到你的设备...'"],
    [/'(?:Verify on your device to continue…|请在您的设备上完成验证以继续…)'/g, "'请在你的设备上完成验证以继续...'"]
  ]))) extraMainPatched++;

  if (patchFile(tempDir, path.join('dist', 'remote', 'disconnectedPage.js'), (code) => applyPairs(code, [
    [/reconnect:\s*'Reconnect'/g, "reconnect: '重新连接'"],
    [/stop:\s*'Stop Server'/g, "stop: '停止服务端'"],
    [/close:\s*'Close'/g, "close: '关闭'"],
    [/connecting \? 'Reconnecting…' : 'Disconnected'/g, "connecting ? '正在重新连接...' : '连接已断开'"],
    [/'Restarting…'/g, "'正在重启...'"],
    [/'Reconnecting…'/g, "'正在重新连接...'"],
    [/'Disconnected'/g, "'连接已断开'"],
    [/`Restarting the Antigravity server on \$\{host\}…`/g, "`正在重启 ${host} 上的 Antigravity 服务端...`"],
    [/`(?:Reconnecting to \$\{host\}…|正在重新连接到 \$\{host\}…)`/g, "`正在重新连接到 ${host}...`"],
    [/`Disconnected from \$\{host\}`/g, "`已断开与 ${host} 的连接`"],
    [/'This window opens it again once it has started\.'/g, "'启动完成后此窗口将自动重新打开。'"],
    [/`Its server on \$\{host\} stopped, and its agents with it\.`/g, "`${host} 上的服务端已停止，对应的智能体也随之停止。`"],
    [/`Its agents on \$\{host\} stopped with it\.`/g, "`${host} 上的智能体也随之停止。`"],
    [/`Agents keep running on \$\{host\}\.`/g, "`智能体仍会继续在 ${host} 上运行。`"],
    [/`Agents keep running on \$\{host\} unless its server stopped\.`/g, "`除非服务端已停止，否则智能体仍会继续在 ${host} 上运行。`"],
    [/>Reconnect<\/a>/g, '>重新连接</a>'],
    [/>Close<\/a>/g, '>关闭</a>']
  ]))) extraMainPatched++;

  if (patchFile(tempDir, path.join('dist', 'remote', 'signInCallback.js'), (code) => applyPairs(code, [
    [/page\('Signed in',\s*'Signed in\. You can close this tab\.'\)/g, "page('登录成功', '已完成登录，你可以关闭此标签页。')"],
    [/page\('You have successfully authenticated\.',\s*'You can close this tab and return to Antigravity\.'\)/g, "page('登录成功', '已完成身份验证，你可以关闭此标签页并返回 Antigravity。')"],
    [/'已完成登录，您可以关闭此标签页。'/g, "'已完成登录，你可以关闭此标签页。'"],
    [/'Sign-in did not complete'/g, "'登录未完成'"],
    [/"Sign-in didn't finish"/g, "'登录未完成'"],
    [/'The Antigravity server on the SSH host could not be reached\. '\s*\+\s*\r?\n\s*'Sign in again from Antigravity\.'/g, "'无法连接到 SSH 主机上的 Antigravity 服务。请从 Antigravity 重新发起登录。'"],
    [/`Antigravity couldn't reach \$\{host\} to finish signing in\. `\s*\+\s*\r?\n\s*'Sign in again from Antigravity\.'/g, "`Antigravity 无法连接到 ${host} 以完成登录。请从 Antigravity 重新发起登录。`"],
    [/'This sign-in came back from another server than the sign-in page you '\s*\+\s*\r?\n\s*`agreed to, so Antigravity didn't pass it on to \$\{host\}\.`/g, "`此次登录来自与你同意的登录页不同的服务器，因此 Antigravity 未将其传递给 ${host}。`"],
    [/`The Antigravity server on the SSH host answered with HTTP \$\{status\}\. `\s*\+\s*\r?\n\s*'Sign in again from Antigravity\.'/g, "`SSH 主机上的 Antigravity 服务返回了 HTTP ${status}。请从 Antigravity 重新发起登录。`"],
    [/`Antigravity on \$\{host\} couldn't finish signing in \(HTTP \$\{status\}\)\. `\s*\+\s*\r?\n\s*'Sign in again from Antigravity\.'/g, "`${host} 上的 Antigravity 无法完成登录 (HTTP ${status})。请从 Antigravity 重新发起登录。`"]
  ]))) extraMainPatched++;

  if (patchFile(tempDir, path.join('dist', 'remote', 'sshPrompts.js'), (code) => applyPairs(code, [
    [/(?:Asked again: your last answer may not have worked\.|再次提示：您上次的输入可能未通过验证。)/g, '再次提示：你上次的输入可能未通过验证。'],
    [/That's too long\./g, '输入内容过长。'],
    [/>Cancel<\/button><button id="continue">Continue<\/button>/g, '>取消</button><button id="continue">继续</button>'],
    [/confirm \? `\$\{label\} asks:` : 'Touch your security key'/g, "confirm ? `${label} 请求确认：` : '请触碰你的安全密钥'"],
    [/'Touch your security key'/g, "'请触碰你的安全密钥'"],
    [/'请触碰您的安全密钥'/g, "'请触碰你的安全密钥'"],
    [/confirm \? \['Yes', 'No'\] : \['Cancel'\]/g, "confirm ? ['是', '否'] : ['取消']"]
  ]))) extraMainPatched++;

  if (patchFile(tempDir, path.join('dist', 'remote', 'sshPromptPreload.js'), (code) => applyPairs(code, [
    [/asks\.textContent = `\$\{label\} asks:`;/g, "asks.textContent = `${label} 请求确认：`;"]
  ]))) extraMainPatched++;

  if (patchFile(tempDir, path.join('dist', 'remote', 'sshErrorText.js'), (code) => applyPairs(code, [
    [/`Error code: \$\{err\.code\}\\nLogs: \$\{logPath\(\)\}`/g, "`错误代码：${err.code}\\n日志：${logPath()}`"],
    [/`\$\{label\} reported: \$\{text\}`/g, "`${label} 返回：${text}`"],
    [/'(?:The connection was closed before it finished\.|连接在完成前已关闭。)'/g, "'连接尚未完成即已断开。'"],
    [/`\$\{what\}\\nFile: \$\{note\} on \$\{label\}`/g, "`${what}\\n文件：${label} 上的 ${note}`"],
    [/`\$\{text\}\\nLogs: \$\{logPath\(\)\}`/g, "`${text}\\n日志：${logPath()}`"]
  ]))) extraMainPatched++;

  if (patchFile(tempDir, path.join('dist', 'remote', 'sshArgs.js'), (code) => applyPairs(code, [
    [/`Couldn't connect to the SSH host \(\$\{String\(code\)\}\)\.`/g, "`无法连接到 SSH 主机 (${String(code)})。`"],
    [/yes:\s*'SSH authentication failed\. Check your password, code or keys, then try again\.'/g, "yes: 'SSH 身份验证失败。请检查密码、验证码或密钥后重试。'"],
    [/onReconnect:\s*'SSH authentication failed\. Click Reconnect to sign in again\.'/g, "onReconnect: 'SSH 身份验证失败。请点击“重新连接”再次登录。'"],
    [/no:\s*"(?:SSH authentication failed\. Antigravity can't answer password or code prompts on Windows yet: set up key-based login with ssh-agent, then try again\.|SSH 身份验证失败。Windows 暂不支持自动响应密码或验证码提示：请先通过 ssh-agent 配置密钥登录后重试。)"/g, 'no: "SSH 身份验证失败。Antigravity 在 Windows 上暂不支持密码或验证码交互提示：请先通过 ssh-agent 配置密钥登录后重试。"'],
    [/"That SSH host isn't valid\. Enter an alias from your SSH config or a host like user@host or user@host:2222\."/g, '"该 SSH 主机地址无效。请输入 SSH 配置中的别名，或形如 user@host / user@host:2222 的地址。"'],
    [/"The host's SSH key is unknown or has changed\. Save it with ssh in a terminal\. If it changed, ask the host's owner first: the connection may be intercepted\."/g, '"该主机的 SSH 密钥未知或已变更。请先在终端中使用 ssh 保存密钥；如果密钥发生变更，请先向主机管理员确认，连接可能正被拦截。"'],
    [/"The host's SSH key has changed or isn't trusted\. If it changed, ask the host's owner first: the connection may be intercepted\."/g, '"该主机的 SSH 密钥已变更或未受信任。如果密钥发生变更，请先向主机管理员确认，连接可能正被拦截。"'],
    [/`Couldn't connect to the SSH host\. Check its name, your network and ssh config \(e\.g\. a ProxyCommand\), and that ssh to it works in a terminal\$\{prompts === 'no' \? ' without a prompt' : ''\}\.`/g, "`无法连接到 SSH 主机。请检查主机名、网络和 SSH 配置（例如 ProxyCommand），并确认在终端中可执行 ssh 连接${prompts === 'no' ? '且无需交互提示' : ''}。`"],
    [/'(?:SSH port forwarding failed\. Make sure the server allows TCP forwarding \(AllowTcpForwarding\) for your account, then try again\.|SSH 端口转发失败。请确认服务器允许您的账号使用 TCP 转发（AllowTcpForwarding）后重试。)'/g, "'SSH 端口转发失败。请确认服务器允许你的账号使用 TCP 转发（AllowTcpForwarding）后重试。'"],
    [/"The SSH host isn't supported\. Antigravity needs Linux on x64 or arm64 with glibc 2\.26 or newer\."/g, '"不支持此 SSH 主机。Antigravity 需要 glibc 2.26 及以上版本的 x64 或 arm64 Linux 系统。"'],
    [/'Another host that shares your home directory runs the Antigravity server\. Connect to that host instead\.'/g, "'共享同一主目录的另一台主机正在运行 Antigravity 服务端，请改为连接到该主机。'"],
    [/"Couldn't install the Antigravity server on the SSH host\. Make sure it has free disk space, and that it or this computer can download from the internet\."/g, '"无法在 SSH 主机上安装 Antigravity 服务端。请确保磁盘空间充足，且该主机或本机可正常访问互联网下载组件。"'],
    [/`The Antigravity server failed to start on the SSH host\. See its log in ~\/\$\{types_1\.REMOTE_INSTALL_ROOT\}\/data on that host\.`/g, "`SSH 主机上的 Antigravity 服务端启动失败。请查看该主机 ~/${types_1.REMOTE_INSTALL_ROOT}/data 目录下的日志。`"],
    [/'The Antigravity server on the SSH host stopped\. Reconnect to start it again\.'/g, "'SSH 主机上的 Antigravity 服务端已停止。请重新连接以再次启动。'"],
    [/'The SSH connection closed\. Check your network connection, then reconnect\.'/g, "'SSH 连接已关闭。请检查网络连接后重新连接。'"],
    [/'The connection was cancelled\.'/g, "'连接已取消。'"],
    [/"Couldn't connect to the SSH host\. Try ssh to it in a terminal, and see the Antigravity log for details\."/g, '"无法连接到 SSH 主机。请尝试在终端中执行 ssh 连接，并查看 Antigravity 日志了解详情。"']
  ]))) extraMainPatched++;

  if (patchFile(tempDir, path.join('dist', 'remote', 'remoteManager.js'), (code) => applyPairs(code, [
    [/title:\s*'Choose an SSH config file'/g, "title: '选择 SSH 配置文件'"],
    [/title:\s*'SSH connection failed'/g, "title: 'SSH 连接失败'"],
    [/buttons:\s*\['Choose Another File…',\s*'Cancel'\]/g, "buttons: ['选择其他文件...', '取消']"],
    [/buttons:\s*\['Stop Server',\s*'Cancel'\]/g, "buttons: ['停止服务端', '取消']"],
    [/title:\s*'Stop SSH server'/g, "title: '停止 SSH 服务端'"],
    [/`Stop the Antigravity server on \$\{entry\.label\}\?`/g, "`确定要停止 ${entry.label} 上的 Antigravity 服务端吗？`"],
    [/'Agents running on this host will stop and its window will close\. '\s*\+\s*\r?\n\s*'The server starts again the next time you connect\.'/g, "'此主机上正在运行的智能体将会停止，对应窗口也会关闭。下次连接时将自动重新启动服务端。'"],
    [/'Could not stop the SSH server'/g, "'无法停止 SSH 服务端'"],
    [/`Not connected to \$\{label\}`/g, "`尚未连接到 ${label}`"],
    [/'Reconnect first, then stop its server\.'/g, "'请先重新连接，然后再停止其服务端。'"],
    [/buttons:\s*\['Sign In',\s*'Cancel'\]/g, "buttons: ['登录', '取消']"],
    [/title:\s*'Sign in'/g, "title: '登录'"],
    [/`(?:Sign in to your organization for \$\{entry\.label\}\?|是否为 \$\{entry\.label\} 登录您的组织？)`/g, "`是否为 ${entry.label} 登录你的组织？`"],
    [/(?:'Continue only if you just chose to sign in with your organization '\s*\+\s*\r?\n\s*`in this window\. \$\{entry\.label\} will get access to your `\s*\+\s*\r?\n\s*"organization's Google Cloud account\.\\n"|`仅当您刚刚在此窗口中主动选择使用组织账号登录时才继续。\$\{entry\.label\} 将获得您组织的 Google Cloud 账号访问权限。\\n`)\s*\+/g, "`仅当你刚刚在此窗口中主动选择使用组织账号登录时才继续。${entry.label} 将获得你组织的 Google Cloud 账号访问权限。\\n` +"],
    [/`Workforce pool: \$\{names\[1\]\}  Provider: \$\{names\[2\]\}`/g, "`员工身份池：${names[1]}  身份提供商：${names[2]}`"],
    [/`Identity provider: \$\{provider\}`/g, "`身份提供商：${provider}`"]
  ]))) extraMainPatched++;
  if (extraMainPatched > 0) {
    console.log(` - 其余主进程弹窗与远程页面补丁完成 (${extraMainPatched} 个模块)`);
  }

  // 8. 编译并写入前端 i18n 引擎与原生菜单字典至打包临时目录
  const { buildEngine, cleanDictObject } = require('./build_clean_engine');
  const { engineScript, dictCount } = buildEngine();
  console.log(`[3/4] 正在内联生成 ${dictCount || '全量'} 词条确定性引擎...`);
  fs.writeFileSync(path.join(tempDir, 'dist', 'i18n.js'), engineScript, 'utf8');
  const preserveList = JSON.parse(fs.readFileSync(path.join(projectRoot, 'assets', 'preserve_list.json'), 'utf8'));
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

  fs.copyFileSync(outputAsar, asarPath);
  fs.rmSync(tempDir, { recursive: true, force: true });
  const buildUnpackedDir = path.join(buildDir, 'app.asar.unpacked');
  if (fs.existsSync(buildUnpackedDir)) {
    fs.rmSync(buildUnpackedDir, { recursive: true, force: true });
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('==========================================');
  console.log(`  成功！Antigravity v${version} 汉化完成 (耗时: ${duration}s) `);
  console.log('==========================================');
}

if (require.main === module) {
  patchAsar().catch((err) => {
    console.error('[错误] 补丁执行失败:', err);
    process.exit(1);
  });
}

module.exports = {
  isAsarPatched,
  patchAsar,
  asarPath,
  installDir
};
