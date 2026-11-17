# chat-demo

English | [简体中文](README.zh-CN.md)

A chat demo powered by the DeepSeek API. The browser only talks to the bundled Node server, which proxies chat, attachment, and speech requests and keeps the API key on the server.

Run the app with `pnpm start` (or `pnpm dev`) after setting `CHAT_DEMO_API_KEY`; see below for details.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build and run the app with server-side storage:

```sh
pnpm build
pnpm start
```

The build output is written to `dist/`; `node server.mjs` serves it, the storage API, and the authenticated `/api/proxy` endpoint on port 8090. Conversations are kept in `.chat-demo-data/` next to the project by default; set `CHAT_DEMO_DATA_DIR` to change the location. Because the API key never reaches the browser, serving `dist/` from a static file host is no longer enough to chat.

Set these environment variables when starting the server:

| Variable | Description |
| --- | --- |
| `CHAT_DEMO_API_KEY` | DeepSeek API key. Injected into upstream requests by the server; required for chat. |
| `CHAT_DEMO_PASSWORD` | Login password. If omitted, the first visitor sets a password that is stored hashed on the server. |
| `CHAT_DEMO_API_ORIGIN` | Upstream API origin, `https://api.deepseek.com` by default. |
| `CHAT_DEMO_DATA_DIR` | Directory for conversations and attachments. |

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and storage

Settings are stored in the browser's localStorage. The API key lives only in the server's `CHAT_DEMO_API_KEY` environment variable and is never sent to the browser; authenticated requests go to `/api/proxy`, where the server adds the key and forwards them upstream. Conversations and original attachments are stored on the server in `.chat-demo-data/` (override with `CHAT_DEMO_DATA_DIR`), so clearing browser storage does not lose them. Every browser that logs in to the same server sees the same conversations. Data stored in the browser before upgrading is migrated to the server automatically on first load. Sending messages, uploading attachments, and using speech features sends the relevant content through the server to the configured API service.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all server-side conversations and attachments. Exports include conversations and server-stored original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all server-side conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your settings are preserved; the server's API key and files already uploaded to the API service are not affected.

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

[rspack.config.ts](rspack.config.ts) reads `CHAT_DEMO_API_ORIGIN` (default `https://api.deepseek.com`) and `CHAT_DEMO_API_KEY` for the development proxy. Use `createConfig({ apiOrigin, devServer })` to override them programmatically.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
