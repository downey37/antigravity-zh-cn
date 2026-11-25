const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const asar = require('@electron/asar');

function verifyDeployedAsar({ deployedAsar, projectRoot }) {
  let i18nCode;
  let pkgVersion = 'local';
  let asarEntriesCount = 0;
  {
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

    const expectedAutoPatch = path.resolve(__dirname, '..', 'auto_patch_on_update.js');
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

    // Verify languageServer.js proxy hook honors ANTIGRAVITY_PROXY=direct without synthesizing http://direct
    const lsCode = asar.extractFile(deployedAsar, path.join('dist', 'languageServer.js')).toString('utf8');
    assert(lsCode.includes('ANTIGRAVITY_PROXY_INJECTED'), 'languageServer.js must include ANTIGRAVITY_PROXY_INJECTED hook');
    assert(!lsCode.includes('http://${_agyRawProxy}') || lsCode.includes('/^(?:none|direct|off|false|0)$/i.test(_agyRawProxy)'), 'languageServer.js must strip proxy env when ANTIGRAVITY_PROXY=direct');
  }
  return { i18nCode, pkgVersion, asarEntriesCount };
}

module.exports = { verifyDeployedAsar };
