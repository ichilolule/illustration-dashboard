# Dashboard project instructions

## 正本

- 公開用HTMLの正本は `index.html`。同じ内容の版番号付きHTMLを作らない。
- 表示上のバージョン文字列を更新する必要があっても、ファイル名は `index.html` のまま保つ。
- `../archive/dashboard/` は参照・復元専用。新しい作業ファイルを置かない。

## 変更手順

- 作業開始時に `git status` と既存差分を確認する。ユーザーの未コミット変更を破棄しない。
- 大きな変更や並行案はブランチまたはCodex Worktreeで行う。
- 原因調査と修正を分け、原因が説明できる最小差分を作る。
- `localStorage` の案件データ、アーカイブ、設定を消去するコードを安易に追加しない。
- Google OAuthのクライアントシークレット、アクセストークン、認証コードをHTML・JavaScript・Gitへ入れない。

## 確認

- カレンダー連携ロジックを変更したら `node --test tests/calendar-sync.test.cjs` を実行する。
- UIまたは連携画面を変更したら、利用可能な場合は `node tests/calendar-ui-smoke.cjs` とHTMLプレビューでデスクトップ・モバイル表示を確認する。
- JavaScript変更後はブラウザの実行時エラー、既存データとの互換性、サービスワーカーのキャッシュ影響を確認する。
- 最終差分に調査用コード、不要なログ、無関係な整形変更を残さない。

## GitHub公開

- 現在の `main` と `origin` は履歴を分離した公開リポジトリ `ichilolule/illustration-dashboard`。`legacy` リモートと `legacy-main`、`migrate-clean-public` ブランチには旧履歴が残る。旧ブランチやタグを `origin` へpushせず、公開用 `main` にマージしない。
- ユーザーから「公開までやって」などGitHub公開を明示的に依頼されていない場合は、実装と確認が完了した時点で停止し、ユーザーがGitHubへ直接アップロードすべき変更ファイルを箇条書きで列挙する。コミットやpushは行わない。
- 通常の公開先は `main`。ユーザーが公開を依頼したら、テスト、差分レビュー、コミット、`origin/main` へのpushまで行う。
- 強制pushをしない。認証が必要ならユーザー本人のログイン操作だけを案内する。
