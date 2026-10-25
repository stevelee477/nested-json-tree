import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

/** Opens VS Code with the extension and a scripted demo scene for screenshots. */
async function main(): Promise<void> {
  await runTests({
    extensionDevelopmentPath: path.resolve(__dirname, "../.."),
    extensionTestsPath: path.resolve(__dirname, "demoScene"),
    version: process.env.VSCODE_TEST_VERSION ?? "1.90.0",
    launchArgs: [
      "--disable-extensions",
      // Keep painting while other windows cover it, so window captures are current.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      path.resolve(__dirname, "../../examples"),
    ],
    extensionTestsEnv: { DEMO_SCENE: process.env.DEMO_SCENE ?? "jsonl" },
  });
}

void main().catch(() => {
  // Closing the demo window ends the run; that is the expected exit.
});
