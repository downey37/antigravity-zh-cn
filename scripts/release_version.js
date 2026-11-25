const fs = require('fs');
const path = require('path');
const { cleanDictObject } = require('./build_clean_engine');

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const DEFAULT_ROOT = path.resolve(__dirname, '..');

/**
 * 判断版本号是否严格符合三段式语义化版本 (MAJOR.MINOR.PATCH)。
 */
function isStrictSemver(version) {
  return typeof version === 'string' && SEMVER_RE.test(version.trim());
}

/**
 * 去除可选的单个前导 `v`/`V`，并校验是否为三段式版本号。
 */
function normalizeStrictSemver(rawInput, label = '版本号') {
  const raw = String(rawInput == null ? '' : rawInput).trim();
  const stripped = raw.startsWith('v') || raw.startsWith('V') ? raw.slice(1) : raw;
  if (!isStrictSemver(stripped)) {
    throw new Error(
      `${label} "${raw}" 不符合规范：必须使用严格三段式版本号 (MAJOR.MINOR.PATCH，例如 0.3.0 或 2.35.0)。`
    );
  }
  return stripped;
}

/**
 * 基于当前版本号计算目标版本号（支持 patch / minor / major / 显式 X.Y.Z）。
 */
function bumpSemver(current, target) {
  const base = normalizeStrictSemver(current, '当前版本号');
  const rawTarget = String(target == null ? '' : target).trim();
  const keyword = rawTarget.toLowerCase();

  if (keyword === 'patch' || keyword === 'minor' || keyword === 'major') {
    const [major, minor, patch] = base.split('.').map(Number);
    if (keyword === 'patch') return `${major}.${minor}.${patch + 1}`;
    if (keyword === 'minor') return `${major}.${minor + 1}.0`;
    return `${major + 1}.0.0`;
  }

  return normalizeStrictSemver(rawTarget, '目标版本号');
}

function formatTagName(patchVersion) {
  const clean = normalizeStrictSemver(patchVersion, '补丁版本号');
  return `v${clean}`;
}

function formatReleaseTitle(patchVersion, clientVersion) {
  const cleanPatch = normalizeStrictSemver(patchVersion, '补丁版本号');
  const cleanClient = normalizeStrictSemver(clientVersion, '客户端版本号');
  return `v${cleanPatch} (适配 Antigravity v${cleanClient})`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * 计算与构建引擎一致的净静态词库与属性词库数量。
 */
function getDictionaryCounts(rootDir = DEFAULT_ROOT) {
  const assetsDir = path.join(rootDir, 'assets');
  const preserveList = readJson(path.join(assetsDir, 'preserve_list.json'));
  const dict = cleanDictObject(readJson(path.join(assetsDir, 'dictionary.json')), preserveList);
  const attrDict = cleanDictObject(readJson(path.join(assetsDir, 'attr_dict.json')), preserveList);
  return {
    dictCount: Object.keys(dict).length,
    attrCount: Object.keys(attrDict).length
  };
}

/**
 * 校验 package.json、assets/baseline/version.json、README.md、README.en.md 与文档中的版本一致性。
 */
function verifyVersionConsistency(rootDir = DEFAULT_ROOT) {
  const errors = [];
  const pkgPath = path.join(rootDir, 'package.json');
  const baselinePath = path.join(rootDir, 'assets', 'baseline', 'version.json');
  const readmePath = path.join(rootDir, 'README.md');
  const readmeEnPath = path.join(rootDir, 'README.en.md');
  const manifestPath = path.join(rootDir, 'docs', 'i18n_files_manifest.md');

  let patchVersion = '';
  let clientVersion = '';

  if (!fs.existsSync(pkgPath)) {
    errors.push(`缺少文件: ${pkgPath}`);
  } else {
    const pkg = readJson(pkgPath);
    patchVersion = String(pkg.version || '').trim();
    if (!isStrictSemver(patchVersion)) {
      errors.push(`package.json 的 version ("${patchVersion}") 必须为三段式 MAJOR.MINOR.PATCH。`);
    }
  }

  if (!fs.existsSync(baselinePath)) {
    errors.push(`缺少基线版本文件: ${baselinePath}`);
  } else {
    const baseline = readJson(baselinePath);
    clientVersion = String(baseline.version || '').trim();
    if (!isStrictSemver(clientVersion)) {
      errors.push(`assets/baseline/version.json 的 version ("${clientVersion}") 必须为三段式 MAJOR.MINOR.PATCH。`);
    }
  }

  if (!fs.existsSync(readmePath)) {
    errors.push(`缺少文件: ${readmePath}`);
  } else {
    const readme = fs.readFileSync(readmePath, 'utf8');
    if (isStrictSemver(clientVersion)) {
      const expectedBadge = `适配客户端-Antigravity%20v${clientVersion}-blue`;
      if (!readme.includes(expectedBadge)) {
        errors.push(`README.md 顶部适配徽章未匹配 "${expectedBadge}"。`);
      }
    }
    if (isStrictSemver(patchVersion) && isStrictSemver(clientVersion)) {
      const expectedIntro = `当前版本：**\`v${patchVersion}\`**（适配 Antigravity 客户端 \`v${clientVersion}\`）`;
      if (!readme.includes(expectedIntro)) {
        errors.push(`README.md 简介版本行未匹配 "${expectedIntro}"。`);
      }
    }
  }

  if (fs.existsSync(readmeEnPath)) {
    const readmeEn = fs.readFileSync(readmeEnPath, 'utf8');
    if (isStrictSemver(clientVersion)) {
      const expectedEnBadge = `Targets-Antigravity%20v${clientVersion}-blue`;
      if (!readmeEn.includes(expectedEnBadge)) {
        errors.push(`README.en.md 顶部适配徽章未匹配 "${expectedEnBadge}"。`);
      }
    }
    if (isStrictSemver(patchVersion) && isStrictSemver(clientVersion)) {
      const expectedEnIntro = `Current version: **\`v${patchVersion}\`** (supports Antigravity client \`v${clientVersion}\`)`;
      if (!readmeEn.includes(expectedEnIntro)) {
        errors.push(`README.en.md 简介版本行未匹配 "${expectedEnIntro}"。`);
      }
    }
  }

  if (fs.existsSync(manifestPath)) {
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    if (manifest.includes('v2.32.2')) {
      errors.push('docs/i18n_files_manifest.md 仍包含过时的硬编码基线版本号 "v2.32.2"。');
    }
  }

  const tagName = isStrictSemver(patchVersion) ? formatTagName(patchVersion) : '';
  const releaseTitle =
    isStrictSemver(patchVersion) && isStrictSemver(clientVersion)
      ? formatReleaseTitle(patchVersion, clientVersion)
      : '';

  return {
    ok: errors.length === 0,
    errors,
    patchVersion,
    clientVersion,
    tagName,
    releaseTitle
  };
}

/**
 * 同步更新 package.json、README.md 与 README.en.md 中的版本号、适配徽章和词条数量统计。
 */
function syncVersionFiles({ patchVersion, clientVersion, rootDir = DEFAULT_ROOT, dryRun = false }) {
  const cleanPatch = normalizeStrictSemver(patchVersion, '补丁版本号');
  const cleanClient = normalizeStrictSemver(clientVersion, '客户端版本号');

  const pkgPath = path.join(rootDir, 'package.json');
  const readmePath = path.join(rootDir, 'README.md');
  const readmeEnPath = path.join(rootDir, 'README.en.md');
  const baselinePath = path.join(rootDir, 'assets', 'baseline', 'version.json');

  const rawPkg = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(rawPkg);
  pkg.version = cleanPatch;
  const pkgEol = rawPkg.includes('\r\n') ? '\r\n' : '\n';
  const pkgTrailingNewline = rawPkg.endsWith('\n') ? pkgEol : '';
  const nextPkgText = JSON.stringify(pkg, null, 2).replace(/\n/g, pkgEol) + pkgTrailingNewline;

  const { dictCount, attrCount } = getDictionaryCounts(rootDir);
  const dictBucket = `${Math.floor(dictCount / 10) * 10}+`;
  const attrBucket = `${Math.floor(attrCount / 10) * 10}+`;

  const rawReadme = fs.readFileSync(readmePath, 'utf8');
  const badgeRe = /适配客户端-Antigravity%20v\d+\.\d+\.\d+-blue/;
  const introRe = /当前版本：\*\*`v\d+\.\d+\.\d+`\*\*（适配 Antigravity 客户端 `v\d+\.\d+\.\d+`）/;
  const statsRe = /\d+\+ 条静态词库 \+ \d+\+ 条属性译文/;

  if (!badgeRe.test(rawReadme)) {
    throw new Error('README.md 中未找到适配客户端徽章锚点（适配客户端-Antigravity%20vX.Y.Z-blue）。');
  }
  if (!introRe.test(rawReadme)) {
    throw new Error('README.md 中未找到简介版本声明锚点（当前版本：**`vX.Y.Z`**（适配 Antigravity 客户端 `vA.B.C`））。');
  }
  if (!statsRe.test(rawReadme)) {
    throw new Error('README.md 中未找到词库规模统计锚点（N+ 条静态词库 + M+ 条属性译文）。');
  }

  const nextReadme = rawReadme
    .replace(badgeRe, `适配客户端-Antigravity%20v${cleanClient}-blue`)
    .replace(introRe, `当前版本：**\`v${cleanPatch}\`**（适配 Antigravity 客户端 \`v${cleanClient}\`）`)
    .replace(statsRe, `${dictBucket} 条静态词库 + ${attrBucket} 条属性译文`);

  let nextReadmeEn = null;
  if (fs.existsSync(readmeEnPath)) {
    const rawReadmeEn = fs.readFileSync(readmeEnPath, 'utf8');
    const enBadgeRe = /Targets-Antigravity%20v\d+\.\d+\.\d+-blue/;
    const enIntroRe = /Current version: \*\*`v\d+\.\d+\.\d+`\*\* \(supports Antigravity client `v\d+\.\d+\.\d+`\)/;
    const enStatsRe = /\d+\+ static entries \+ \d+\+ attribute translations/;

    if (!enBadgeRe.test(rawReadmeEn)) {
      throw new Error('README.en.md 中未找到适配客户端徽章锚点（Targets-Antigravity%20vX.Y.Z-blue）。');
    }
    if (!enIntroRe.test(rawReadmeEn)) {
      throw new Error('README.en.md 中未找到简介版本声明锚点（Current version: **`vX.Y.Z`** (supports Antigravity client `vA.B.C`)）。');
    }
    if (!enStatsRe.test(rawReadmeEn)) {
      throw new Error('README.en.md 中未找到词库规模统计锚点（N+ static entries + M+ attribute translations）。');
    }

    nextReadmeEn = rawReadmeEn
      .replace(enBadgeRe, `Targets-Antigravity%20v${cleanClient}-blue`)
      .replace(enIntroRe, `Current version: **\`v${cleanPatch}\`** (supports Antigravity client \`v${cleanClient}\`)`)
      .replace(enStatsRe, `${dictBucket} static entries + ${attrBucket} attribute translations`);
  }

  if (!dryRun) {
    fs.writeFileSync(pkgPath, nextPkgText, 'utf8');
    fs.writeFileSync(readmePath, nextReadme, 'utf8');
    if (nextReadmeEn !== null) {
      fs.writeFileSync(readmeEnPath, nextReadmeEn, 'utf8');
    }
  }

  let baselineVersion = '';
  if (fs.existsSync(baselinePath)) {
    baselineVersion = String(readJson(baselinePath).version || '').trim();
  }

  return {
    patchVersion: cleanPatch,
    clientVersion: cleanClient,
    tagName: formatTagName(cleanPatch),
    releaseTitle: formatReleaseTitle(cleanPatch, cleanClient),
    dictCount,
    attrCount,
    baselineMatches: cleanClient === baselineVersion
  };
}

function printHelp() {
  console.log([
    '用法:',
    '  node scripts/release_version.js --check',
    '  node scripts/release_version.js <patch|minor|major|X.Y.Z> [--client A.B.C] [--dry-run]',
    '',
    '说明:',
    '  --check            校验 package.json、assets/baseline/version.json、README.md 与文档版本一致性',
    '  patch|minor|major  按三段式 SemVer 递增补丁版本号 (如 0.2.4 -> 0.2.5 / 0.3.0 / 1.0.0)',
    '  X.Y.Z              显式指定三段式目标版本号 (禁止 0.3 这类两段式)',
    '  --client A.B.C     指定适配的 Antigravity 客户端版本 (默认读取 assets/baseline/version.json)',
    '  --dry-run          仅预览变更与发版命令，不写入任何文件'
  ].join('\n'));
}

function parseCliArgs(argv) {
  const opts = {
    help: false,
    check: false,
    dryRun: false,
    client: null,
    target: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--check') {
      opts.check = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--client') {
      if (i + 1 >= argv.length) {
        throw new Error('--client 参数缺少客户端版本号。');
      }
      opts.client = argv[++i];
    } else if (arg.startsWith('--client=')) {
      opts.client = arg.slice('--client='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`未知参数: ${arg}`);
    } else if (!opts.target) {
      opts.target = arg;
    } else {
      throw new Error(`多余的位置参数: ${arg}`);
    }
  }

  return opts;
}

function runCli() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printHelp();
    process.exit(1);
  }

  const opts = parseCliArgs(argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (opts.check) {
    const res = verifyVersionConsistency(DEFAULT_ROOT);
    if (!res.ok) {
      console.error('[版本校验失败]');
      for (const err of res.errors) {
        console.error(` - ${err}`);
      }
      process.exit(1);
    }
    console.log('[版本校验通过]');
    console.log(` - 补丁版本: v${res.patchVersion}`);
    console.log(` - 基线客户端: v${res.clientVersion}`);
    console.log(` - 标准 Tag: ${res.tagName}`);
    console.log(` - 标准 Release 标题: ${res.releaseTitle}`);
    process.exit(0);
  }

  if (!opts.target) {
    printHelp();
    process.exit(1);
  }

  const pkg = readJson(path.join(DEFAULT_ROOT, 'package.json'));
  const baseline = readJson(path.join(DEFAULT_ROOT, 'assets', 'baseline', 'version.json'));

  const nextVersion = bumpSemver(pkg.version, opts.target);
  const targetClientVersion = opts.client
    ? normalizeStrictSemver(opts.client, '客户端版本号')
    : normalizeStrictSemver(baseline.version, '基线客户端版本号');

  const result = syncVersionFiles({
    patchVersion: nextVersion,
    clientVersion: targetClientVersion,
    rootDir: DEFAULT_ROOT,
    dryRun: opts.dryRun
  });

  const prefix = opts.dryRun ? '[DRY-RUN] ' : '';
  console.log(`${prefix}版本信息${opts.dryRun ? '预览' : '已同步'}:`);
  console.log(` - 补丁版本: ${pkg.version} -> ${result.patchVersion}`);
  console.log(` - 适配客户端: v${result.clientVersion}`);
  console.log(` - 词库统计: ${result.dictCount} 静态词条 / ${result.attrCount} 属性译文`);
  console.log(` - 标准 Tag: ${result.tagName}`);
  console.log(` - 标准 Release 标题: ${result.releaseTitle}`);

  if (!result.baselineMatches) {
    console.warn(
      `\n[注意] 指定客户端版本 v${result.clientVersion} 与当前 assets/baseline/version.json (v${baseline.version}) 不一致！` +
        '\n发布适配新版客户端的补丁前，请先打开新版客户端并运行 `npm run scan` 更新本地基线。'
    );
  }

  const readmeFiles = fs.existsSync(path.join(DEFAULT_ROOT, 'README.en.md'))
    ? 'README.md README.en.md'
    : 'README.md';
  const stageFiles = result.baselineMatches
    ? `package.json ${readmeFiles}`
    : `package.json ${readmeFiles} assets/baseline/version.json`;

  console.log('\n标准发版命令参考:');
  console.log('  npm run verify:local');
  console.log(`  git add ${stageFiles}`);
  console.log(`  git commit -m "chore: release ${result.tagName}"`);
  console.log(
    `  git tag -a ${result.tagName} -m "${result.tagName} - Antigravity 简体中文汉化补丁 (supports Antigravity v${result.clientVersion})"`
  );
  console.log(`  git push origin main ${result.tagName}`);
  console.log(
    `  gh release create ${result.tagName} --title "${result.releaseTitle}" --notes "当前适配 **Antigravity 桌面客户端 v${result.clientVersion} (Windows)**。"`
  );
}

if (require.main === module) {
  try {
    runCli();
  } catch (err) {
    console.error(`[错误] ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

module.exports = {
  SEMVER_RE,
  isStrictSemver,
  bumpSemver,
  formatTagName,
  formatReleaseTitle,
  getDictionaryCounts,
  verifyVersionConsistency,
  syncVersionFiles
};
