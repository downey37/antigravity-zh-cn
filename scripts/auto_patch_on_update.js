process.noAsar = true;

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { resolveInstallPaths } = require('./runtime_paths');
const { isAsarPatched, patchAsar, asarPath } = require('./i18n_core');
const { detectActiveProxy, buildProxyLaunchConfig } = require('./guard_launch');

const logPath = path.resolve(__dirname, '..', 'build', 'auto_patch.log');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function logLine(msg) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch (_) {}
}

function parseTargetPid(argv = process.argv) {
  const args = Array.isArray(argv) ? argv : [];
  const watchIdx = args.indexOf('--watch-after-quit');
  let raw = '';
  if (watchIdx !== -1 && watchIdx + 1 < args.length) {
    raw = String(args[watchIdx + 1] || '').trim();
  } else if (args.length > 3 && args[3] && !String(args[3]).startsWith('-')) {
    raw = String(args[3]).trim();
  }
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function isRunning(pid) {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

async function waitForStableFile(filePath) {
  let prevSize = -1;
  for (let i = 0; i < 20; i++) {
    try {
      const size = fs.statSync(filePath).size;
      if (size > 0 && size === prevSize) return true;
      prevSize = size;
    } catch (_) {
      prevSize = -1;
    }
    await sleep(500);
  }
  return false;
}

function relaunchApplication(resolvedPaths, launchArgs, isolatedEnv) {
  const { exePath, appBundle, platform } = resolvedPaths;
  if (platform === 'darwin' && appBundle && fs.existsSync(appBundle)) {
    const openArgs = ['-a', appBundle];
    if (launchArgs.length > 0) {
      openArgs.push('--args', ...launchArgs);
    }
    const child = spawn('open', openArgs, {
      detached: true,
      stdio: 'ignore',
      env: isolatedEnv
    });
    child.unref();
    return;
  }
  const child = spawn(exePath, launchArgs, {
    detached: true,
    stdio: 'ignore',
    env: isolatedEnv
  });
  child.unref();
}

async function runAutoPatchWatcher() {
  const resolvedPaths = resolveInstallPaths();
  const { exePath } = resolvedPaths;
  const targetPid = parseTargetPid(process.argv);
  const noRelaunch = process.argv.includes('--no-relaunch');

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, `[${new Date().toISOString()}] Auto-patch watcher started (targetPid=${targetPid || 'none'})\n`, 'utf8');
  } catch (_) {}

  if (targetPid) {
    let waitedExit = 0;
    while (isRunning(targetPid) && waitedExit < 30000) {
      await sleep(300);
      waitedExit += 300;
    }
    if (isRunning(targetPid)) {
      logLine(`Target PID ${targetPid} did not exit within 30s; aborting without modifying app.asar.`);
      process.exit(0);
    }
  }

  let detectedUnpatched = !isAsarPatched();
  let waitedUpdate = 0;
  while (!detectedUnpatched && waitedUpdate < 90000) {
    await sleep(800);
    waitedUpdate += 800;
    if (!isAsarPatched()) {
      detectedUnpatched = true;
      break;
    }
  }

  if (!detectedUnpatched) {
    logLine('app.asar remained patched after 90s; update may have been cancelled or deferred. Exiting cleanly.');
    process.exit(0);
  }

  logLine(`Detected unpatched app.asar after update (noRelaunch=${noRelaunch}); waiting for installer file writes to settle...`);
  await sleep(1500);
  const asarSettled = await waitForStableFile(asarPath);
  const exeSettled = fs.existsSync(exePath) ? await waitForStableFile(exePath) : true;
  if (!asarSettled || !exeSettled) {
    logLine(`Warning: file size stability check incomplete (asar=${asarSettled}, exe=${exeSettled}); continuing with retry guard.`);
    await sleep(1500);
  }

  let retries = 8;
  while (retries-- > 0) {
    try {
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /F /IM Antigravity.exe /FI "PID ne ${process.pid}"`, { stdio: 'ignore' });
        } catch (_) {}
      }
      await sleep(500);
      await patchAsar();

      if (!isAsarPatched()) {
        throw new Error('patchAsar completed but isAsarPatched() returned false');
      }

      if (noRelaunch) {
        logLine('Successfully re-patched Antigravity after quit (--no-relaunch); skipping relaunch.');
        process.exit(0);
      }

      const activeEndpoints = await detectActiveProxy('');
      const { args: launchArgs, env: isolatedEnv } = buildProxyLaunchConfig(activeEndpoints, [], process.env);

      relaunchApplication(resolvedPaths, launchArgs, isolatedEnv);
      logLine('Successfully re-patched and relaunched Antigravity.');
      process.exit(0);
    } catch (err) {
      logLine(`Retry failed (${retries} left): ${err && err.stack ? err.stack : err}`);
      await sleep(1500);
    }
  }
  logLine('Exhausted all retries; exiting with code 1.');
  process.exit(1);
}

if (require.main === module) {
  runAutoPatchWatcher().catch((err) => {
    logLine(`Fatal error: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = {
  parseTargetPid,
  isRunning,
  runAutoPatchWatcher
};
