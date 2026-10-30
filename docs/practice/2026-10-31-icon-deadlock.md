# ISUCON13: アイコン更新のデッドロック修正

## 対象と根拠

- Node.jsの `POST /api/icon`。基準はmainの `907e18b2a22df6a945ce24423f6c4aee6521a38b`、ブランチは `fix/icon-update-deadlock`。
- [pproteinのHTTP集計](http://localhost:9000/#/group/2026-10-30_14-53-16.894441/httplog/dmi9bdsyimos-httplog.log/)では、アイコン更新195件中1件が5xxだった。
- 同じベンチの2026-10-30 23:54:51 JSTに、InnoDBは `icons` のINSERT同士が `idx_icons_user_id` のロックとinsert intentionの待ちで競合し、片方をロールバックしたと記録していた。画像を含む生SQLは転載しない。

旧処理は、トランザクション内で `DELETE FROM icons WHERE user_id = ?` の後にINSERTする。非一意のuser_id索引では、既存のアイコンがなくても検索範囲にギャップロックを取る。異なるユーザーが同じ隙間でDELETEした後にINSERTすると、互いのロック解放待ちになり得る。[MySQL 8.0のロック仕様](https://dev.mysql.com/doc/refman/8.0/en/innodb-locks-set.html)を参照。

## 変更

更新処理を次の順序にする。

1. `SELECT id FROM users WHERE id = ? FOR UPDATE` で対象ユーザー行をロックする。
2. 通常のSELECTで、そのユーザーの既存アイコンIDを取得する。
3. 存在する各IDを `DELETE FROM icons WHERE id = ?` で削除する。
4. 新しいアイコンをINSERTし、従来どおり新しいidを201で返す。

主キーで既存行を削除することで、空のuser_id範囲に対するDELETEを避ける。同じ登録済みユーザーの更新はユーザー行で直列化する。ロック待ちの前に古いアイコンのスナップショットを作らないよう、ユーザーのロックを取得してからアイコンを読む。

user_id索引は保持する。DBスキーマ、分離レベル、依存パッケージは変更しない。既存の重複アイコンも全件置き換える。画像の取得、代替画像、プロフィールのハッシュ計算、失敗時のロールバックを維持する。

## 検証

`webapp/node` で実行:

```sh
npm test
npm run test:icons:mysql
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint src/handlers/user-handler.ts tests/icon-update.mysql.test.ts
./node_modules/.bin/prettier --check src/handlers/user-handler.ts tests/icon-update.mysql.test.ts package.json
```

MySQLテストは、ローカルにある `mysql:8.0.35` から専用コンテナを作り、127.0.0.1の一時ポートだけを公開する。外部DBの接続先は受け取らず、イメージも自動取得しない。初期スキーマとデータはこのコンテナ内だけに作り、終了時にそのコンテナとボリュームを削除する。

MySQL 8.0.35で7テストが通過した。

- 旧DELETEの後で2接続を待ち合わせ、異なるユーザーの初回登録でも `ER_LOCK_DEADLOCK` を再現した。InnoDBの最新デッドロックに `idx_icons_user_id` が含まれ、`information_schema.innodb_metrics` の `lock_deadlocks` が1増加した。
- 修正後の実際のハンドラでは、異なるユーザーのINSERTを待ち合わせて同時に進めても、初回登録・既存画像更新とも全件201、デッドロック増加0だった。
- 同じユーザーの8並列更新を、アイコンなし・ありの両方で確認。全件201、新しいIDは8件とも異なり、保存画像は1件で返却IDと対応した。デッドロック増加は0だった。
- 修正後のハンドラはテストで明示的にREPEATABLE READを使う。
- 更新ごとのID採番、画像バイト列、GETで取得する画像、プロフィールのSHA-256、代替画像を確認した。
- 既存重複行の置き換え、他ユーザー画像の保持、期限切れセッションの403を確認した。
- INSERT直後にエラーを注入して旧画像の復元を確認し、続く更新も201となった。

既存の7テスト、型チェック、変更箇所のlintも通過した。手元の検証では、前の作業用worktreeにインストール済みのnode_modulesをシンボリックリンクで参照した。依存定義とロックファイルは変更していない。

## 未確認

実環境への反映・再起動・ベンチは未実施。この修正は一般的な全デッドロックを防ぐ保証ではなく、確認したuser_id範囲DELETEの競合を対象にしている。

通常のアイコン1件の更新では、トランザクション操作を除くSQLが2本から4本へ増える。実機のHTTP応答時間、スコア、同時更新の失敗率は反映後に計測する。直前のベンチはPR #5反映状態で行われた。この作業ではs1を変更していない。
