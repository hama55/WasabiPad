# 外部プレビューの表示設定保存

opaque originの外部HTMLはlocalStorageを使えないため、表示設定の真偽値だけを本体のSettingsへ保存する。音楽プレビューの「コード位置の鍵盤図」のON/OFFを形式横断で復元するために追加した共通経路。

- `externalPreviewPreferences`に名前空間付きkeyとbooleanを保存する。音楽プレビューのkeyは`wasabipad.music-preview.chord-keyboard-diagrams`。adapterをまたいで共有する。
- `wasabipad-external-preference-ready`で現行表示の準備完了を通知する。中継が準備状態を保持し、遅い子の初期化にも応答する。
- `wasabipad-external-preference-request`: 非負のsafe integer `request_id`、`key`、任意のboolean `value`。valueなしはGET、ありはSET。
- keyは小文字英数字・`.`・`-`の1〜128文字。任意のSettingsキーや設定一覧へのアクセスは与えない。
- `wasabipad-external-preference-result`: `request_id`、`key`、booleanまたは未設定のnull `value`、失敗理由またはnull `reason`。
- 中継は外部iframeのcontentWindowを検証し、子が渡すrender_idを採用せず、表示側のrender IDを付ける。本体はviewerのsource/origin、確定済み表示世代、外部出力、置換中・終了中でないことを検証する。
- 本体のSettings APIとflushSettingsを使用し、永続化成功後だけ成功を返す。古い表示への遅延応答は破棄する。sandboxのallow-same-originは追加しない。

BDDはsettings.test.ts（保存・再読込・不正データ除去）、viewer-external-output.test.ts（opaque境界・handshake・要求/応答の型）、inline-preview.test.ts（表示世代・保存完了・失敗）で検証する。外部音楽プレビューの描画・音声生成は別プロジェクトのままとする。
