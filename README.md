# 案件管理ダッシュボード

このフォルダがダッシュボードの正本です。公開用ファイルは常に `index.html` で、修正のたびに `dashboard_v60.html` のような複製を作る必要はありません。公開履歴は個人情報を含まない新規リポジトリ `ichilolule/illustration-dashboard` から始めています。移行前の履歴は非公開の旧リポジトリに保管しています。

## 普段の流れ

1. ChatGPTデスクトップでこのフォルダのプロジェクトを開く。
2. 修正内容を伝え、実装・表示確認・テストまで依頼する。
3. HTMLプレビューと変更差分を確認する。
4. 問題がなければ「GitHubへ公開して」と伝える。

Codexが `index.html` と必要な関連ファイルを直接更新し、公開依頼時にコミットとpushを行います。

## 確認コマンド

Googleカレンダー連携のロジックテスト：

```sh
node --test tests/case-state-core.test.cjs tests/calendar-sync.test.cjs
```

PlaywrightとChromiumが利用できる場合の画面テスト：

```sh
node tests/calendar-ui-smoke.cjs
```

Google連携の初回設定と実機確認は `CALENDAR_SYNC.md` を参照してください。

Chromeでは、設定タブで次の2つの保存先を別々に選べます。

- 「バックアップ」：ダッシュボード復元用の `dashboard_sync.json`
- 「バックアップ（個人情報なし）」：AIが読む案件専用ファイル `dashboard_cases.json`

以後は案件変更時に両方へ独立して自動上書きします。`dashboard_sync.json` は案件・設定・休日・Google連携設定を含みます。発行者プロフィール、旧版の請求書番号と採番カウンターも、移行と旧版への復帰に備えてバックアップへ保持します。ダッシュボードでは新規採番を行わず、新しい請求書番号はローカルの `../correspondence/` で管理します。

`dashboard_cases.json` には案件・連絡先・内部メモ・料金を含みますが、発行者プロフィール、住所、口座情報、料金設定、Google認証情報は含みません。AIへ案件の確認を依頼するときは、接続済みのGoogle Driveにあるこの固定名のファイルを参照させてください。

### `dashboard_cases.json` の状態の読み方

`schemaVersion: 2` では、案件の総合状態を `overallStatus` に出力します。AIはまずこの値を使います。

- `in_progress`：制作中
- `awaiting_client`：依頼者の確認・返信待ち
- `delivered_awaiting_payment`：納品済み・入金待ち。制作作業や確認待ちは完了
- `completed`：納品済み・入金済み
- `archived_other`：未完了または未入金のまま手動アーカイブされた案件

`workStatus` は工程1〜4の `progress` / `wait` だけを表し、工程5では `null` です。支払いは `paymentMethod`、`paymentTerms` (`prepaid` / `postpaid` / `unknown`)、`paymentStatus` (`unpaid` / `paid`)、`paidDate` に分離しています。`unknown` は旧データから前払い・後払いを安全に復元できないことを表し、前払いとは推定しません。

`cases` は現行一覧、`archive` はアーカイブです。`dashboard_cases.json` はAI参照用の投影データであり、ダッシュボードへの復元元ではありません。保存先で直接書き換えると外部更新として検知され、自動保存が停止します。

別端末などによる外部更新を検知した保存先だけ自動保存を停止します。完全バックアップは画面の案内に従って保存先のJSONを読み込むか保存先を再設定し、AI参照用ファイルは保存先を再設定してください。

## 認証

GitHubへの初回pushでmacOSのキーチェーンやブラウザ認証が表示された場合は、本人がログイン・許可します。Googleカレンダー連携でもGoogleのログイン・同意だけは本人操作が必要です。パスワード、二要素認証コード、クライアントシークレットをチャットやリポジトリへ貼らないでください。
