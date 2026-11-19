const { patchAsar } = require('./i18n_core');

patchAsar().catch(err => {
  console.error('[错误] 汉化补丁执行失败:', err);
  process.exit(1);
});
