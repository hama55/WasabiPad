# SQLiteプレビュー: 閲覧専用実ファイルの読取元修正計画

## 状態

実装完了（2026-09-16）。この文書を実装内容と受入条件の記録として扱う。

## 問題

ディスク上に存在する `.sqlite` / `.sqlite3` はバイナリ文書として閲覧専用で開かれる。現在の `DocumentSession` はその文書の `displayPath` を保持する一方、`savePath` は `null` になる。SQLiteプレビューが `savePath` だけを実ファイル判定に使うため、実在するSQLiteファイルまで「保存済みの通常ファイルではない」と誤認して開けない。

SQLiteデータベース自体に、テキストエディタの新規タブのような「未保存SQLite」は通常ない。外部アプリの未コミット変更は実ファイルのパスを持たないため対象外であり、今回扱うのは実パスを持つ閲覧専用文書だけである。

## 修正後の仕様

- SQLiteプレビューは、保存済み編集文書の `savePath` がなくても、通常実ファイルを指す `displayPath` から開く。
- 本当に実パスがない新規文書、アーカイブ内項目、仮想項目は引き続き対象外。
- SQLiteの読取専用接続、renderer、行数設定、対象拡張子、アーカイブ除外は変更しない。
- 実パスがない場合のエラーは、「保存済み通常ファイルだけ対応」のような誤解を招く表現ではなく、「SQLiteプレビューには実ファイルのパスが必要」と伝える。

## BDD seam

公開seamは `sourcePathForViewer(format, savePath, displayPath)` とする。`main.ts` のSQLite起動経路はすべてこの関数と `sqlitePreviewSourcePath` を経由するため、ここを直せば全呼び出し元へ同じ判定が適用される。

最初に `ui/viewer-formats.test.ts` へ次の失敗するBDDを追加する。

```ts
// Feature: 閲覧専用SQLite実ファイルをプレビューする
// Scenario: savePathを持たない閲覧専用SQLite文書から実ファイルを読む
// Given: formatがsqlite、savePathがnull、displayPathがdata.sqlite
// When: sourcePathForViewerを呼ぶ
// Then: data.sqliteを返す
```

必要なら `ui/session.test.ts` に、バイナリ閲覧専用の `DocInfo` から作った `DocumentSession` が `displayPath` を保持するBDDを追加する。既存テストがこの振る舞いを保証している場合は重複追加しない。

## 実装手順

1. `ui/viewer-formats.test.ts` のSQLite・PDF・asset形式の既存テストを確認し、上記BDDを追加して失敗させる。
2. `ui/viewer-formats.ts` の `sourcePathForViewer` を最小変更する。asset形式が `displayPath` を使う既存分岐へSQLiteを加え、`savePath` がないSQLiteでも `displayPath` を返すようにする。
3. `ui/main.ts` の `sqlitePreviewSourcePath`、通常プレビュー開始、SQLiteの表示処理を変更せず、修正済み共通関数を通じて既存実パスが渡ることを確認する。
4. `sqlitePreviewSourcePath` のアーカイブ除外を維持する。`archivePath` または `archiveEntry` がある場合に `displayPath` へフォールバックさせてはならない。
5. `ui/main.ts` の実パス不在エラー文を、真の失敗理由に更新する。新規タブ・仮想項目・アーカイブ内SQLiteはプレビュー不可のままとする。
6. BDDをgreenにし、型検査と既存プレビュー回帰を確認する。リファクタリングやRust/IPCの変更は行わない。

## 変更対象

- `ui/viewer-formats.ts`: SQLiteを実ファイル読取元の対象に加える。
- `ui/viewer-formats.test.ts`: 閲覧専用SQLiteの実パスを返すBDDを追加する。
- `ui/main.ts`: 実パス不在時のSQLiteエラー文だけを正確化する。
- `ui/session.test.ts`: `displayPath`保持の保証が不足している場合だけBDDを追加する。

## 非対象

- `core/`、`src-tauri/`、`rusqlite`、IPC型、generatedファイル、SQLite renderer、設定、サイズ計測。
- 本当にパスのないSQLite、新規SQLite作成、DB編集、アーカイブ内SQLite、DBコピー。

## 検証

1. 追加BDDを含む `ui/viewer-formats.test.ts` を実行する。
2. 必要なら `ui/session.test.ts` を実行する。
3. `npm test`、`npx tsc --noEmit`、`npm run build`、`git diff --check` を実行する。
4. 手動確認では、エクスプローラーまたはファイルツリーから既存の `.sqlite` を開き、SQLiteプレビューがテーブル一覧を表示することを確認する。未保存タブとアーカイブ内SQLiteは、実パスがない理由でプレビュー不可のままであることを確認する。

## 文書の扱い

既存の [SQLiteプレビュー実装計画](./0015-sqlite-preview.md) とADR 0015の「通常実ファイルだけ」という境界は維持する。この修正は、閲覧専用の通常実ファイルを誤って未保存扱いしていた不具合の修正であり、ADRや用語集の変更を必要としない。
