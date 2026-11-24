const fs = require('fs');
const path = require('path');

const { createDynamicRules } = require('./engine/dynamic_rules');
const { createContextRules } = require('./engine/context_rules');
const { translateSplitTextNode } = require('./engine/split_node_rules');
const { antigravityI18nBootstrap } = require('./engine/runtime_bootstrap');

const baseDir = path.resolve(__dirname, '..');
const assetsDir = path.join(baseDir, 'assets');
const buildDir = path.join(baseDir, 'build');

const dictPath = path.join(assetsDir, 'dictionary.json');
const attrDictPath = path.join(assetsDir, 'attr_dict.json');
const preservePath = path.join(assetsDir, 'preserve_list.json');
const otaRulesPath = path.join(assetsDir, 'ota_rules.json');
const pkgPath = path.join(baseDir, 'package.json');

function cleanDictObject(rawDict, preserveList) {
  const cleaned = { ...rawDict };
  // 剔除保留白名单项，确保品牌与专有名词不被覆盖
  for (const p of preserveList) {
    delete cleaned[p];
  }
  return cleaned;
}

function formatUtcPackVersion(date) {
  const d = date instanceof Date ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}.` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/**
 * 读取词库与引擎模块，生成 build/i18n.js。
 */
function buildEngine(options = {}) {
  const preserveList = JSON.parse(fs.readFileSync(preservePath, 'utf8'));
  const dict = cleanDictObject(JSON.parse(fs.readFileSync(dictPath, 'utf8')), preserveList);
  const attrDict = cleanDictObject(JSON.parse(fs.readFileSync(attrDictPath, 'utf8')), preserveList);
  const otaRules = fs.existsSync(otaRulesPath)
    ? JSON.parse(fs.readFileSync(otaRulesPath, 'utf8'))
    : [];
  const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : {};
  const now = options.now instanceof Date ? options.now : new Date();
  const builtinMeta = {
    schemaVersion: 1,
    engineVersion: pkg.version || '0.3.0',
    packVersion: options.packVersion || formatUtcPackVersion(now),
    builtAt: options.builtAt || now.toISOString(),
    dictCount: Object.keys(dict).length,
    attrCount: Object.keys(attrDict).length,
    ruleCount: Array.isArray(otaRules) ? otaRules.length : 0
  };

  const dictCount = builtinMeta.dictCount;
  const engineScript =
    `// Antigravity 全量本地化引擎 (${dictCount} 词条 + Unicode 归一化 + 动态模板 + 上下文消歧 + 浮层/Swarm/OTA 支持)\n` +
    `(${antigravityI18nBootstrap.toString()})(\n` +
    `  ${JSON.stringify(dict)},\n` +
    `  ${JSON.stringify(attrDict)},\n` +
    `  ${JSON.stringify(preserveList)},\n` +
    `  ${createDynamicRules.toString()},\n` +
    `  ${createContextRules.toString()},\n` +
    `  ${translateSplitTextNode.toString()},\n` +
    `  ${JSON.stringify(Array.isArray(otaRules) ? otaRules : [])},\n` +
    `  ${JSON.stringify(builtinMeta)}\n` +
    `);\n`;

  fs.mkdirSync(buildDir, { recursive: true });
  const outPath = path.join(buildDir, 'i18n.js');
  fs.writeFileSync(outPath, engineScript, 'utf8');
  return { engineScript, dictCount, outPath, builtinMeta };
}

if (require.main === module) {
  const { dictCount, outPath } = buildEngine();
  console.log(`Successfully generated modular i18n engine (${dictCount} entries) at: ${outPath}`);
}

module.exports = { buildEngine, cleanDictObject, formatUtcPackVersion };
