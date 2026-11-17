import { openDB, type DBSchema } from 'idb'
import * as db from './db.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

/** 旧版本把会话与原件存在浏览器 IndexedDB；升级后只在首次打开时迁移一次 */
const LEGACY_DB = 'chat-demo'

const MIGRATED_KEY = 'chat-demo:legacy-migrated'
const PROGRESS_KEY = 'chat-demo:legacy-migrating'
/** 多个标签页同时打开时只让一个执行迁移；超时后允许接管 */
const LOCK_KEY = 'chat-demo:legacy-migration-lock'
const LOCK_TTL = 60_000

type LegacyFile = { id: string; blob: Blob }

interface LegacyDB extends DBSchema {
  sessions: { key: string; value: Session }
  files: { key: string; value: LegacyFile }
}

const readFlag = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const writeFlag = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时按“未迁移”处理，下次打开再试
  }
}

const acquireLock = () => {
  const now = Date.now()
  const current = readFlag(LOCK_KEY)
  if (current && now - Number(current) < LOCK_TTL) {
    return false
  }
  writeFlag(LOCK_KEY, String(now))
  return true
}

const hasLegacyDatabase = async () => {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    return false
  }
  try {
    return (await indexedDB.databases()).some((entry) => entry.name === LEGACY_DB)
  } catch {
    return false
  }
}

const deleteLegacyDatabase = () =>
  new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(LEGACY_DB)
    // 被其他标签页占用时保留旧数据，迁移标记已经写入，不会重复导入
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })

/**
 * 把浏览器里已有的会话和附件搬到服务端。
 * 服务端已有数据且上次没有迁移中断时不做任何事，避免覆盖另一台设备的数据；
 * 本次上传失败会回滚已写入的会话，保持服务端为空，下次打开继续迁移。
 */
export const migrateLegacyHistory = async (
  serverHasSessions: boolean
): Promise<SessionSummary[] | null> => {
  if (readFlag(MIGRATED_KEY)) {
    return null
  }
  if (!(await hasLegacyDatabase()) || !acquireLock()) {
    return null
  }
  const resuming = readFlag(PROGRESS_KEY) === '1'
  if (serverHasSessions && !resuming) {
    writeFlag(LOCK_KEY, null)
    return null
  }
  writeFlag(PROGRESS_KEY, '1')

  const uploaded: string[] = []
  let migrated = false
  try {
    const legacy = await openDB<LegacyDB>(LEGACY_DB)
    let summaries: SessionSummary[]
    try {
      if (!legacy.objectStoreNames.contains('sessions')) {
        migrated = true
        return null
      }
      const hasFiles = legacy.objectStoreNames.contains('files')
      const sessions = await legacy.getAll('sessions')
      if (sessions.length === 0) {
        migrated = true
        return null
      }
      summaries = []
      for (const session of sessions) {
        const files: db.StoredFile[] = []
        const seen = new Set<string>()
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            if (seen.has(file.id)) {
              continue
            }
            seen.add(file.id)
            const stored = hasFiles ? await legacy.get('files', file.id) : undefined
            if (stored) {
              files.push(stored)
            }
          }
        }
        await db.saveSession(session, files)
        uploaded.push(session.id)
        summaries.push(toSessionSummary(session))
      }
      migrated = true
      return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
    } finally {
      legacy.close()
    }
  } catch (error) {
    db.reportStorageError('migrate legacy history')(error)
    // 回到打开页面前的状态，避免半迁移的数据挡住下次迁移
    const results = await Promise.allSettled(uploaded.map((id) => db.deleteSession(id)))
    if (results.every((result) => result.status === 'fulfilled')) {
      uploaded.length = 0
    }
    return null
  } finally {
    writeFlag(LOCK_KEY, null)
    if (migrated) {
      writeFlag(MIGRATED_KEY, '1')
      writeFlag(PROGRESS_KEY, null)
      await deleteLegacyDatabase()
    } else if (uploaded.length === 0) {
      // 没有写入任何数据时可以直接重试；写入过但回滚也失败则保留标记，下次继续
      writeFlag(PROGRESS_KEY, null)
    }
  }
}
