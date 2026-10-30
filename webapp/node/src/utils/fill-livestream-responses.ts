import { createHash } from 'node:crypto'
import { PoolConnection, RowDataPacket } from 'mysql2/promise'
import {
  LivestreamsModel,
  LivestreamTagsModel,
  TagsModel,
  ThemeModel,
  UserModel,
} from '../types/models'
import { LivestreamResponse } from './fill-livestream-response'
import { UserResponse } from './fill-user-response'

// 一覧の関連データをまとめて取得する。キャッシュはこのリクエスト内だけで共有する。
export const fillLivestreamResponses = async (
  conn: PoolConnection,
  livestreams: LivestreamsModel[],
  getFallbackUserIcon: () => Promise<Readonly<ArrayBuffer>>,
): Promise<LivestreamResponse[]> => {
  if (livestreams.length === 0) return []

  const userIds = [
    ...new Set(livestreams.map((livestream) => livestream.user_id)),
  ]
  const livestreamIds = [
    ...new Set(livestreams.map((livestream) => livestream.id)),
  ]

  const [users] = await conn.query<
    (Omit<UserModel, 'password'> & RowDataPacket)[]
  >('SELECT id, name, display_name, description FROM users WHERE id IN (?)', [
    userIds,
  ])
  const [themes] = await conn.query<(ThemeModel & RowDataPacket)[]>(
    'SELECT * FROM themes WHERE user_id IN (?) ORDER BY id',
    [userIds],
  )
  const [icons] = await conn.query<
    ({ user_id: number; icon_hash: string } & RowDataPacket)[]
  >(
    'SELECT user_id, SHA2(image, 256) AS icon_hash FROM icons WHERE user_id IN (?) ORDER BY id',
    [userIds],
  )
  const [livestreamTags] = await conn.query<
    (LivestreamTagsModel & RowDataPacket)[]
  >('SELECT * FROM livestream_tags WHERE livestream_id IN (?) ORDER BY id', [
    livestreamIds,
  ])
  const tagIds = [...new Set(livestreamTags.map((tag) => tag.tag_id))]
  const [tags] =
    tagIds.length > 0
      ? await conn.query<(TagsModel & RowDataPacket)[]>(
          'SELECT * FROM tags WHERE id IN (?)',
          [tagIds],
        )
      : [[]]

  const themesByUserId = new Map<number, ThemeModel>()
  for (const theme of themes) {
    if (!themesByUserId.has(theme.user_id)) {
      themesByUserId.set(theme.user_id, theme)
    }
  }
  const iconHashesByUserId = new Map<number, string>()
  for (const icon of icons) {
    if (!iconHashesByUserId.has(icon.user_id)) {
      iconHashesByUserId.set(icon.user_id, icon.icon_hash)
    }
  }

  let fallbackIconHash: string | undefined
  const usersById = new Map<number, UserResponse>()
  for (const user of users) {
    const theme = themesByUserId.get(user.id)
    if (!theme) throw new Error('not found theme that has the given user id')

    let iconHash = iconHashesByUserId.get(user.id)
    if (iconHash === undefined) {
      if (fallbackIconHash === undefined) {
        fallbackIconHash = createHash('sha256')
          .update(new Uint8Array(await getFallbackUserIcon()))
          .digest('hex')
      }
      iconHash = fallbackIconHash
    }

    usersById.set(user.id, {
      id: user.id,
      name: user.name,
      display_name: user.display_name,
      description: user.description,
      theme: { id: theme.id, dark_mode: !!theme.dark_mode },
      icon_hash: iconHash,
    })
  }

  const tagsById = new Map(tags.map((tag) => [tag.id, tag]))
  const tagsByLivestreamId = new Map<number, TagsModel[]>()
  for (const livestreamTag of livestreamTags) {
    const tag = tagsById.get(livestreamTag.tag_id)
    if (!tag) throw new Error('not found tag that has the given id')

    const streamTags = tagsByLivestreamId.get(livestreamTag.livestream_id) ?? []
    streamTags.push(tag)
    tagsByLivestreamId.set(livestreamTag.livestream_id, streamTags)
  }

  return livestreams.map((livestream) => {
    const owner = usersById.get(livestream.user_id)
    if (!owner) throw new Error('not found user that has the given id')

    return {
      id: livestream.id,
      owner,
      title: livestream.title,
      tags: (tagsByLivestreamId.get(livestream.id) ?? []).map((tag) => ({
        id: tag.id,
        name: tag.name,
      })),
      description: livestream.description,
      playlist_url: livestream.playlist_url,
      thumbnail_url: livestream.thumbnail_url,
      start_at: livestream.start_at,
      end_at: livestream.end_at,
    }
  })
}
