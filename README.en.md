<p align="center">
  <img src="assets/logo-128.png" width="80" alt="Antigravity++">
</p>

# Antigravity++

<p align="center">Multi-account management · Quota rings · Local proxy · Reversible localization</p>

<p align="center">
  <a href="https://github.com/shallFun4Learning/AntigravityPlusPlus/actions/workflows/tauri-ci.yml"><img src="https://github.com/shallFun4Learning/AntigravityPlusPlus/actions/workflows/tauri-ci.yml/badge.svg" alt="Tauri Build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

[English](README.en.md) · [中文](README.md)

Antigravity++ is an independent launcher for Antigravity desktop and IDE clients. Manage multiple accounts, import an existing local login, and switch accounts from one panel. Quota rings inside the Antigravity composer show the active model's remaining quota and reset times.

It also provides local proxy configuration, reversible interface localization, and context monitoring. The current version is **0.1.4**.

## Features

### Multi-account management

- **Import the current login**: read existing local Antigravity credentials into the account store without exiting the running client.
- **Add through browser login**: generate a Google authorization link with open and copy actions. A local callback identifies the email and saves the account automatically.
- **Complete login manually**: paste the full callback URL when automatic completion does not work. An advanced credential entry form is also available.
- **Restart after switching**: after confirmation, stop the selected client, update its credentials, and restart it with the selected account.
- **Separate current-account selections**: track the desktop client and IDE independently, refresh access credentials, and remove local account records.
- **Encrypted local storage**: keep the account index locally and encrypt credentials with AES-256-GCM using a separate local key.

The first use of account management displays a risk notice that requires an explicit checkbox confirmation. Acceptance is saved locally, so later launches do not repeat the notice.

> Account management may trigger Google's risk controls and result in account restrictions, suspension, or bans. Follow applicable local laws, Google's terms, and Antigravity's usage policies. Switching accounts exits and restarts the client; save unfinished work first.

### Quota rings and context monitoring

- The **quota ring** appears inside the Antigravity composer. It prefers the active model's quota and falls back to a shared model-family quota when an exact model window is unavailable.
- Click the ring to view the weekly and five-hour windows, remaining percentages, and reset times supplied by the local service.
- Distinguishes exhausted, unknown, disabled, and unavailable states. An effective remaining quota below 1% displays as **0%**, preventing an exhausted quota from appearing as 1%.
- The **context ring** shows the latest request's estimated context usage, with model and generation-speed details.
- Monitoring reads the local language service without uploading conversations, account information, or access credentials to third parties.

Use “AG 内上下文” (context) and “AG 内模型用量” (model quota) on the dashboard or the enhancements page to control each ring independently. Turning one off removes its ring and stops its data collection. The quota ring also works in a new conversation before the first message. On upgrade, both switches inherit your previous monitoring preference.

### Launching and local proxy

- Supports Antigravity desktop and IDE clients, with automatic installation discovery and custom paths.
- The checkmark in the client selector shows which version you are viewing. You can browse IDE settings even if the IDE is missing. A notice explains its status, and viewing its settings leaves a running desktop session alone.
- Connects to your own local proxy on a per-process basis without TUN, with common port presets and custom port input.
- Clearly displays the selected port and validates the 1–65535 range. Direct connections are also supported.
- Offers a cleanup and restart action for process conflicts or leftover background processes.
- Supports Windows and macOS; macOS packages are currently validated through a beta workflow.

### Reversible interface enhancements

- Provides dynamic localization for the desktop client.
- Restores the original page text when localization is disabled.
- Keeps context and quota monitoring available for the IDE without injecting the desktop localization dictionary.
- Supports dictionary and backend/UI hot updates, with SHA-256 verification of downloaded files.

## Account management quick start

1. Select the desktop or IDE client in the workspace header, then open “账号管理” in the sidebar. Use “导入当前登录” to import an existing local login.
2. To add another account, select “添加账号”, then open or copy the generated link and complete Google authorization. The account is saved automatically after login.
3. If it is not saved automatically, paste the full callback URL from the browser's address bar into the manual completion field and select “回填登录结果”. **Copy the URL shown after a successful login.**
4. Select or search for an account on the left and check its email and target client on the right. Save your work, choose “切换并重启”, and confirm. The details pane shows progress or the reason for failure. The current account badge moves when the switch succeeds.

Browser login and token refresh use the launcher's current proxy settings. By default, OAuth client configuration is read from the local Antigravity installation without writing its values to this repository; install the client and verify its path first. Advanced deployments can supply their own OAuth client through `ANTIGRAVITY_OAUTH_CLIENT_ID` and `ANTIGRAVITY_OAUTH_CLIENT_SECRET`.

## Troubleshooting

- **Login reports `fetch failed`**: check that the selected local proxy port and proxy process are available. Direct mode requires access to Google's login and token endpoints. Manual completion supplies the callback result; saving the account still requires network access for the token exchange.
- **The current login cannot be imported**: check the selected client. If the email cannot be identified, launch that client, sign in, and retry. If `sqlite3` is missing, database-based import needs that command; browser login is an alternative.
- **Switching does not take effect**: continue through the in-app confirmation dialog. Failures while stopping the client, updating credentials, or relaunching are displayed in the interface and can be investigated through the runtime log.
- **A ring has no numeric value**: check the monitoring switches and local statistics service. Unknown and disconnected states are displayed separately and are not treated as 0%.

## Getting started

### Download the compiled application

Open [GitHub Releases](https://github.com/shallFun4Learning/AntigravityPlusPlus/releases) and choose the ZIP for Windows x64, macOS Apple Silicon, or macOS Intel. On Windows, extract the entire archive and run `AntigravityPlusPlus.exe`. On macOS, extract and open `Antigravity++.app`. macOS packages are currently beta builds and have not been notarized by Apple.

Each release includes `SHA256SUMS.txt` for download verification. Releases marked **Pre-release** are built automatically from the main branch for testing and feedback.

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
Database integration tests require the `sqlite3` command. macOS normally includes it; Windows developers can install it with `choco install sqlite`. GitHub Actions prepares this dependency automatically.

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
| `core/` | Sessions, settings, encrypted account storage, OAuth, and events |
| `features/` | Login callbacks, client credentials, proxy, localization, context, and quota monitoring |
| `adapters/desktop/` | Desktop and IDE discovery, CDP, and language-service adapters |
| `desktop/` | Application assembly, local API, and host communication |
| `ui/` | Launcher interface and interaction logic |
| `src-tauri/` | Tauri shell, tray integration, and packaging configuration |
| `test/` | Unit, integration, and browser regression tests |

## Updates and releases

The update manifest is stored in `update-manifest.json`. By default, it reads verified dictionaries and runtime resources from the `main` branch of Antigravity++. Native shell changes require a new full application package; backend and interface resources can be delivered through hot updates.

GitHub Actions verifies JavaScript modules, runs the full test suite, executes browser regression tests, and builds the Tauri application. A Release with complete application packages and SHA-256 checksums is published only after Windows x64, macOS Apple Silicon, and macOS Intel all succeed. A failure on any platform stops publication.

- A push to `main` publishes a preview such as `v0.1.4-preview.<run-number>`, using the version from `package.json`.
- A manual workflow run on `main` also builds and publishes a preview.
- A `v<version>` tag publishes the corresponding version. Versions with suffixes such as `beta` remain prereleases. The tag must match the versions in `package.json`, `package-lock.json`, the Tauri configuration, and Cargo.

Release notes come from the matching `CHANGELOG.md` section. All assets are uploaded to a draft before publication. Reruns can complete an unfinished draft while preserving assets in an already published release.

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
- The multi-account design and client-credential compatibility research reference [Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager). Thanks to lbjlaq and its contributors; AntigravityPlusPlus independently adapts the behavior to its own architecture. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the upstream license note.

## License

Antigravity++ is released under the [MIT License](LICENSE).

This project is not affiliated with Google and does not provide proxy nodes. Use it in accordance with the applicable local laws and the terms of the related software and services.
