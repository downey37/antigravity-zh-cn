const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { createMockDomEnv } = require('./mock_dom');


async function runOtaControllerVerification() {
  const crypto = require('crypto');
  const http = require('http');
  const { buildOtaPack, validateOtaRules, loadOtaRulesFile } = require('../build_ota_pack');
  const { createOtaController } = require('../ota/i18n_ota_main');

  // 1. Validate buildOtaPack & declarative rule guards
  const dry = buildOtaPack({ dryRun: true, notes: 'verify-smoke' });
  assert.strictEqual(dry.manifest.schemaVersion, 1);
  assert(/^[a-f0-9]{64}$/.test(dry.manifest.sha256));
  assert(dry.manifest.dictCount >= 4000, 'OTA pack dictCount sanity check');
  assert.throws(() => validateOtaRules([{ pattern: '(a+)+$', flags: 'i', replace: 'x' }]), /嵌套量词/);
  assert.throws(() => validateOtaRules([{ pattern: '^a$', flags: 'g', replace: 'x' }]), /flags/);
  assert.strictEqual(validateOtaRules([{ id: 'ok', pattern: '^Hello (.+)$', flags: 'i', replace: '你好 $1' }]).length, 1);

  const shippedOtaRules = loadOtaRulesFile();
  assert(shippedOtaRules.some((r) => r.id === 'updated-zh-date-time'), 'assets/ota_rules.json must include updated-zh-date-time');
  const applyShippedOtaRules = (input) => {
    for (const r of shippedOtaRules) {
      const re = new RegExp(r.pattern, r.flags);
      if (re.test(input)) {
        const res = input.replace(re, r.replace);
        if (res !== input) return res;
      }
    }
    return input;
  };
  const otaCases = [
    ['Updated 11月26日, 14:52', '更新于 11月26日 14:52'],
    ['Updated 2026年11月26日, 14:52', '更新于 2026年11月26日 14:52'],
    ['Updated 11月26日, 下午2:52', '更新于 11月26日 下午2:52'],
    ['Updated 下午2:52', '更新于 下午2:52'],
    ['Updated 11月26日', '更新于 11月26日'],
    ['Updated 11/26, 14:52', '更新于 11/26 14:52'],
    ['Updated the configuration file', 'Updated the configuration file']
  ];
  for (const [input, expected] of otaCases) {
    assert.strictEqual(applyShippedOtaRules(input), expected, `OTA rule mismatch for: ${input}`);
  }

  // 2. Spin up local mock HTTP OTA server (primary fails 500 -> secondary serves valid manifest + pack with ETag)
  const samplePack = {
    schemaVersion: 1,
    packVersion: '2026.12.01.120000',
    builtAt: '2026-12-01T12:00:00.000Z',
    engineVersion: '0.3.0',
    minEngineVersion: '0.3.0',
    dictionary: {
      'OTA Live Test Key': 'OTA 实时测试词条',
      'Copy Link': '复制链接（OTA）'
    },
    attrDict: {
      'OTA Attr Tip': 'OTA 属性提示'
    },
    preserveList: ['Antigravity'],
    rules: [
      { id: 'r1', pattern: '^Deploy\\s+(\\d+)$', flags: 'i', replace: '部署 $1' }
    ]
  };
  const samplePackText = JSON.stringify(samplePack);
  const sampleSha = crypto.createHash('sha256').update(samplePackText, 'utf8').digest('hex');
  const sampleManifest = {
    schemaVersion: 1,
    packVersion: samplePack.packVersion,
    builtAt: samplePack.builtAt,
    engineVersion: '0.3.0',
    minEngineVersion: '0.3.0',
    packFile: 'dict-pack.json',
    sha256: sampleSha,
    dictCount: 2,
    attrCount: 1,
    ruleCount: 1,
    releaseUrl: 'https://github.com/downey37/antigravity-zh-cn/releases/latest',
    notes: 'mock ota update'
  };

  let mode = 'normal';
  let manifestEtag = '"etag-v1"';
  let packDownloads = 0;
  let redirectSawInternalHeader = false;

  const server = http.createServer((req, res) => {
    if ('_redirectdepth' in req.headers || '_redirectDepth' in req.headers) {
      redirectSawInternalHeader = true;
    }
    const cleanUrl = (req.url || '').split('?')[0];
    if (cleanUrl === '/redirect/manifest.json' || cleanUrl === '/redirect/dict-pack.json') {
      res.writeHead(302, { Location: cleanUrl.replace('/redirect/', '/backup/') });
      res.end();
      return;
    }
    if (cleanUrl.startsWith('/primary/')) {
      res.writeHead(500);
      res.end('primary down');
      return;
    }
    if (cleanUrl === '/backup/manifest.json') {
      if (mode === 'incompatible') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...sampleManifest, engineVersion: '9.9.9', minEngineVersion: '9.9.9' }));
        return;
      }
      if (mode === 'tampered') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...sampleManifest, packVersion: '2026.12.02.000000', builtAt: '2026-12-02T00:00:00.000Z', sha256: '0'.repeat(64) }));
        return;
      }
      if (req.headers['if-none-match'] === manifestEtag) {
        res.writeHead(304, { ETag: manifestEtag });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: manifestEtag });
      res.end(JSON.stringify(sampleManifest));
      return;
    }
    if (cleanUrl === '/backup/dict-pack.json') {
      packDownloads++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(samplePackText);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrls = [`http://127.0.0.1:${port}/primary`, `http://127.0.0.1:${port}/backup`];
  const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-i18n-ota-test-'));

  try {
    const mainExecs = [];
    const pluginFrameExecs = [];
    const extFrameExecs = [];
    const mockWc = {
      isDestroyed: () => false,
      getURL: () => 'https://antigravity.local/app',
      once: () => {},
      executeJavaScript: (code) => { mainExecs.push(code); return Promise.resolve(); },
      mainFrame: {
        framesInSubtree: [
          { url: 'plugin://swarm/index.html', executeJavaScript: (code) => { pluginFrameExecs.push(code); return Promise.resolve(); } },
          { url: 'https://example.com/third-party', executeJavaScript: (code) => { extFrameExecs.push(code); return Promise.resolve(); } }
        ]
      }
    };
    mockWc.mainFrame.framesInSubtree.unshift(mockWc.mainFrame);

    const ctrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls,
      minDictCount: 1,
      minAttrCount: 1,
      builtinMeta: {
        schemaVersion: 1,
        engineVersion: '0.3.0',
        packVersion: '2026.11.24.000000',
        builtAt: '2026-11-24T00:00:00.000Z'
      },
      env: {}
    });
    ctrl.registerWebContents(mockWc);

    // 2a. Primary fails -> fallback succeeds -> broadcasts to main + plugin subframe only (never external https)
    const r1 = await ctrl.checkForUpdates({ manual: false });
    assert.strictEqual(r1.status, 'updated');
    assert.strictEqual(r1.packVersion, samplePack.packVersion);
    assert.strictEqual(packDownloads, 1);
    assert.strictEqual(mainExecs.length, 1);
    assert.strictEqual(pluginFrameExecs.length, 1);
    assert.strictEqual(extFrameExecs.length, 0, 'OTA broadcast must never inject into third-party external subframes');
    assert.strictEqual(ctrl.getNativeContextDict().exactMap.get('OTA Live Test Key'), 'OTA 实时测试词条');

    // 2b. Second background check hits ETag 304 without downloading pack again
    const r2 = await ctrl.checkForUpdates({ manual: false });
    assert.strictEqual(r2.status, 'up_to_date');
    assert.strictEqual(packDownloads, 1);

    // 2c. Tampered SHA-256 is rejected and previous valid pack remains active
    mode = 'tampered';
    const r3 = await ctrl.checkForUpdates({ manual: false });
    assert.strictEqual(r3.status, 'error');
    assert.strictEqual(ctrl.getActiveVersion(), samplePack.packVersion);

    // 2d. Engine upgrade required when minEngineVersion > local engineVersion
    mode = 'incompatible';
    const r4 = await ctrl.checkForUpdates({ manual: false });
    assert.strictEqual(r4.status, 'engine_upgrade_required');
    assert.strictEqual(ctrl.getActiveVersion(), samplePack.packVersion);

    // 2e. Stale cache guard: newer local built-in baseline ignores older cached OTA pack
    const newerCtrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls,
      minDictCount: 1,
      minAttrCount: 1,
      builtinMeta: {
        schemaVersion: 1,
        engineVersion: '0.2.5',
        packVersion: '2027.01.01.000000',
        builtAt: '2027-01-01T00:00:00.000Z'
      },
      env: {}
    });
    assert.strictEqual(newerCtrl.loadCachedPackSync(), null, 'Stale OTA cache older than built-in baseline must be ignored');

    // 2f. ANTIGRAVITY_I18N_NO_OTA=1 completely disables network calls
    const disabledCtrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls,
      fetchText: () => { throw new Error('Should never fetch when NO_OTA=1'); },
      env: { ANTIGRAVITY_I18N_NO_OTA: '1' }
    });
    const rDisabled = await disabledCtrl.checkForUpdates({ manual: false });
    assert.strictEqual(rDisabled.status, 'disabled');

    // 2g. Persisted Chinese <-> English toggle broadcasts to main + eligible plugin subframes only & remembers across restarts
    const langEvents = [];
    const unsubscribe = ctrl.onLanguageChange((enabled) => langEvents.push(enabled));
    assert.strictEqual(ctrl.isI18nEnabled(), true);
    assert.strictEqual(ctrl.t('中文', 'English'), '中文');
    assert.strictEqual(ctrl.getInitialStateScript(), 'window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ = true;\nwindow.__ANTIGRAVITY_I18N_AUTO_MT_ENABLED__ = true;');
    const preToggleMainCount = mainExecs.length;
    const preTogglePluginCount = pluginFrameExecs.length;
    assert.strictEqual(ctrl.setI18nEnabled(false), false);
    assert.strictEqual(ctrl.isI18nEnabled(), false);
    assert.strictEqual(ctrl.t('中文', 'English'), 'English');
    assert.strictEqual(ctrl.getInitialStateScript(), 'window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ = false;\nwindow.__ANTIGRAVITY_I18N_AUTO_MT_ENABLED__ = true;');
    assert.deepStrictEqual(langEvents, [false]);
    assert.strictEqual(mainExecs.length, preToggleMainCount + 1);
    assert(mainExecs[mainExecs.length - 1].includes('__antigravitySetI18nEnabled(false)'));
    assert.strictEqual(pluginFrameExecs.length, preTogglePluginCount + 1);
    assert.strictEqual(extFrameExecs.length, 0);

    const savedState1 = JSON.parse(fs.readFileSync(path.join(tmpCacheDir, 'state.json'), 'utf8'));
    assert.strictEqual(savedState1.i18nEnabled, false, 'state.json must persist i18nEnabled=false');
    const relaunchedOffCtrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls,
      env: {}
    });
    assert.strictEqual(relaunchedOffCtrl.isI18nEnabled(), false, 'New controller after restart must remember English preference');
    assert.strictEqual(relaunchedOffCtrl.t('中文', 'English'), 'English');
    assert.strictEqual(relaunchedOffCtrl.getInitialStateScript(), 'window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ = false;\nwindow.__ANTIGRAVITY_I18N_AUTO_MT_ENABLED__ = true;');

    assert.strictEqual(ctrl.toggleI18nEnabled(), true);
    assert.deepStrictEqual(langEvents, [false, true]);
    assert.strictEqual(ctrl.t('中文', 'English'), '中文');
    assert(mainExecs[mainExecs.length - 1].includes('__antigravitySetI18nEnabled(true)'));
    unsubscribe();

    const relaunchedOnCtrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls,
      env: {}
    });
    assert.strictEqual(relaunchedOnCtrl.isI18nEnabled(), true, 'New controller after toggling back must remember Chinese preference');

    const envDisabledCtrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls,
      env: { ANTIGRAVITY_I18N_DISABLED: '1' }
    });
    assert.strictEqual(envDisabledCtrl.isI18nEnabled(), false);
    assert.strictEqual(envDisabledCtrl.getInitialStateScript(), 'window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ = false;\nwindow.__ANTIGRAVITY_I18N_AUTO_MT_ENABLED__ = true;');

    // 2h. Manual dialog respects English mode & nodeHttpFetchText 302 redirect never leaks _redirectDepth header
    mode = 'normal';
    const dlgBoxes = [];
    const enCtrl = createOtaController({
      electron: {
        dialog: {
          showMessageBox: async (...args) => {
            dlgBoxes.push(args[args.length - 1]);
            return { response: 0 };
          }
        }
      },
      cacheDir: tmpCacheDir,
      baseUrls: [`http://127.0.0.1:${port}/backup`],
      minDictCount: 1,
      minAttrCount: 1,
      env: { ANTIGRAVITY_I18N_DISABLED: '1' }
    });
    const mRes = await enCtrl.checkForUpdates({ manual: true });
    assert.strictEqual(mRes.status, 'up_to_date');
    assert.strictEqual(dlgBoxes[0].title, 'Check i18n Updates');
    assert.strictEqual(dlgBoxes[0].message, 'Localization Pack Is Up to Date');
    assert.deepStrictEqual(dlgBoxes[0].buttons, ['OK']);

    const origFetch = globalThis.fetch;
    globalThis.fetch = undefined;
    try {
      const redirRes = await createOtaController({
        electron: null,
        cacheDir: fs.mkdtempSync(path.join(tmpCacheDir, 'redir-')),
        baseUrls: [`http://127.0.0.1:${port}/redirect`],
        minDictCount: 1,
        minAttrCount: 1,
        env: {}
      }).checkForUpdates({ manual: false });
      assert(redirRes.status === 'updated' || redirRes.status === 'up_to_date', `Expected updated/up_to_date, got ${redirRes.status}`);
      assert.strictEqual(redirectSawInternalHeader, false, 'nodeHttpFetchText redirect must never leak _redirectDepth header');
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  }
}


async function runAutoMtVerification({ i18nCode, projectRoot }) {
  const http = require('http');
  const {
    isEligibleMtText,
    protectDynamicMtTerms,
    restoreDynamicMtTerms,
    createOtaController
  } = require('../ota/i18n_ota_main');
  const preserveList = JSON.parse(fs.readFileSync(path.join(projectRoot, 'assets', 'preserve_list.json'), 'utf8'));

  // 1. Brand/model term masking, restoration, and eligibility guards
  const sampleBody = 'Both Carbon and Argon are now included as part of the entire Gemini entitlement, so you can use them for much longer.';
  const { masked, placeholders } = protectDynamicMtTerms(sampleBody, preserveList);
  assert.deepStrictEqual(placeholders, ['Carbon', 'Argon', 'Gemini']);
  assert.strictEqual(
    masked,
    'Both AGYTERM0X and AGYTERM1X are now included as part of the entire AGYTERM2X entitlement, so you can use them for much longer.'
  );
  const restored = restoreDynamicMtTerms(
    'AGYTERM0X和AGYTERM1X现已包含在整个AGYTERM2X权益中，因此你可以使用它们更长时间。',
    placeholders
  );
  assert.strictEqual(
    restored,
    'Carbon 和 Argon 现已包含在整个 Gemini 权益中，因此你可以使用它们更长时间。'
  );
  assert.strictEqual(restoreDynamicMtTerms('missing placeholder text 中文', placeholders), null);
  assert.strictEqual(restoreDynamicMtTerms('AGYTERM0X and AGYTERM99X 中文', placeholders), null);

  assert.strictEqual(isEligibleMtText(sampleBody), true);
  assert.strictEqual(isEligibleMtText('已经是中文内容'), false);
  assert.strictEqual(isEligibleMtText('SingleWord'), false);
  assert.strictEqual(isEligibleMtText('https://example.com/docs/page'), false);
  assert.strictEqual(isEligibleMtText('C:\\Users\\Alice\\project\\file.js'), false);
  assert.strictEqual(isEligibleMtText('{"key": "value"}'), false);
  assert.strictEqual(isEligibleMtText('word '.repeat(150)), false);

  // 2. Main-process auto-MT controller + mock HTTP (google-gtx & openai) + persistent cache + dedup + toggle
  let gtxCalls = 0;
  let openaiCalls = 0;
  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    if (parsedUrl.pathname === '/gtx') {
      gtxCalls++;
      const q = parsedUrl.searchParams.get('q') || '';
      const out = q.includes('AGYTERM0X') && q.includes('AGYTERM1X') && q.includes('AGYTERM2X')
        ? 'AGYTERM0X和AGYTERM1X现已包含在整个AGYTERM2X权益中，因此你可以使用它们更长时间。'
        : '延迟重试翻译结果：' + q;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([[[out, q]]]));
      return;
    }
    if (parsedUrl.pathname === '/openai') {
      openaiCalls++;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.strictEqual(req.headers.authorization, 'Bearer test-key');
        assert.strictEqual(body.model, 'test-model');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: 'AGYTERM0X已升级完成。' } }]
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-auto-mt-test-'));

  try {
    const broadcastExecs = [];
    const mockWc = {
      isDestroyed: () => false,
      getURL: () => 'https://antigravity.local/app',
      once: () => {},
      executeJavaScript: (code) => { broadcastExecs.push(code); return Promise.resolve(); },
      mainFrame: { framesInSubtree: [] }
    };

    const ctrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls: [`http://127.0.0.1:${port}/unused`],
      mtUrl: `http://127.0.0.1:${port}/gtx`,
      preserveList,
      env: {}
    });
    ctrl.registerWebContents(mockWc);

    // 2a. Concurrent calls deduplicate to 1 HTTP request & persist to dynamic-mt-cache.json
    const [mt1, mt2] = await Promise.all([
      ctrl.translateDynamicText(sampleBody),
      ctrl.translateDynamicText(sampleBody)
    ]);
    assert.strictEqual(mt1.status, 'ok');
    assert.strictEqual(mt1.translated, 'Carbon 和 Argon 现已包含在整个 Gemini 权益中，因此你可以使用它们更长时间。');
    assert.strictEqual(mt2.translated, mt1.translated);
    assert.strictEqual(gtxCalls, 1, 'Concurrent identical requests must deduplicate into 1 HTTP call');

    const diskCache = JSON.parse(fs.readFileSync(path.join(tmpCacheDir, 'dynamic-mt-cache.json'), 'utf8'));
    assert.strictEqual(diskCache.entries[sampleBody].zh, mt1.translated);

    // 2b. New controller after restart serves directly from disk cache with 0 HTTP requests
    const ctrl2 = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls: [`http://127.0.0.1:${port}/unused`],
      mtUrl: `http://127.0.0.1:${port}/gtx`,
      preserveList,
      env: {}
    });
    const mtCached = await ctrl2.translateDynamicText(sampleBody);
    assert.strictEqual(mtCached.status, 'ok');
    assert.strictEqual(mtCached.cached, true);
    assert.strictEqual(mtCached.translated, mt1.translated);
    assert.strictEqual(gtxCalls, 1, 'Restarted controller must serve from disk cache without HTTP request');

    // 2c. OpenAI-compatible POST provider
    const openaiCtrl = createOtaController({
      electron: null,
      cacheDir: fs.mkdtempSync(path.join(tmpCacheDir, 'oa-')),
      baseUrls: [`http://127.0.0.1:${port}/unused`],
      mtProvider: 'openai',
      mtUrl: `http://127.0.0.1:${port}/openai`,
      mtApiKey: 'test-key',
      mtModel: 'test-model',
      preserveList,
      env: {}
    });
    const oaRes = await openaiCtrl.translateDynamicText('Gemini 4 Carbon upgrade is ready for all users.');
    assert.strictEqual(oaRes.status, 'ok');
    assert.strictEqual(oaRes.translated, 'Gemini 4 Carbon 已升级完成。');
    assert.strictEqual(openaiCalls, 1);

    // 2d. Toggle autoMtEnabled persists to state.json, updates getInitialStateScript, and respects NO_OTA / AUTO_MT=0
    const autoMtEvents = [];
    const unsubAuto = ctrl.onAutoMtChange((val) => autoMtEvents.push(val));
    assert.strictEqual(ctrl.setAutoMtEnabled(false), false);
    assert.deepStrictEqual(autoMtEvents, [false]);
    assert(broadcastExecs.some((c) => c.includes('__antigravitySetAutoMtEnabled(false)')));
    assert.strictEqual(
      ctrl.getInitialStateScript(),
      'window.__ANTIGRAVITY_I18N_INITIAL_ENABLED__ = true;\nwindow.__ANTIGRAVITY_I18N_AUTO_MT_ENABLED__ = false;'
    );
    const disabledRes = await ctrl.translateDynamicText('Another new announcement message here.');
    assert.strictEqual(disabledRes.status, 'disabled');
    assert.strictEqual(gtxCalls, 1);

    assert.strictEqual(ctrl.toggleAutoMtEnabled(), true);
    assert.deepStrictEqual(autoMtEvents, [false, true]);
    unsubAuto();

    const noOtaCtrl = createOtaController({
      electron: null,
      cacheDir: fs.mkdtempSync(path.join(tmpCacheDir, 'no-ota-')),
      baseUrls: [`http://127.0.0.1:${port}/unused`],
      fetchText: () => { throw new Error('Should never fetch when NO_OTA=1'); },
      env: { ANTIGRAVITY_I18N_NO_OTA: '1' }
    });
    const noOtaMt = await noOtaCtrl.translateDynamicText('Fresh announcement text here.');
    assert.strictEqual(noOtaMt.status, 'disabled');

    const envAutoOffCtrl = createOtaController({
      electron: null,
      cacheDir: tmpCacheDir,
      baseUrls: [`http://127.0.0.1:${port}/unused`],
      env: { ANTIGRAVITY_I18N_AUTO_MT: '0' }
    });
    assert.strictEqual(envAutoOffCtrl.isAutoMtEnabled(), false);

    // 3. Renderer VM DOM integration test (whitelist isolation, sync + async MT, [中 | EN] & Auto-MT toggle reversibility)

    const { DomNode, DomElement, makeText } = createMockDomEnv();
    const html = new DomElement('HTML');
    html.isConnected = true;
    const body = new DomElement('BODY');
    html.appendChild(body);
    const rootDiv = new DomElement('DIV');
    rootDiv.id = 'root';
    body.appendChild(rootDiv);

    const ipcRequests = [];
    const sandbox = {
      console, setTimeout, clearTimeout,
      Node: DomNode,
      Element: DomElement,
      NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
      MutationObserver: class { observe() {} },
      requestAnimationFrame: (cb) => { cb(); return 1; },
      window: {
        location: { protocol: 'app:' },
        history: {},
        addEventListener() {},
        antigravityI18nOta: {
          translateDynamicText: (txt) => {
            ipcRequests.push(txt);
            return ctrl2.translateDynamicText(txt);
          }
        }
      },
      location: { protocol: 'app:' },
      document: {
        readyState: 'complete',
        title: 'Antigravity',
        documentElement: html,
        body,
        createElement: (tag) => new DomElement(String(tag).toUpperCase()),
        createTextNode: (val) => makeText(val),
        querySelectorAll: () => [],
        addEventListener: () => {}
      }
    };
    sandbox.window.document = sandbox.document;
    vm.runInNewContext(i18nCode, sandbox);

    // 3a. Non-whitelisted div & user chat message must never trigger auto-MT IPC
    const normalDiv = new DomElement('DIV');
    const normalText = makeText('Some completely arbitrary untranslated sentence in a regular div.');
    normalDiv.appendChild(normalText);
    rootDiv.appendChild(normalDiv);

    const userMsg = new DomElement('DIV');
    userMsg.setAttribute('data-testid', 'user-message-content');
    const userMsgText = makeText('Please explain how Carbon and Argon models work in detail.');
    userMsg.appendChild(userMsgText);
    rootDiv.appendChild(userMsg);
    assert.strictEqual(ipcRequests.length, 0, 'Non-whitelisted containers must never trigger auto-MT');

    // 3b. Whitelisted nux-card: title & button translate synchronously; body triggers 1 async MT call
    const nuxCard = new DomElement('DIV');
    nuxCard.setAttribute('data-testid', 'nux-card');
    const nuxTitle = new DomElement('DIV');
    const nuxTitleText = makeText('Gemini 4 Carbon now available!');
    nuxTitle.appendChild(nuxTitleText);
    const nuxBody = new DomElement('DIV');
    const nuxBodyText = makeText(sampleBody);
    nuxBody.appendChild(nuxBodyText);
    const nuxBtn = new DomElement('BUTTON');
    const nuxBtnText = makeText('Dismiss');
    nuxBtn.appendChild(nuxBtnText);
    nuxCard.appendChild(nuxTitle);
    nuxCard.appendChild(nuxBody);
    nuxCard.appendChild(nuxBtn);
    rootDiv.appendChild(nuxCard);

    assert.strictEqual(nuxTitleText.nodeValue, 'Gemini 4 Carbon 现已开放！');
    assert.strictEqual(nuxBtnText.nodeValue, '忽略');
    assert.strictEqual(ipcRequests.length, 1, 'Only unmatched NUX body should invoke translateDynamicText');
    assert.strictEqual(ipcRequests[0], sampleBody);

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.strictEqual(nuxBodyText.nodeValue, 'Carbon 和 Argon 现已包含在整个 Gemini 权益中，因此你可以使用它们更长时间。');

    // 3c. Global [中 | EN] toggle restores all NUX nodes cleanly and re-applies synchronously from memory cache
    sandbox.window.__antigravitySetI18nEnabled(false);
    assert.strictEqual(nuxTitleText.nodeValue, 'Gemini 4 Carbon now available!');
    assert.strictEqual(nuxBodyText.nodeValue, sampleBody);
    assert.strictEqual(nuxBtnText.nodeValue, 'Dismiss');

    sandbox.window.__antigravitySetI18nEnabled(true);
    assert.strictEqual(nuxTitleText.nodeValue, 'Gemini 4 Carbon 现已开放！');
    assert.strictEqual(nuxBodyText.nodeValue, 'Carbon 和 Argon 现已包含在整个 Gemini 权益中，因此你可以使用它们更长时间。');
    assert.strictEqual(nuxBtnText.nodeValue, '忽略');
    assert.strictEqual(ipcRequests.length, 1, 'Re-enabling Chinese must reuse renderer memory cache without extra IPC');

    // 3d. Auto-MT toggle off restores only auto-MT nodes while preserving local title/button translations
    sandbox.window.__antigravitySetAutoMtEnabled(false);
    assert.strictEqual(nuxBodyText.nodeValue, sampleBody);
    assert.strictEqual(nuxTitleText.nodeValue, 'Gemini 4 Carbon 现已开放！');
    assert.strictEqual(nuxBtnText.nodeValue, '忽略');

    sandbox.window.__antigravitySetAutoMtEnabled(true);
    assert.strictEqual(nuxBodyText.nodeValue, 'Carbon 和 Argon 现已包含在整个 Gemini 权益中，因此你可以使用它们更长时间。');
    assert.strictEqual(ipcRequests.length, 1);

    // 3e. Onboarding / auth-error / persona auto-MT whitelist positive & negative guards
    const authErrBox = new DomElement('DIV');
    authErrBox.setAttribute('data-testid', 'onboarding-auth-code-error');
    const authErrText = makeText('Server returned an unexpected authorization error code.');
    authErrBox.appendChild(authErrText);
    rootDiv.appendChild(authErrBox);
    assert(ipcRequests.includes('Server returned an unexpected authorization error code.'), 'onboarding-auth-code-error must trigger auto-MT');

    const blockedScreen = new DomElement('DIV');
    blockedScreen.setAttribute('data-testid', 'jetbox-access-blocked-screen');
    const blockedMsg = makeText('Your workspace administrator blocked desktop access.');
    blockedScreen.appendChild(blockedMsg);
    rootDiv.appendChild(blockedScreen);
    assert(ipcRequests.includes('Your workspace administrator blocked desktop access.'), 'jetbox-access-blocked-screen must trigger auto-MT');

    const personaDesc = new DomElement('P');
    personaDesc.setAttribute('data-testid', 'persona-description');
    const personaText = makeText('Build software faster with autonomous coding workflows.');
    personaDesc.appendChild(personaText);
    rootDiv.appendChild(personaDesc);
    assert(ipcRequests.includes('Build software faster with autonomous coding workflows.'), 'persona-description must trigger auto-MT');

    const brandShell = new DomElement('DIV');
    brandShell.setAttribute('data-testid', 'onboarding-brand-shell');
    const brandP = new DomElement('P');
    const brandPText = makeText('Unmatched server onboarding guidance message.');
    brandP.appendChild(brandPText);
    const brandMono = new DomElement('SPAN');
    brandMono.className = 'font-mono';
    const brandMonoText = makeText('locations/global/workforcePools/custom-pool');
    brandMono.appendChild(brandMonoText);
    const brandInput = new DomElement('INPUT');
    const brandInputText = makeText('Raw input placeholder value inside shell');
    brandInput.appendChild(brandInputText);
    brandShell.appendChild(brandP);
    brandShell.appendChild(brandMono);
    brandShell.appendChild(brandInput);
    rootDiv.appendChild(brandShell);
    assert(ipcRequests.includes('Unmatched server onboarding guidance message.'), 'p inside onboarding-brand-shell must trigger auto-MT');
    assert(!ipcRequests.includes('locations/global/workforcePools/custom-pool'), '.font-mono inside onboarding-brand-shell must NOT trigger auto-MT');
    assert(!ipcRequests.includes('Raw input placeholder value inside shell'), 'input inside onboarding-brand-shell must NOT trigger auto-MT');

    // 3f. Customizations marketplace & plugin detail auto-MT whitelist positive & negative guards
    const pluginCard = new DomElement('DIV');
    pluginCard.setAttribute('data-testid', 'customization-card');
    const cardTitleWrap = new DomElement('DIV');
    cardTitleWrap.className = 'font-medium text-foreground truncate';
    const cardTitleText = makeText('New Future Brand');
    cardTitleWrap.appendChild(cardTitleText);
    const cardDescWrap = new DomElement('DIV');
    cardDescWrap.className = 'text-sm text-muted-foreground truncate';
    const cardDescText = makeText('Unmatched future plugin description for marketplace cards.');
    cardDescWrap.appendChild(cardDescText);
    pluginCard.appendChild(cardTitleWrap);
    pluginCard.appendChild(cardDescWrap);
    rootDiv.appendChild(pluginCard);
    assert(ipcRequests.includes('Unmatched future plugin description for marketplace cards.'), 'customization-card description must trigger auto-MT');
    assert(!ipcRequests.includes('New Future Brand'), 'customization-card brand name must NOT trigger auto-MT');

    const promptRow = new DomElement('BUTTON');
    promptRow.setAttribute('data-testid', 'plugin-suggested-prompt-row');
    const promptSpan = new DomElement('SPAN');
    const promptText = makeText('Unmatched future suggested prompt for this new plugin.');
    promptSpan.appendChild(promptText);
    promptRow.appendChild(promptSpan);
    rootDiv.appendChild(promptRow);
    assert(ipcRequests.includes('Unmatched future suggested prompt for this new plugin.'), 'plugin-suggested-prompt-row must trigger auto-MT');

    const marketplaceWrap = new DomElement('DIV');
    marketplaceWrap.setAttribute('data-testid', 'customizations-marketplace');
    const shelfSub = new DomElement('P');
    shelfSub.className = 'text-sm text-muted-foreground';
    const shelfSubText = makeText('Unmatched future marketplace shelf subtitle text.');
    shelfSub.appendChild(shelfSubText);
    marketplaceWrap.appendChild(shelfSub);
    rootDiv.appendChild(marketplaceWrap);
    assert(ipcRequests.includes('Unmatched future marketplace shelf subtitle text.'), 'customizations-marketplace shelf subtitle must trigger auto-MT');

    const detailRoot = new DomElement('DIV');
    detailRoot.setAttribute('data-testid', 'plugin-detail');
    const detailDesc = new DomElement('P');
    detailDesc.className = 'text-sm text-muted-foreground';
    const detailDescText = makeText('Unmatched future plugin detail header description.');
    detailDesc.appendChild(detailDescText);
    const readmeMdRoot = new DomElement('DIV');
    readmeMdRoot.setAttribute('data-markdown-root', 'true');
    const readmeP = new DomElement('P');
    readmeP.className = 'text-sm text-muted-foreground';
    const readmePText = makeText('Unmatched plugin README paragraph inside markdown root.');
    readmeP.appendChild(readmePText);
    readmeMdRoot.appendChild(readmeP);
    detailRoot.appendChild(detailDesc);
    detailRoot.appendChild(readmeMdRoot);
    rootDiv.appendChild(detailRoot);
    assert(ipcRequests.includes('Unmatched future plugin detail header description.'), 'plugin-detail header description must trigger auto-MT');
    assert(!ipcRequests.includes('Unmatched plugin README paragraph inside markdown root.'), 'plugin-detail README inside [data-markdown-root] must NOT trigger auto-MT');

    // 3g. Debounced MT disk cache coalesces writes and flushMtCacheSync persists immediately
    const debouncedDir = fs.mkdtempSync(path.join(tmpCacheDir, 'debounced-'));
    const debouncedCtrl = createOtaController({
      electron: null,
      cacheDir: debouncedDir,
      baseUrls: [`http://127.0.0.1:${port}/unused`],
      mtUrl: `http://127.0.0.1:${port}/gtx`,
      mtCacheDebounceMs: 80,
      preserveList,
      env: {}
    });
    await Promise.all([
      debouncedCtrl.translateDynamicText('First debounced announcement card text.'),
      debouncedCtrl.translateDynamicText('Second debounced announcement card text.')
    ]);
    const debouncedCacheFile = path.join(debouncedDir, 'dynamic-mt-cache.json');
    assert.strictEqual(fs.existsSync(debouncedCacheFile), false, 'Debounced cache must not write synchronously during burst');
    debouncedCtrl.flushMtCacheSync();
    assert.strictEqual(fs.existsSync(debouncedCacheFile), true, 'flushMtCacheSync must persist immediately');
    const flushedData = JSON.parse(fs.readFileSync(debouncedCacheFile, 'utf8'));
    assert(flushedData.entries['First debounced announcement card text.']);
    assert(flushedData.entries['Second debounced announcement card text.']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  }
}

module.exports = { runOtaControllerVerification, runAutoMtVerification };
