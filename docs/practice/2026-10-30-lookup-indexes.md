# ISUCON13: 検索用インデックス6本

## 対象と変更

ISUPipeとPowerDNSの既存DBに、検索条件に対応する非一意のBTREE索引を追加する。

| DB / テーブル | 索引名 | 列順 |
| --- | --- | --- |
| isupipe.livestream_tags | idx_livestream_tags_livestream_id | livestream_id |
| isudns.records | idx_records_name_type | name, type |
| isupipe.icons | idx_icons_user_id | user_id |
| isupipe.reservation_slots | idx_reservation_slots_start_end | start_at, end_at |
| isupipe.themes | idx_themes_user_id | user_id |
| isupipe.ng_words | idx_ng_words_livestream_user_created | livestream_id, user_id, created_at |

`livestream_tags` は単列を選ぶ。単件の応答組み立てには `ORDER BY` のない取得が残っており、`(livestream_id, tag_id)` だとタグID順に変わる可能性があるため。InnoDBの二次索引に主キーidが含まれる構造を使い、従来の取得順への影響を抑える。

アプリ用の5本は `webapp/sql/initdb.d/10_schema.sql` にも定義する。既存DBと、初期スキーマをこのリポジトリで管理していないPowerDNSのDBには、`webapp/sql/lookup_indexes.sh` を使う。

## pproteinをブラウザで確認した根拠

`task pprotein` で接続するブラウザ画面を参照し、SQL表の `Sum(QueryTime)` を降順に並べて確認した。

- [計測グループ](http://localhost:9000/#/group/): `2026-10-30_07-50-30.176097`。表示時刻はUTCで、日本時間16:50:30開始。メモにスコア3784。
- [slowlog:s1](http://localhost:9000/#/group/2026-10-30_07-50-30.176097/slowlog/dmi0bohte1lj-slowlog.log/): ID `dmi0bohte1lj-slowlog.log`。
- [httplog:s1](http://localhost:9000/#/group/2026-10-30_07-50-30.176097/httplog/dmi0bohtm5cv-httplog.log/): ID `dmi0bohtm5cv-httplog.log`。
- [setting](http://localhost:9000/#/setting/): s1の各計測のDurationは120秒。slowlogはSELECT / INSERT / UPDATE / REPLACEを対象にするフィルターが設定されている。

この収集は初期化・整合性確認・負荷走行を含む120秒単位。負荷走行本体の16:51:13〜16:52:13だけを抽出した集計とは範囲が異なる。下表はブラウザ画面の値であり、累積秒数をベンチ全体の経過時間や改善見込み秒数にはしない。

| SQLの対象 | Count | Sum(QueryTime) | Sum(RowsExamined) |
| --- | ---: | ---: | ---: |
| livestream_tags: livestream_id指定 | 5,787 | 104.623129秒 | 64,544,695 |
| records: name + domain_id指定 | 6,888 | 49.591403秒 | 9,424,163 |
| records: name + type指定 | 5,024 | 29.311837秒 | 6,872,569 |
| icons: user_id指定 | 10,369 | 29.181323秒 | 792,594 |
| reservation_slots: start_at + end_at一致 | 769 | 15.065255秒 | 6,735,671 |
| themes: user_id指定 | 8,624 | 10.114014秒 | 9,325,249 |
| ng_words: user_id + livestream_id指定 | 216 | 7.887379秒 | 3,098,471 |

同じhttplog画面で、配信検索は44件・平均3.018秒・P95 6.821秒・4xx 2件だった。

この収集のs1のソースは `247d465602baa3a75c2dcad7eb652c20e4a73e42`（ユーザー統計改善を含む）。このPRのベース `4591218` は配信検索の一括取得を含み、同じ版ではない。上記は候補選定の根拠で、索引追加前後の性能比較ではない。

現在のs1（MySQL 8.0.35）では6本とも未追加で、対応する代表SQLはEXPLAINで `type=ALL` だった。予約枠の範囲条件は、複合索引の後続列まで等価検索と同じように絞れるとは限らないため、適用後の実行計画を別途確認する。

## 既存DBへの適用と復元

MySQL 8.0以降向け。現在の構成では、isupipe / isudnsを持つ同じMySQLに管理権限で接続する。既存のdeploy処理はSQLの索引変更を実行しないため、反映時はDB担当者がタイミングを合わせて明示的に適用する。

DBホスト上で実行する例:

```sh
sudo bash webapp/sql/lookup_indexes.sh check
sudo bash webapp/sql/lookup_indexes.sh apply
sudo bash webapp/sql/lookup_indexes.sh check
```

`check` は未追加なら `missing` を表示して終了コード1を返す。引数省略時もcheck。mysqlの接続オプションは操作名の後に渡せる。認証情報はコマンドや記録に直書きしない。

applyは追加済みの同じ定義をスキップする。全対象のテーブルと索引定義を先に確認し、同名で列順・一意性・索引種別・可視性が異なる場合は変更前に停止する。6本のDDLは一括トランザクションにはならない。途中のDDLで失敗した場合はcheckで状態を確認してから再実行する。

戻す場合:

```sh
sudo bash webapp/sql/lookup_indexes.sh rollback
```

この6つの名前と定義に一致する索引を削除する。対象が既にない場合はスキップする。通常の `webapp/sql/init.sql` はTRUNCATEでデータを初期化するため、追加した索引は保持される。

## 検証手順

専用Dockerコンテナ内で、初期スキーマ・既存DB両方の適用、再実行、復元、データのチェックサム、タグの取得順、NGワードの日時順、6種類の実行計画、初期化後の索引保持、同名の異なる定義・欠落テーブルでの事前停止を確認する。

```sh
bash -n webapp/sql/lookup_indexes.sh webapp/sql/tests/lookup_indexes.sh
MYSQL_IMAGE=mysql:8.0.35 bash webapp/sql/tests/lookup_indexes.sh
```

テストは既存のローカルイメージからネットワーク・公開ポートのないコンテナを作り、終了時にそのコンテナと一時データだけを削除する。イメージの自動ダウンロードはしない。

2026-10-30、専用のMySQL 8.0.35コンテナで上記テストが通過した。6本とも代表SQLで利用され、適用前後のデータのチェックサムと取得結果が一致した。アプリ初期化は実際の `init.sql` を実行し、DNS側はrecordsの削除・再投入で保持を確認した。PowerDNSの `pdnsutil` 自体はこの隔離テストでは実行していない。

共有サーバーへの適用・再起動・ベンチマークはこのPR作成では行わない。実機での性能、索引維持に伴う更新コスト、42秒以内の初期化は追加計測が必要。反映後は同じソース・計測設定でベンチを実行し、同じ120秒のpprotein収集を使ってCount / Sum(QueryTime) / RowsExamined、HTTPの平均・P95・失敗、スコアを比較する。
