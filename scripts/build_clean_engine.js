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

function cleanDictObject(rawDict, preserveList) {
  const cleaned = { ...rawDict };
  // 剔除保留白名单项，确保品牌与专有名词不被覆盖
  for (const p of preserveList) {
    delete cleaned[p];
  }
  return cleaned;
}

/**
 * 读取词库与引擎模块，生成 build/i18n.js。
 */
function buildEngine() {
  const preserveList = JSON.parse(fs.readFileSync(preservePath, 'utf8'));
  const dict = cleanDictObject(JSON.parse(fs.readFileSync(dictPath, 'utf8')), preserveList);
  const attrDict = cleanDictObject(JSON.parse(fs.readFileSync(attrDictPath, 'utf8')), preserveList);

  const dictCount = Object.keys(dict).length;
  const engineScript =
    `// Antigravity 全量本地化引擎 (${dictCount} 词条 + Unicode 归一化 + 动态模板 + 上下文消歧 + 浮层/Swarm 支持)\n` +
    `(${antigravityI18nBootstrap.toString()})(\n` +
    `  ${JSON.stringify(dict)},\n` +
    `  ${JSON.stringify(attrDict)},\n` +
    `  ${JSON.stringify(preserveList)},\n` +
    `  ${createDynamicRules.toString()},\n` +
    `  ${createContextRules.toString()},\n` +
    `  ${translateSplitTextNode.toString()}\n` +
    `);\n`;

  fs.mkdirSync(buildDir, { recursive: true });
  const outPath = path.join(buildDir, 'i18n.js');
  fs.writeFileSync(outPath, engineScript, 'utf8');
  return { engineScript, dictCount, outPath };
}

if (require.main === module) {
  const { dictCount, outPath } = buildEngine();
  console.log(`Successfully generated modular i18n engine (${dictCount} entries) at: ${outPath}`);
}

module.exports = { buildEngine, cleanDictObject };
