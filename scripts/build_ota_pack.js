const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { cleanDictObject } = require('./build_clean_engine');

const SCHEMA_VERSION = 1;
const MIN_ENGINE_VERSION = '0.3.0';
const MAX_OTA_RULES = 200;
const MAX_RULE_LEN = 240;
const SAFE_FLAGS_RE = /^[iu]*$/;
const NESTED_QUANTIFIER_RE = /\([^)]*[+*][^)]*\)[+*{]/;

const baseDir = path.resolve(__dirname, '..');
const assetsDir = path.join(baseDir, 'assets');
const buildOtaDir = path.join(baseDir, 'build', 'ota');

function formatPackVersion(date) {
  const d = date instanceof Date ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}.` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

function validateOtaRules(rawRules) {
  if (rawRules === undefined || rawRules === null) return [];
  if (!Array.isArray(rawRules)) {
    throw new Error('assets/ota_rules.json 必须为 JSON 数组');
  }
  if (rawRules.length > MAX_OTA_RULES) {
    throw new Error(`assets/ota_rules.json 规则数量超过上限 (${MAX_OTA_RULES})`);
  }
  const normalized = [];
  for (let i = 0; i < rawRules.length; i++) {
    const r = rawRules[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error(`ota_rules[${i}] 必须为对象`);
    }
    if (typeof r.pattern !== 'string' || !r.pattern || r.pattern.length > MAX_RULE_LEN) {
      throw new Error(`ota_rules[${i}].pattern 必须为 1..${MAX_RULE_LEN} 字符的非空字符串`);
    }
    if (typeof r.replace !== 'string' || r.replace.length > MAX_RULE_LEN) {
      throw new Error(`ota_rules[${i}].replace 必须为 <= ${MAX_RULE_LEN} 字符的字符串`);
    }
    const flags = r.flags === undefined ? 'i' : String(r.flags);
    if (!SAFE_FLAGS_RE.test(flags)) {
      throw new Error(`ota_rules[${i}].flags 仅允许 i / u，禁止 g 等有状态标志: ${flags}`);
    }
    if (NESTED_QUANTIFIER_RE.test(r.pattern)) {
      throw new Error(`ota_rules[${i}].pattern 含潜在回溯风险的嵌套量词: ${r.pattern}`);
    }
    try {
      new RegExp(r.pattern, flags);
    } catch (err) {
      throw new Error(`ota_rules[${i}].pattern 正则无效: ${err.message}`);
    }
    const entry = {
      pattern: r.pattern,
      flags,
      replace: r.replace,
      requireAscii: r.requireAscii !== false
    };
    if (typeof r.id === 'string' && r.id.trim()) {
      entry.id = r.id.trim();
    }
    normalized.push(entry);
  }
  return normalized;
}

function readGitCommitSubject() {
  try {
    return execFileSync('git', ['log', '-1', '--pretty=%s'], {
      cwd: baseDir,
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true
    }).trim();
  } catch (_) {
    return '';
  }
}

function resolveReleaseUrl(pkg) {
  const repoUrl = pkg && pkg.repository && typeof pkg.repository.url === 'string'
    ? pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
    : 'https://github.com/downey37/antigravity-zh-cn';
  return `${repoUrl}/releases/latest`;
}

function loadOtaRulesFile(rulesPath = path.join(assetsDir, 'ota_rules.json')) {
  if (!fs.existsSync(rulesPath)) return [];
  return validateOtaRules(JSON.parse(fs.readFileSync(rulesPath, 'utf8')));
}

function buildOtaPack(options = {}) {
  const outDir = options.outDir || buildOtaDir;
  const now = options.now instanceof Date ? options.now : new Date();
  const builtAt = options.builtAt || now.toISOString();
  const packVersion = options.packVersion || formatPackVersion(now);

  const pkg = JSON.parse(fs.readFileSync(path.join(baseDir, 'package.json'), 'utf8'));
  const engineVersion = pkg.version || MIN_ENGINE_VERSION;
  const preserveList = JSON.parse(fs.readFileSync(path.join(assetsDir, 'preserve_list.json'), 'utf8'));
  const rawDict = JSON.parse(fs.readFileSync(path.join(assetsDir, 'dictionary.json'), 'utf8'));
  const rawAttrDict = JSON.parse(fs.readFileSync(path.join(assetsDir, 'attr_dict.json'), 'utf8'));
  const rules = loadOtaRulesFile(path.join(assetsDir, 'ota_rules.json'));

  const dictionary = cleanDictObject(rawDict, preserveList);
  const attrDict = cleanDictObject(rawAttrDict, preserveList);

  const dictCount = Object.keys(dictionary).length;
  const attrCount = Object.keys(attrDict).length;
  if (dictCount < 1000 || attrCount < 100) {
    throw new Error(`词库条数异常偏低 (dict=${dictCount}, attr=${attrCount})，中止生成 OTA 包`);
  }

  const pack = {
    schemaVersion: SCHEMA_VERSION,
    packVersion,
    builtAt,
    engineVersion,
    minEngineVersion: MIN_ENGINE_VERSION,
    dictionary,
    attrDict,
    preserveList,
    rules
  };

  const packJson = JSON.stringify(pack);
  const sha256 = crypto.createHash('sha256').update(packJson, 'utf8').digest('hex');

  const rawNotes = typeof options.notes === 'string' && options.notes.trim()
    ? options.notes.trim()
    : (process.env.OTA_NOTES || '').trim() || readGitCommitSubject() || `OTA 词库更新 (${packVersion})`;
  const notes = rawNotes.split(/\r?\n/)[0].trim();

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    packVersion,
    builtAt,
    engineVersion,
    minEngineVersion: MIN_ENGINE_VERSION,
    packFile: 'dict-pack.json',
    sha256,
    dictCount,
    attrCount,
    ruleCount: rules.length,
    releaseUrl: resolveReleaseUrl(pkg),
    notes
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';

  if (!options.dryRun) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'dict-pack.json'), packJson, 'utf8');
    fs.writeFileSync(path.join(outDir, 'manifest.json'), manifestJson, 'utf8');
  }

  return {
    manifest,
    pack,
    packJson,
    manifestJson,
    sha256,
    packPath: path.join(outDir, 'dict-pack.json'),
    manifestPath: path.join(outDir, 'manifest.json')
  };
}

if (require.main === module) {
  const res = buildOtaPack();
  console.log(
    `Successfully built OTA pack v${res.manifest.packVersion} ` +
    `(dict=${res.manifest.dictCount}, attr=${res.manifest.attrCount}, rules=${res.manifest.ruleCount}, ` +
    `size=${(Buffer.byteLength(res.packJson, 'utf8') / 1024).toFixed(1)} KB, sha256=${res.sha256.slice(0, 12)}...)`
  );
  console.log(`  manifest: ${res.manifestPath}`);
  console.log(`  pack    : ${res.packPath}`);
}

module.exports = {
  SCHEMA_VERSION,
  MIN_ENGINE_VERSION,
  validateOtaRules,
  loadOtaRulesFile,
  buildOtaPack,
  formatPackVersion
};
