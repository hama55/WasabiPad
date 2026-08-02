import type { StoredTab } from "./stored-tabs";

export interface NavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
}

export type NavigationKind = Exclude<StoredTab["kind"], "blank">;

export interface NavigationEntry {
  path: string;
  kind: NavigationKind;
  selectedRelPath?: string;
  line: number;
}

export type NavigationDirection = "back" | "forward";

const HISTORY_LIMIT = 10;

export function sameNavigationLink(a: NavigationEntry, b: NavigationEntry): boolean {
  return a.path === b.path && a.kind === b.kind && a.selectedRelPath === b.selectedRelPath;
}

function copy(entry: NavigationEntry): NavigationEntry {
  return { ...entry };
}

export class NavigationHistory {
  private back: NavigationEntry[] = [];
  private forward: NavigationEntry[] = [];

  get state(): NavigationState {
    return {
      canGoBack: this.back.length > 0,
      canGoForward: this.forward.length > 0,
    };
  }

  target(direction: NavigationDirection): NavigationEntry | null {
    const stack = direction === "back" ? this.back : this.forward;
    const entry = stack.at(-1);
    return entry ? copy(entry) : null;
  }

  record(previous: NavigationEntry) {
    if (!this.back.at(-1) || !sameNavigationLink(this.back.at(-1)!, previous)) {
      this.back.push(copy(previous));
      if (this.back.length > HISTORY_LIMIT) this.back.shift();
    }
    this.forward = [];
  }

  complete(direction: NavigationDirection, current: NavigationEntry | null) {
    const source = direction === "back" ? this.back : this.forward;
    source.pop();
    if (!current) return;
    const destination = direction === "back" ? this.forward : this.back;
    if (destination.at(-1) && sameNavigationLink(destination.at(-1)!, current)) return;
    destination.push(copy(current));
    if (destination.length > HISTORY_LIMIT) destination.shift();
  }
}
