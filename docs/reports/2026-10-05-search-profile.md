# 検索の速度優先・サイズ優先比較（2026-10-05）

検索関連の速度優先設定を維持する。サイズ優先にすると EXE は 3.42% 小さくなったが、検索処理の中央値は全測定条件で遅くなった。実験後、Cargo.toml は実験前の速度優先設定に戻した。

## EXE サイズ

Windows、WasabiPad 1.8.2、同じソースと Cargo.lock、`npm run tauri -- build --no-bundle` で比較した。全体の opt-level=z、LTO、codegen-units=1、strip は共通。変更は検索関連8パッケージの opt-level=3 の例外を除去したことだけ。

| 設定 | bytes | SHA-256 |
| --- | ---: | --- |
| 検索だけ速度優先 | 7,805,952 | `0C6E1128249BCCE137F3D90D6990BF50F470AC42B285B8F7455E5AC95E0BA38D` |
| 全体サイズ優先 | 7,539,200 | `BE0668186C34EA633D34181857FF5442B1712517F82213FA93EB0E6F5F3A3C2E` |

削減は **266,752 bytes（3.42%）**。両設定で UI 1,150テスト、型チェック、設定整合性、IPC77コマンド検証、ビルド成功。サイズ優先の検索関連リリーステスト19件も成功した。

速度優先へ復元後の再ビルドも成功し、EXE は 7,805,952 bytes に戻った。復元後の SHA-256 は `523D4FF6209EF9C30E8D7F315A2A7F98E73E763F0E3F1E32C3817E819A0C8405`。表のハッシュは比較測定時の成果物を識別する値。

## 検索速度

アプリと同じ公開 API `wasabipad_core::search_workspace` を独立した一時プログラムから呼んだ。検索コアの比較であり、配布EXEそのものの応答時間の比較ではない。比較プログラムも opt-level=z、LTO、codegen-units=1、strip を使用し、検索依存に対する速度優先例外だけを切り替えた。製品Cargo.lockをコピーして依存バージョンを揃えた。8パッケージ中 regex 自体はコア側に依存がなく、比較プログラムには含まれない。

- 固定 UTF-8 テキスト128ファイル、70,779,392 bytes（約70.8MB / 67.5MiB）。各ファイル4行に一致文字列、計512件。不一致条件は0件。
- 本文のみ、各上限なし、gitignore無視。workers=0（自動、最大8）と workers=1。
- 各プロセスで2回ウォームアップ後10回測定。4ラウンドで speed→size / size→speed の順を交互に変え、各条件・設定40回の中央値を比較。
- データ生成、コンパイル、ウォームアップ、結果照合は測定対象外。タイマー対象は検索 API 呼び出しのみ。途中結果のコールバックは何もしない。
- 全測定で128ファイル走査、スキップ・打ち切り・エラーなし。件数と、全結果フィールドをJSON化・ソートした64-bit fingerprintが両設定で一致した。

| 条件 | 自動:速度優先 ms | 自動:サイズ優先 ms | 時間増加 | 1並列:速度優先 ms | 1並列:サイズ優先 ms | 時間増加 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 文字列・一致 | 7.35 | 7.95 | 8.2% | 15.50 | 19.43 | 25.4% |
| 文字列・不一致 | 7.23 | 7.60 | 5.1% | 14.72 | 18.42 | 25.1% |
| 大文字小文字無視 | 8.40 | 9.05 | 7.7% | 18.81 | 22.46 | 19.4% |
| 正規表現・一致 | 7.51 | 8.04 | 6.9% | 15.89 | 19.64 | 23.6% |
| 正規表現・不一致 | 7.20 | 7.83 | 8.7% | 14.87 | 18.46 | 24.2% |
| 日本語 | 7.46 | 7.71 | 3.3% | 15.61 | 19.04 | 21.9% |

生データ、中央値、p10/p90は [測定データ](2026-10-05-search-profile-measurements.json) に保存した。自動並列の p10–p90 範囲は両設定で重なり、短い測定にはばらつきもある。全条件の中央値と1並列の差から、サイズ削減と速度低下の交換が発生する傾向を確認した。統計的な有意差の検定はしていない。

OSキャッシュが温まった固定データでの測定。Tauri IPC、画面描画、配布EXEのリンク結果、初回ディスクアクセス、Shift-JIS、ファイル名検索は含まない。別のデータやPCでも同じ割合になるとは限らない。

## 再測定

測定ソースを `core/examples/search-profile-bench.rs` に保存した。製品EXEには含まれず、新しい依存も追加していない。一時版との違いは引数チェックと説明コメントだけ。現在の速度優先設定では、ルートから次のコマンドで実行できる。

```powershell
cargo run --release --locked -p wasabipad-core --example search-profile-bench -- <data-directory> 0
```

今回のデータ生成手順（Windows上でtarget内の専用ディレクトリへ生成）：

```powershell
$dataRoot = Join-Path $PWD 'target/search-profile-data'
New-Item -ItemType Directory -Force $dataRoot | Out-Null
$content = [System.Text.StringBuilder]::new()
for ($lineIndex=0; $lineIndex -lt 4096; $lineIndex++) {
    if ($lineIndex % 1024 -eq 0) {
        [void]$content.AppendLine('WasabiNeedle1234 検索対象 ' + ('a' * 104))
    } else {
        [void]$content.AppendLine('ordinary log entry 2026 sample text abcdefghijklmnopqrstuvwxyz ' + ('x' * 70))
    }
}
$bytes = [System.Text.Encoding]::UTF8.GetBytes($content.ToString())
for ($fileIndex=0; $fileIndex -lt 128; $fileIndex++) {
    [System.IO.File]::WriteAllBytes((Join-Path $dataRoot ('sample-{0:D3}.txt' -f $fileIndex)), $bytes)
}
```

比較時は、速度優先と検索関連8パッケージをzにした設定で同じ測定ソースをビルドし、バイナリを別々に保存する。コンパイル中には計測せず、実行順を交互にして測定する。設定を一時変更した場合は、測定後に元へ戻す。
