const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert');
const asar = require('@electron/asar');
const { resolveInstallPaths } = require('../runtime_paths');


async function runGuardProxyAndRestoreVerification() {
  const {
    resolveProxyEndpoints,
    parseWinProxyServer,
    extractAndStripProxyArgs,
    detectActiveProxy,
    buildProxyLaunchConfig
  } = require('../guard_launch');
  const { restoreAsar } = require('../restore_antigravity');
  const { hasAnyPatchArtifacts } = require('../i18n_core');

  // 1. Proxy parsing & launch config helpers
  assert.deepStrictEqual(resolveProxyEndpoints('127.0.0.1:7897'), {
    http: 'http://127.0.0.1:7897',
    socks: 'socks5://127.0.0.1:7897'
  });
  assert.deepStrictEqual(resolveProxyEndpoints('socks5://127.0.0.1:10808'), {
    http: 'socks5://127.0.0.1:10808',
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
    ANTIGRAVITY_PROXY: 'direct',
    HTTP_PROXY: 'http://stale:1234',
    https_proxy: 'http://stale:1234',
    ALL_PROXY: 'socks5://stale:1234'
  });
  assert.strictEqual(directCfg.env.ANTIGRAVITY_PROXY, undefined, 'ANTIGRAVITY_PROXY must be stripped on direct launch');
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

    const cliDirect = await detectActiveProxy('direct', {
      env: {},
      readWindowsSystemProxy: () => `127.0.0.1:${openPort}`,
      fallbackCandidates: [`http://127.0.0.1:${openPort}`]
    });
    assert.strictEqual(cliDirect, null, '--proxy-server=direct must skip fallback proxy probing');
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

  const vm = require('vm');
  // 5. auto_patch_on_update PID parsing & safety guards
  const { parseTargetPid, isRunning } = require('../auto_patch_on_update');
  assert.strictEqual(parseTargetPid(['node', 'auto.js', '--watch-after-quit', '--no-relaunch']), null);
  assert.strictEqual(parseTargetPid(['node', 'auto.js', '--watch-after-quit', '98765']), 98765);
  assert.strictEqual(isRunning(NaN), false);
  assert.strictEqual(isRunning(0), false);
  assert.strictEqual(isRunning(-10), false);

  // 6. languageServer.js proxyHook template literal syntax & runtime behavior in VM
  const coreSrc = fs.readFileSync(path.resolve(__dirname, '..', 'i18n_core.js'), 'utf8');
  const hookMatch = coreSrc.match(/const proxyHook = `([\s\S]*?)`;/);
  assert(hookMatch, 'i18n_core.js must define languageServer proxyHook');
  const renderedHook = vm.runInNewContext('`' + hookMatch[1] + '`');
  const runProxyHook = (rawProxy, initialEnv = {}) => {
    const fn = vm.runInNewContext(
      `(function(process, env) {\n${renderedHook}\nreturn env;\n})`,
      {}
    );
    return fn({ env: { ANTIGRAVITY_PROXY: rawProxy } }, { ...initialEnv });
  };

  const directEnv = runProxyHook('direct', { HTTP_PROXY: 'http://stale:1', ALL_PROXY: 'socks5://stale:1', http_proxy: 'http://stale:1' });
  assert.strictEqual(directEnv.HTTP_PROXY, undefined, 'ANTIGRAVITY_PROXY=direct must strip HTTP_PROXY');
  assert.strictEqual(directEnv.ALL_PROXY, undefined, 'ANTIGRAVITY_PROXY=direct must strip ALL_PROXY');
  assert.strictEqual(directEnv.http_proxy, undefined, 'ANTIGRAVITY_PROXY=direct must strip http_proxy');

  const socksEnv = runProxyHook('socks5://127.0.0.1:10808');
  assert.strictEqual(socksEnv.HTTP_PROXY, 'socks5://127.0.0.1:10808');
  assert.strictEqual(socksEnv.ALL_PROXY, 'socks5://127.0.0.1:10808');

  const hostPortEnv = runProxyHook('127.0.0.1:7897');
  assert.strictEqual(hostPortEnv.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.strictEqual(hostPortEnv.ALL_PROXY, 'socks5://127.0.0.1:7897');
}

module.exports = { runGuardProxyAndRestoreVerification };
