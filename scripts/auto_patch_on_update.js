process.noAsar = true;

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { resolveInstallPaths } = require('./runtime_paths');
const { isAsarPatched, patchAsar, asarPath } = require('./i18n_core');
const { detectActiveProxy, buildProxyLaunchConfig } = require('./guard_launch');

const { exePath } = resolveInstallPaths();
const watchIdx = process.argv.indexOf('--watch-after-quit');
const targetPid = watchIdx !== -1 ? process.argv[watchIdx + 1] : process.argv[3];
const noRelaunch = process.argv.includes('--no-relaunch');
const logPath = path.resolve(__dirname, '..', 'build', 'auto_patch.log');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function logLine(msg) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch (_) {}
}

function isRunning(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_) {
    return false;
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

(async () => {
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

      const child = spawn(exePath, launchArgs, {
        detached: true,
        stdio: 'ignore',
        env: isolatedEnv
      });
      child.unref();
      logLine('Successfully re-patched and relaunched Antigravity.');
      process.exit(0);
    } catch (err) {
      logLine(`Retry failed (${retries} left): ${err && err.stack ? err.stack : err}`);
      await sleep(1500);
    }
  }
  logLine('Exhausted all retries; exiting with code 1.');
  process.exit(1);
})();
