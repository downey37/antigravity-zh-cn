const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { isAsarPatched, patchAsar } = require('./i18n_core');

const defaultAppDir = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity')
  : path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'antigravity');
const appDir = process.env.ANTIGRAVITY_DIR || defaultAppDir;
const exePath = process.env.ANTIGRAVITY_EXE || path.join(appDir, 'Antigravity.exe');
const rawProxy = (process.env.ANTIGRAVITY_PROXY || '').trim();
function resolveProxyEndpoints(proxyStr) {
  if (/^socks\d*:\/\//i.test(proxyStr)) {
    return {
      http: proxyStr.replace(/^socks\d*:\/\//i, 'http://'),
      socks: proxyStr
    };
  }
  if (/^https?:\/\//i.test(proxyStr)) {
    return {
      http: proxyStr,
      socks: proxyStr.replace(/^https?:\/\//i, 'socks5://')
    };
  }
  return {
    http: `http://${proxyStr}`,
    socks: `socks5://${proxyStr}`
  };
}
const defaultEndpoints = rawProxy ? resolveProxyEndpoints(rawProxy) : null;
const noProxyVal = process.env.ANTIGRAVITY_NO_PROXY || 'localhost,127.0.0.1,::1';
const DEFAULT_BYPASS = `--proxy-bypass-list=<local>;${noProxyVal.replace(/,/g, ';')}`;

function findProxyArgValue(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--proxy-server=')) {
      return args[i].slice('--proxy-server='.length).trim();
    }
    if (args[i] === '--proxy-server' && i + 1 < args.length) {
      return String(args[i + 1]).trim();
    }
  }
  return '';
}

(async () => {
  // 1. 若检测到刚被官方更新覆盖为英文原版，先极速自愈补丁
  if (!isAsarPatched()) {
    try {
      await patchAsar();
    } catch (err) {
      console.error('[Guard] 自愈补丁异常:', err && err.message ? err.message : err);
    }
  }

  // 2. 组装启动参数（仅当显式传入 --proxy-server 或配置了 ANTIGRAVITY_PROXY 时启用代理）
  const args = [...process.argv.slice(2)];
  const explicitProxy = findProxyArgValue(args);
  let activeEndpoints = null;

  if (explicitProxy) {
    activeEndpoints = resolveProxyEndpoints(explicitProxy);
  } else if (defaultEndpoints) {
    activeEndpoints = defaultEndpoints;
    args.push(`--proxy-server=${defaultEndpoints.http}`);
  }

  if (activeEndpoints && !args.some(a => a === '--proxy-bypass-list' || a.startsWith('--proxy-bypass-list='))) {
    args.push(DEFAULT_BYPASS);
  }

  // 3. 应用级可选隔离代理环境变量注入
  const isolatedEnv = activeEndpoints
    ? {
        ...process.env,
        HTTP_PROXY: activeEndpoints.http,
        HTTPS_PROXY: activeEndpoints.http,
        ALL_PROXY: activeEndpoints.socks,
        NO_PROXY: noProxyVal,
        http_proxy: activeEndpoints.http,
        https_proxy: activeEndpoints.http,
        all_proxy: activeEndpoints.socks,
        no_proxy: noProxyVal
      }
    : { ...process.env };

  // 4. 启动 Antigravity 主进程
  const child = spawn(exePath, args, {
    detached: true,
    stdio: 'ignore',
    env: isolatedEnv
  });
  child.unref();
  process.exit(0);
})();
