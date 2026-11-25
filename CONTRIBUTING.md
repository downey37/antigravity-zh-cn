# 参与贡献 (Contributing Guide)

感谢你对 **antigravity-zh-cn** 的关注与支持！无论是补充一条漏翻词条、润色译文表达，还是改进注入引擎与跨平台脚本，都非常欢迎。

---

## 一、仅贡献翻译词条（零代码门槛，合并后自动 OTA 推送）

绝大多数漏翻或错译修复只需修改 `assets/` 下的纯 JSON 文件，**合并到 `main` 分支后会自动触发 Cloud OTA 工作流推送至所有用户的客户端**：

1. **`assets/dictionary.json`**：主静态精确词库（`{ "English Source": "简体中文译文" }`）。
2. **`assets/attr_dict.json`**：HTML 属性译文（`title`、`aria-label`、`placeholder` 等）。
3. **`assets/preserve_list.json`**：必须保留英文原名的品牌、模型与专有名词白名单（如 `Antigravity`、`Gemini`、`Claude`、`GPT-OSS`）。
4. **`assets/ota_rules.json`**：纯数据声明式正则模板（用于带动态变量的短语）。

> [!TIP]
> 如果存在同词多义冲突（例如 `New` 在不同界面可能是「新」或「新建」，`None` 可能是「不分组」或「关闭思考」），请不要直接加入 `dictionary.json`，而是通过 Issue 附上位置与截图，或在 `scripts/engine/context_rules.js` 中按 DOM 上下文精确消歧。

---

## 二、开发与修改流程

**环境要求**：Node.js `>= 20.19`（推荐 `22+`）

```powershell
git clone https://github.com/downey37/antigravity-zh-cn.git
cd antigravity-zh-cn
npm install
```

修改完成后，请在本地运行完整沙箱校验（无需安装或覆盖本地客户端也可运行）：

```powershell
npm run build          # 重新构建 dist/前端引擎 (build/i18n.js)
npm run verify:local   # 运行构建、MutationObserver 收敛、OTA 热更、代理探测与还原沙箱测试
npm run version:check  # 校验版本号、基线与 README 一致性
```

如果本地已安装 Antigravity 客户端，还可执行：

```powershell
npm run deploy         # 完整编译、部署至本地客户端并运行全量校验
npm run restore        # 随时无损还原为官方英文原版
```

---

## 三、提交 Pull Request 规范

- 请保持词库 JSON 键名与官方客户端原始大小写、标点完全一致。
- 不要提交 `build/` 目录、日志或 `assets/baseline/bundle_main.js`（已由 `.gitignore` 忽略）。
- 提交 PR 时请按 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md) 勾选本地校验结果；GitHub Actions 的 `CI Verify` 工作流也会在 PR 上自动复核。

如果不便直接修改代码，也欢迎直接提交 [漏翻 / 错译反馈 Issue](https://github.com/downey37/antigravity-zh-cn/issues/new/choose) 或在 [Discussions](https://github.com/downey37/antigravity-zh-cn/discussions) 留言。
