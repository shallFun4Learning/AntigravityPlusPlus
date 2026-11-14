<p align="center">
  <img src="assets/logo-128.png" width="80" alt="AntigravityPlusPlus">
</p>

<h1 align="center">AntigravityPlusPlus</h1>

<p align="center">面向 Antigravity 桌面端与 IDE 的独立 Lite 启动器</p>

<p align="center">
  <a href="https://github.com/shallFun4Learning/AntigravityPlusPlus/actions/workflows/tauri-ci.yml"><img src="https://github.com/shallFun4Learning/AntigravityPlusPlus/actions/workflows/tauri-ci.yml/badge.svg" alt="Tauri Build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

[中文](README.md) · [English](README.en.md)

AntigravityPlusPlus 是一个独立维护的 Lite 启动器，为 Antigravity 桌面端和 IDE 提供本地代理配置、可逆界面汉化、上下文监控和模型额度监控。项目不提供代理节点，也不会修改 Antigravity 的安装包。

## 项目定位

AntigravityPlusPlus 将启动、进程管理和界面增强集中在一个轻量应用中：

- 通过免 TUN 进程代理连接用户自己的本地代理。
- 在桌面端和 IDE 之间选择启动目标，并自动检测安装路径。
- 通过 CDP 动态注入界面增强，关闭功能后恢复原文。
- 在 Antigravity 输入区显示上下文使用量和模型剩余额度。
- 使用本地只读接口读取额度窗口、剩余比例和重置时间。
- 在进程冲突或后台残留时提供清理后重新启动的处理流程。

## 主要功能

### Lite 启动器

- 支持 Antigravity 桌面端和 IDE。
- 支持常见本地代理端口和自定义端口。
- 支持直连模式，不强制启用代理。
- 支持 Windows 和 macOS；macOS 发布包当前按 Beta 流程验证。

### 上下文与额度监控

- 上下文圆环显示最近请求的上下文估算。
- 额度圆环优先显示当前具体模型的剩余用量。
- 没有具体模型额度时，回退到对应共享模型族额度。
- 详情面板显示每周窗口、5 小时窗口、剩余比例和重置时间。
- 真实耗尽、未知、禁用和接口不可用分别显示。
- 小于 1% 的有效剩余额度按 0% 显示，避免将已耗尽额度误显示为 1%。
- 监控功能只读取本地语言服务数据，不上传账号信息或访问凭据。

### 可逆界面增强

- 桌面端支持动态界面汉化。
- 关闭汉化后恢复页面原文。
- IDE 继续提供上下文和额度监控，但不注入桌面端汉化字典。
- 热更新支持词典和后台/UI 资源，并通过 SHA-256 校验下载内容。

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
| `core/` | 会话、设置、存储和事件基础设施 |
| `features/` | 代理、汉化、上下文和额度监控 |
| `adapters/desktop/` | 桌面端与 IDE 的发现、CDP 和语言服务适配 |
| `desktop/` | 应用组装、本地 API 和宿主通信 |
| `ui/` | 启动器界面和交互逻辑 |
| `src-tauri/` | Tauri 原生外壳、托盘和应用打包配置 |
| `test/` | 单元测试、集成测试和浏览器回归测试 |

## 更新与发布

项目的更新清单位于 `update-manifest.json`，默认从 AntigravityPlusPlus 自己的 `main` 分支读取经过校验的字典和运行时资源。原生外壳更新需要下载新的完整应用包；后台和界面资源可以通过热更新获取。

正式构建由 GitHub Actions 完成，流程会执行 JavaScript 检查、完整测试、浏览器回归测试和 Tauri 多平台构建。

## 贡献

欢迎提交 Issue、改进建议和代码贡献。提交代码前请运行：

```bash
npm run check
npm test
```

涉及界面、启动流程或额度显示的改动，请同时说明测试平台、Antigravity 目标类型和复现步骤。

## 致谢

本项目在 EasyAntigravity Lite 的基础上继续开发；相关第三方代码与许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 许可证

AntigravityPlusPlus 使用 [MIT License](LICENSE) 发布。

本项目与 Google 官方无关。使用前请遵守相关软件、服务和所在地区的适用条款。
