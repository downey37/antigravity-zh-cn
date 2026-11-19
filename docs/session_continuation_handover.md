# Antigravity UI 汉化维护与交接指南

> 本文档位于 `docs/session_continuation_handover.md`，用于快速掌握仓库目录结构、核心机制、避坑事项及标准跟版维护流程。

---

## 1. 核心原则

1. **保留品牌与模型原名**：`assets/preserve_list.json` 中的 `Antigravity`、`Google Drive` 及 AI 模型名称（`Gemini`、`Claude`、`GPT-OSS` 等）始终保留原文。
2. **单一数据源**：静态翻译词条只保存在 `assets/dictionary.json` 与 `assets/attr_dict.json`，**不要在脚本里硬编码覆写对象并回写 JSON**。
3. **重上下文轻模糊**：若出现“同一个英文在不同菜单含义不同”（如 `New` / `None`），优先在 `scripts/engine/context_rules.js` 添加精确 DOM 上下文判断，避免全局改写误伤其他模块。
4. **保持官方自动更新**：主进程 `updater.js`、`ipcHandlers.js`（`updater:quit-and-install`）及 `will-quit` 已联动指向 `scripts/auto_patch_on_update.js`，且 `scripts/guard_launch.js` 支持启动前毫秒级自愈检查；`languageServer.js`、`guard_launch.js` 与 `auto_patch_on_update.js` 默认不强制注入代理，仅在显式设置 `ANTIGRAVITY_PROXY` 环境变量时启用隔离代理。

---

## 2. 重点目录速查

| 用途 | 路径 | 说明 |
| :--- | :--- | :--- |
| **主静态词库** | `assets/dictionary.json` | 3770+ 条确定性译文 |
| **属性译文表** | `assets/attr_dict.json` | 340+ 条 HTML 属性 / Tooltip 译文 |
| **保留白名单** | `assets/preserve_list.json` | 不翻译的专有名词列表 |
| **新版前端基线** | `assets/baseline/bundle_main.js` | 本地运行 `npm run scan` 后从客户端缓存提取的前端基线（不纳入 Git） |
| **动态模板** | `scripts/engine/dynamic_rules.js` | 动态数字、日期、配额、通知模板 |
| **上下文消歧** | `scripts/engine/context_rules.js` | `New`、`None` 等特定场景识别 |
| **碎片节点** | `scripts/engine/split_node_rules.js` | React 内联拆分 TextNode 处理 |
| **打包部署入口** | `build_and_deploy.ps1` | 构建 → 部署 `app.asar` → 自动执行 `verify_engine.js` |
| **更新扫漏脚本** | `scripts/scan_updates.js` | 支持 `--refresh` 自动从缓存提取最新官方版本脚本并扫描未汉化词条 |
| **回归测试脚本** | `scripts/verify_engine.js` | 直接读取安装目录 `app.asar` 的 `dist/i18n.js` 在 Node VM 中校验 |
| **双击修复工具** | `一键修复或更新汉化.bat` | 一键重新打补丁 |

---

## 3. 标准维护工作流

### 场景 A：反馈某处未翻译或翻译不准确
1. 在本地 `assets/baseline/bundle_main.js`（可先执行 `npm run scan` 提取）中按英文精确文本搜索其组件上下文（确认是否属于属性、碎片 JSX 节点、动态模板或同词多义冲突）。
2. 按需修改对应位置：
   - 普通固定文案：修改 `assets/dictionary.json`（如果是 `title` / `aria-label` 等同时加进 `assets/attr_dict.json`）。
   - 含变量句子：修改 `scripts/engine/dynamic_rules.js`。
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
