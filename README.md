<p align="center">
  <img src="assets/logo-128.png" width="80" alt="Antigravity++">
</p>

# Antigravity++

<p align="center">多账号管理 · 额度圆环 · 本地代理 · 可逆汉化</p>

<p align="center">
  <a href="https://github.com/shallFun4Learning/AntigravityPlusPlus/actions/workflows/tauri-ci.yml"><img src="https://github.com/shallFun4Learning/AntigravityPlusPlus/actions/workflows/tauri-ci.yml/badge.svg" alt="Tauri Build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

[中文](README.md) · [English](README.en.md)

Antigravity++ 是面向 Antigravity 桌面端与 IDE 的独立启动器。通过一个面板管理多个账号、导入现有登录状态并切换账号；在 Antigravity 输入区通过额度圆环查看当前模型的剩余额度和重置时间。

同时提供本地代理配置、可逆界面汉化和上下文监控。当前版本为 **0.1.0**。

## 主要功能

### 多账号管理

- **导入当前登录**：读取本机 Antigravity 已有的登录凭据，保存到账号库；导入过程不会退出正在运行的客户端。
- **网页登录添加**：生成登录链接，提供“打开链接”和“复制链接”；完成 Google 授权后通过本地回调自动识别邮箱并保存账号。
- **手工回填**：回调未自动完成时，可以粘贴登录成功后的完整链接继续保存；另有高级手动填写凭据入口。
- **切换后自动重启**：确认切换后，自动退出对应客户端、更新登录凭据并重新启动，使新账号生效。
- **分别记录当前账号**：桌面版与 IDE 版各自保存当前账号选择；支持刷新访问凭据和删除本地账号记录。
- **本地加密保存**：账号索引保存在本机，访问凭据通过 AES-256-GCM 加密并使用独立本地密钥保存。

首次使用账号管理时，会显示风险提示。需要主动勾选确认后才能继续；确认状态保存在本机，后续启动不再重复提示。

> 账号管理可能触发 Google 风控，存在账号受限、停用或封禁风险。请遵守所在地法律法规、Google 服务条款及 Antigravity 相关使用政策。切换账号会退出并重新启动客户端，请先保存未完成的工作。

### 额度圆环与上下文监控

- **额度圆环**显示在 Antigravity 输入区，优先展示当前具体模型的剩余额度；无具体模型窗口时回退到对应共享模型族额度。
- 点击圆环查看接口提供的每周窗口、5 小时窗口、剩余比例和重置时间。
- 正确区分真实耗尽、未知、禁用和接口不可用；小于 1% 的有效剩余额度显示为 **0%**，避免出现“额度耗尽却显示 1%”。
- **上下文圆环**展示最近请求的上下文估算，详情提供模型、生成速度等信息。
- 监控只读取本机语言服务数据，不向第三方上传对话、账号信息或访问凭据。

在启动器中开启“界面深度汉化与监控”，并保持“AG 内上下文与模型用量”开启，再通过启动器运行对应客户端。圆环位于 Antigravity 内，不在账号列表中。

### 启动与本地代理

- 支持 Antigravity 桌面端和 IDE，自动检测安装路径，也可自定义路径。
- 通过免 TUN 进程代理连接用户自己的本地代理，提供常见端口快捷选择和自定义端口输入。
- 清晰展示当前选中的端口，校验 1–65535 范围；也可关闭代理使用直连模式。
- 进程冲突或后台残留时，提供“清理并重新启动”操作。
- 支持 Windows 和 macOS；macOS 发布包当前按 Beta 流程验证。

### 可逆界面增强

- 桌面端支持动态界面汉化。
- 关闭汉化后恢复页面原文。
- IDE 继续提供上下文和额度监控，但不注入桌面端汉化字典。
- 热更新支持词典和后台/UI 资源，并通过 SHA-256 校验下载内容。

## 账号管理快速上手

1. 选择要管理的桌面版或 IDE 版。已有登录状态时，点击“导入当前登录”。
2. 添加其他账号时，点击“手动添加”，再用“打开链接”或“复制链接”完成 Google 授权。登录后账号会自动保存到列表。
3. 没有自动保存时，在“手工回填”中粘贴浏览器地址栏里的完整回调链接，再点击“回填登录结果”。**提示：复制登录成功后的链接。**
4. 保存当前工作，点击目标账号的“切换”，在应用内确认后等待客户端自动重启。

网页登录与令牌刷新会使用启动器当前的代理设置。默认从本机 Antigravity 安装资源只读加载 OAuth 客户端配置，配置值不写入代码仓库；请先安装客户端并确认路径。高级部署可通过 `ANTIGRAVITY_OAUTH_CLIENT_ID` 和 `ANTIGRAVITY_OAUTH_CLIENT_SECRET` 指定自己的 OAuth 客户端。

## 常见问题

- **登录出现 `fetch failed`**：检查选中的本地代理端口和代理进程是否可用；直连模式需要能够直接访问 Google 登录及令牌接口。手工回填可以补交回调结果，后续保存仍需要网络完成授权交换。
- **无法导入当前登录**：确认选中了正确的客户端；若无法识别邮箱，先启动该客户端并登录后重试。若提示缺少 `sqlite3`，数据库读取方式需要该命令，也可改用网页登录添加。
- **点击切换没有生效**：切换需要在应用内确认弹窗中继续；如果退出、凭据更新或启动失败，界面会显示具体错误，可结合运行日志排查。
- **圆环没有显示数字**：先检查监控开关与本地统计接口是否可用。未知或接口失联会单独显示，不会作为 0% 处理。

## 使用方式

### 从源码运行

需要 Node.js 22 或更高版本：

```bash
npm ci
npm start
```

启动器会在本地启动服务并输出访问地址。开发调试时可以使用浏览器打开该地址。

### 运行检查

```bash
npm run check
npm test
```

测试使用模拟接口和隔离数据目录，不会启动真实的 Antigravity 进程。

### 构建 macOS App

以 Apple Silicon 为例：

```bash
npm ci
npm run check
npm test
node scripts/prepare-tauri.cjs aarch64-apple-darwin
npx --yes @tauri-apps/cli@2 build --target aarch64-apple-darwin --bundles app
```

Intel macOS 使用 `x86_64-apple-darwin`，Windows 使用 `x86_64-pc-windows-msvc`。构建原生应用还需要对应平台的 Rust 工具链和系统构建依赖。

## 项目结构

| 目录 | 作用 |
| --- | --- |
| `core/` | 会话、设置、加密账号库、OAuth 和事件基础设施 |
| `features/` | 登录回调、客户端凭据、代理、汉化、上下文和额度监控 |
| `adapters/desktop/` | 桌面端与 IDE 的发现、CDP 和语言服务适配 |
| `desktop/` | 应用组装、本地 API 和宿主通信 |
| `ui/` | 启动器界面和交互逻辑 |
| `src-tauri/` | Tauri 原生外壳、托盘和应用打包配置 |
| `test/` | 单元测试、集成测试和浏览器回归测试 |

## 更新与发布

项目的更新清单位于 `update-manifest.json`，默认从 Antigravity++ 自己的 `main` 分支读取经过校验的字典和运行时资源。原生外壳更新需要下载新的完整应用包；后台和界面资源可以通过热更新获取。

正式构建由 GitHub Actions 完成，流程会执行 JavaScript 检查、完整测试、浏览器回归测试和 Tauri 多平台构建。

## 贡献

欢迎提交 Issue、改进建议和代码贡献。提交代码前请运行：

```bash
npm run check
npm test
```

涉及界面、启动流程或额度显示的改动，请同时说明测试平台、Antigravity 目标类型和复现步骤。

## 致谢

- 本项目在 [EasyAntigravity Lite](https://github.com/DSDS-CMHL/EasyAntigravity) 的基础上继续开发；相关第三方代码与许可见 [THIRD-PARTY-NOTICES.md](https://github.com/shallFun4Learning/AntigravityPlusPlus/blob/main/THIRD-PARTY-NOTICES.md)。
- 汉化词典感谢社区整理与维护，其中包括 [nicktan @ linux.do](https://linux.do/t/topic/2896116)。
- 上下文监控相关实现参考 [Antigrative Dashboard / AG Pulse](https://github.com/YOU-SHOULD-KNOW-ME/antigrative-dashboard)，相关部分遵循 MIT 协议。
- 多账号管理的功能设计与客户端凭据兼容性研究参考 [Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager)，感谢 lbjlaq 及其贡献者；AntigravityPlusPlus 按自身架构独立适配，原项目许可证说明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 许可证

Antigravity++ 使用 [MIT License](LICENSE) 发布。

本项目与 Google 官方无关，不提供代理节点。使用前请遵守相关软件、服务和所在地区的适用条款。
