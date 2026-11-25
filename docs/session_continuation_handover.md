# Antigravity UI 汉化维护与交接指南

> 本文档位于 `docs/session_continuation_handover.md`，用于快速掌握仓库目录结构、核心机制、避坑事项及标准跟版维护流程。

---

## 1. 核心原则

1. **保留品牌与模型原名**：`assets/preserve_list.json` 中的 `Antigravity`、`Google Drive` 及 AI 模型名称（`Gemini`、`Claude`、`GPT-OSS` 等）始终保留原文。
2. **单一数据源**：静态翻译词条只保存在 `assets/dictionary.json` 与 `assets/attr_dict.json`，**不要在脚本里硬编码覆写对象并回写 JSON**。
3. **重上下文轻模糊**：若出现“同一个英文在不同菜单含义不同”（如 `New` / `None`），优先在 `scripts/engine/context_rules.js` 添加精确 DOM 上下文判断，避免全局改写误伤其他模块。
4. **ASAR 与零依赖运行时安全**：所有直接操作 `app.asar` 的脚本顶部统一设置 `process.noAsar = true;`，确保在客户端自带 `ELECTRON_RUN_AS_NODE=1` 环境下将 `.asar` 当作普通文件读写。
5. **保持官方自动更新与智能代理探测**：
   - 主进程 `updater.js`、`ipcHandlers.js`（`updater:quit-and-install`）及 `will-quit` 已联动指向 `scripts/auto_patch_on_update.js`，且 `scripts/guard_launch.js` 支持启动前毫秒级自愈检查。
   - `guard_launch.js`（以及更新自愈重启流程）内置 **Windows 系统代理读取** 与常见本地代理端口（`7897` / `10808` / `7890`）并行 TCP 自动探测；若未探测到可用代理或显式设置 `ANTIGRAVITY_PROXY=direct` / `ANTIGRAVITY_AUTO_PROXY=0`，则清理残留代理变量走直连 / TUN（并清除 `ELECTRON_RUN_AS_NODE` 防止误入 Node 模式）。
6. **无损可逆与持久化标题栏中英切换**：
   - 首次部署保留干净 `app.asar.bak`，支持 `scripts/restore_antigravity.js` 一键还原官方英文（macOS 自动本地重签名）。
   - 渲染端使用 `WeakMap`（`ORIG_TEXT` / `ORIG_ATTRS`）保存原文并注入顶部标题栏常驻 `[ 中 | EN ]` 开关，由 `scripts/ota/i18n_ota_main.js` 将开关状态持久化至 `state.json` 并通过 `_i18nT(zh, en)` 联动主进程原生菜单、托盘、对话框、更新器、安全弹窗、向导与远程 SSH 页面同步无损切换。

---

## 2. 重点目录速查

| 用途 | 路径 | 说明 |
| :--- | :--- | :--- |
| **主静态词库** | `assets/dictionary.json` | 4060+ 条确定性译文 |
| **属性译文表** | `assets/attr_dict.json` | 390+ 条 HTML 属性 / Tooltip 译文 |
| **保留白名单** | `assets/preserve_list.json` | 不翻译的专有名词列表 |
| **OTA 规则** | `assets/ota_rules.json` | 云端可热更声明式正则模板 |
| **新版前端基线** | `assets/baseline/bundle_main.js` | 本地运行 `npm run scan` 后从客户端缓存提取的前端基线（不纳入 Git） |
| **跨平台路径与签名** | `scripts/runtime_paths.js` | 统一解析 Windows / macOS / Linux 路径与 macOS `codesign` |
| **动态模板** | `scripts/engine/dynamic_rules.js` | 动态数字、日期、配额、通知模板 |
| **上下文消歧** | `scripts/engine/context_rules.js` | `New`、`None` 等特定场景识别 |
| **碎片节点** | `scripts/engine/split_node_rules.js` | React 内联拆分 TextNode 处理 |
| **运行时调度引擎** | `scripts/engine/runtime_bootstrap.js` | 原型链拦截、`WeakMap` 原文追踪、标题栏 `[ 中 \| EN ]` 开关与菜单注入 |
| **OTA 与语言状态** | `scripts/ota/i18n_ota_main.js` | 纯 JSON OTA 热更控制器、`state.json` 开关持久化与 `_i18nT` 双语状态广播 |
| **打包部署入口** | `build_and_deploy.ps1` | 构建 → 部署 `app.asar` → 自动执行 `verify_engine.js` |
| **更新扫漏脚本** | `scripts/scan_updates.js` | 支持 `--refresh` 自动从缓存提取最新官方版本脚本并扫描未汉化词条 |
| **回归测试脚本** | `scripts/verify_engine.js` | 校验 `app.asar` 钩子、VM 引擎、中英切换、OTA、代理探测与还原 |
| **便携包构建脚本** | `scripts/build_portable_release.js` | 生成零 Node 依赖便携压缩包及 `.sha256` 校验文件 |
| **版本发版工具** | `scripts/release_version.js` | 校验 `package.json` / 基线 / `README.md` 一致性并辅助递增三段式版本号 |
| **一键桌面入口** | `一键修复或更新汉化.bat` / `一键还原官方英文.bat` / `一键免TUN启动.bat` / `*.sh` | 面向普通用户的一键安装、还原与免 TUN 联网启动入口 |

---

## 3. 标准维护工作流

### 场景 A：反馈某处未翻译或翻译不准确
1. 在本地 `assets/baseline/bundle_main.js`（可先执行 `npm run scan` 提取）中按英文精确文本搜索其组件上下文（确认是否属于属性、碎片 JSX 节点、动态模板或同词多义冲突）。
2. 按需修改对应位置：
   - 普通固定文案：修改 `assets/dictionary.json`（如果是 `title` / `aria-label` 等同时加进 `assets/attr_dict.json`）。
   - 含变量句子：修改 `scripts/engine/dynamic_rules.js`（或仅纯词库热更可加入 `assets/ota_rules.json`）。
   - 被标签拆散的句子：修改 `scripts/engine/split_node_rules.js`。
   - 特定位置专属含义：修改 `scripts/engine/context_rules.js` 与 `runtime_bootstrap.js`。
3. 同步在 `scripts/verify_engine.js` 添加一条断言，然后执行：
   ```powershell
   npm run deploy
   ```
4. 按 `Ctrl + Q` 彻底退出 Antigravity 并重开验证。

### 场景 B：Antigravity 客户端更新到新版本后出现新英文
1. 打开一次新版客户端使缓存写入，然后运行：
   ```powershell
   npm run scan
   ```
2. 查看生成的 `build/untranslated_scan_report.json`，补全合理的新增 UI 词条后再运行 `npm run deploy`。

---

## 4. 版本号规范与标准发版流程

### 版本号规则
1. **严格三段式 SemVer（`vMAJOR.MINOR.PATCH`）**：所有 Git Tag、GitHub Release 与 `package.json` 必须写满三位（如 `v0.1.0`、`v0.2.0`、`v0.4.0`），**严禁使用 `v0.4` 这类两段式 Tag**。
2. **递增标准**：
   - **修订号 (`+0.0.1`)**：同一 Antigravity 版本内的补漏、纠错、动态/上下文规则调整与文档优化。
   - **次版本号 (`+0.1.0`)**：适配新版 Antigravity 官方客户端基线，或新增重要功能（同时将修订号归零）。
   - **主版本号晋升 (`1.0.0`)**：当整体架构定型、常用界面覆盖完善且安装/还原体验稳定时正式升至 `1.0.0`。
3. **双版本标识（Release 标题规范）**：所有 GitHub Release 标题强制采用 **`vX.Y.Z (适配 Antigravity vA.B.C)`**，让用户一眼确认所支持的客户端版本。

### 标准发版检查清单
1. 若本次适配新版客户端，先打开新版客户端并运行 `npm run scan`，确保 `assets/baseline/version.json` 已更新为新版本号。
2. 运行 `npm run version:bump -- <patch|minor|major|X.Y.Z>`（可先加 `--dry-run` 预演）同步更新 `package.json` 与 `README.md` 中的版本号、适配徽章及词条数统计。
3. 运行 `npm run version:check`、`npm run verify:local`（或真机验证 `npm run deploy`）以及 `npm run build:portable`，确认全部校验通过。
4. 提交变更、创建带注解的三段式 Tag 并推送（`.github/workflows/release-portable.yml` 亦会在打 Tag 时自动构建并附加便携包，也可本地构建后在 `gh release create` 时一并上传）：
   ```powershell
   git add -A
   git commit -m "chore: release vX.Y.Z"
   git tag -a vX.Y.Z -m "vX.Y.Z - Antigravity 简体中文汉化补丁 (supports Antigravity vA.B.C)"
   git push origin main vX.Y.Z
   gh release create vX.Y.Z build/antigravity-zh-cn-vX.Y.Z-portable.zip build/antigravity-zh-cn-vX.Y.Z-portable.zip.sha256 --title "vX.Y.Z (适配 Antigravity vA.B.C)" --notes "..."
   ```
