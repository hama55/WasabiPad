import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry, globalCommandForEvent } from "./commands";

const noop = vi.fn();
const registry = createCommandRegistry({
  newFile: async () => {},
  openFile: noop,
  openFolder: noop,
  save: async () => true,
  saveAs: async () => true,
  quit: noop,
  find: noop,
});

function key(key: string, shiftKey = false, defaultPrevented = false): KeyboardEvent {
  return { key, ctrlKey: true, shiftKey, defaultPrevented } as KeyboardEvent;
}

describe("command registry", () => {
  it("uses the same command for menu metadata and shortcuts", () => {
    expect(globalCommandForEvent(registry, key("s"))).toBe(registry.save);
    expect(globalCommandForEvent(registry, key("s", true))).toBe(registry.saveAs);
  });

  it("does not dispatch events already handled by the editor", () => {
    expect(globalCommandForEvent(registry, key("f"))).toBeUndefined();
    expect(globalCommandForEvent(registry, key("s", false, true))).toBeUndefined();
  });
});
