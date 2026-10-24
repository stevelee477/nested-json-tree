/** Minimal DOM harness for executing the actual embedded Webview script. */
export function createWebviewHarness(
  script: string,
  api: { getState?: () => unknown; setState?: (state: unknown) => void } = {},
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

  class FakeElement {
    readonly classList = new FakeClassList();
    readonly listeners = new Map<string, Array<(event: unknown) => void>>();
    readonly attributes = new Map<string, string>();
    readonly children: FakeElement[] = [];
    className = "";
    textContent = "";
    title = "";
    value = "";
    disabled = false;
    tabIndex = 0;
    scrollTop = 0;

    constructor(readonly fragment = false) {}

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    dispatch(type: string, event: unknown = {}): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    appendChild(child: FakeElement): FakeElement {
      if (child.fragment) this.children.push(...child.children);
      else this.children.push(child);
      return child;
    }

    replaceChildren(...children: FakeElement[]): void {
      this.children.splice(0, this.children.length, ...children);
    }

    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
    }

    querySelectorAll(selector: string): FakeElement[] {
      const classes = selector.split('.').filter(Boolean);
      const result: FakeElement[] = [];
      const pending = [...this.children];
      while (pending.length > 0) {
        const child = pending.pop() as FakeElement;
        if (classes.every((name) => child.classList.contains(name) || child.className.split(' ').includes(name))) result.push(child);
        pending.push(...child.children);
      }
      return result.reverse();
    }

    getBoundingClientRect(): { width: number; height: number } {
      return { width: 0, height: 0 };
    }

    focus(): void {}
    select(): void {}
    scrollIntoView(): void {}
  }

  const elementIds = [
    "tree",
    "menu",
    "search-input",
    "search-count",
    "search-scope-warning",
    "previous-match",
    "next-match",
    "clear-search",
    "expand-all",
    "collapse-all",
    "empty-search",
    "title",
    "path",
    "jsonl-bar",
    "previous-jsonl",
    "next-jsonl",
    "jsonl-line",
    "jsonl-total",
    "go-jsonl",
    "reveal-source",
    "follow-cursor",
    "jsonl-status",
    "recovery-warning",
    "tree-operation-status",
  ];
  const elements = new Map(elementIds.map((id) => [id, new FakeElement()]));
  const windowListeners = new Map<string, Array<(event: { data: unknown }) => void>>();
  const timers: Array<() => void> = [];
  const document = {
    getElementById: (id: string) => elements.get(id),
    createElement: () => new FakeElement(),
    createDocumentFragment: () => new FakeElement(true),
    addEventListener: () => {},
  };
  const window = {
    innerWidth: 1_000,
    innerHeight: 800,
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
  run(window, document, () => ({ postMessage: () => {}, ...api }), setTimeout, () => {}, { now: () => 0 });

  const drainTimers = (maxTurns = 10_000): number => {
    let turns = 0;
    while (timers.length > 0) {
      if (++turns > maxTurns) throw new Error("Webview timers did not settle");
      timers.shift()!();
    }
    return turns;
  };
  return { elements, windowListeners, timers, drainTimers };
}
