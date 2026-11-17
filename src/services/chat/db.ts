import { toSessionSummary, type Session, type SessionSummary } from './types.js'

/** 附件原件按本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看和补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 会话与附件由服务端本地存储接口读写，接口受登录态保护 */
const ENDPOINT = '/api/storage'

const request = async (path: string, init?: RequestInit): Promise<Response> => {
  const response = await fetch(`${ENDPOINT}${path}`, init)
  if (response.status === 401) {
    // 登录态过期：回到登录页，避免继续在内存里修改却无法保存
    window.location.assign('/login')
    throw new Error('Storage request is not authorized')
  }
  return response
}

const expectOk = async (path: string, init?: RequestInit): Promise<Response> => {
  const response = await request(path, init)
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status}`)
  }
  return response
}

const sendJson = (path: string, method: string, body: unknown): Promise<void> =>
  expectOk(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(() => undefined)

const putFile = (base: string, file: StoredFile): Promise<void> =>
  expectOk(`/${base}/${encodeURIComponent(file.id)}?type=${encodeURIComponent(file.blob.type)}`, {
    method: 'PUT',
    body: file.blob,
  }).then(() => undefined)

/**
 * 所有写操作按发起顺序串行执行。
 * 流式回复收尾时会连续发起保存，导入历史又要求整体替换排在保存之后；串行保证服务端最后看到的是最新状态。
 */
let writeQueue: Promise<unknown> = Promise.resolve()

const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
  const run = writeQueue.then(task, task)
  writeQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const response = await expectOk('/sessions')
  const summaries = (await response.json()) as SessionSummary[]
  return summaries.map(toSessionSummary)
}

export const loadSession = async (id: string): Promise<Session | undefined> => {
  const response = await request(`/sessions/${encodeURIComponent(id)}`)
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw new Error(`GET /sessions/${id} failed: ${response.status}`)
  }
  return (await response.json()) as Session
}

export const saveSession = (session: Session, files: StoredFile[] = []): Promise<void> =>
  // 原件先落盘，会话再引用；上传与会话写入一起排队，避免新状态被旧状态的保存覆盖
  enqueue(async () => {
    for (const file of files) {
      await putFile('files', file)
    }
    await sendJson(`/sessions/${encodeURIComponent(session.id)}`, 'PUT', session)
  })

/** 未打开的会话也可重命名，不需要先读取完整会话 */
export const renameSession = (id: string, title: string): Promise<void> =>
  enqueue(() => sendJson(`/sessions/${encodeURIComponent(id)}`, 'PATCH', { title }))

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删 */
export const deleteSession = (id: string): Promise<void> =>
  enqueue(() => expectOk(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => undefined))

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const response = await request(`/files/${encodeURIComponent(id)}`)
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw new Error(`GET /files/${id} failed: ${response.status}`)
  }
  return response.blob()
}

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = (): Promise<void> =>
  enqueue(() => expectOk('/staging/clear', { method: 'POST' }).then(() => undefined))

export const addStagingSession = (session: Session): Promise<void> =>
  enqueue(() => sendJson(`/staging/sessions/${encodeURIComponent(session.id)}`, 'PUT', session))

export const saveStagingFiles = async (files: StoredFile[]): Promise<void> => {
  for (const file of files) {
    await enqueue(() => putFile('staging/files', file))
  }
}

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = (types: ReadonlyMap<string, string>): Promise<void> =>
  enqueue(() => sendJson('/staging/file-types', 'POST', { types: [...types] }))

/** 把暂存整体换入正式数据，返回替换后的会话列表；失败时服务端保留原有数据。 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const response = await enqueue(() => expectOk('/staging/commit', { method: 'POST' }))
  const summaries = (await response.json()) as SessionSummary[]
  return summaries.map(toSessionSummary)
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
