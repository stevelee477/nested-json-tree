/** Minimal DOM harness for executing the actual embedded Webview script. */
export function createWebviewHarness(
  script: string,
  api: { getState?: () => unknown; setState?: (state: unknown) => void; getSelectionText?: () => string } = {},
  l10nBundle?: Record<string, string>,
) {
  class FakeClassList {
    private readonly names = new Set<string>();

    add(...names: string[]): void {
      for (const name of names) this.names.add(name);
    }

    contains(name: string): boolean {
      return this.names.has(name);
    }

    remove(...names: string[]): void {
      for (const name of names) this.names.delete(name);
    }

    toggle(name: string, force?: boolean): boolean {
      const enabled = force ?? !this.names.has(name);
      if (enabled) this.names.add(name);
      else this.names.delete(name);
      return enabled;
    }
  }

  let activeElement: FakeElement | undefined;
  let selectionText = "";
  const setActiveElement = (element: FakeElement | undefined): void => {
    activeElement = element;
  };
  const dispatchFrom = (start: FakeElement, type: string, event: unknown): void => {
    const eventObj = event && typeof event === "object" ? event as Record<string, unknown> : {};
    if (!("target" in eventObj)) eventObj.target = start;
    let stopped = false;
    const origStop = typeof eventObj.stopPropagation === "function"
      ? eventObj.stopPropagation as () => void
      : undefined;
    eventObj.stopPropagation = () => {
      stopped = true;
      origStop?.();
    };
    let current: FakeElement | undefined = start;
    while (current && !stopped) {
      for (const listener of current.listeners.get(type) ?? []) listener(eventObj);
      current = current.parentElement;
    }
  };

  class FakeElement {
    readonly classList = new FakeClassList();
    readonly listeners = new Map<string, Array<(event: unknown) => void>>();
    readonly attributes = new Map<string, string>();
    readonly children: FakeElement[] = [];
    readonly tagName: string;
    parentElement: FakeElement | undefined;
    className = "";
    textContent = "";
    title = "";
    value = "";
    checked = false;
    disabled = false;
    tabIndex = 0;
    scrollTop = 0;
    clientHeight = 600;
    readonly style: Record<string, string> = {};

    constructor(readonly fragment = false, tagName = "DIV") {
      this.tagName = tagName.toUpperCase();
    }

    get firstChild(): FakeElement | null {
      return this.children[0] ?? null;
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    dispatch(type: string, event: unknown = {}): void {
      dispatchFrom(this, type, event);
    }

    appendChild(child: FakeElement): FakeElement {
      if (child.fragment) {
        const items = child.children.splice(0);
        for (const item of items) {
          if (item.parentElement) item.parentElement.removeChild(item);
          item.parentElement = this;
          this.children.push(item);
        }
      } else {
        if (child.parentElement) child.parentElement.removeChild(child);
        child.parentElement = this;
        this.children.push(child);
      }
      return child;
    }

    removeChild(child: FakeElement): FakeElement {
      const idx = this.children.indexOf(child);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        child.parentElement = undefined;
      }
      return child;
    }

    insertBefore(child: FakeElement, reference: FakeElement | null | undefined): FakeElement {
      if (!reference) return this.appendChild(child);
      const refIdx = this.children.indexOf(reference);
      if (refIdx < 0) return this.appendChild(child);
      if (child.fragment) {
        const items = child.children.splice(0);
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          if (item.parentElement) item.parentElement.removeChild(item);
          item.parentElement = this;
        }
        const currentRefIdx = this.children.indexOf(reference);
        this.children.splice(currentRefIdx >= 0 ? currentRefIdx : this.children.length, 0, ...items);
      } else {
        if (child.parentElement) child.parentElement.removeChild(child);
        child.parentElement = this;
        const currentRefIdx = this.children.indexOf(reference);
        this.children.splice(currentRefIdx >= 0 ? currentRefIdx : this.children.length, 0, child);
      }
      return child;
    }

    replaceChildren(...children: FakeElement[]): void {
      for (const existing of this.children) existing.parentElement = undefined;
      this.children.length = 0;
      for (const child of children) {
        this.appendChild(child);
      }
    }

    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
    }

    getAttribute(name: string): string | null {
      return this.attributes.get(name) ?? null;
    }

    removeAttribute(name: string): void {
      this.attributes.delete(name);
    }

    contains(other: FakeElement | null | undefined): boolean {
      let current = other ?? undefined;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    }

    matchesSelector(selector: string): boolean {
      if (selector.startsWith(".")) {
        const classes = selector.split(".").filter(Boolean);
        return classes.every((name) => this.classList.contains(name) || this.className.split(" ").includes(name));
      }
      return this.tagName === selector.toUpperCase();
    }

    querySelector(selector: string): FakeElement | null {
      return this.querySelectorAll(selector)[0] ?? null;
    }

    querySelectorAll(selector: string): FakeElement[] {
      const result: FakeElement[] = [];
      const walk = (node: FakeElement): void => {
        for (const child of node.children) {
          if (child.matchesSelector(selector)) result.push(child);
          walk(child);
        }
      };
      walk(this);
      return result;
    }

    getBoundingClientRect(): { width: number; height: number; left: number; bottom: number } {
      return { width: 0, height: 0, left: 0, bottom: 0 };
    }

    focus(): void {
      setActiveElement(this);
    }

    blur(): void {
      if (activeElement === this) setActiveElement(undefined);
    }

    select(): void {}
    scrollIntoView(): void {}
  }

  const elementIds = [
    "tree",
    "menu",
    "search-input",
    "search-case",
    "search-regex",
    "search-scope",
    "search-count",
    "search-scope-warning",
    "previous-match",
    "next-match",
    "clear-search",
    "diff-clipboard",
    "toggle-inspector",
    "expand-all",
    "collapse-all",
    "expand-depth",
    "sort-keys",
    "empty-search",
    "title",
    "path",
    "diff-bar",
    "diff-added-count",
    "diff-removed-count",
    "diff-changed-count",
    "diff-unchanged-count",
    "diff-changes-only",
    "jsonl-bar",
    "previous-jsonl",
    "next-jsonl",
    "jsonl-diff-prev",
    "jsonl-line",
    "jsonl-total",
    "go-jsonl",
    "reveal-source",
    "follow-cursor",
    "keep-view",
    "jsonl-filter",
    "jsonl-filter-list",
    "jsonl-table",
    "jsonl-status",
    "recovery-warning",
    "tree-operation-status",
    "source-bar",
    "sync-cursor",
    "refresh-source",
    "source-status",
    "search-decoded",
    "pinned-bar",
    "pinned-chips",
    "pinned-clear",
    "breadcrumb-bar",
    "breadcrumb-segments",
    "breadcrumb-copy-jsonpath",
    "breadcrumb-copy-jq",
    "inspector-drawer",
    "inspector-path",
    "inspector-meta",
    "inspector-wrap",
    "inspector-copy",
    "inspector-close",
    "inspector-content",
    "table-view",
    "table-title",
    "table-filter",
    "table-count",
    "table-flatten",
    "table-copy-csv",
    "table-copy-tsv",
    "table-copy-md",
    "table-export-csv",
    "table-close",
    "table-container",
    "data-table",
  ];
  const elements = new Map(elementIds.map((id) => [id, new FakeElement(false, id === "data-table" ? "TABLE" : "DIV")]));
  const dataTable = elements.get("data-table")!;
  dataTable.appendChild(new FakeElement(false, "THEAD"));
  dataTable.appendChild(new FakeElement(false, "TBODY"));
  elements.get("table-view")!.classList.add("hidden");
  elements.get("menu")!.classList.add("hidden");
  elements.get("inspector-drawer")!.classList.add("hidden");
  elements.get("pinned-bar")!.classList.add("hidden");
  elements.get("diff-bar")!.classList.add("hidden");
  elements.get("inspector-wrap")!.classList.add("active");
  elements.get("inspector-content")!.classList.add("wrap");
  elements.get("search-scope")!.value = "all";

  if (l10nBundle !== undefined) {
    const bundle = new FakeElement();
    bundle.textContent = JSON.stringify(l10nBundle);
    elements.set("l10n-bundle", bundle);
  }
  const posted: Array<Record<string, unknown>> = [];
  const windowListeners = new Map<string, Array<(event: { data: unknown }) => void>>();
  const docListeners = new Map<string, Array<(event: unknown) => void>>();
  const timers: Array<() => void> = [];
  const document = {
    get activeElement() {
      return activeElement;
    },
    getElementById: (id: string) => elements.get(id),
    createElement: (tag = "div") => new FakeElement(false, tag),
    createDocumentFragment: () => new FakeElement(true),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const listeners = docListeners.get(type) ?? [];
      listeners.push(listener);
      docListeners.set(type, listeners);
    },
  };
  const window = {
    innerWidth: 1_000,
    innerHeight: 800,
    getSelection: () => ({ toString: () => (api.getSelectionText ? api.getSelectionText() : selectionText) }),
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
  };
  const setTimeout = (callback: () => void): number => {
    timers.push(callback);
    return timers.length;
  };

  const run = new Function(
    "window",
    "document",
    "acquireVsCodeApi",
    "setTimeout",
    "clearTimeout",
    "performance",
    script,
  );
  run(
    window,
    document,
    () => ({ postMessage: (message: Record<string, unknown>) => posted.push(message), ...api }),
    setTimeout,
    () => {},
    { now: () => 0 },
  );

  const drainTimers = (maxTurns = 10_000): number => {
    let turns = 0;
    while (timers.length > 0) {
      if (++turns > maxTurns) throw new Error("Webview timers did not settle");
      timers.shift()!();
    }
    return turns;
  };
  const send = (data: unknown): void => {
    for (const listener of windowListeners.get("message") ?? []) listener({ data });
  };
  const setSelectionText = (text: string): void => {
    selectionText = text;
  };
  return { elements, windowListeners, docListeners, timers, drainTimers, posted, send, setSelectionText };
}
