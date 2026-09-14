# GFMをMarkdown互換基準にする

WasabiPadのMarkdown表示は、特定サービスの表示ではなくGitHub Flavored Markdown（GFM）を互換基準として扱い、解析基盤にはmarkdown-it v15を使う。段落内の通常改行（softbreak）を`<br>`として表示するかどうかだけは、入力のしやすさと既存文書の表示を選べるアプリ設定にする。空行はMarkdown標準の段落区切りに任せ、独自の空行要素で入力行数を再現しない。安全のためのHTML制限とWasabiPad内部のソース位置連携は互換基準とは別の固定仕様として維持する。

## Considered Options

- WebView2だけでMarkdownを解釈する: WebView2はHTML/CSS/JavaScriptの表示基盤でありMarkdown解析を行わないため採用しない。
- markdown-itをGitHub専用プリセットとして扱う: markdown-itにはGFMという公式プリセットがなく、現在の拡張と安全処理を明示的に管理する方が差分を説明しやすいため採用しない。
- 空行を入力行数どおり独自要素へ変換する: 他のMarkdown環境と段落構造が異なり、外部アプリで開いたときの差を増やすため採用しない。

## Consequences

通常改行の表示は設定画面のプレビュー項目から即時切り替えでき、設定値はJSONへ保存される。既定値は`breaks: true`とし、段落内の改行入力をそのまま表示できる。`breaks: false`ではmarkdown-itの標準softbreakとなる。Markdownの表、取り消し線、リンク自動認識などはmarkdown-itの既存設定を維持し、GFM以外のサービス固有拡張は追加しない。
