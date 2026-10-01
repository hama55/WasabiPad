# ABC・LilyPond 外部プレビュー

保存済みの ABC（`.abc`）と LilyPond（`.ly`・`.ily`）を、WasabiPad の共通外部プレビューから表示する。全ページ・全曲を保持し、選択した曲を先頭から再生・停止できる。元の譜面は変更しない。

## 配置する

1. Node.js 22 以降を導入する。LilyPond を使う場合は LilyPond 2.26 を別途導入する。
2. リポジトリのルートで `npm ci`、続いて `npm ci --prefix addins/music-preview --ignore-scripts` を実行する。
3. `npm run build --prefix addins/music-preview` を実行する。
4. 生成された `addins/music-preview/dist` の内容を、例えば `C:\Tools\WasabiPadMusic` に配置する。`preview.mjs`、`abc.js`、`cursor.ily`、`licenses` をまとめて保持する。配布物の実行に `node_modules` は不要。
5. 利用権のある SF2/SF3 音源をローカルに配置する。音源は同梱しない。音源のライセンスと対応楽器を確認する。

依存ライブラリを取得するビルド時には通信が必要。配置後の生成・表示・再生はオフラインで動作する。

## WasabiPad に登録する

設定 → 外部プレビュー → 追加で、ABC と LilyPond を別々に登録する。生成形式はどちらも **HTML**。実行ファイルや資産のパスは配置場所に合わせる。

ABC（対象拡張子 `abc`）:

```text
"C:\Program Files\nodejs\node.exe" "C:\Tools\WasabiPadMusic\preview.mjs" --input "{file}" --output "{output}" --soundfont "C:\Tools\SoundFonts\piano.sf2"
```

LilyPond（対象拡張子 `ly, ily`）:

```text
"C:\Program Files\nodejs\node.exe" "C:\Tools\WasabiPadMusic\preview.mjs" --input "{file}" --output "{output}" --soundfont "C:\Tools\SoundFonts\general-midi.sf3" --lilypond "C:\Tools\lilypond-2.26.0\bin\lilypond.exe"
```

`--lilypond` を省略すると PATH の `lilypond` を使う。`--soundfont` の音源パスは両形式で共用できる。

対象ファイルを保存し、設定の「外部プレビュー」で拡張子ごとの候補を選ぶ。標準プレビューも対応する拡張子では「外部プレビューを優先」を選び、通常のプレビューを開く。初回の実行確認で、登録したプログラムを信頼して実行する。更新はプレビュー内の更新ボタンを使う。

LilyPond の入力は Scheme を実行できるため、信頼できる譜面だけを変換する。外部 HTML の隔離は、変換プログラムが入力を実行することまで防がない。

## 表示と再生

- ABC の全曲を表示する。空入力と不正な ABC は別の案内を出し、再生を無効にする。
- ABC はプレビュー幅に合わせて縦横比を保って表示し、幅の変更で五線譜を切らない。曲名を左揃えにし、外周と曲間の余白を小さくする。原稿の改行・余白指定を優先する。
- LilyPond は用紙全体ではなく内容に合う高さで表示する。既定ではページ内の縦方向の引き伸ばしを抑え、上下余白を 2 mm にし、既定の末尾クレジットを省く。表示用設定を原稿より先に読み込み、原稿の `\\paper`・`\\header` 指定、改行・改ページ・段間を尊重する。音符・歌詞の間隔は変更しない。
- LilyPond は既定の先頭段の字下げとページ番号を省き、小節番号を残す。楽器名は譜表の外側へ右揃えで置く。原稿の字下げ・ページ番号・楽器名の配置指定を優先する。
- LilyPond の全 SVG ページと、生成された全 MIDI 曲を生成時刻順に保持する。同時刻の場合はファイル名などで順序を決める。再生位置は変換時に記録した曲・音符の識別情報で対応付け、ファイル名から推測しない。相対 `\include` は入力ファイルの親ディレクトリから解決する。
- LilyPond は `\score` 内に `\layout {}` と `\midi {}` を指定すると譜面と再生データを生成できる。MIDI がない場合は譜面を表示し、再生不可と指定方法を案内する。
- 曲名・ファイル名で曲を選択して「再生」を押す。「停止」は先頭へ戻す。曲を変更したときも停止する。
- 再生中は実際の音声時刻に合わせて赤い縦線が進む。段・ページの移動時は画面外の段を自動スクロールで表示し、停止・終了・曲変更・失敗時は線を消す。位置対応が不明な場合は音声再生を維持し、理由を表示する。LilyPond の装飾音を含む曲は現在、位置表示の対象外。
- 音源の未指定・不足・破損や音声生成の失敗は、譜面を残して再生不可の理由を表示する。LilyPond の起動・譜面変換に失敗した場合は WasabiPad の実行ログに診断を出す。
- 生成時間、容量、曲数・ページ数の独自上限は設けない。長い譜面ほど生成時間とメモリ・ディスク使用量が増える。再生成や表示終了に伴う取消は既存の外部プレビュー経路で処理する。

WAV は22,050 Hz・ステレオ・16-bit PCMで、一時出力先に置く。音源の取得や AudioWorklet はプレビュー内で行わず、外部 HTML の隔離を保つ。

## サンプル・検証

`samples/two-tunes.abc` と `samples/two-books.ly` を登録後に開く。LilyPond サンプルは同じフォルダの `notes.ily` を参照する。

自動検証は、リポジトリのルートで次を実行する:

```powershell
$env:WASABIPAD_TEST_LILYPOND = 'C:\Tools\lilypond-2.26.0\bin\lilypond.exe'
npm run test:music-preview
```

本体の `npm test` とビルドはアドインのテストを含まない。専用の検証前に、配置手順と同じアドイン用依存導入を行う。LilyPond 未指定時は実変換テストだけをスキップする。専用テストはサンプル音源で無音ではない WAV の生成と HTML の操作を検証するが、実機の表示・発音の確認とは区別する。

`addins/pending` の旧マニフェスト・公式カタログは使わない。音楽専用の管理機能や自動ダウンロードは追加しない。
