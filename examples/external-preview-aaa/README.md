# 外部プレビューアダプタ AAA サンプル

`aaa` ファイルを Node.js でHTMLへ変換する、WasabiPad外部プレビューアダプタの最小サンプルです。Node.jsの組み込みモジュールだけを使うため、npm依存はありません。

## 設定画面への登録例

WasabiPadの設定画面で、アドインを次のように登録します。

- 拡張子: `aaa`
- 実行ファイル: `node`（または `node.exe`）
- 引数:

  ```text
  "C:\Work\20260722_WasabiPad_GitHub\examples\external-preview-aaa\render-preview.cjs" "{file}" "{output}"
  ```

- 出力形式: `HTML`

`{file}` は選択した入力ファイル、`{output}` はWasabiPadが用意する出力先に置き換えられます。

## 使い方

1. `sample.aaa` を保存する。
2. WasabiPadで `aaa` の外部プレビューアダプタを登録する。
3. 保存済みの `sample.aaa` を選択し、プレビューを開始する。

`render-preview.cjs` は実行のたびに同じフォルダの `template.html` を読み込み、ファイル名と本文を埋め込んで指定された出力先へHTMLを書き出します。入力本文のHTMLタグやスクリプト風文字列はHTMLテキストとしてエスケープされ、実行されません。

動作確認は `node --test examples/external-preview-aaa/render-preview-check.cjs` で実行できます。

注意: WasabiPadの外部プレビューは、保存済みの通常ファイルでプレビューを開始した時に実行されます。未保存の内容、フォルダ、アーカイブ内の仮想ファイルはこのサンプルの対象外です。
