# Antigravity UI 汉化工程文件清单

---

## 1. 一键入口与依赖配置

- `build_and_deploy.ps1`：编译生成 `build/i18n.js`，从 `app.asar.bak` 打包部署至官方安装目录，并自动运行 `verify_engine.js` 校验。
- `一键修复或更新汉化.bat`：Windows 双击一键修复/应用最新版汉化补丁。
- `package.json` / `package-lock.json`：提供 `@electron/asar` 打包拆包依赖。

## 2. 词库与版本基线（`assets/`）

- `assets/dictionary.json`：唯一静态精确词典主表（不再在构建脚本中二次硬编码覆盖）。
- `assets/attr_dict.json`：元素属性（`title`、`aria-label`、`placeholder`、`tooltip` 等）专用译文表。
- `assets/preserve_list.json`：严格保留原英文的品牌、模型与专有名词白名单。
- `assets/extracted_tooltips.json`：历史逆向提取的 Tooltip 对照参考。
- `assets/baseline/bundle_main.js` & `version.json`：与当前适配客户端版本（记录于 `assets/baseline/version.json`）同步的完整渲染端代码基线，用于版本升级扫漏。

## 3. 核心脚本与模块（`scripts/`）

- `scripts/i18n_core.js`：解包官方干净备份 `app.asar.bak`，注入 `utils.js`、`menu.js`、`tray.js`、`main.js`、`updater.js`、`ipcHandlers.js`、`webviewPopupSecurity.js`、`ideInstall/wizardHtml.js`、`languageServer.js` 等主进程补丁，并内置 `build/i18n.js`。
- `scripts/build_clean_engine.js`：组装词库、属性表、保留表与 `scripts/engine/*` 子模块，输出 `build/i18n.js`。
- `scripts/engine/dynamic_rules.js`：动态句式与变量正则模板。
- `scripts/engine/context_rules.js`：代码区隔离与上下文消歧（`New` 徽章 vs `新建`；`None` 分组为 `不分组`、思考深度为 `关闭思考`、其余为 `无`）。
- `scripts/engine/split_node_rules.js`：React 相邻 TextNode 碎片翻译规则。
- `scripts/engine/runtime_bootstrap.js`：DOM 原型链拦截、`MutationObserver` 与浮层/悬停调度器。
- `scripts/scan_updates.js`：从 `%APPDATA%\Antigravity\Cache\Cache_Data` 刷新最新前端 `bundle_main.js` 基线并扫描遗漏英文 UI 字符串。
- `scripts/verify_engine.js`：使用 Node `vm` 对已部署 `app.asar` 执行回归测试。
- `scripts/release_version.js`：校验 `package.json`、`assets/baseline/version.json` 与 `README.md` 版本一致性，并辅助递增三段式版本号及生成标准 Tag / Release 命令。
- `scripts/guard_launch.js` & `scripts/auto_patch_on_update.js` & `scripts/patch_antigravity.js`：启动守护与官方更新后自动重打补丁入口。

## 4. 构建产物与文档

- `build/`（构建时自动生成，不纳入 Git）：`i18n.js`、`app.asar`、`untranslated_scan_report.json`
- `docs/`：`i18n_architecture_and_history.md`、`i18n_files_manifest.md`、`session_continuation_handover.md`

## 5. 官方安装目录（生产目标）

- 主程序包：`%LOCALAPPDATA%\Programs\antigravity\resources\app.asar`
- 官方原版备份：`%LOCALAPPDATA%\Programs\antigravity\resources\app.asar.bak`
