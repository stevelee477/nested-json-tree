import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "../..");

for (const readme of ["README.md", "README.zh-CN.md"]) {
  test(`${readme} has no broken local links or images`, () => {
    const markdown = readFileSync(path.join(root, readme), "utf8");
    const destinations = [...markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map(
      (match) => match[1].split("#", 1)[0],
    );
    const htmlImages = [...markdown.matchAll(/<img\s+[^>]*src="([^"]+)"/g)].map(
      (match) => match[1],
    );

    for (const destination of [...destinations, ...htmlImages]) {
      if (
        destination.length === 0 ||
        destination.startsWith("http://") ||
        destination.startsWith("https://") ||
        destination.startsWith("mailto:")
      ) {
        continue;
      }
      assert.equal(
        existsSync(path.resolve(root, destination)),
        true,
        `${readme} points to missing local path: ${destination}`,
      );
    }
  });
}
