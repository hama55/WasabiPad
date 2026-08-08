import { describe, expect, it, vi } from "vitest";
import { createAsyncUnlisten } from "./async-unlisten";

describe("Feature: asynchronous listener cleanup", () => {
  // Given: listener登録が完了している
  // When: listenerを破棄する
  // Then: unlistenを一度呼ぶ
  it("Scenario: disposes a registered listener", () => {
    const unlisten = vi.fn();
    const listener = createAsyncUnlisten();
    listener.set(unlisten);

    listener.dispose();
    listener.dispose();

    expect(unlisten).toHaveBeenCalledOnce();
  });

  // Given: listener破棄が登録完了より先に行われている
  // When: 非同期登録が完了する
  // Then: 完了直後にunlistenを呼ぶ
  it("Scenario: disposes a listener that resolves after teardown", () => {
    const unlisten = vi.fn();
    const listener = createAsyncUnlisten();

    listener.dispose();
    listener.set(unlisten);

    expect(unlisten).toHaveBeenCalledOnce();
  });

  // Given: listener登録が置き換えられている
  // When: listenerを破棄する
  // Then: 古い登録と最新の登録をそれぞれ一度だけ解除する
  it("Scenario: replaces a previous listener without leaking it", () => {
    const first = vi.fn();
    const second = vi.fn();
    const listener = createAsyncUnlisten();

    listener.set(first);
    listener.set(second);
    listener.dispose();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});
