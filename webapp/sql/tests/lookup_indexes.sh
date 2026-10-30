#!/usr/bin/env bash
# Integration test: all writes and truncation are confined to our own container.
set -euo pipefail
sql_dir=$(cd "$(dirname "$0")/.." && pwd)
image=${MYSQL_IMAGE:-mysql:8.0.35}
temp_dir=$(mktemp -d)
container=''
cleanup() {
  if [ -n "$container" ]; then docker rm -fv "$container" >/dev/null 2>&1 || true; fi
  rm -rf "$temp_dir"
}
trap cleanup EXIT
container=$(docker run --detach --pull=never --network none \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes "$image" --skip-log-bin)
ready=0
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$container" mysqladmin ping --silent >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo 'Test MySQL did not become ready' >&2
  exit 1
fi
export LOOKUP_INDEX_TEST_CONTAINER=$container
cat > "$temp_dir/mysql" <<'WRAPPER'
#!/usr/bin/env bash
exec docker exec -i "$LOOKUP_INDEX_TEST_CONTAINER" mysql -uroot "$@"
WRAPPER
chmod +x "$temp_dir/mysql"
export MYSQL_BIN=$temp_dir/mysql
mysql=("$MYSQL_BIN" --batch --raw --skip-column-names)
run() { bash "$sql_dir/lookup_indexes.sh" "$@"; }
expect_failure() {
  if "$@" > "$temp_dir/failure.log" 2>&1; then
    echo 'Expected command to fail' >&2
    exit 1
  fi
}

"${mysql[@]}" -e 'CREATE DATABASE isupipe; CREATE DATABASE isudns;'
"${mysql[@]}" < "$sql_dir/initdb.d/10_schema.sql"
"${mysql[@]}" <<'SQL'
CREATE TABLE isudns.records (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  domain_id INT DEFAULT NULL,
  name VARCHAR(255) DEFAULT NULL,
  type VARCHAR(10) DEFAULT NULL,
  content VARCHAR(64000) DEFAULT NULL,
  ttl INT DEFAULT NULL,
  prio INT DEFAULT NULL,
  disabled TINYINT(1) DEFAULT 0,
  ordername VARCHAR(255) BINARY DEFAULT NULL,
  auth TINYINT(1) DEFAULT 1,
  KEY domain_id (domain_id), KEY ordername (ordername)
) ENGINE=InnoDB CHARACTER SET latin1;
USE isupipe;
SET SESSION cte_max_recursion_depth=10000;
CREATE TABLE fixture_numbers (n INT PRIMARY KEY);
INSERT INTO fixture_numbers
WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n+1 FROM seq WHERE n<10000)
SELECT n FROM seq;
INSERT INTO livestream_tags (id,livestream_id,tag_id)
SELECT n, 1+MOD(n,1000), 1+MOD(FLOOR(n/1000)*17,103) FROM fixture_numbers;
INSERT INTO icons (id,user_id,image)
SELECT n, 1+MOD(n,1000), REPEAT(CHAR(65+MOD(n,26)),256) FROM fixture_numbers;
INSERT INTO themes (id,user_id,dark_mode)
SELECT n, 1+MOD(n,1000), MOD(n,2) FROM fixture_numbers;
INSERT INTO reservation_slots (id,slot,start_at,end_at)
SELECT n, 100, 1700000000+n*3600, 1700003600+n*3600 FROM fixture_numbers;
INSERT INTO ng_words (id,user_id,livestream_id,word,created_at)
SELECT n, 1+MOD(n,50), 1+MOD(n,1000), CONCAT('word',n), 1700000000+n FROM fixture_numbers;
INSERT INTO isudns.records (id,domain_id,name,type,content,ttl)
SELECT n, 1, CONCAT('user',n,'.u.isucon.local'), 'A', '192.0.2.1', 0 FROM fixture_numbers;
SQL

# Fresh application schema already has five indexes; apply must add only DNS.
run apply
run check
run apply
run rollback
run rollback
expect_failure run check

checksums='CHECKSUM TABLE isupipe.livestream_tags,isudns.records,isupipe.icons,isupipe.reservation_slots,isupipe.themes,isupipe.ng_words;'
tag_query='SELECT id,tag_id FROM isupipe.livestream_tags WHERE livestream_id=43;'
words_query='SELECT id,word FROM isupipe.ng_words WHERE livestream_id=43 AND user_id=43 ORDER BY created_at DESC;'
before=$("${mysql[@]}" -e "$checksums")
tags_before=$("${mysql[@]}" -e "$tag_query")
words_before=$("${mysql[@]}" -e "$words_query")
run apply
run apply
run check
[ "$before" = "$("${mysql[@]}" -e "$checksums")" ]
[ "$tags_before" = "$("${mysql[@]}" -e "$tag_query")" ]
[ "$words_before" = "$("${mysql[@]}" -e "$words_query")" ]

# Refresh estimates after bulk fixture loading and repeated index DDL.
"${mysql[@]}" -e 'ANALYZE TABLE isupipe.livestream_tags,isudns.records,isupipe.icons,isupipe.reservation_slots,isupipe.themes,isupipe.ng_words;' > /dev/null

check_plan() {
  local index=$1 query=$2 plan
  plan=$("${mysql[@]}" -e "EXPLAIN FORMAT=TRADITIONAL $query")
  if [ "$(printf '%s\n' "$plan" | cut -f7)" != "$index" ]; then
    echo "Expected $index, got: $plan" >&2
    exit 1
  fi
  printf 'plan ok %s\n' "$index"
}
check_plan idx_livestream_tags_livestream_id 'SELECT * FROM isupipe.livestream_tags WHERE livestream_id=43'
check_plan idx_records_name_type "SELECT * FROM isudns.records WHERE disabled=0 AND name='user42.u.isucon.local' AND type='A'"
check_plan idx_icons_user_id 'SELECT image FROM isupipe.icons WHERE user_id=43'
check_plan idx_reservation_slots_start_end 'SELECT slot FROM isupipe.reservation_slots WHERE start_at=1700151200 AND end_at=1700154800'
check_plan idx_themes_user_id 'SELECT * FROM isupipe.themes WHERE user_id=43'
check_plan idx_ng_words_livestream_user_created 'SELECT * FROM isupipe.ng_words WHERE livestream_id=43 AND user_id=43 ORDER BY created_at DESC'

# The normal initialization and replacement of DNS records keep the indexes.
"${mysql[@]}" isupipe < "$sql_dir/init.sql"
"${mysql[@]}" -e "DELETE FROM isudns.records WHERE domain_id=1; INSERT INTO isudns.records(domain_id,name,type,content) VALUES(1,'pipe.u.isucon.local','A','192.0.2.1');"
run check

# A conflicting definition must fail before any of the other five indexes change.
run rollback
"${mysql[@]}" -e 'ALTER TABLE isudns.records ADD INDEX idx_records_name_type(type,name);'
expect_failure run apply
grep -q 'Unexpected definition' "$temp_dir/failure.log"
[ "$("${mysql[@]}" -e "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='isupipe' AND INDEX_NAME IN ('idx_livestream_tags_livestream_id','idx_icons_user_id','idx_reservation_slots_start_end','idx_themes_user_id','idx_ng_words_livestream_user_created');")" = 0 ]

"${mysql[@]}" -e 'DROP TABLE isudns.records;'
expect_failure run apply
grep -q 'Missing table' "$temp_dir/failure.log"
[ "$("${mysql[@]}" -e "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='isupipe' AND INDEX_NAME='idx_livestream_tags_livestream_id';")" = 0 ]

printf 'lookup indexes integration test passed (%s)\n' "$("${mysql[@]}" -e 'SELECT VERSION();')"
