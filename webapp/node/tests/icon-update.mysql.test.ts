import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  RowDataPacket,
} from 'mysql2/promise'
import { defaultSessionExpiresKey, defaultUserIDKey } from '../src/contants'
import {
  getIconHandler,
  getMeHandler,
  postIconHandler,
} from '../src/handlers/user-handler'
import { ApplicationRuntime, HonoEnvironment } from '../src/types/application'

// Own a disposable container; never accept an existing server/database URL.
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
    const [[version]] = await connection.query<RowDataPacket[]>(
      'SELECT VERSION() AS v',
    )
    assert.match(version.v as string, /^8\.0\./)
  } finally {
    await connection.end()
  }
  pool = createPool({ ...options, database: 'isupipe', connectionLimit: 8 })
})

after(async () => {
  try {
    if (pool) await pool.end()
  } finally {
    if (container) docker('rm', '--force', '--volumes', container)
  }
})

const fallback = Buffer.from('fallback image')
const image = (value: number) => Buffer.from([0, 255, 128, value, 0, 42])
interface StoredIcon extends RowDataPacket {
  id: number
  user_id: number
  image: Buffer
}

async function seed(existing = false) {
  await pool.query(`
    TRUNCATE icons; TRUNCATE themes; TRUNCATE users;
    INSERT INTO users VALUES
      (10,'user10','','',''), (20,'user20','','',''), (100,'user100','','','');
    INSERT INTO themes (user_id,dark_mode) VALUES (10,0),(20,0),(100,0);
    INSERT INTO icons (user_id,image) VALUES (100,'sentinel');
  `)
  if (existing) {
    await pool.query('INSERT INTO icons (user_id,image) VALUES ?', [
      [
        [10, image(1)],
        [20, image(2)],
      ],
    ])
  }
}

const icons = async () => {
  const [rows] = await pool.query<StoredIcon[]>(
    'SELECT * FROM icons ORDER BY id',
  )
  return rows
}
const deadlocks = async () => {
  const [[row]] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT AS n FROM information_schema.innodb_metrics WHERE NAME = 'lock_deadlocks'",
  )
  return Number(row.n)
}

// Synchronize the INSERTs after both transactions have acquired their locks.
function insertBarrier(participants: number) {
  let arrivals = 0
  let resolve!: () => void
  let reject!: (error: Error) => void
  let timer: ReturnType<typeof setTimeout>
  const ready = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return async () => {
    if (++arrivals === 1) {
      timer = setTimeout(
        () => reject(new Error('INSERT barrier timed out')),
        5000,
      )
    }
    if (arrivals === participants) {
      clearTimeout(timer)
      resolve()
    }
    await ready
  }
}

// Original DELETE predicate, with the problematic scheduling made deterministic.
async function originalUpdate(
  userId: number,
  beforeInsert: () => Promise<void>,
) {
  const conn = await pool.getConnection()
  await conn.beginTransaction()
  try {
    await conn.execute('DELETE FROM icons WHERE user_id = ?', [userId])
    await beforeInsert()
    await conn.query('INSERT INTO icons (user_id,image) VALUES (?,?)', [
      userId,
      image(userId),
    ])
    await conn.commit()
  } finally {
    await conn.rollback()
    conn.release()
  }
}

interface RequestOptions {
  beforeInsert?: () => Promise<void>
  failAfterInsert?: boolean
  expired?: boolean
}

function application(userId: number, options: RequestOptions = {}) {
  const app = new Hono<HonoEnvironment>()
  app.use('*', async (c, next) => {
    c.set('session', {
      get: (key: string) => {
        if (key === defaultUserIDKey) return userId
        if (key === defaultSessionExpiresKey)
          return options.expired ? 0 : Date.now() + 60_000
      },
    } as HonoEnvironment['Variables']['session'])
    c.set('runtime', {
      fallbackUserIcon: async () => Uint8Array.from(fallback).buffer,
    } as ApplicationRuntime)
    c.set('pool', {
      getConnection: async () => {
        const conn = await pool.getConnection()
        return {
          beginTransaction: async () => {
            await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            await conn.beginTransaction()
          },
          commit: () => conn.commit(),
          rollback: () => conn.rollback(),
          release: () => conn.release(),
          execute: (sql: string, values: unknown[]) =>
            conn.execute(sql, values),
          query: async (sql: string, values: unknown[]) => {
            const inserting = sql.startsWith('INSERT INTO icons')
            if (inserting) await options.beforeInsert?.()
            const result = await conn.query(sql, values)
            if (inserting && options.failAfterInsert) {
              throw new Error('injected failure after actual INSERT')
            }
            return result
          },
        }
      },
    } as unknown as Pool)
    await next()
  })
  app.post('/api/icon', ...postIconHandler)
  app.get('/api/user/:username/icon', ...getIconHandler)
  app.get('/api/user/me', ...getMeHandler)
  return app
}

const update = (userId: number, bytes: Buffer, options: RequestOptions = {}) =>
  application(userId, options).request('/api/icon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: bytes.toString('base64') }),
  })

test('旧処理は異なるユーザーの初回登録でもuser_id索引上でデッドロックする', async () => {
  await seed()
  const barrier = insertBarrier(2)
  const beforeCount = await deadlocks()
  const results = await Promise.allSettled([
    originalUpdate(10, barrier),
    originalUpdate(20, barrier),
  ])
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  assert.equal(failures.length, 1)
  assert.equal(
    (failures[0].reason as { code: string }).code,
    'ER_LOCK_DEADLOCK',
  )
  assert.equal((await deadlocks()) - beforeCount, 1)
  const [[status]] = await pool.query<RowDataPacket[]>(
    'SHOW ENGINE INNODB STATUS',
  )
  const detail = (status.Status as string)
    .split('LATEST DETECTED DEADLOCK')[1]
    .split('TRANSACTIONS')[0]
  assert.match(detail, /index idx_icons_user_id/)
})

test('異なるユーザーはINSERTを同時に進めても初回登録・更新とも201になる', async () => {
  for (const existing of [false, true]) {
    await seed(existing)
    const beforeCount = await deadlocks()
    const barrier = insertBarrier(2)
    const responses = await Promise.all([
      update(10, image(10), { beforeInsert: barrier }),
      update(20, image(20), { beforeInsert: barrier }),
    ])
    assert.deepEqual(
      responses.map((response) => response.status),
      [201, 201],
    )
    const rows = await icons()
    assert.equal(rows.length, 3)
    assert.deepEqual(rows.find((row) => row.user_id === 10)?.image, image(10))
    assert.deepEqual(rows.find((row) => row.user_id === 20)?.image, image(20))
    assert.equal((await deadlocks()) - beforeCount, 0)
  }
})

test('同じユーザーの8並列更新も全件201で、保存するアイコンは1件になる', async () => {
  for (const existing of [false, true]) {
    await seed(existing)
    const beforeCount = await deadlocks()
    const images = Array.from({ length: 8 }, (_, index) => image(index))
    const responses = await Promise.all(
      images.map((bytes) => update(10, bytes)),
    )
    assert.ok(responses.every((response) => response.status === 201))
    const ids = await Promise.all(
      responses.map(async (response) => {
        const body = (await response.json()) as { id: number }
        return body.id
      }),
    )
    assert.equal(new Set(ids).size, 8)
    const rows = await icons()
    const stored = rows.filter((row) => row.user_id === 10)
    assert.equal(stored.length, 1)
    const last = ids.indexOf(stored[0].id)
    assert.notEqual(last, -1)
    assert.deepEqual(stored[0].image, images[last])
    assert.equal((await deadlocks()) - beforeCount, 0)
  }
})

test('更新ごとに新しいIDを返し、画像バイト列とプロフィールのハッシュを保つ', async () => {
  await seed()
  const initial = await update(10, image(10))
  const first = (await initial.json()) as { id: number }
  const changed = await update(10, image(11))
  const second = (await changed.json()) as { id: number }
  assert.equal(initial.status, 201)
  assert.equal(changed.status, 201)
  assert.ok(second.id > first.id)
  const app = application(10)
  const response = await app.request('/api/user/user10/icon')
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image(11))
  const profile = await app.request('/api/user/me')
  assert.equal(profile.status, 200)
  const profileBody = await profile.json()
  assert.equal(
    profileBody.icon_hash,
    createHash('sha256').update(image(11)).digest('hex'),
  )
  const defaultIcon = await app.request('/api/user/user20/icon')
  assert.deepEqual(Buffer.from(await defaultIcon.arrayBuffer()), fallback)
})

test('既存の重複アイコンもすべて置き換え、他ユーザーの画像を保つ', async () => {
  await seed(true)
  await pool.query('INSERT INTO icons (user_id,image) VALUES (?,?)', [
    10,
    image(9),
  ])
  const allRows = await icons()
  const beforeRows = allRows.filter((row) => row.user_id !== 10)
  const response = await update(10, image(10))
  assert.equal(response.status, 201)
  const rows = await icons()
  assert.equal(rows.filter((row) => row.user_id === 10).length, 1)
  assert.deepEqual(
    rows.filter((row) => row.user_id !== 10),
    beforeRows,
  )
})

test('INSERT直後の失敗でも旧アイコンを復元し、次の更新でロックを解放する', async () => {
  await seed(true)
  const beforeRows = await icons()
  const failed = await update(10, image(10), { failAfterInsert: true })
  assert.equal(failed.status, 500)
  assert.deepEqual(await icons(), beforeRows)
  const next = await update(10, image(11))
  assert.equal(next.status, 201)
})

test('期限切れセッションではアイコンを変更しない', async () => {
  await seed(true)
  const beforeRows = await icons()
  const response = await update(10, image(10), { expired: true })
  assert.equal(response.status, 403)
  assert.deepEqual(await icons(), beforeRows)
})
