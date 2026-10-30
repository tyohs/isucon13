import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { Hono } from 'hono'
import { PoolConnection } from 'mysql2/promise'
import { searchLivestreamsHandler } from '../handlers/livestream-handler'
import { ApplicationRuntime, HonoEnvironment } from '../types/application'
import { LivestreamsModel } from '../types/models'
import { fillLivestreamResponse } from './fill-livestream-response'
import { fillLivestreamResponses } from './fill-livestream-responses'

const fallbackImage = Uint8Array.from(Buffer.from('default icon')).buffer
const fallbackUserIcon = async () => fallbackImage
const stream = (id: number, userId: number): LivestreamsModel => ({
  id,
  user_id: userId,
  title: `配信 ${id}`,
  description: `説明 ${id}`,
  playlist_url: `https://example.com/${id}.m3u8`,
  thumbnail_url: `https://example.com/${id}.jpg`,
  start_at: 1_700_880_000,
  end_at: 1_700_883_600,
})

const makeUser = (id: number) => ({
  id,
  name: `user${id}`,
  display_name: `配信者 ${id}`,
  description: `自己紹介 ${id}`,
  password: 'not returned',
})

class DatabaseFixture {
  queries: string[] = []
  transactions = 0
  commits = 0
  rollbacks = 0
  released = false
  users = [makeUser(9), makeUser(4), makeUser(7)]
  themes = [
    { id: 1, user_id: 9, dark_mode: 0 },
    { id: 2, user_id: 4, dark_mode: 1 },
    { id: 3, user_id: 7, dark_mode: 0 },
  ]
  icons = [
    { id: 1, user_id: 9, image: Buffer.from([0, 255, 128, 1]) },
    { id: 2, user_id: 7, image: Buffer.alloc(0) },
  ]
  livestreams = [stream(1, 9), stream(5, 7), stream(10, 4)]
  livestreamTags = [
    { id: 1, livestream_id: 10, tag_id: 8 },
    { id: 2, livestream_id: 1, tag_id: 2 },
    { id: 3, livestream_id: 10, tag_id: 2 },
    { id: 4, livestream_id: 10, tag_id: 2 },
  ]
  tags = [
    { id: 2, name: 'ゲーム' },
    { id: 8, name: '雑談' },
  ]

  connection() {
    return this as unknown as PoolConnection
  }

  async beginTransaction() {
    this.transactions++
  }
  async commit() {
    this.commits++
  }
  async rollback() {
    this.rollbacks++
  }
  release() {
    this.released = true
  }

  async query(sql: string, values: unknown[] = []) {
    this.queries.push(sql)
    const ids = new Set(Array.isArray(values[0]) ? values[0] : [values[0]])
    if (/FROM users /.test(sql)) {
      return [this.users.filter((user) => ids.has(user.id)), []]
    }
    if (/FROM themes /.test(sql)) {
      return [this.themes.filter((theme) => ids.has(theme.user_id)), []]
    }
    if (/FROM icons /.test(sql)) {
      const icons = this.icons.filter((icon) => ids.has(icon.user_id))
      return [
        sql.includes('SHA2(')
          ? icons.map((icon) => ({
              user_id: icon.user_id,
              icon_hash: createHash('sha256').update(icon.image).digest('hex'),
            }))
          : icons,
        [],
      ]
    }
    if (/FROM livestream_tags /.test(sql)) {
      const tags = this.livestreamTags.filter((tag) =>
        ids.has(sql.includes('WHERE tag_id') ? tag.tag_id : tag.livestream_id),
      )
      if (sql.includes('ORDER BY livestream_id DESC')) {
        tags.sort((a, b) => b.livestream_id - a.livestream_id)
      }
      return [tags, []]
    }
    if (/FROM tags /.test(sql)) {
      return [
        this.tags.filter((tag) =>
          sql.includes('WHERE name') ? tag.name === values[0] : ids.has(tag.id),
        ),
        [],
      ]
    }
    if (/FROM livestreams /.test(sql)) {
      if (sql.includes('WHERE id')) {
        return [this.livestreams.filter((item) => ids.has(item.id)), []]
      }
      const streams = [...this.livestreams].sort((a, b) => b.id - a.id)
      const limit = sql.match(/LIMIT (\d+)/)
      return [limit ? streams.slice(0, Number(limit[1])) : streams, []]
    }
    throw new Error(`unexpected SQL: ${sql}`)
  }
}

test('既存実装と同じJSONを返し、配信・タグの順序と重複を保つ', async () => {
  const database = new DatabaseFixture()
  const streams = [
    database.livestreams[2],
    database.livestreams[0],
    database.livestreams[2],
    database.livestreams[1],
  ]
  const expected = []
  for (const item of streams) {
    expected.push(
      await fillLivestreamResponse(
        database.connection(),
        item,
        fallbackUserIcon,
      ),
    )
  }
  database.queries = []
  const actual = await fillLivestreamResponses(
    database.connection(),
    streams,
    fallbackUserIcon,
  )

  assert.deepEqual(actual, expected)
  assert.deepEqual(
    actual.map((item) => item.id),
    [10, 1, 10, 5],
  )
  assert.deepEqual(
    actual[0].tags.map((tag) => tag.id),
    [8, 2, 2],
  )
  assert.equal(actual[3].owner.icon_hash, createHash('sha256').digest('hex'))
  assert.equal(database.queries.length, 5)
  assert.ok(!JSON.stringify(actual).includes('not returned'))
})

test('0件ではSQLもデフォルト画像の取得も実行しない', async () => {
  const database = new DatabaseFixture()
  assert.deepEqual(
    await fillLivestreamResponses(database.connection(), [], async () => {
      throw new Error('unexpected fallback')
    }),
    [],
  )
  assert.equal(database.queries.length, 0)
})

test('100件でも関連データのSQLは5回で、同じ配信者のデフォルト画像も1回だけ取得する', async () => {
  const database = new DatabaseFixture()
  const streams = Array.from({ length: 100 }, (_, index) =>
    stream(index + 1, 4),
  )
  let fallbackCalls = 0
  const actual = await fillLivestreamResponses(
    database.connection(),
    streams,
    async () => {
      fallbackCalls++
      return fallbackImage
    },
  )
  assert.equal(actual.length, 100)
  assert.equal(database.queries.length, 5)
  assert.equal(fallbackCalls, 1)
  assert.equal(actual[0].owner.id, 4)
  assert.equal(actual[99].owner.id, 4)
})

test('アイコンのハッシュを次のリクエストへキャッシュしない', async () => {
  const database = new DatabaseFixture()
  const before = await fillLivestreamResponses(
    database.connection(),
    [stream(1, 9)],
    fallbackUserIcon,
  )
  database.icons[0].image = Buffer.from('updated icon')
  const after = await fillLivestreamResponses(
    database.connection(),
    [stream(1, 9)],
    fallbackUserIcon,
  )
  assert.notEqual(before[0].owner.icon_hash, after[0].owner.icon_hash)
  assert.equal(
    after[0].owner.icon_hash,
    createHash('sha256').update('updated icon').digest('hex'),
  )
})

test('参照先の配信者・テーマ・タグが欠けたときに不完全な応答を返さない', async () => {
  const missingOwner = new DatabaseFixture()
  missingOwner.users = []
  await assert.rejects(
    fillLivestreamResponses(
      missingOwner.connection(),
      [stream(1, 9)],
      fallbackUserIcon,
    ),
  )
  const missingTheme = new DatabaseFixture()
  missingTheme.themes = []
  await assert.rejects(
    fillLivestreamResponses(
      missingTheme.connection(),
      [stream(1, 9)],
      fallbackUserIcon,
    ),
  )
  const missingTag = new DatabaseFixture()
  missingTag.tags = []
  await assert.rejects(
    fillLivestreamResponses(
      missingTag.connection(),
      [stream(1, 9)],
      fallbackUserIcon,
    ),
  )
})

const search = async (query: string) => {
  const database = new DatabaseFixture()
  const app = new Hono<HonoEnvironment>()
  app.use('*', async (c, next) => {
    c.set('pool', {
      getConnection: async () => database.connection(),
    } as HonoEnvironment['Variables']['pool'])
    c.set('runtime', { fallbackUserIcon } as ApplicationRuntime)
    await next()
  })
  app.get('/api/livestream/search', searchLivestreamsHandler)
  return {
    db: database,
    response: await app.request(`/api/livestream/search${query}`),
  }
}

test('検索APIはlimit・降順・0件と、不正limitの400を維持する', async () => {
  const limited = await search('?limit=2')
  assert.equal(limited.response.status, 200)
  const body = await limited.response.json()
  assert.deepEqual(
    body.map((item: LivestreamsModel) => item.id),
    [10, 5],
  )
  assert.equal(limited.db.queries.length, 6)
  assert.equal(limited.db.commits, 1)
  assert.equal(limited.db.released, true)

  const empty = await search('?limit=0')
  assert.deepEqual(await empty.response.json(), [])
  assert.equal(empty.db.queries.length, 1)

  const invalid = await search('?limit=abc')
  assert.equal(invalid.response.status, 400)
  assert.equal(invalid.db.released, true)
})

test('タグ検索の配信取得をまとめても、降順・重複と従来のlimitの扱いを維持する', async () => {
  const { db, response } = await search(
    `?tag=${encodeURIComponent('ゲーム')}&limit=1`,
  )
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(
    body.map((item: LivestreamsModel) => item.id),
    [10, 10, 1],
  )
  assert.equal(db.queries.length, 8)
  assert.equal(
    db.queries.filter((sql) => sql.includes('FROM livestreams WHERE id'))
      .length,
    1,
  )
})
