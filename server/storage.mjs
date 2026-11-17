/* oxlint-disable no-console -- 存储接口出错时需要写入服务端日志 */
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 存储接口前缀，生产服务器与开发服务器共用 */
export const STORAGE_PREFIX = '/api/storage'

/** 单个会话 JSON 的上限；长对话的思考块也会计入 */
const SESSION_LIMIT = 64 * 1024 * 1024
/** 单个附件原件的上限，需覆盖 64 MB 的附件 */
const FILE_LIMIT = 256 * 1024 * 1024

/** 会话与附件 id 由客户端生成，只允许常见 id 字符，避免路径穿越 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const isValidId = (id) => typeof id === 'string' && ID_PATTERN.test(id)

const exists = async (target) => Boolean(await stat(target).catch(() => null))

const readJsonFile = async (target) => {
  try {
    return JSON.parse(await readFile(target, 'utf8'))
  } catch {
    return undefined
  }
}

const summaryOf = (session) => ({
  id: session.id,
  title: typeof session.title === 'string' ? session.title : '',
  createdAt: Number(session.createdAt) || 0,
  updatedAt: Number(session.updatedAt) || 0,
})

/** 先写临时文件再改名，避免读到写了一半的 JSON */
const writeJsonFile = async (target, value) => {
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value))
  await rename(temporary, target)
}

const isTooLarge = (error) => error instanceof Error && error.message === 'too-large'

const readJsonBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) {
        return
      }
      size += chunk.length
      if (size > limit) {
        settled = true
        reject(new Error('too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) {
        return
      }
      settled = true
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    req.on('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })

/** 把请求体流式写到临时文件，写完再改名；避免大附件全部读进内存 */
const receiveFile = async (req, target, limit) => {
  const temporary = `${target}.${randomUUID()}.tmp`
  let size = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length
      callback(size > limit ? new Error('too-large') : null, chunk)
    },
  })
  try {
    await pipeline(req, meter, createWriteStream(temporary))
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

const sendJson = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

const sendEmpty = (res, status = 204) => {
  res.writeHead(status, { 'cache-control': 'no-store' })
  res.end()
}

/**
 * 创建文件系统存储接口。数据目录由调用方决定，生产服务器和开发服务器共用同一份实现。
 *
 * 目录结构：
 *   sessions/{id}.json   完整会话
 *   files/{id}.bin       附件原件
 *   files/{id}.meta.json 附件 MIME
 *   index.json           会话列表元数据
 * 导入暂存放在数据目录旁边（{dataDir}.staging），提交时整体换入数据目录。
 */
export const createStorageApi = ({ dataDir }) => {
  const sessionsDir = path.join(dataDir, 'sessions')
  const filesDir = path.join(dataDir, 'files')
  const indexPath = path.join(dataDir, 'index.json')
  const stagingDir = `${dataDir}.staging`
  const stagingSessionsDir = path.join(stagingDir, 'sessions')
  const stagingFilesDir = path.join(stagingDir, 'files')
  const stagingIndexPath = path.join(stagingDir, 'index.json')
  const previousDir = `${dataDir}.prev`

  const sessionPath = (id, base = sessionsDir) => path.join(base, `${id}.json`)
  const fileDataPath = (id, base = filesDir) => path.join(base, `${id}.bin`)
  const fileMetaPath = (id, base = filesDir) => path.join(base, `${id}.meta.json`)

  /** 内存中的会话列表，与 index.json 保持一致 */
  let summaries = []
  let initialized
  /** 所有写操作串行执行；跨设备的并发写入按到达顺序落盘 */
  let writeQueue = Promise.resolve()

  const withLock = (task) => {
    const run = writeQueue.then(task)
    writeQueue = run.then(
      () => {},
      () => {}
    )
    return run
  }

  const ensureLayout = async () => {
    await Promise.all([
      mkdir(sessionsDir, { recursive: true }),
      mkdir(filesDir, { recursive: true }),
      mkdir(stagingSessionsDir, { recursive: true }),
      mkdir(stagingFilesDir, { recursive: true }),
    ])
  }

  /** 上次提交在“旧目录改名”和“暂存换入”之间中断时，恢复旧数据 */
  const recoverSwap = async () => {
    const hasData = await exists(dataDir)
    const hasPrevious = await exists(previousDir)
    if (!hasData && hasPrevious) {
      await rename(previousDir, dataDir)
    } else if (hasData && hasPrevious) {
      await rm(previousDir, { recursive: true, force: true })
    }
  }

  const writeIndex = (list, target = indexPath) => writeJsonFile(target, list)

  /** 索引缺失或损坏时从会话文件重建列表 */
  const rebuildIndex = async () => {
    const list = []
    for (const name of await readdir(sessionsDir)) {
      if (!name.endsWith('.json')) {
        continue
      }
      const session = await readJsonFile(path.join(sessionsDir, name))
      if (session && typeof session.id === 'string') {
        list.push(summaryOf(session))
      }
    }
    await writeIndex(list)
    return list
  }

  const loadIndex = async () => {
    const stored = await readJsonFile(indexPath)
    if (
      Array.isArray(stored) &&
      stored.every((entry) => entry && typeof entry.id === 'string')
    ) {
      return stored
    }
    return rebuildIndex()
  }

  const init = () =>
    (initialized ??= (async () => {
      await recoverSwap()
      await ensureLayout()
      summaries = await loadIndex()
    })().catch((error) => {
      initialized = undefined
      throw error
    }))

  const listSummaries = () => [...summaries].sort((a, b) => b.updatedAt - a.updatedAt)

  const upsertSummary = (session) => {
    const summary = summaryOf(session)
    summaries = summaries.some((entry) => entry.id === summary.id)
      ? summaries.map((entry) => (entry.id === summary.id ? summary : entry))
      : [...summaries, summary]
    return summary
  }

  /** 会话删掉后清理没有任何会话再引用的本地原件 */
  const cleanupFiles = async () => {
    const referenced = new Set()
    for (const name of await readdir(sessionsDir)) {
      if (!name.endsWith('.json')) {
        continue
      }
      const session = await readJsonFile(path.join(sessionsDir, name))
      if (!session || !Array.isArray(session.messages)) {
        continue
      }
      for (const message of session.messages) {
        if (message?.role === 'user' && Array.isArray(message.files)) {
          for (const file of message.files) {
            if (typeof file?.id === 'string') {
              referenced.add(file.id)
            }
          }
        }
      }
    }
    for (const name of await readdir(filesDir)) {
      const id = name.endsWith('.bin')
        ? name.slice(0, -'.bin'.length)
        : name.endsWith('.meta.json')
          ? name.slice(0, -'.meta.json'.length)
          : null
      if (id !== null && !referenced.has(id)) {
        await rm(path.join(filesDir, name), { force: true })
      }
    }
  }

  const readFileType = async (id, base = filesDir) => {
    const meta = await readJsonFile(fileMetaPath(id, base))
    return typeof meta?.type === 'string' ? meta.type : ''
  }

  const getSession = async (res, id) => {
    const session = await readJsonFile(sessionPath(id))
    if (!session) {
      sendJson(res, 404, { error: 'not-found' })
      return
    }
    sendJson(res, 200, session)
  }

  const putSession = async (req, res, id) => {
    const session = await readJsonBody(req, SESSION_LIMIT)
    if (!session || session.id !== id || !Array.isArray(session.messages)) {
      sendJson(res, 400, { error: 'invalid-session' })
      return
    }
    await withLock(async () => {
      await writeJsonFile(sessionPath(id), session)
      upsertSummary(session)
      await writeIndex(summaries)
    })
    sendEmpty(res)
  }

  const renameSession = async (req, res, id) => {
    const body = await readJsonBody(req, SESSION_LIMIT)
    const title = typeof body?.title === 'string' ? body.title : null
    if (title === null) {
      sendJson(res, 400, { error: 'invalid-title' })
      return
    }
    await withLock(async () => {
      const session = await readJsonFile(sessionPath(id))
      if (session) {
        await writeJsonFile(sessionPath(id), { ...session, title })
      }
      if (summaries.some((entry) => entry.id === id)) {
        summaries = summaries.map((entry) => (entry.id === id ? { ...entry, title } : entry))
        await writeIndex(summaries)
      }
    })
    sendEmpty(res)
  }

  const removeSession = async (res, id) => {
    await withLock(async () => {
      await rm(sessionPath(id), { force: true })
      summaries = summaries.filter((entry) => entry.id !== id)
      await writeIndex(summaries)
      await cleanupFiles()
    })
    sendEmpty(res)
  }

  const getFile = async (res, id) => {
    const target = fileDataPath(id)
    const info = await stat(target).catch(() => null)
    if (!info?.isFile()) {
      sendJson(res, 404, { error: 'not-found' })
      return
    }
    const type = await readFileType(id)
    res.writeHead(200, {
      'content-type': type || 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    })
    createReadStream(target).pipe(res)
  }

  const putFile = async (req, id, directory) => {
    const type = new URL(req.url ?? '/', 'http://localhost').searchParams.get('type') ?? ''
    await withLock(async () => {
      await receiveFile(req, fileDataPath(id, directory), FILE_LIMIT)
      await writeJsonFile(fileMetaPath(id, directory), { type })
    })
  }

  const clearStaging = async (res) => {
    await withLock(async () => {
      await rm(stagingDir, { recursive: true, force: true })
      await mkdir(stagingSessionsDir, { recursive: true })
      await mkdir(stagingFilesDir, { recursive: true })
    })
    sendEmpty(res)
  }

  const putStagingSession = async (req, res, id) => {
    const session = await readJsonBody(req, SESSION_LIMIT)
    if (!session || session.id !== id || !Array.isArray(session.messages)) {
      sendJson(res, 400, { error: 'invalid-session' })
      return
    }
    await withLock(() => writeJsonFile(sessionPath(id, stagingSessionsDir), session))
    sendEmpty(res)
  }

  /** 图片在会话之后到达，全部读完再回填 MIME，保留归档给出的 isImage 标识 */
  const updateStagingFileTypes = async (req, res) => {
    const body = await readJsonBody(req, SESSION_LIMIT)
    const entries = Array.isArray(body?.types) ? body.types : null
    if (!entries) {
      sendJson(res, 400, { error: 'invalid-types' })
      return
    }
    const types = new Map(entries)
    await withLock(async () => {
      for (const name of await readdir(stagingSessionsDir)) {
        if (!name.endsWith('.json')) {
          continue
        }
        const target = path.join(stagingSessionsDir, name)
        const session = await readJsonFile(target)
        if (!session || !Array.isArray(session.messages)) {
          continue
        }
        let changed = false
        for (const message of session.messages) {
          if (message?.role !== 'user' || !Array.isArray(message.files)) {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await writeJsonFile(target, session)
        }
      }
    })
    sendEmpty(res)
  }

  /** 用暂存整体替换正式数据；替换失败时恢复原有数据目录 */
  const commitStaging = async (res) => {
    const committed = await withLock(async () => {
      const list = []
      for (const name of await readdir(stagingSessionsDir).catch(() => [])) {
        if (!name.endsWith('.json')) {
          continue
        }
        const session = await readJsonFile(path.join(stagingSessionsDir, name))
        if (session && typeof session.id === 'string') {
          list.push(summaryOf(session))
        }
      }
      await writeIndex(list, stagingIndexPath)
      await rm(previousDir, { recursive: true, force: true })
      await rename(dataDir, previousDir)
      try {
        await rename(stagingDir, dataDir)
      } catch (error) {
        await rename(previousDir, dataDir)
        throw error
      }
      await rm(previousDir, { recursive: true, force: true })
      await mkdir(stagingSessionsDir, { recursive: true })
      await mkdir(stagingFilesDir, { recursive: true })
      summaries = list
      return list
    })
    sendJson(res, 200, [...committed].sort((a, b) => b.updatedAt - a.updatedAt))
  }

  const handle = async (req, res, pathname) => {
    if (!pathname.startsWith(`${STORAGE_PREFIX}/`)) {
      return false
    }
    await init()
    const route = pathname.slice(STORAGE_PREFIX.length)
    const method = req.method ?? 'GET'

    try {
      if (route === '/sessions' && method === 'GET') {
        sendJson(res, 200, listSummaries())
        return true
      }

      const sessionMatch = /^\/sessions\/([^/]+)$/.exec(route)
      if (sessionMatch) {
        const id = sessionMatch[1]
        if (!isValidId(id)) {
          sendJson(res, 400, { error: 'invalid-id' })
          return true
        }
        if (method === 'GET') {
          await getSession(res, id)
          return true
        }
        if (method === 'PUT') {
          await putSession(req, res, id)
          return true
        }
        if (method === 'PATCH') {
          await renameSession(req, res, id)
          return true
        }
        if (method === 'DELETE') {
          await removeSession(res, id)
          return true
        }
        sendJson(res, 405, { error: 'method-not-allowed' })
        return true
      }

      const fileMatch = /^\/files\/([^/]+)$/.exec(route)
      if (fileMatch) {
        const id = fileMatch[1]
        if (!isValidId(id)) {
          sendJson(res, 400, { error: 'invalid-id' })
          return true
        }
        if (method === 'GET') {
          await getFile(res, id)
          return true
        }
        if (method === 'PUT') {
          await putFile(req, id, filesDir)
          sendEmpty(res)
          return true
        }
        sendJson(res, 405, { error: 'method-not-allowed' })
        return true
      }

      if (route === '/staging/clear' && method === 'POST') {
        await clearStaging(res)
        return true
      }

      const stagingSessionMatch = /^\/staging\/sessions\/([^/]+)$/.exec(route)
      if (stagingSessionMatch) {
        const id = stagingSessionMatch[1]
        if (method !== 'PUT') {
          sendJson(res, 405, { error: 'method-not-allowed' })
          return true
        }
        if (!isValidId(id)) {
          sendJson(res, 400, { error: 'invalid-id' })
          return true
        }
        await putStagingSession(req, res, id)
        return true
      }

      const stagingFileMatch = /^\/staging\/files\/([^/]+)$/.exec(route)
      if (stagingFileMatch) {
        const id = stagingFileMatch[1]
        if (method !== 'PUT') {
          sendJson(res, 405, { error: 'method-not-allowed' })
          return true
        }
        if (!isValidId(id)) {
          sendJson(res, 400, { error: 'invalid-id' })
          return true
        }
        await putFile(req, id, stagingFilesDir)
        sendEmpty(res)
        return true
      }

      if (route === '/staging/file-types' && method === 'POST') {
        await updateStagingFileTypes(req, res)
        return true
      }

      if (route === '/staging/commit' && method === 'POST') {
        await commitStaging(res)
        return true
      }

      sendJson(res, 404, { error: 'not-found' })
      return true
    } catch (error) {
      if (isTooLarge(error)) {
        if (!res.headersSent) {
          sendJson(res, 413, { error: 'too-large' })
        }
        return true
      }
      if (error instanceof Error && error.message === 'invalid-json') {
        if (!res.headersSent) {
          sendJson(res, 400, { error: 'invalid-json' })
        }
        return true
      }
      console.error('[storage]', error)
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal' })
      } else {
        res.end()
      }
      return true
    }
  }

  return { handle }
}
