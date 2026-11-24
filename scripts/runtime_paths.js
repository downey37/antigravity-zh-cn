process.noAsar = true;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * 解析当前平台下的 Antigravity 安装目录、resources、app.asar、备份路径与可执行文件位置。
 * 支持通过环境变量（ANTIGRAVITY_DIR / ANTIGRAVITY_RESOURCES / ANTIGRAVITY_ASAR / ANTIGRAVITY_EXE / ANTIGRAVITY_APP）覆盖。
 */
function resolveInstallPaths(env = process.env, platform = process.platform, fsMod = fs) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let appDir;
  let appBundle = null;
  let installDir;
  let exePath;

  if (platform === 'win32') {
    const home = env.USERPROFILE || os.homedir();
    const defaultAppDir = env.LOCALAPPDATA
      ? p.join(env.LOCALAPPDATA, 'Programs', 'antigravity')
      : p.join(home, 'AppData', 'Local', 'Programs', 'antigravity');
    appDir = env.ANTIGRAVITY_DIR || defaultAppDir;
    installDir = env.ANTIGRAVITY_RESOURCES || p.join(appDir, 'resources');
    exePath = env.ANTIGRAVITY_EXE || p.join(appDir, 'Antigravity.exe');
  } else if (platform === 'darwin') {
    const home = env.HOME || os.homedir();
    const bundleCandidates = [
      env.ANTIGRAVITY_APP,
      env.ANTIGRAVITY_DIR,
      '/Applications/Antigravity.app',
      p.join(home, 'Applications', 'Antigravity.app')
    ].filter(Boolean);

    appBundle = bundleCandidates.find((candidate) => {
      try {
        return fsMod.existsSync(candidate);
      } catch (_) {
        return false;
      }
    }) || '/Applications/Antigravity.app';

    if (env.ANTIGRAVITY_RESOURCES) {
      const normalizedRes = String(env.ANTIGRAVITY_RESOURCES).replace(/\\/g, '/').replace(/\/+$/, '');
      if (normalizedRes.endsWith('/Contents/Resources') || normalizedRes === 'Contents/Resources') {
        appBundle = p.resolve(normalizedRes, '..', '..');
      }
    }

    installDir = env.ANTIGRAVITY_RESOURCES || p.join(appBundle, 'Contents', 'Resources');
    exePath = env.ANTIGRAVITY_EXE || p.join(appBundle, 'Contents', 'MacOS', 'Antigravity');
    appDir = appBundle;
  } else {
    const resourceCandidates = [
      env.ANTIGRAVITY_RESOURCES,
      env.ANTIGRAVITY_DIR ? p.join(env.ANTIGRAVITY_DIR, 'resources') : null,
      '/opt/Antigravity/resources',
      '/usr/share/antigravity/resources',
      '/usr/lib/antigravity/resources'
    ].filter(Boolean);

    installDir = resourceCandidates.find((candidate) => {
      try {
        return fsMod.existsSync(candidate);
      } catch (_) {
        return false;
      }
    }) || '/opt/Antigravity/resources';

    appDir = env.ANTIGRAVITY_DIR || p.dirname(installDir);
    exePath = env.ANTIGRAVITY_EXE || p.join(appDir, 'antigravity');
  }

  const asarPath = env.ANTIGRAVITY_ASAR || p.join(installDir, 'app.asar');
  const backupAsar = p.join(p.dirname(asarPath), 'app.asar.bak');

  return {
    platform,
    appDir,
    appBundle,
    installDir,
    asarPath,
    backupAsar,
    exePath
  };
}

/**
 * macOS 修改 app.asar 后需要重新进行本地 Ad-hoc 深度签名，否则 Gatekeeper 可能拦截启动。
 */
function resignMacAppIfNeeded(appBundle, platform = process.platform) {
  if (platform !== 'darwin' || !appBundle || !String(appBundle).endsWith('.app') || !fs.existsSync(appBundle)) {
    return false;
  }
  console.log(` - [macOS] 正在对应用执行本地深度签名: ${appBundle}`);
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appBundle], { stdio: 'inherit' });
    console.log(' - [macOS] 本地签名完成');
    return true;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error(
      `macOS 本地重新签名失败 (${msg})。请尝试使用 sudo 重新运行，或手动执行: codesign --force --deep --sign - "${appBundle}"`
    );
  }
}

module.exports = {
  resolveInstallPaths,
  resignMacAppIfNeeded
};
