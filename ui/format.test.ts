import { describe, expect, it } from "vitest";
import { formatByteSize, formatWindowTitle } from "./format";
import { initialSession } from "./session";

describe("display formatting", () => {
  it("formats byte boundaries", () => {
    expect(formatByteSize(1023)).toBe("1023 B");
    expect(formatByteSize(1024)).toBe("1.0 KB");
    expect(formatByteSize(1024 * 1024)).toBe("1.0 MB");
  });

  it("derives the window title from session state", () => {
    const session = initialSession();
    expect(formatWindowTitle(session)).toBe("無題 — PetaPad");
    session.displayPath = "C:\\work\\memo.txt";
    session.savePath = session.displayPath;
    session.dirty = true;
    expect(formatWindowTitle(session)).toBe("● memo.txt — PetaPad");
  });
});
