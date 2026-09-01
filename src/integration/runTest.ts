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
    launchArgs: ["--disable-extensions"],
  });

  if (exitCode !== 0) {
    throw new Error(`VS Code extension tests exited with code ${exitCode}.`);
  }
}

void main().catch((error: unknown) => {
  console.error("Failed to run VS Code extension tests.", error);
  process.exitCode = 1;
});
