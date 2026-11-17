import type { IncomingMessage, ServerResponse } from 'node:http'

export const STORAGE_PREFIX: '/api/storage'

export type StorageApi = {
  /** 处理 /api/storage 下的请求；路径不属于存储接口时返回 false */
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean>
}

export function createStorageApi(options: { dataDir: string }): StorageApi
