# Antigravity UI 汉化工程文件清单

---

## 1. 一键入口与依赖配置

- `一键修复或更新汉化.bat`：Windows 双击一键修复/应用最新版汉化补丁（免 Node.js，自动回落复用客户端内置 Electron 运行时）。
- `一键还原官方英文.bat`：Windows 双击一键将 `app.asar.bak` 无损还原为官方英文原版。
- `一键代理守护启动.bat`：Windows 启动守护入口，启动前自动自愈补丁并探测 Windows 系统代理与本地端口（`7897 / 10808 / 7890`）。
- `install_macos.sh` / `restore_macos.sh`：macOS 一键安装与一键还原脚本（含自动本地 `codesign` 深度签名）。
- `build_and_deploy.ps1`：编译生成 `build/i18n.js`，从 `app.asar.bak` 打包部署至官方安装目录，并自动运行 `verify_engine.js` 校验。
- `package.json` / `package-lock.json`：提供 `@electron/asar` 打包拆包依赖与标准化 npm 脚本。

## 2. 词库与版本基线（`assets/`）

- `assets/dictionary.json`：唯一静态精确词典主表（不再在构建脚本中二次硬编码覆盖）。
- `assets/attr_dict.json`：元素属性（`title`、`aria-label`、`placeholder`、`tooltip` 等）专用译文表。
- `assets/preserve_list.json`：严格保留原英文的品牌、模型与专有名词白名单。
- `assets/ota_rules.json`：云端可热更的纯数据声明式正则规则。
- `assets/extracted_tooltips.json`：历史逆向提取的 Tooltip 对照参考。
- `assets/baseline/bundle_main.js` & `version.json`：与当前适配客户端版本（记录于 `assets/baseline/version.json`）同步的完整渲染端代码基线，用于版本升级扫漏（`bundle_main.js` 不纳入 Git 与便携包）。

## 3. 核心脚本与模块（`scripts/`）

- `scripts/runtime_paths.js`：设置 `process.noAsar = true`，解析 Windows / macOS / Linux 安装路径并在 macOS 注入/还原后执行本地 Ad-hoc `codesign`。
- `scripts/run_with_runtime.ps1`：Windows PowerShell 5.1/7 通用运行时包装器，优先使用 Node `>= 20.19`，未安装时自动回落至 `Antigravity.exe` (`ELECTRON_RUN_AS_NODE=1`)。
- `scripts/i18n_core.js`：解包官方干净备份 `app.asar.bak`，注入 `utils.js`、`menu.js`、`tray.js`、`main.js`、`preload.js`、`updater.js`、`ipcHandlers.js`、`webviewPopupSecurity.js`、`ideInstall/wizardHtml.js`、`languageServer.js` 等主进程补丁，并内置 `build/i18n.js` 与 `dist/i18n_ota.js`。
- `scripts/restore_antigravity.js`：校验 `app.asar.bak` 完整性并无损恢复官方英文原版 `app.asar`。
- `scripts/build_clean_engine.js`：组装词库、属性表、保留表与 `scripts/engine/*` 子模块，输出 `build/i18n.js`。
- `scripts/build_ota_pack.js`：生成云端 OTA 分发产物 `build/ota/manifest.json` 与 `dict-pack.json`。
- `scripts/build_portable_release.js`：打包精简零依赖便携发布包（仅包含生产依赖树，剔除 `bundle_main.js`）及 `.sha256` 校验文件。
- `scripts/ota/i18n_ota_main.js`：主进程云端 OTA 热更新控制器与持久化中英切换状态广播中心（含 `t(zh, en)` 双语辅助与 `state.json` 持久化）。
- `scripts/engine/dynamic_rules.js`：动态句式与变量正则模板。
- `scripts/engine/context_rules.js`：代码区隔离与上下文消歧（`New` 徽章 vs `新建`；`None` 分组为 `不分组`、思考深度为 `关闭思考`、其余为 `无`）。
- `scripts/engine/split_node_rules.js`：React 相邻 TextNode 碎片翻译规则。
- `scripts/engine/runtime_bootstrap.js`：DOM 原型链拦截、`MutationObserver`、`WeakMap` 原文追踪（支持无损即时中英切换）、顶部标题栏 `[ 中 | EN ]` 常驻切换开关与标题栏菜单注入、浮层/悬停调度器。
- `scripts/scan_updates.js`：从 `%APPDATA%\Antigravity\Cache\Cache_Data` 刷新最新前端 `bundle_main.js` 基线并扫描遗漏英文 UI 字符串。
- `scripts/verify_engine.js`：使用 Node `vm` 对已部署 `app.asar`、DOM 切换、OTA 热更、代理自动探测与还原逻辑执行回归测试。
- `scripts/release_version.js`：校验 `package.json`、`assets/baseline/version.json` 与 `README.md` 版本一致性，并辅助递增三段式版本号及生成标准 Tag / Release 命令。
- `scripts/guard_launch.js` & `scripts/auto_patch_on_update.js` & `scripts/patch_antigravity.js`：启动守护（内置 Windows 系统代理读取与 `7897 / 10808 / 7890` 自动探测）、官方更新后自动重打补丁与一键修复入口。

## 4. 构建产物、CI 与文档

- `build/`（构建时自动生成，不纳入 Git）：`i18n.js`、`app.asar`、`ota/*`、`antigravity-zh-cn-*-portable.zip(.sha256)`、`untranslated_scan_report.json`
- `.github/workflows/`：`publish-ota.yml`（自动发布 `ota-dist` 词库包）、`release-portable.yml`（发版打 Tag 自动构建并上传便携包）
- `.github/ISSUE_TEMPLATE/`：漏翻/错译反馈与 Bug 反馈表单模板
- `docs/`：`i18n_architecture_and_history.md`、`i18n_files_manifest.md`、`session_continuation_handover.md`、`images/*`

## 5. 官方安装目录（生产目标）

- Windows 主程序包：`%LOCALAPPDATA%\Programs\antigravity\resources\app.asar`（备份：`app.asar.bak`）
- macOS 主程序包：`/Applications/Antigravity.app/Contents/Resources/app.asar`（备份：`app.asar.bak`）
