# PetaPad — 激軽メモ帳

軽快な操作感と、巨大なテキストファイルの省メモリ表示・編集を重視した Windows 用テキストエディタ。
最優先価値: **起動速度・軽さ・行番号・巨大ファイル対応**。

- UI: Tauri 2 + TypeScript (VSCode 風ダークテーマ、独自の仮想スクロールエディタ)
- 内部処理: UI 非依存の共有crate `petapad-core` (Rust)
- 文書は常に mmap ベースで開く (RAM に全文を載せない)。フロントへは可視スライスのみ渡す

## 機能

### 編集
| 機能 | 操作 |
|---|---|
| 新規 / 開く / 上書き保存 / 名前を付けて保存 | Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| 元に戻す / やり直し | Ctrl+Z / Ctrl+Y (連続文字入力は1回にまとめる) |
| 切り取り / コピー / 貼り付け / 全選択 | Ctrl+X / Ctrl+C / Ctrl+V / Ctrl+A |
| 検索 / 置換 | Ctrl+F / Ctrl+H |
| 単語移動 / 単語選択 | Ctrl+←→ |

- 行番号表示 (常時)
- IME インライン変換
- ファイルのドラッグ&ドロップで開く
- コマンドライン引数でファイル指定可 (`petapad.exe file.txt`)
- お気に入りバー・アドレスバー・フォルダビュー

### エンコーディング / 改行コード
- 自動判定: BOM → UTF-8 厳密検証 → Shift-JIS (UTF-16LE は BOM 検出)
- 保存時にステータスバーから UTF-8 / UTF-8(BOM) / Shift-JIS / UTF-16LE、CRLF / LF を選択

### 巨大ファイル向け mmap ベース省メモリ編集
ファイルサイズによらず、開いたファイルは mmap + 疎な行インデックスで扱う。

- ファイルを RAM に丸読みしない (巨大ファイルでもメモリ使用量は小さい)
- 4096 行ごとの行インデックスのみ保持、表示行はオンデマンドでデコード
- 編集したチャンクだけメモリに実体化 (overlay)
- フロントは可視範囲の行だけを IPC で取得する仮想スクロールエディタ
- 保存はストリーム書き (未編集部分は生バイトコピー)
  (一時ファイル → mmap 解放 → 差し替え → 再マップ)

制約:
- 開いている実ファイルは読み取り共有でロックされる (他アプリから閲覧可能、書き込み・削除・名前変更は不可)
- UTF-16LE と 空ファイルは通常の RAM 読込にフォールバック
- 長い行の折り返し表示に対応

### ZIP / Excel の遅延展開ビュー (読み取り専用)
以下のファイルは中身を **展開せずツリーの1エントリとして表示** し、
サイドバーの展開ボタンを押すまで中身の一覧すら読まない。展開後にエントリを
選択して初めてその1件だけを実際に展開して表示する。

| 形式 | 判定 | 内容 |
|---|---|---|
| ZIP (xlsx / zip / .zip 拡張子) | 先頭 `PK\x03\x04` | 選択したエントリだけを展開して表示。バイナリは `(バイナリ: N bytes)` |
| 旧 Excel (.xls, BIFF8) | CFB シグネチャ | 選択したシートだけをタブ区切りで表示 (文字列・数値・数式のキャッシュ値) |

- フォルダビュー内に見つかった zip/xlsx/xls も同様に遅延展開される (実ファイルとしてツリーに並び、展開ボタンでエントリ一覧を取得する)
- `.zip`/`.xlsx`/`.xls` 以外の拡張子を持つ ZIP コンテナ (docx 等) は従来通り開いた時点で全エントリを展開する
- サイドバーに `(閲覧)` モードとして表示され、編集は不可 (元ファイルを壊さないため)
- 非対応: 暗号化 ZIP、ZIP64 (4GB 超)、BIFF5 以前の .xls、セル書式 (日付は数値のまま)

## 内部構成

```
core/                  petapad-core (rlib, UI 非依存)
  src/doc.rs            高レベル文書API (可視行取得・編集・検索・保存)
  src/buffer.rs          テキストバッファ (Small: 行Vec / Huge: mmap+overlay)
  src/hugebuf.rs          mmap + 疎な行インデックス + overlay 編集
  src/fileio.rs           読込/保存、エンコーディング判定、mmap 起動判定
  src/undo.rs             Undo/Redo スタック
  src/ziptext.rs          ZIP 連結ビュー
  src/xlstext.rs          .xls (CFB+BIFF8) 連結ビュー
  src/bookmarks.rs        お気に入りの永続化

src-tauri/              Tauri バックエンド (petapad-core を呼ぶコマンド層)
  src/main.rs            Tauri コマンド定義

ui/                     フロントエンド (TypeScript)
  editor.ts               仮想スクロールエディタ本体 (caret/選択/IME/検索)
  findbar.ts               検索/置換バー
  main.ts                  アプリ全体の配線 (メニュー・ファイル操作)
  sidebar.ts                フォルダ/ZIP/Excel エントリのツリー表示
  favbar.ts                  お気に入りバー
  menu.ts                     共有ドロップダウンメニュー
```

依存クレート (`core`): `windows-sys` (mmap) / `encoding_rs` / `memchr` / `miniz_oxide` / `serde`

## ビルド

事前に以下をインストールする。

- Node.js (npmを含む)
- Rust
- Microsoft C++ Build Tools
- WebView2 Runtime (Windows 10/11では通常導入済み)

PowerShellでリポジトリ直下のスクリプトを実行する。

```powershell
.\build_tauri_release.ps1
```

このスクリプトがNode依存パッケージの導入、フロントエンドのビルド、Rust/Tauriの
リリースビルドを順番に実行する。成果物は `release/` に生成される。

- `release/petapad.exe`: 単体実行版
- `release/*-setup.exe`: Windowsインストーラー

開発起動と単体テスト:

```powershell
npm run tauri dev
cargo test --manifest-path core/Cargo.toml
```

## インストール

最新版はGitHubの [Releases](https://github.com/hama55/PetaPad/releases) から取得できる。

- `PetaPad_*-setup.exe`: 通常のインストーラー
- `petapad.exe`: インストール不要の単体実行版

通常は `release/` 内の `*-setup.exe` を実行し、画面の案内に従う。

インストールせず使う場合は、`release/petapad.exe` を好きなフォルダへ置いて
そのまま実行する。WindowsからWebView2 Runtimeを要求された場合は、Microsoftの
WebView2 Runtimeをインストールする。

## リリース

バージョンの正本はルート `Cargo.toml` の `[workspace.package].version`。
変更後は `npm run sync:version` で各ツールの生成値を同期する。

`v<version>` のバージョンタグをpushすると、GitHub ActionsがWindows版を
ビルドし、GitHub Releaseへインストーラーと単体実行版を自動登録する。
タグとCargo versionが一致しないreleaseは失敗する。

```powershell
git tag v0.2.0
git push origin v0.2.0
```

## 既知の仕様
- グラフェム単位ではなく char (Unicode スカラー値) 単位のカーソル移動
- 検索の大文字小文字無視は ASCII のみ
- Undo はファイル保存後もクリアされない
