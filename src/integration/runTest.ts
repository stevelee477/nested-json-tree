import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "suite");
  const version = process.env.VSCODE_TEST_VERSION ?? "stable";
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;

  const exitCode = await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    ...(vscodeExecutablePath === undefined ? { version } : { vscodeExecutablePath }),
    launchArgs: [
      // A locale needs its language pack, so a locale run uses a dedicated
      // extensions folder that contains only that pack, plus its own user
      // data folder where VS Code records installed language packs.
      ...(process.env.VSCODE_TEST_EXTENSIONS_DIR === undefined
        ? ["--disable-extensions"]
        : [
            `--extensions-dir=${process.env.VSCODE_TEST_EXTENSIONS_DIR}`,
            `--user-data-dir=${process.env.VSCODE_TEST_EXTENSIONS_DIR}-user-data`,
          ]),
      ...(process.env.VSCODE_TEST_LOCALE === undefined ? [] : [`--locale=${process.env.VSCODE_TEST_LOCALE}`]),
    ],
  });

  if (exitCode !== 0) {
    throw new Error(`VS Code extension tests exited with code ${exitCode}.`);
  }
}

void main().catch((error: unknown) => {
  console.error("Failed to run VS Code extension tests.", error);
  process.exitCode = 1;
});
