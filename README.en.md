<p align="center">
  <img src="assets/logo-128.png" width="80" alt="AntigravityPlusPlus">
</p>

<h1 align="center">AntigravityPlusPlus</h1>

<p align="center">An independent Lite launcher for Antigravity desktop and IDE clients</p>

<p align="center">
  <a href="https://github.com/shallFun4Learning/AntigravityPlusPlus/actions/workflows/tauri-ci.yml"><img src="https://github.com/shallFun4Learning/AntigravityPlusPlus/actions/workflows/tauri-ci.yml/badge.svg" alt="Tauri Build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

[English](README.en.md) · [中文](README.md)

AntigravityPlusPlus is an independently maintained Lite launcher for Antigravity desktop and IDE clients. It provides local proxy configuration, reversible interface localization, context monitoring, and model quota monitoring without modifying the Antigravity installation or providing proxy nodes.

## Project scope

AntigravityPlusPlus brings launching, process handling, and interface enhancements into one lightweight application:

- Configure a per-process proxy using the user's own local proxy.
- Select between the Antigravity desktop client and IDE, with automatic installation discovery.
- Inject reversible interface enhancements through CDP.
- Display context usage and remaining model quota beside the Antigravity composer.
- Read quota windows, remaining percentages, and reset times from the local read-only service.
- Handle process conflicts and leftover background processes with a guided cleanup and restart flow.

## Features

### Lite launcher

- Supports the Antigravity desktop client and IDE.
- Supports common local proxy ports and custom ports.
- Supports direct connections without forcing a proxy.
- Supports Windows and macOS; macOS packages are currently validated through a beta workflow.

### Context and quota monitoring

- Shows the estimated context usage of the most recent request.
- Prefers the quota for the exact active model.
- Falls back to a shared model-family quota when an exact model window is unavailable.
- Shows weekly and five-hour windows, remaining percentages, and reset times.
- Distinguishes exhausted, unknown, disabled, and unavailable states.
- Displays an effective remaining quota below 1% as 0% so an exhausted quota is not shown as 1%.
- Reads local language-service data without uploading account information or access credentials.

### Reversible interface enhancements

- Provides dynamic localization for the desktop client.
- Restores the original page text when localization is disabled.
- Keeps context and quota monitoring available for the IDE without injecting the desktop localization dictionary.
- Supports signed hot updates for dictionaries and backend/UI resources.

## Getting started

### Run from source

Node.js 22 or newer is required:

```bash
npm ci
npm start
```

The launcher starts a local service and prints its address. Open that address in a browser during development.

### Run checks

```bash
npm run check
npm test
```

The test suite uses mock interfaces and isolated data directories. It does not launch a real Antigravity process.

### Build the macOS app

For Apple Silicon:

```bash
npm ci
npm run check
npm test
node scripts/prepare-tauri.cjs aarch64-apple-darwin
npx --yes @tauri-apps/cli@2 build --target aarch64-apple-darwin --bundles app
```

Use `x86_64-apple-darwin` for Intel macOS and `x86_64-pc-windows-msvc` for Windows. Native builds also require the Rust toolchain and platform build dependencies for the target system.

## Project structure

| Directory | Purpose |
| --- | --- |
| `core/` | Session, settings, storage, and event infrastructure |
| `features/` | Proxy, localization, context, and quota monitoring |
| `adapters/desktop/` | Desktop and IDE discovery, CDP, and language-service adapters |
| `desktop/` | Application assembly, local API, and host communication |
| `ui/` | Launcher interface and interaction logic |
| `src-tauri/` | Tauri shell, tray integration, and packaging configuration |
| `test/` | Unit, integration, and browser regression tests |

## Updates and releases

The update manifest is stored in `update-manifest.json`. By default, it reads verified dictionaries and runtime resources from the `main` branch of AntigravityPlusPlus. Native shell changes require a new full application package; backend and interface resources can be delivered through hot updates.

The GitHub Actions build verifies JavaScript modules, runs the full test suite, executes browser regression tests, and builds the Tauri application for supported platforms.

## Contributing

Issues, suggestions, and code contributions are welcome. Run these checks before submitting changes:

```bash
npm run check
npm test
```

For changes involving the interface, launch flow, or quota display, include the test platform, target client type, and reproduction steps.

## Acknowledgements

- This project continues development on the Lite foundation of [EasyAntigravity Lite](https://github.com/DSDS-CMHL/EasyAntigravity); see [THIRD-PARTY-NOTICES.md](https://github.com/shallFun4Learning/AntigravityPlusPlus/blob/main/THIRD-PARTY-NOTICES.md) for third-party code and license information.
- The localization dictionary builds on community-maintained work, including [nicktan @ linux.do](https://linux.do/t/topic/2896116).
- The context-monitoring implementation references [Antigrative Dashboard / AG Pulse](https://github.com/YOU-SHOULD-KNOW-ME/antigrative-dashboard), with the relevant material under the MIT License.

## License

AntigravityPlusPlus is released under the [MIT License](LICENSE).

This project is not affiliated with Google. Use it in accordance with the applicable terms of the related software and services.
