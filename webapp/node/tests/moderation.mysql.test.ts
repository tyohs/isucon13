import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import {
  createConnection,
  createPool,
  Connection,
  Pool,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'
import { defaultSessionExpiresKey, defaultUserIDKey } from '../src/contants'
import { moderateHandler } from '../src/handlers/livecomment-handler'
import { HonoEnvironment } from '../src/types/application'
import { LivecommentsModel, NgWordsModel } from '../src/types/models'

// Always use our own disposable MySQL. No server/database URL is accepted.
let container = ''
let pool: Pool
const docker = (...dockerArguments: string[]) =>
  execFileSync('docker', dockerArguments, { encoding: 'utf8' }).trim()

before(async () => {
  container = docker(
    'run',
    '--detach',
    '--pull=never',
    '--publish',
    '127.0.0.1::3306',
    '--env',
    'MYSQL_ALLOW_EMPTY_PASSWORD=yes',
    process.env.MYSQL_IMAGE ?? 'mysql:8.0.35',
    '--skip-log-bin',
  )
  const port = docker('port', container, '3306/tcp').match(
    /^127\.0\.0\.1:(\d+)$/,
  )
  assert.ok(port, 'MySQL must be published only on loopback')
  const options = {
    host: '127.0.0.1',
    port: Number(port[1]),
    user: 'root',
    multipleStatements: true,
  }
  let connection: Connection
  for (let attempt = 0; ; attempt++) {
    try {
      connection = await createConnection(options)
      break
    } catch (error) {
      if (attempt >= 59) throw error
      await delay(500)
    }
  }
  try {
    await connection.query('CREATE DATABASE isupipe')
    await connection.query(
      await readFile(
        // eslint-disable-next-line unicorn/prefer-module -- This package uses CommonJS.
        join(__dirname, '../../sql/initdb.d/10_schema.sql'),
        'utf8',
      ),
    )
  } finally {
    await connection.end()
  }
  pool = createPool({ ...options, database: 'isupipe', connectionLimit: 1 })
  const [[version]] = await pool.query<RowDataPacket[]>('SELECT VERSION() AS v')
  assert.match(version.v as string, /^8\.0\./)
})

after(async () => {
  try {
    if (pool) await pool.end()
  } finally {
    if (container) docker('rm', '--force', '--volumes', container)
  }
})

const comments = [
  'spam',
  'SPAM',
  'spám',
  '安全なコメント',
  '古いNGを含む',
  'hello_world',
  'hello%world',
  'helloXworld',
  'slash\\tail',
  'quote\' and double"',
  "word') OR 1=1 --",
  '配信🐱です',
  '配信🐶です',
  'カタカナ',
  'かたかな',
  'ＡＢＣ',
  'abc ',
  'e\u0301',
  'null\0byte',
  '',
]

async function seed(texts = comments) {
  // Only tables inside the container created by this test are reset.
  await pool.query(`
    TRUNCATE ng_words; TRUNCATE livecomments;
    TRUNCATE livecomment_reports; TRUNCATE livestreams;
    INSERT INTO livestreams VALUES
      (101,7,'target','','','',0,1), (202,8,'other','','','',0,1);
    INSERT INTO ng_words (user_id,livestream_id,word,created_at) VALUES
      (7,101,'古いNG',1), (8,202,'安全',1);
    INSERT INTO livecomment_reports VALUES (1,8,101,1,1);
  `)
  if (texts.length > 0) {
    await pool.query(
      'INSERT INTO livecomments (id,user_id,livestream_id,comment,tip,created_at) VALUES ?',
      [
        [101, 202].flatMap((streamId, group) =>
          texts.map((comment, index) => [
            group * texts.length + index + 1,
            9,
            streamId,
            comment,
            index,
            1,
          ]),
        ),
      ],
    )
  }
}

async function snapshot() {
  const [livecomments] = await pool.query(
    'SELECT * FROM livecomments ORDER BY id',
  )
  const [ngwords] = await pool.query(
    'SELECT id,user_id,livestream_id,word FROM ng_words ORDER BY id',
  )
  const [reports] = await pool.query(
    'SELECT * FROM livecomment_reports ORDER BY id',
  )
  return { livecomments, ngwords, reports }
}

// Reference: the original moderation loop, including its literal LIKE comparison.
async function originalModerate(word: string) {
  const conn = await pool.getConnection()
  await conn.beginTransaction()
  try {
    const [{ insertId }] = await conn.query<ResultSetHeader>(
      'INSERT INTO ng_words(user_id,livestream_id,word,created_at) VALUES (7,101,?,1)',
      [word],
    )
    const [ngwords] = await conn.query<(NgWordsModel & RowDataPacket)[]>(
      'SELECT * FROM ng_words WHERE livestream_id = ?',
      [101],
    )
    for (const ngword of ngwords) {
      const [livecomments] = await conn.query<
        (LivecommentsModel & RowDataPacket)[]
      >('SELECT * FROM livecomments')
      for (const livecomment of livecomments) {
        await conn.query(
          `DELETE FROM livecomments
           WHERE id = ? AND livestream_id = ? AND
             (SELECT COUNT(*) FROM (SELECT ? AS text) AS texts
              INNER JOIN (SELECT CONCAT('%', ?, '%') AS pattern) AS patterns
              ON texts.text LIKE patterns.pattern) >= 1`,
          [livecomment.id, 101, livecomment.comment, ngword.word],
        )
      }
    }
    await conn.commit()
    return { word_id: insertId }
  } finally {
    await conn.rollback()
    conn.release()
  }
}

async function moderate(
  word: string,
  {
    userId = 7,
    streamId = '101',
    expired = false,
    failAfterDelete = false,
  } = {},
) {
  const queries: string[] = []
  let commits = 0
  let released = false
  const app = new Hono<HonoEnvironment>()
  app.use('*', async (c, next) => {
    c.set('session', {
      get: (key: string) => {
        if (key === defaultUserIDKey) return userId
        if (key === defaultSessionExpiresKey) {
          return expired ? 0 : Date.now() + 60_000
        }
      },
    } as HonoEnvironment['Variables']['session'])
    c.set('pool', {
      getConnection: async () => {
        const conn = await pool.getConnection()
        return {
          beginTransaction: () => conn.beginTransaction(),
          commit: async () => {
            await conn.commit()
            commits++
          },
          rollback: () => conn.rollback(),
          release: () => {
            released = true
            conn.release()
          },
          query: async (sql: string, values: unknown[]) => {
            queries.push(sql)
            const result = await conn.query(sql, values)
            if (failAfterDelete && sql.startsWith('DELETE FROM livecomments')) {
              throw new Error('injected failure after actual DELETE')
            }
            return result
          },
        }
      },
    } as unknown as Pool)
    await next()
  })
  app.post('/api/livestream/:livestream_id/moderate', ...moderateHandler)
  const response = await app.request(`/api/livestream/${streamId}/moderate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ng_word: word }),
  })
  return { response, queries, commits, released }
}

test('旧実装と同じコメントを削除し、他配信・既存NGワード・通報を保つ', async (t) => {
  const words = [
    'spam',
    '安全',
    '%',
    '_',
    'hello\\_world',
    '\\',
    '',
    '🐱',
    "'",
    "word') OR 1=1 --",
    'カタカナ',
    'ABC',
    'é',
  ]
  for (const collation of [
    'utf8mb4_unicode_ci',
    'utf8mb4_bin',
    'utf8mb4_0900_ai_ci',
  ]) {
    await t.test(collation, async () => {
      await pool.query(`SET NAMES utf8mb4 COLLATE ${collation}`)
      for (const word of words) {
        await seed()
        const expectedResponse = await originalModerate(word)
        const expected = await snapshot()
        await seed()
        const actual = await moderate(word)
        assert.equal(actual.response.status, 201, word)
        assert.deepEqual(await actual.response.json(), expectedResponse, word)
        assert.deepEqual(await snapshot(), expected, word)
        assert.equal(actual.commits, 1)
        assert.equal(actual.released, true)
      }
    })
  }
})

test('コメント0件でもNGワードを登録して201を返す', async () => {
  await seed([])
  const result = await moderate('spam')
  assert.equal(result.response.status, 201)
  assert.deepEqual(await result.response.json(), { word_id: 3 })
  const [[row]] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM ng_words WHERE livestream_id=101 AND word='spam'",
  )
  assert.equal(row.n, 1)
})

test('所有者以外・存在しない配信・不正ID・期限切れではDBを変更しない', async () => {
  await seed()
  const before = await snapshot()
  for (const [options, status] of [
    [{ userId: 8 }, 400],
    [{ streamId: '999' }, 400],
    [{ streamId: 'invalid' }, 400],
    [{ expired: true }, 403],
  ] as const) {
    const result = await moderate('spam', options)
    assert.equal(result.response.status, status)
    assert.equal(result.commits, 0)
    assert.deepEqual(await snapshot(), before)
  }
})

test('DELETE後に失敗してもコメント削除とNGワード追加を一緒にロールバックする', async () => {
  await seed()
  const before = await snapshot()
  const result = await moderate('spam', { failAfterDelete: true })
  assert.equal(result.response.status, 500)
  assert.equal(result.commits, 0)
  assert.equal(result.released, true)
  assert.deepEqual(await snapshot(), before)
})

async function deleteCount() {
  const [[row]] = await pool.query<RowDataPacket[]>(
    "SHOW SESSION STATUS LIKE 'Com_delete'",
  )
  return Number(row.Value)
}

test('1,000コメントでも削除結果を維持し、DELETE実行回数をNGワード数まで減らす', async (t) => {
  const texts = Array.from({ length: 500 }, (_, index) =>
    index % 2 === 0 ? '古いNG' : 'spam',
  )
  await seed(texts)
  const beforeOld = await deleteCount()
  await originalModerate('spam')
  const oldDeletes = (await deleteCount()) - beforeOld
  const expected = await snapshot()
  await seed(texts)
  const beforeNew = await deleteCount()
  const result = await moderate('spam')
  const newDeletes = (await deleteCount()) - beforeNew
  assert.equal(result.response.status, 201)
  assert.deepEqual(await snapshot(), expected)
  assert.equal(oldDeletes, 1750)
  assert.equal(newDeletes, 2)
  t.diagnostic(`MySQL Com_delete: ${oldDeletes} -> ${newDeletes}`)
})
