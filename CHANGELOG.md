# 更新日志 (Changelog)

本项目遵循严格三段式语义化版本（`vMAJOR.MINOR.PATCH`），并与适配的 Antigravity 桌面客户端版本双线对应。

---

## [v0.6.0] - 2026-11-25（适配 Antigravity v2.35.1）

### 新增与改进
- **适配 Antigravity v2.35.1**：更新客户端基线，新增 180+ 条静态词库（总计 **4250+ 条静态词库 + 440+ 条属性译文**）、动态句式与拆分节点规则。
- **全新标题栏 `[ 中 | EN ]` 开关**：重构为随客户端深/浅色主题自动联动的胶囊滑块开关，支持点击与横向拖拽滑动切换及果冻弹性动效。
- **免 TUN 联网启动强化**：将守护启动脚本正式更名为 `一键免TUN启动.bat`，在文档与脚本中突出零 TUN 虚拟网卡、Electron + Go 核心双端代理自动注入能力。
- **动态公告自动机翻兜底**：新增白名单动态公告卡片异步机翻兜底（默认免 Key `google-gtx`，可选 OpenAI/Ollama，可在「帮助 → 自动翻译动态公告」开关）并精简标题栏菜单入口。
- **英文文档与 GitHub 仓库完善**：新增英文主页 [README.en.md](README.en.md) 与英文横幅，优化深色主题友好的无边框高清预览排版，补充 PR CI（`ci.yml`）、[贡献指南](CONTRIBUTING.md)、PR 模板及 `1280×640` 社交分享封面图。

---

## [v0.5.1] - 2026-11-25（适配 Antigravity v2.34.0）

### 修复
- **彻底解决打开「设置」时界面卡死**：引入 `dictGeneration` 世代计数与 `fromSplit` 标记阻断 `MutationObserver` 微任务死循环；前置大小写不敏感上下文消歧，消除 `Request Review` / `auto` / `NEW` / `NONE` 等震荡。
- **消除嵌套弹窗重扫与属性写入风暴**：跳过嵌套 `PORTAL_SELECTOR` 容器 3 倍重复扫描，新增 `takeRecords()` 排空、批次去重与高频冷却熔断器；`setAttrIfChanged` 实现标题栏零冗余属性写入。
- **自动化测试增强**：`verify_engine.js` 新增实时 `MutationObserver` 收敛回归套件。

---

## [v0.5.0] - 2026-11-25（适配 Antigravity v2.34.0）

### 新增
- **标题栏常驻 `[ 中 | EN ]` 切换开关与跨重启持久化**：在用户数据目录 `i18n-cache/state.json` 持久化中英显示偏好。
- **全主进程动态双语**：基于 `_i18nT(zh, en)` 联动主窗口、原生菜单、托盘菜单、系统通知、弹窗、更新步骤、WebView 安全弹窗与向导/远程页实时中英同步。

---

## [v0.4.0] - 2026-11-24（适配 Antigravity v2.34.0）

### 新增
- **零依赖便携包（`-portable.zip`）**：内嵌生产依赖并自动复用客户端内置 Electron 运行时（`ELECTRON_RUN_AS_NODE=1`），普通用户无需安装 Node.js。
- **跨平台支持**：新增 macOS 一键安装与还原脚本（`install_macos.sh` / `restore_macos.sh`），支持修改后自动本地 `codesign` 深度签名。
- **一键还原与代理探测启动**：新增 `一键还原官方英文.bat` 与系统代理 / 本地端口自动探测启动及更新自愈。

---

## [v0.3.0] - 2026-11-24（适配 Antigravity v2.34.0）

### 新增
- **Cloud OTA 云端词库热更新**：通过 GitHub `ota-dist` 单向只读通道拉取 SHA-256 校验的纯 JSON 词库与声明式正则模板，免重启生效；新增「帮助 → 检查汉化更新」手动入口。

---

## [v0.2.0] ~ [v0.2.4] - 2026-11-21 ~ 2026-11-24（适配 Antigravity v2.34.0）

- 适配 Antigravity v2.34.0，引入标准 SemVer 版本校验工具 `release_version.js`、Swarm UI 与套餐/模型公告规则、统一术语规范并补充截图预览与 Discussions 入口。

---

## [v0.1.0] - 2026-11-19（适配 Antigravity v2.33.0）

- 首个开源版本发布，实现基于 `app.asar.bak` 备份的可逆注入架构、核心词库与上下文消歧引擎。
