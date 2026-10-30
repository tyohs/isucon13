// ISUCON_STATS_TEST_MYSQL=1 ./node_modules/.bin/tsx --test test/user-statistics.test.cjs
// Uses connection-local temporary tables; does not modify application tables.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const mysql = require('mysql2/promise')
const handler = require('../src/handlers/stats-handler.ts')
  .getUserStatisticsHandler[1]

test(
  'user statistics aggregates streams and preserves ranking and emoji tie breaks',
  {
    skip: process.env.ISUCON_STATS_TEST_MYSQL !== '1',
  },
  async () => {
    const conn = await mysql.createConnection({
      host: process.env.ISUCON_DB_HOST || '127.0.0.1',
      port: Number(process.env.ISUCON_DB_PORT || 3306),
      user: process.env.ISUCON_DB_USER || 'isucon',
      password: process.env.ISUCON_DB_PASSWORD || 'isucon',
      database: process.env.ISUCON_DB_NAME || 'isupipe',
    })
    let queries = 0
    const wrapper = {
      query: (...args) => {
        queries++
        return conn.query(...args)
      },
      beginTransaction: () => conn.beginTransaction(),
      commit: () => conn.commit(),
      rollback: () => conn.rollback(),
      release: () => {},
    }
    const pool = { getConnection: async () => wrapper }
    async function run(_handler, username) {
      queries = 0
      const result = await handler({
        req: { param: () => username },
        get: () => pool,
        json: (body, status = 200) => ({ body, status }),
        text: (body, status = 200) => ({ body, status }),
      })
      return { result }
    }
    async function check(name) {
      const { result } = await run(handler, name)
      if (name === 'missing') {
        assert.equal(result.status, 404)
        return
      }
      assert.equal(result.status, 200)
      assert.equal(queries, 6)
      const expected = {
        alice: [2, 3, 4, 3, 5, 'z'],
        bob: [1, 0, 1, 1, 8, 'x'],
        zero: [3, 0, 0, 0, 0, undefined],
        empty: [4, 0, 0, 0, 0, undefined],
        Alice: [5, 0, 0, 0, 0, undefined],
      }[name]
      assert.deepEqual(Object.values(result.body), expected, name)
    }
    try {
      // Temporary tables shadow production tables only on this connection.
      await conn.query(
        'CREATE TEMPORARY TABLE users (id BIGINT PRIMARY KEY, name VARCHAR(255) COLLATE utf8mb4_bin)',
      )
      await conn.query(
        'CREATE TEMPORARY TABLE livestreams (id BIGINT PRIMARY KEY,user_id BIGINT)',
      )
      await conn.query(
        'CREATE TEMPORARY TABLE reactions (id BIGINT PRIMARY KEY,livestream_id BIGINT,emoji_name VARCHAR(255) COLLATE utf8mb4_bin)',
      )
      await conn.query(
        'CREATE TEMPORARY TABLE livecomments (id BIGINT PRIMARY KEY,livestream_id BIGINT,tip BIGINT)',
      )
      await conn.query(
        'CREATE TEMPORARY TABLE livestream_viewers_history (id BIGINT PRIMARY KEY,livestream_id BIGINT)',
      )
      await conn.query(
        "INSERT INTO users VALUES (1,'alice'),(2,'bob'),(3,'zero'),(4,'empty'),(5,'Alice')",
      )
      await conn.query('INSERT INTO livestreams VALUES (1,1),(2,1),(3,2),(4,4)')
      await conn.query(
        "INSERT INTO reactions VALUES (1,1,'a'),(2,1,'z'),(3,2,'a'),(4,2,'z'),(5,3,'x')",
      )
      await conn.query(
        'INSERT INTO livecomments VALUES (1,1,2),(2,1,3),(3,2,0),(4,3,8)',
      )
      await conn.query(
        'INSERT INTO livestream_viewers_history VALUES (1,1),(2,2),(3,2)',
      )
      for (const name of ['alice', 'bob', 'zero', 'empty', 'Alice', 'missing'])
        await check(name)
      const { result } = await run(handler, 'alice')
      assert.deepEqual(result.body, {
        rank: 2,
        viewers_count: 3,
        total_reactions: 4,
        total_livecomments: 3,
        total_tip: 5,
        favorite_emoji: 'z',
      })
    } finally {
      await conn.end()
    }
  },
)
