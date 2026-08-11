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

  // Given: 現在のlistener解除が同期例外を投げる
  // When: 新しいlistenerを登録してから破棄する
  // Then: 解除例外を外へ漏らさず、新しいlistenerの解除まで実行する
  it("Scenario: 解除失敗後も次のlistenerを破棄する", () => {
    const first = vi.fn(() => { throw new Error("first failed"); });
    const second = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = createAsyncUnlisten();

    expect(() => listener.set(first)).not.toThrow();
    expect(() => listener.set(second)).not.toThrow();
    expect(() => listener.dispose()).not.toThrow();

    expect(second).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  // Given: listener解除が同期例外を投げる
  // When: listenerを破棄する
  // Then: 例外を握り潰しても解除済み状態を維持し、再破棄で再実行しない
  it("Scenario: 解除失敗後も破棄状態を確定する", () => {
    const unlisten = vi.fn(() => { throw new Error("dispose failed"); });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = createAsyncUnlisten();
    listener.set(unlisten);

    expect(() => listener.dispose()).not.toThrow();
    expect(() => listener.dispose()).not.toThrow();

    expect(unlisten).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
