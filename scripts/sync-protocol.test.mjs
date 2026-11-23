import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertProtocolLabelKeys } from "./check-ipc-contract.mjs";
import { validateProtocol } from "./sync-protocol.mjs";

const validProtocol = () => JSON.parse(readFileSync(new URL("../shared/protocol.json", import.meta.url), "utf8"));

describe("Feature: protocol schema validation and IPC enum key parity", () => {
  // Given: リポジトリの現行 shared/protocol.json がある
  // When: プロトコル定義を検証する
  // Then: 例外を投げずに通過する
  it("Scenario: accepts current shared/protocol.json", () => {
    expect(() => validateProtocol(validProtocol())).not.toThrow();
  });

  // Given: 必須文字列フィールドが欠落または空文字である
  // When: プロトコル定義を検証する
  // Then: 不正設定エラーで失敗する
  it.each([
    ["archiveEntrySeparator", undefined],
    ["archiveEntrySeparator", ""],
    ["passwordErrorMarker", undefined],
    ["passwordErrorMarker", ""],
  ])("Scenario: rejects invalid string field %s=%j", (field, value) => {
    const protocol = validProtocol();
    protocol[field] = value;
    expect(() => validateProtocol(protocol)).toThrow(`${field}設定が不正です`);
  });

  // Given: 必須配列フィールドが欠落・空配列・空文字要素を含む
  // When: プロトコル定義を検証する
  // Then: 不正設定エラーで失敗する
  it.each([
    ["archiveFormats", []],
    ["videoExtensions", undefined],
    ["videoExtensions", []],
    ["videoExtensions", [""]],
    ["imageFormats", []],
  ])("Scenario: rejects invalid array field %s=%j", (field, value) => {
    const protocol = validProtocol();
    protocol[field] = value;
    expect(() => validateProtocol(protocol)).toThrow(`${field}設定が不正です`);
  });

  // Given: imageFormats の要素で extensions または mimeTypes が空配列である
  // When: プロトコル定義を検証する
  // Then: 不正設定エラーで失敗する
  it.each(["extensions", "mimeTypes"])("Scenario: rejects empty imageFormats[].%s", (field) => {
    const protocol = validProtocol();
    protocol.imageFormats[0][field] = [];
    expect(() => validateProtocol(protocol)).toThrow(`imageFormats.${field}設定が不正です`);
  });

  // Given: 必須マップフィールドが欠落・空オブジェクト・配列・空文字値を含む
  // When: プロトコル定義を検証する
  // Then: 不正設定エラーで失敗する
  it.each([
    ["events", {}],
    ["events", []],
    ["encodingLabels", undefined],
    ["encodingLabels", {}],
    ["encodingLabels", { utf8: "" }],
    ["eolLabels", undefined],
    ["eolLabels", {}],
    ["eolLabels", { lf: "" }],
  ])("Scenario: rejects invalid map field %s=%j", (field, value) => {
    const protocol = validProtocol();
    protocol[field] = value;
    expect(() => validateProtocol(protocol)).toThrow(`${field}設定が不正です`);
  });

  // Given: encodingLabels のキー集合が Rust の EncodingId と一致しない
  // When: IPC 契約のラベルキー突合を実行する
  // Then: 欠落でも余剰でも不一致エラーで失敗する
  it("Scenario: rejects encodingLabels key drift against Rust EncodingId", () => {
    const missing = validProtocol();
    delete missing.encodingLabels.utf16le;
    expect(() => assertProtocolLabelKeys(["utf8", "utf8bom", "sjis", "utf16le"], ["crlf", "lf"], missing))
      .toThrow("Protocol encodingLabels keys");

    const extra = validProtocol();
    extra.encodingLabels.eucjp = "EUC-JP";
    expect(() => assertProtocolLabelKeys(["utf8", "utf8bom", "sjis", "utf16le"], ["crlf", "lf"], extra))
      .toThrow("Protocol encodingLabels keys");
  });

  // Given: eolLabels のキー集合が Rust の Eol と一致しない
  // When: IPC 契約のラベルキー突合を実行する
  // Then: 欠落でも余剰でも不一致エラーで失敗する
  it("Scenario: rejects eolLabels key drift against Rust Eol", () => {
    const missing = validProtocol();
    delete missing.eolLabels.lf;
    expect(() => assertProtocolLabelKeys(["utf8", "utf8bom", "sjis", "utf16le"], ["crlf", "lf"], missing))
      .toThrow("Protocol eolLabels keys");

    const extra = validProtocol();
    extra.eolLabels.cr = "CR";
    expect(() => assertProtocolLabelKeys(["utf8", "utf8bom", "sjis", "utf16le"], ["crlf", "lf"], extra))
      .toThrow("Protocol eolLabels keys");
  });
});
