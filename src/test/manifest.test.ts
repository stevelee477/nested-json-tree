import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

interface MenuItem {
  command: string;
  when?: string;
}

interface ExtensionManifest {
  icon: string;
  author: { name: string; email: string };
  repository: { type: string; url: string };
  homepage: string;
  bugs: { url: string };
  contributes: {
    menus: Record<string, MenuItem[]>;
  };
}

const manifestPath = path.resolve(__dirname, "../../package.json");
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
    assert.match(item.when ?? "", /editorLangId == json/);
    assert.match(item.when ?? "", /resourceExtname == \.jsonl/);
    assert.match(item.when ?? "", /resourceExtname == \.ndjson/);
  }
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
