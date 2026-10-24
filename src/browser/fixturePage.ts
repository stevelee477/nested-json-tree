/**
 * Serves the bundled Webview with a mock Host for real-browser tests and
 * README screenshots. Never shipped: everything here runs in development.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  buildJsonTreeContextIndex,
  createJsonTreeWebviewModel,
  looksLikeEmbeddedJson,
  walkJsonTree,
} from "../jsonTree";
import { parseJsonCandidates, parseNestedJsonCandidates } from "../parser";
import type { RenderMessage } from "../protocol";
import { renderWebviewHtml } from "../webviewHtml";

const root = path.resolve(__dirname, "../..");
const NONCE = "fixtureNonce";

/** VS Code's Dark Modern theme, plus the color registry defaults it leaves unset. */
export const DARK_MODERN = {
  "--vscode-font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
  "--vscode-font-size": "13px",
  "--vscode-editor-font-family": "Menlo, Monaco, 'Courier New', monospace",
  "--vscode-editor-font-size": "12px",
  "--vscode-foreground": "#cccccc",
  "--vscode-descriptionForeground": "#9d9d9d",
  "--vscode-editor-background": "#1f1f1f",
  "--vscode-focusBorder": "#0078d4",
  "--vscode-list-hoverBackground": "#2a2d2e",
  "--vscode-panel-border": "#2b2b2b",
  "--vscode-input-background": "#313131",
  "--vscode-input-foreground": "#cccccc",
  "--vscode-input-border": "#3c3c3c",
  "--vscode-button-secondaryBackground": "#313131",
  "--vscode-button-secondaryForeground": "#cccccc",
  "--vscode-button-secondaryHoverBackground": "#3c3c3c",
  "--vscode-menu-background": "#1f1f1f",
  "--vscode-menu-foreground": "#cccccc",
  "--vscode-menu-selectionBackground": "#0078d4",
  "--vscode-menu-selectionForeground": "#ffffff",
  "--vscode-menu-border": "#454545",
  "--vscode-menu-separatorBackground": "#454545",
  "--vscode-editor-findMatchHighlightBackground": "#ea5c0055",
  "--vscode-editor-findMatchBackground": "#9e6a03",
  "--vscode-editorWarning-foreground": "#cca700",
  "--vscode-textLink-foreground": "#4daafc",
  "--vscode-tree-indentGuidesStroke": "#585858",
  "--vscode-inputOption-activeBackground": "#2489db82",
  "--vscode-inputOption-activeBorder": "#2488db",
  "--vscode-editor-selectionHighlightBackground": "#add6ff26",
  "--vscode-widget-shadow": "#0000005c",
};

export interface FixtureOptions {
  /** Text parsed into the tree, like a document or log line. */
  sample: string;
  title?: string;
  language?: "en" | "zh";
  /** Inline CSS variables, as VS Code injects for the active theme. */
  theme?: Record<string, string>;
}

/** A render message plus what the Host would answer for every decodable string. */
export function buildFixture(sample: string, title = "JSON Tree · demo"): { render: RenderMessage; decoded: Record<number, unknown> } {
  const [candidate] = parseJsonCandidates(sample);
  const index = buildJsonTreeContextIndex(candidate.tree);
  const decoded: Record<number, unknown> = {};
  // The model is built first so the Webview starts with decodable strings.
  const model = createJsonTreeWebviewModel(candidate.tree);
  const decodeAll = (tree: typeof candidate.tree): void => walkJsonTree(tree, (node) => {
    if (node.type !== "string" || node.decoded || !looksLikeEmbeddedJson(node.value as string)) return;
    const [nested] = parseNestedJsonCandidates(node.value as string);
    if (!nested || (nested.tree.type !== "object" && nested.tree.type !== "array")) return;
    const attached = { root: nested.tree, unwrapDepth: nested.unwrapDepth };
    index.attachDecoded(node.id, attached);
    decoded[node.id] = { root: createJsonTreeWebviewModel(attached.root).root, unwrapDepth: attached.unwrapDepth };
    decodeAll(attached.root);
  });
  decodeAll(candidate.tree);
  return {
    render: {
      type: "render", renderKey: 1, root: model.root, title, pathLabel: "$",
      truncatedFieldCount: 0, autoExpand: true, canExpandAll: true, expandAllLimit: 10_000,
      source: { linked: true, syncCursor: true, status: "", canRefresh: false },
    },
    decoded,
  };
}

export function renderFixturePage(origin: string, options: FixtureOptions): string {
  const bundle = options.language === "zh"
    ? JSON.parse(readFileSync(path.join(root, "l10n/bundle.l10n.zh-cn.json"), "utf8")) as Record<string, string>
    : undefined;
  const html = renderWebviewHtml({
    nonce: NONCE,
    cspSource: origin,
    scriptUri: `${origin}/main.js`,
    styleUri: `${origin}/tree.css`,
    l10nBundle: bundle,
    t: (message) => bundle?.[message] ?? message,
  });
  const fixture = buildFixture(options.sample, options.title);
  // CSSOM writes are allowed under the CSP; a style attribute would not be.
  const mockHost = `<script nonce="${NONCE}">
    for (const [name, value] of Object.entries(${JSON.stringify(options.theme ?? {})})) {
      document.documentElement.style.setProperty(name, value);
    }
    window.posted = [];
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        window.posted.push(message);
        const reply = (data) => setTimeout(() => window.postMessage(data, "*"), 10);
        if (message.type === "ready") reply(${JSON.stringify(fixture.render)});
        if (message.type === "expandDecoded") {
          const decoded = ${JSON.stringify(fixture.decoded)}[message.nodeId];
          reply(decoded ? { type: "decoded", nodeId: message.nodeId, decoded } : { type: "decodeFailed", nodeId: message.nodeId });
        }
      },
      getState() {},
      setState() {},
    });
  </script>`;
  const scriptTag = `<script nonce="${NONCE}" src=`;
  if (!html.includes(scriptTag)) throw new Error("Webview script tag not found.");
  return html.replace(scriptTag, `${mockHost}\n  ${scriptTag}`);
}

/** Serves fixture pages at `/?scene=<name>` plus the bundled assets. */
export async function startFixtureServer(scenes: Record<string, FixtureOptions>): Promise<{ origin: string; server: Server }> {
  let origin = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const assets: Record<string, [string, string]> = {
      "/main.js": ["out/webview/main.js", "text/javascript"],
      "/tree.css": ["out/webview/tree.css", "text/css"],
    };
    const asset = assets[url.pathname];
    const scene = scenes[url.searchParams.get("scene") ?? ""];
    if (asset) {
      response.writeHead(200, { "content-type": asset[1] }).end(readFileSync(path.join(root, asset[0])));
    } else if (url.pathname === "/" && scene) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(renderFixturePage(origin, scene));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, server };
}
