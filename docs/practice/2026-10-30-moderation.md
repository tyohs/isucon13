# ISUCON13: モデレーションのコメント削除を一括化

## 対象と根拠

- 対象: Node.jsの `POST /api/livestream/:livestream_id/moderate`。
- 基準: `907e18b`（main、検索一括取得と索引6本のPRを含む）。作業ブランチは `perf/moderation-bulk-delete`。
- 根拠: [pproteinのHTTP集計](http://localhost:9000/#/group/2026-10-30_10-42-08.356636/httplog/dmi3z3ew6reu-httplog.log/)と[SQL集計](http://localhost:9000/#/group/2026-10-30_10-42-08.356636/slowlog/dmi3z3ew6toi-slowlog.log/)をブラウザで参照した。
- この計測のs1はNode.js `247d465602baa3a75c2dcad7eb652c20e4a73e42` に索引6本を追加した状態。PRのベースとは異なる。初期化・事前テストを含む120秒収集で、負荷走行本体は60秒。

モデレーションは15件（2xx 14件、4xx 1件）、平均5.677秒、P95 7.148秒、HTTP累積85.160秒だった。累積は並行するリクエストの所要時間の合計で、ベンチ全体の経過時間ではない。

旧コードは、対象配信のNGワードごとに `SELECT * FROM livecomments` で全配信のコメントを取得し、コメント1件ずつDELETEを送る。SQL集計では全コメント取得が15回、合計16,731行返却されていた。DELETEはslowlog収集の対象外であり、このログから実行回数は確定できない。

## 変更

NGワード一覧の取得後、NGワードごとに次のDELETEを1回送る。全コメントの取得と、コメントごとのDELETEを削除した。

```sql
DELETE FROM livecomments
WHERE livestream_id = ?
  AND CAST(comment AS CHAR) LIKE CONCAT('%', ?, '%')
```

`livecomments.comment` の照合順序は `utf8mb4_bin` だが、旧実装は接続の照合順序で文字列リテラル同士を比較する。単純な `comment LIKE ...` では大小文字やアクセントの判定が変わるため、`CAST(comment AS CHAR)` を使って接続の照合順序を維持する。[MySQL 8.0のCASTの仕様](https://dev.mysql.com/doc/refman/8.0/en/cast-functions.html)を参照。

既存NGワードも処理し、`%`・`_`・バックスラッシュを含む語は従来のLIKEの意味を保つ。所有者の確認、NGワード登録、返すword_id、コミットとロールバックは従来の処理を使う。DBスキーマと依存パッケージは変更しない。

## 検証

`webapp/node` で実行:

```sh
npm test
npm run test:moderation:mysql
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint src/handlers/livecomment-handler.ts tests/moderation.mysql.test.ts
```

MySQLテストは、ローカルにある `mysql:8.0.35` イメージから専用コンテナを作り、127.0.0.1の一時ポートだけを公開する。イメージを自動取得せず、外部DBの接続先も受け取らない。初期スキーマとテストデータはそのコンテナにだけ作り、終了時に作成したコンテナとボリュームを削除する。`MYSQL_IMAGE` で別の既存MySQL 8.0イメージを指定できる。

- 既存の7テストと、MySQL 8.0.35の8テスト（サブテストを含む）が通過。
- 13種類のNGワード × 3種類の接続照合順序（`utf8mb4_unicode_ci` / `utf8mb4_bin` / `utf8mb4_0900_ai_ci`）で、旧実装と実際のハンドラの削除結果・応答が一致した。
- 大小文字、アクセント、日本語、絵文字、結合文字、空文字、LIKEの特殊文字、引用符、SQLのような文字列、他配信、既存NGワード、通報行の保持を確認した。
- コメント0件の201、所有者以外・存在しない配信・不正ID・期限切れの拒否を確認した。
- 実際にDELETEした直後にエラーを注入し、コメント削除とNGワード登録が一緒にロールバックされることを確認した。
- 1,000コメント（対象500件・他配信500件）と対象配信のNGワード2件では、MySQLセッションの `Com_delete` 実測値が1,750回から2回に減り、削除後のデータは一致した。この回数はAPI全体のSQL回数ではない。

既存のロックファイルにはesbuildの一部プラットフォーム定義が不足し、手元のnpmで `npm ci` が失敗した。検証用依存は既存の手順と同じ `npm install --ignore-scripts --package-lock=false --no-audit --no-fund` で用意した。ロックファイルや依存バージョンは変更していない。

## 未確認と次の計測

共有環境への反映・再起動・ベンチは未実施。SQLの往復削減を確認した段階で、HTTP応答時間とスコアの改善は未確認。

DELETEは一致する行を現在読み取りで探すため、旧実装の全件SELECTのスナップショットと並行投稿時の削除対象が完全に同じとは限らない。削除文単位のロック範囲も変わる。`livecomments(livestream_id)` の索引は今回追加しておらず、DELETEは走査を伴い得る。同時投稿や複数のモデレーションとの競合は、実環境に反映する前後の追加検証が必要。

反映時は同じアプリの版・DB索引・ベンチ元・pprotein設定で比較し、モデレーションの平均/P95/失敗、コメント投稿の応答と失敗、デッドロック、pass/scoreを確認する。既知のicons索引のデッドロックは別の問題として扱う。
