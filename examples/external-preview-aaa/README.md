# 外部プレビューアダプタ AAA サンプル

`aaa` ファイルを Windows 標準の Windows PowerShell でHTMLへ変換する、WasabiPad外部プレビューアダプタの最小サンプルです。Node.jsやnpmは不要です。

## インストールと登録

1. このフォルダを移動しない場所へ置きます。`render-preview.ps1` と `template.html` は同じフォルダに置いてください。
2. WasabiPadの「設定」→「外部プレビュー」→「外部プレビューを追加」を選び、次のように登録します。

   - 対象拡張子: `aaa`
   - 実行コマンド:

     ```text
     powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Path\To\external-preview-aaa\render-preview.ps1" "{file}" "{output}"
     ```

     `C:\Path\To\external-preview-aaa` は、実際に置いたフォルダの絶対パスに置き換えます。

   - 生成形式: `HTML`
3. 保存後、拡張子 `aaa` にこのアダプターを選びます。標準プレビューも候補になる環境では、優先順位を「外部プレビューを優先」にします。
4. 初回実行の確認で許可します。

## 使い方

保存済みの `sample.aaa` を選択し、通常のプレビューを開きます。`{file}` は入力ファイル、`{output}` はWasabiPadが用意する出力先に置き換わります。

`render-preview.ps1` は実行のたびに同じフォルダの `template.html` を読み込み、ファイル名と本文を埋め込んで指定された出力先へHTMLを書き出します。入力本文のHTMLタグやスクリプト風文字列はHTMLテキストとしてエスケープされ、実行されません。

実行コマンドの `-ExecutionPolicy Bypass` はこの起動プロセスだけに適用され、Windowsの実行ポリシー設定は変更しません。動作確認は次のコマンドで実行できます。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Path\To\external-preview-aaa\render-preview-check.ps1"
```

注意: WasabiPadの外部プレビューは、保存済みの通常ファイルでプレビューを開始した時に実行されます。未保存の内容、フォルダ、アーカイブ内の仮想ファイルはこのサンプルの対象外です。
