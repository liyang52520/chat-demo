# chat-demo

[English](README.md) | 简体中文

基于 DeepSeek API 的聊天示例。浏览器只访问自带的 Node 服务，由服务端代理聊天、附件与语音请求，API Key 始终留在服务端。

设置 `CHAT_DEMO_API_KEY` 后用 `pnpm start`（或 `pnpm dev`）运行，详见下文。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

构建并启动带服务端存储的应用：

```sh
pnpm build
pnpm start
```

产物位于 `dist/`，`node server.mjs` 会同时提供静态页面、存储接口和需要登录的 `/api/proxy` 代理（默认端口 8090）。会话默认保存在项目下的 `.chat-demo-data/`，可用 `CHAT_DEMO_DATA_DIR` 修改位置。由于 API Key 不会下发到浏览器，只把 `dist/` 部署到静态服务器已无法聊天。

启动服务时可设置以下环境变量：

| 变量 | 说明 |
| --- | --- |
| `CHAT_DEMO_API_KEY` | DeepSeek API Key，由服务端注入上游请求，聊天必需。 |
| `CHAT_DEMO_PASSWORD` | 登录密码；不设置时由第一个访客设置并加密保存在服务端。 |
| `CHAT_DEMO_API_ORIGIN` | 上游 API 地址，默认 `https://api.deepseek.com`。 |
| `CHAT_DEMO_DATA_DIR` | 会话与附件的保存目录。 |

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 数据

设置保存在浏览器 localStorage。API Key 只存在于服务端环境变量 `CHAT_DEMO_API_KEY`，不会发送到浏览器；登录后的请求统一发往 `/api/proxy`，由服务端附加 Key 后转发上游。会话及附件原件保存在服务端的 `.chat-demo-data/`（可用 `CHAT_DEMO_DATA_DIR` 修改），清理浏览器数据不会丢失。登录同一个服务的浏览器共享同一份对话。升级前存在浏览器里的数据会在首次打开时自动迁移到服务端。发送对话、上传附件和使用语音功能时，相应内容会经服务端提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换服务端的全部会话和附件；导出包含会话与服务端保存的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空服务端的全部会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。其他设置保留，服务端 API Key 和已上传到 API 服务的文件不受影响。

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动开发服务器      |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm format` | oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 读取 `CHAT_DEMO_API_ORIGIN`（默认 `https://api.deepseek.com`）和 `CHAT_DEMO_API_KEY` 用于开发服务器代理；也可以用 `createConfig({ apiOrigin, devServer })` 覆盖。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
