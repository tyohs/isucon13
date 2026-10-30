#!/usr/bin/env bash
# Existing MySQL databases: check/apply/rollback only these six non-unique indexes.
# Extra arguments are passed to mysql. No application env file is sourced.
set -euo pipefail

mode=${1:-check}
if [ "$#" -gt 0 ]; then shift; fi
case "$mode" in
  check|apply|rollback) ;;
  -h|--help)
    echo "Usage: bash $0 [check|apply|rollback] [mysql options...]"
    exit 0
    ;;
  *)
    echo "Unknown operation: $mode (expected check, apply, or rollback)" >&2
    exit 2
    ;;
esac

mysql_cmd=("${MYSQL_BIN:-mysql}" --batch --raw --skip-column-names "$@")
indexes=(
  'isupipe|livestream_tags|idx_livestream_tags_livestream_id|livestream_id'
  'isudns|records|idx_records_name_type|name,type'
  'isupipe|icons|idx_icons_user_id|user_id'
  'isupipe|reservation_slots|idx_reservation_slots_start_end|start_at,end_at'
  'isupipe|themes|idx_themes_user_id|user_id'
  'isupipe|ng_words|idx_ng_words_livestream_user_created|livestream_id,user_id,created_at'
)
present=()

# Validate every target before changing any table. In particular, an existing
# index with our name but a different definition must not be skipped or dropped.
for spec in "${indexes[@]}"; do
  IFS='|' read -r db table index columns <<< "$spec"
  actual=$("${mysql_cmd[@]}" -e "
    SELECT IF(
      EXISTS(SELECT 1 FROM information_schema.TABLES
        WHERE TABLE_SCHEMA='$db' AND TABLE_NAME='$table'),
      COALESCE((SELECT CONCAT(NON_UNIQUE, ':', INDEX_TYPE, ':', IS_VISIBLE, ':',
        GROUP_CONCAT(CONCAT(COLUMN_NAME,
          IF(SUB_PART IS NULL, '', CONCAT('(', SUB_PART, ')')))
          ORDER BY SEQ_IN_INDEX SEPARATOR ','))
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA='$db' AND TABLE_NAME='$table' AND INDEX_NAME='$index'
        GROUP BY NON_UNIQUE, INDEX_TYPE, IS_VISIBLE), ''),
      '!missing-table');")
  case "$actual" in
    '') present+=(0) ;;
    "1:BTREE:YES:$columns") present+=(1) ;;
    '!missing-table')
      echo "Missing table: $db.$table; no indexes changed" >&2
      exit 1
      ;;
    *)
      echo "Unexpected definition: $db.$table.$index ($actual); no indexes changed" >&2
      exit 1
      ;;
  esac
done

missing=0
for ((i=0; i<${#indexes[@]}; i++)); do
  IFS='|' read -r db table index columns <<< "${indexes[$i]}"
  case "$mode:${present[$i]}" in
    check:1|apply:1)
      echo "ok $db.$table.$index"
      ;;
    check:0)
      echo "missing $db.$table.$index"
      missing=1
      ;;
    apply:0)
      "${mysql_cmd[@]}" -e "ALTER TABLE \`$db\`.\`$table\` ADD INDEX \`$index\` ($columns);"
      echo "added $db.$table.$index"
      ;;
    rollback:1)
      "${mysql_cmd[@]}" -e "ALTER TABLE \`$db\`.\`$table\` DROP INDEX \`$index\`;"
      echo "dropped $db.$table.$index"
      ;;
    rollback:0)
      echo "absent $db.$table.$index"
      ;;
  esac
done
exit "$missing"
