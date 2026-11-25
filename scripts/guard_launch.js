process.noAsar = true;

const fs = require('fs');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const { resolveInstallPaths } = require('./runtime_paths');
const { isAsarPatched, patchAsar } = require('./i18n_core');

// 默认探测的本地混合代理端口（Clash Verge Rev 默认 7897，v2rayN 默认 10808，Clash 常见 7890）
const FALLBACK_PROXY_CANDIDATES = [
  'http://127.0.0.1:7897',
  'http://127.0.0.1:10808',
  'http://127.0.0.1:7890'
];

function isProxyDisabledValue(val) {
  const normalized = String(val || '').trim().toLowerCase();
  return normalized === 'none' || normalized === 'direct' || normalized === 'off' || normalized === 'false' || normalized === '0';
}

function isAutoProxyDisabled(env = process.env) {
  const flag = String((env && env.ANTIGRAVITY_AUTO_PROXY) || '').trim().toLowerCase();
  return flag === '0' || flag === 'false' || flag === 'off' || flag === 'no';
}

function resolveProxyEndpoints(proxyStr) {
  const cleaned = String(proxyStr || '').trim();
  if (!cleaned) return null;
  if (/^socks\d*:\/\//i.test(cleaned)) {
    return {
      http: cleaned,
      socks: cleaned
    };
  }
  if (/^https?:\/\//i.test(cleaned)) {
    return {
      http: cleaned,
      socks: cleaned.replace(/^https?:\/\//i, 'socks5://')
    };
  }
  return {
    http: `http://${cleaned}`,
    socks: `socks5://${cleaned}`
  };
}

function parseHostPort(proxyStr) {
  try {
    const normalized = /^[a-z0-9+.-]+:\/\//i.test(proxyStr) ? proxyStr : `http://${proxyStr}`;
    const u = new URL(normalized);
    const port = Number(u.port);
    if (!u.hostname || !port || port <= 0 || port > 65535) return null;
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

function probeTcp(host, port, timeoutMs = 200) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function parseWinProxyServer(raw) {
  const str = String(raw || '').trim();
  if (!str) return '';
  if (!str.includes('=')) return str;
  const parts = str.split(';').map(s => s.trim()).filter(Boolean);
  const map = {};
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      map[part.slice(0, idx).trim().toLowerCase()] = part.slice(idx + 1).trim();
    }
  }
  if (map.https) return map.https;
  if (map.http) return map.http;
  if (map.socks) {
    return /^[a-z0-9+.-]+:\/\//i.test(map.socks) ? map.socks : `socks5://${map.socks}`;
  }
  return '';
}

function readWindowsSystemProxy() {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 800, windowsHide: true }
    );
    const enableMatch = out.match(/ProxyEnable\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)/i);
    if (!enableMatch) return '';
    const enabled = Number(enableMatch[1]) === 1;
    if (!enabled) return '';
    const serverMatch = out.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    if (!serverMatch) return '';
    return parseWinProxyServer(serverMatch[1]);
  } catch {
    return '';
  }
}

function extractAndStripProxyArgs(argv) {
  const cleaned = [];
  let explicitProxy = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--proxy-server=')) {
      explicitProxy = arg.slice('--proxy-server='.length).trim();
      continue;
    }
    if (arg === '--proxy-server' && i + 1 < argv.length) {
      explicitProxy = String(argv[i + 1]).trim();
      i++;
      continue;
    }
    cleaned.push(arg);
  }
  return { cleaned, explicitProxy };
}

async function detectActiveProxy(explicitProxy, options = {}) {
  const env = options.env || process.env;
  const probeFn = typeof options.probeTcp === 'function' ? options.probeTcp : probeTcp;
  const readWinProxyFn = typeof options.readWindowsSystemProxy === 'function'
    ? options.readWindowsSystemProxy
    : readWindowsSystemProxy;
  const fallbackCandidates = Array.isArray(options.fallbackCandidates)
    ? options.fallbackCandidates
    : FALLBACK_PROXY_CANDIDATES;

  // 1. 若通过环境变量显式指定 ANTIGRAVITY_PROXY，最高优先级处理（支持 none/direct 强制直连）
  const rawEnvProxy = String((env && env.ANTIGRAVITY_PROXY) || '').trim();
  if (rawEnvProxy) {
    if (isProxyDisabledValue(rawEnvProxy)) {
      return null;
    }
    return resolveProxyEndpoints(rawEnvProxy);
  }

  // 1.5 若命令行显式传入 --proxy-server=direct / none 等禁用值，直接走直连，跳过自动探测
  if (explicitProxy && isProxyDisabledValue(explicitProxy)) {
    return null;
  }

  // 2. 若设置 ANTIGRAVITY_AUTO_PROXY=0，则仅响应命令行显式传入的 --proxy-server
  if (isAutoProxyDisabled(env)) {
    if (explicitProxy && !isProxyDisabledValue(explicitProxy)) {
      return resolveProxyEndpoints(explicitProxy);
    }
    return null;
  }

  // 3. 组装候选列表（优先级：Windows 当前系统代理 > 快捷方式传入端口 > Clash 7897 / v2rayN 10808 / 7890）
  const candidates = [];
  const seen = new Set();
  const addCandidate = (p) => {
    const ep = resolveProxyEndpoints(p);
    if (!ep) return;
    const hp = parseHostPort(ep.http);
    if (!hp) return;
    const key = `${hp.host.toLowerCase()}:${hp.port}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ ep, host: hp.host, port: hp.port });
  };

  const winSysProxy = readWinProxyFn();
  if (winSysProxy) addCandidate(winSysProxy);
  if (explicitProxy && !isProxyDisabledValue(explicitProxy)) addCandidate(explicitProxy);
  for (const fallback of fallbackCandidates) {
    addCandidate(fallback);
  }

  // 并行快速探测本地监听端口，按优先级返回首个可用代理
  const results = await Promise.all(
    candidates.map(async (c) => ({
      candidate: c,
      ok: await probeFn(c.host, c.port, 200)
    }))
  );
  for (const r of results) {
    if (r.ok) {
      return r.candidate.ep;
    }
  }
  return null;
}

function buildProxyLaunchConfig(activeEndpoints, baseArgs = [], baseEnv = process.env) {
  const args = [...baseArgs];
  const env = { ...baseEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const noProxyVal = env.ANTIGRAVITY_NO_PROXY || 'localhost,127.0.0.1,::1';
  const defaultBypass = `--proxy-bypass-list=<local>;${noProxyVal.replace(/,/g, ';')}`;

  if (activeEndpoints) {
    if (!args.some(a => a === '--proxy-server' || a.startsWith('--proxy-server='))) {
      args.push(`--proxy-server=${activeEndpoints.http}`);
    }
    if (!args.some(a => a === '--proxy-bypass-list' || a.startsWith('--proxy-bypass-list='))) {
      args.push(defaultBypass);
    }
    env.HTTP_PROXY = activeEndpoints.http;
    env.HTTPS_PROXY = activeEndpoints.http;
    env.ALL_PROXY = activeEndpoints.socks;
    env.NO_PROXY = noProxyVal;
    env.http_proxy = activeEndpoints.http;
    env.https_proxy = activeEndpoints.http;
    env.all_proxy = activeEndpoints.socks;
    env.no_proxy = noProxyVal;
  } else {
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ANTIGRAVITY_PROXY']) {
      delete env[k];
    }
  }

  return { args, env };
}

if (require.main === module) {
  (async () => {
    const { exePath } = resolveInstallPaths();
    if (!fs.existsSync(exePath)) {
      console.error(`[Guard] 未找到 Antigravity 可执行文件: ${exePath}`);
      process.exit(1);
    }

    // 1. 若检测到刚被官方更新覆盖为英文原版，先极速自愈补丁
    if (!isAsarPatched()) {
      try {
        await patchAsar();
      } catch (err) {
        console.error('[Guard] 自愈补丁异常:', err && err.message ? err.message : err);
      }
    }

    // 2. 自动探测当前活跃代理端口（优先 Windows 系统代理，兼容 7897 / 10808 / 7890）
    const { cleaned, explicitProxy } = extractAndStripProxyArgs(process.argv.slice(2));
    const activeEndpoints = await detectActiveProxy(explicitProxy);
    const { args, env: isolatedEnv } = buildProxyLaunchConfig(activeEndpoints, cleaned, process.env);

    // 3. 启动 Antigravity 主进程，等待 spawn 确认成功后再退出
    const child = spawn(exePath, args, {
      detached: true,
      stdio: 'ignore',
      env: isolatedEnv
    });
    child.once('spawn', () => {
      child.unref();
      process.exit(0);
    });
    child.once('error', (err) => {
      console.error(`[Guard] 启动 Antigravity 失败 (${exePath}):`, err && err.message ? err.message : err);
      process.exit(1);
    });
  })().catch((err) => {
    console.error('[Guard] 启动流程异常:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = {
  FALLBACK_PROXY_CANDIDATES,
  isProxyDisabledValue,
  isAutoProxyDisabled,
  resolveProxyEndpoints,
  parseHostPort,
  probeTcp,
  parseWinProxyServer,
  readWindowsSystemProxy,
  extractAndStripProxyArgs,
  detectActiveProxy,
  buildProxyLaunchConfig
};
