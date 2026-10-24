# Contributing

Thanks for helping improve Nested JSON Tree.

## Development setup

```sh
npm install
npm test
npm run test:integration
```

Run `npm run watch` to rebuild the extension and Webview bundles on change, then press `F5` in VS Code to launch an Extension Development Host.

`npm run test:browser` runs the bundled Webview in the installed Chrome under the production CSP (set `PLAYWRIGHT_CHANNEL=chromium` to use Playwright's own Chromium). `npm run screenshots` regenerates `assets/screenshots/inline-decoding.png` and `zh-cn.png` the same way. `npm run demo` opens VS Code with a scripted scene from `examples/demo.log` for screenshots of the full editor. Use the synthetic files in `examples/` for manual testing.

### Localization

User-visible strings go through `vscode.l10n.t(...)` on the Extension Host and `t(...)` in the Webview; manifest strings live in `package.nls*.json`. Add every new string to `l10n/bundle.l10n.zh-cn.json` — `npm test` fails on missing, stale, or placeholder-mismatched translations, and `node scripts/l10n-keys.cjs` lists every key.

To run the integration tests in Chinese, install the language pack into a dedicated extensions folder once (the path below is for macOS on Apple silicon; use the downloaded VS Code under `.vscode-test/` on other platforms), then pass the locale:

```sh
".vscode-test/vscode-darwin-arm64-1.90.0/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --user-data-dir /tmp/zh-ext-user-data --extensions-dir /tmp/zh-ext \
  --install-extension MS-CEINTL.vscode-language-pack-zh-hans
VSCODE_TEST_LOCALE=zh-cn VSCODE_TEST_EXTENSIONS_DIR=/tmp/zh-ext npm run test:integration
```

VS Code applies a newly installed language pack from its second launch, so the first locale run after installing can still report `en`; run it again.

## Pull requests

- Keep each change focused.
- Add or update tests for behavior changes.
- Run `npm test` before opening a pull request.
- Do not include real logs, credentials, internal hostnames, or personal data in fixtures or screenshots.
- Update `CHANGELOG.md` for user-visible changes.

## Bug reports

Include the VS Code version, extension version, file type, a minimal sanitized sample, and the expected versus actual behavior.
