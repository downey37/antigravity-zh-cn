process.noAsar = true;

const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const { resolveInstallPaths, resignMacAppIfNeeded } = require('./runtime_paths');
const { hasAnyPatchArtifacts } = require('./i18n_core');

/**
 * 将本地已汉化的 app.asar 无损还原为 app.asar.bak 官方英文原版。
 */
async function restoreAsar(options = {}) {
  const resolved = resolveInstallPaths(options.env || process.env, options.platform || process.platform);
  const asarPath = options.asarPath || resolved.asarPath;
  const backupAsar = options.backupAsar || path.join(path.dirname(asarPath), 'app.asar.bak');
  const appBundle = options.appBundle !== undefined ? options.appBundle : resolved.appBundle;
  const platform = options.platform || resolved.platform;

  if (!fs.existsSync(backupAsar)) {
    if (fs.existsSync(asarPath) && !hasAnyPatchArtifacts(asarPath)) {
      console.log('当前客户端已是官方英文原版，无需还原。');
      return { status: 'already_original', asarPath };
    }
    throw new Error(
      `未找到官方原版备份文件 (${backupAsar})，无法自动还原。请重新运行 Antigravity 官方安装包修复或覆盖安装以恢复官方英文原版。`
    );
  }

  try {
    asar.uncache(backupAsar);
  } catch (_) {}

  if (hasAnyPatchArtifacts(backupAsar)) {
    throw new Error(
      `检测到备份文件 (${backupAsar}) 本身已被修改，已中止还原以避免写入错误版本。请使用 Antigravity 官方安装包重新安装。`
    );
  }

  let version = 'unknown';
  try {
    const pkgBuf = asar.extractFile(backupAsar, 'package.json');
    version = JSON.parse(pkgBuf.toString('utf8')).version || 'unknown';
  } catch (err) {
    throw new Error(`备份文件 (${backupAsar}) 校验失败或已损坏: ${err && err.message ? err.message : err}`);
  }

  console.log('==========================================');
  console.log(`  Antigravity 官方英文原版还原工具 (v${version})`);
  console.log('==========================================');
  console.log(` - 目标核心: ${asarPath}`);
  console.log(` - 原版备份: ${backupAsar}`);

  try {
    fs.copyFileSync(backupAsar, asarPath);
  } catch (err) {
    const code = err && err.code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      const hint = platform === 'win32'
        ? '请先在 Antigravity 窗口内按 Ctrl + Q（或右键系统托盘图标 -> 退出）彻底关闭客户端后重试。'
        : '请先完全退出 Antigravity 客户端（Cmd + Q），若安装目录需要管理员权限请使用 sudo 重新运行。';
      throw new Error(`无法写入 ${asarPath} (${code})。${hint}`);
    }
    throw err;
  }

  try {
    asar.uncacheAll();
  } catch (_) {}

  if (hasAnyPatchArtifacts(asarPath)) {
    throw new Error(`还原校验失败: ${asarPath} 仍检测到汉化痕迹，请手动将 app.asar.bak 重命名为 app.asar。`);
  }

  resignMacAppIfNeeded(appBundle, platform);

  console.log('==========================================');
  console.log(`  还原成功！已恢复官方英文原版 (v${version})`);
  console.log('  请彻底退出并重新打开 Antigravity 生效。');
  console.log('==========================================');

  return {
    status: 'restored',
    version,
    asarPath,
    backupAsar
  };
}

if (require.main === module) {
  restoreAsar().catch((err) => {
    console.error(`[错误] 还原失败: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}

module.exports = {
  restoreAsar
};
