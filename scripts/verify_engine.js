process.noAsar = true;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveInstallPaths } = require('./runtime_paths');
const { verifyDeployedAsar } = require('./verify/test_deployed_asar');
const { runTranslationRulesVerification } = require('./verify/test_translation_rules');
const { runOtaControllerVerification, runAutoMtVerification } = require('./verify/test_ota_and_mt');
const { runGuardProxyAndRestoreVerification } = require('./verify/test_guard_and_restore');
const { runLexicalPromptVerification } = require('./verify/test_lexical');

const projectRoot = path.resolve(__dirname, '..');
const resolvedPaths = resolveInstallPaths();
const deployedAsar = process.env.ANTIGRAVITY_ASAR || resolvedPaths.asarPath;
const localOnly = process.argv.includes('--local');
const smokeOnly = process.argv.includes('--smoke');

async function main() {
  let i18nCode;
  let pkgVersion = 'local';
  let asarEntriesCount = 0;

  if (localOnly) {
    const localI18n = path.join(projectRoot, 'build', 'i18n.js');
    assert(fs.existsSync(localI18n), `Missing local build/i18n.js at ${localI18n}`);
    i18nCode = fs.readFileSync(localI18n, 'utf8');
  } else {
    const deployedInfo = verifyDeployedAsar({ deployedAsar, projectRoot });
    i18nCode = deployedInfo.i18nCode;
    pkgVersion = deployedInfo.pkgVersion;
    asarEntriesCount = deployedInfo.asarEntriesCount;
  }

  runTranslationRulesVerification({
    i18nCode,
    projectRoot,
    pkgVersion,
    asarEntriesCount,
    smoke: smokeOnly
  });

  if (smokeOnly) {
    return;
  }

  await runOtaControllerVerification();
  await runGuardProxyAndRestoreVerification();
  await runAutoMtVerification({ i18nCode, projectRoot });
  await runLexicalPromptVerification(i18nCode);
  console.log('OTA CONTROLLER & HOT-RELOAD VERIFICATION PASSED!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
