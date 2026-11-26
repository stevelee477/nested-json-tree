import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

interface MenuItem {
  command: string;
  when?: string;
  group?: string;
}

interface KeybindingItem {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

interface ExtensionManifest {
  icon: string;
  author: { name: string; email: string };
  repository: { type: string; url: string };
  homepage: string;
  bugs: { url: string };
  activationEvents: string[];
  contributes: {
    menus: Record<string, MenuItem[]>;
    keybindings?: KeybindingItem[];
  };
}

const rootDir = path.resolve(__dirname, "../..");
const manifestPath = path.join(rootDir, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;

test("manifest icon is a square 256 px PNG", () => {
  assert.equal(manifest.icon, "assets/icon.png");
  const iconPath = path.resolve(__dirname, "../../", manifest.icon);
  assert.equal(existsSync(iconPath), true);
  const png = readFileSync(iconPath);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
});

test("GitHub publication metadata is complete and uses the public author identity", () => {
  assert.deepEqual(manifest.author, {
    name: "stevelee477",
    email: "hi.whoareyou12@gmail.com",
  });
  assert.equal(manifest.repository.type, "git");
  assert.equal(manifest.repository.url, "https://github.com/stevelee477/nested-json-tree.git");
  assert.equal(manifest.homepage, "https://github.com/stevelee477/nested-json-tree#readme");
  assert.equal(manifest.bugs.url, "https://github.com/stevelee477/nested-json-tree/issues");
});

test("Open Selection appears in the editor context menu whenever text is selected", () => {
  const item = manifest.contributes.menus["editor/context"].find(
    (candidate) => candidate.command === "nestedJsonTree.openSelection",
  );
  assert.equal(item?.when, "editorHasSelection");
});

test("editor context commands are limited to JSON and JSONL family files", () => {
  const contextItems = manifest.contributes.menus["editor/context"];
  const commands = ["nestedJsonTree.openDocument", "nestedJsonTree.openCurrentLine"];

  for (const command of commands) {
    const item = contextItems.find((candidate) => candidate.command === command);
    assert.ok(item, `${command} must be present in the editor context menu`);
    assert.match(item.when ?? "", /editorTextFocus/);
    assert.match(item.when ?? "", /editorLangId == json\b/);
    assert.match(item.when ?? "", /editorLangId == jsonl\b/);
    assert.match(item.when ?? "", /resourceExtname == \.jsonl/);
    assert.match(item.when ?? "", /resourceExtname == \.ndjson/);
  }
});

test("editor title buttons handle jsonl language mode alongside file extensions", () => {
  const titleItems = manifest.contributes.menus["editor/title"];
  const openDoc = titleItems.find((candidate) => candidate.command === "nestedJsonTree.openDocument");
  const openLine = titleItems.find((candidate) => candidate.command === "nestedJsonTree.openCurrentLine");
  assert.ok(openDoc);
  assert.ok(openLine);
  assert.match(openDoc.when ?? "", /editorLangId != jsonl/);
  assert.match(openLine.when ?? "", /editorLangId == jsonl/);
  assert.match(openLine.when ?? "", /resourceExtname == \.jsonl/);
  assert.match(openLine.when ?? "", /resourceExtname == \.ndjson/);
});

test("explorer context menu exposes Open Document as Tree for JSON, JSONL, and log files", () => {
  const explorerItems = manifest.contributes.menus["explorer/context"];
  assert.ok(Array.isArray(explorerItems) && explorerItems.length > 0);
  const openDoc = explorerItems.find((candidate) => candidate.command === "nestedJsonTree.openDocument");
  assert.ok(openDoc, "nestedJsonTree.openDocument must be present in explorer/context");
  assert.equal(openDoc.group, "navigation@20");
  for (const ext of [".json", ".jsonc", ".jsonl", ".ndjson", ".log"]) {
    const escaped = ext.replace(".", "\\.");
    assert.match(openDoc.when ?? "", new RegExp(`resourceExtname == ${escaped}\\b`));
  }
});

test("activationEvents include WebviewPanelSerializer restoration for nestedJsonTree.viewer", () => {
  assert.ok(manifest.activationEvents.includes("onWebviewPanel:nestedJsonTree.viewer"));
  assert.ok(manifest.activationEvents.includes("onCommand:nestedJsonTree.openDocument"));
  assert.ok(manifest.activationEvents.includes("onCommand:nestedJsonTree.openCurrentLine"));
  assert.ok(manifest.activationEvents.includes("onCommand:nestedJsonTree.openSelection"));
  assert.ok(manifest.activationEvents.includes("onCommand:nestedJsonTree.openClipboard"));
});

test("keybindings bind Alt+Cmd+J / Alt+Ctrl+J to document vs current line without overlap", () => {
  const bindings = manifest.contributes.keybindings ?? [];
  const docBinding = bindings.find((b) => b.command === "nestedJsonTree.openDocument");
  const lineBinding = bindings.find((b) => b.command === "nestedJsonTree.openCurrentLine");
  assert.ok(docBinding, "keybinding for nestedJsonTree.openDocument must exist");
  assert.ok(lineBinding, "keybinding for nestedJsonTree.openCurrentLine must exist");
  assert.equal(docBinding.key, "alt+ctrl+j");
  assert.equal(docBinding.mac, "alt+cmd+j");
  assert.equal(lineBinding.key, "alt+ctrl+j");
  assert.equal(lineBinding.mac, "alt+cmd+j");
  assert.match(docBinding.when ?? "", /editorTextFocus/);
  assert.match(docBinding.when ?? "", /resourceExtname != \.jsonl/);
  assert.match(docBinding.when ?? "", /resourceExtname != \.ndjson/);
  assert.match(docBinding.when ?? "", /editorLangId != jsonl/);
  assert.match(lineBinding.when ?? "", /editorTextFocus/);
  assert.match(lineBinding.when ?? "", /resourceExtname == \.jsonl/);
  assert.match(lineBinding.when ?? "", /resourceExtname == \.ndjson/);
  assert.match(lineBinding.when ?? "", /editorLangId == jsonl/);
});

test("NLS config.autoExpandMaxNodes documents the 100,000-node bulk-expansion limit", () => {
  const enNls = JSON.parse(readFileSync(path.join(rootDir, "package.nls.json"), "utf8")) as Record<string, string>;
  const zhNls = JSON.parse(readFileSync(path.join(rootDir, "package.nls.zh-cn.json"), "utf8")) as Record<string, string>;
  assert.match(enNls["config.autoExpandMaxNodes"] ?? "", /100,000-node bulk-expansion limit/);
  assert.doesNotMatch(enNls["config.autoExpandMaxNodes"] ?? "", /\b10,000\b/);
  assert.match(zhNls["config.autoExpandMaxNodes"] ?? "", /100,000/);
  assert.doesNotMatch(zhNls["config.autoExpandMaxNodes"] ?? "", /\b10,000\b/);
});

test("every command remains available from the Command Palette", () => {
  const paletteItems = manifest.contributes.menus.commandPalette;
  assert.deepEqual(
    paletteItems.map((item) => item.command).sort(),
    [
      "nestedJsonTree.openClipboard",
      "nestedJsonTree.openCurrentLine",
      "nestedJsonTree.openDocument",
      "nestedJsonTree.openSelection",
    ],
  );
  assert.ok(paletteItems.every((item) => item.when === undefined));
});

test("release workflow conditionally publishes to VS Code Marketplace and Open VSX when secrets are set", () => {
  const releaseYml = readFileSync(path.join(rootDir, ".github/workflows/release.yml"), "utf8");
  assert.match(releaseYml, /VSCE_PAT:\s*\$\{\{\s*secrets\.VSCE_PAT\s*\}\}/);
  assert.match(releaseYml, /if \[\[ -n "\$\{VSCE_PAT:-\}" \]\]; then/);
  assert.match(releaseYml, /npx @vscode\/vsce publish --packagePath dist\/\*\.vsix/);
  assert.match(releaseYml, /OVSX_PAT:\s*\$\{\{\s*secrets\.OVSX_PAT\s*\}\}/);
  assert.match(releaseYml, /if \[\[ -n "\$\{OVSX_PAT:-\}" \]\]; then/);
  assert.match(releaseYml, /npx ovsx publish dist\/\*\.vsix/);
});
