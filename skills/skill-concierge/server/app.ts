// HTTP surface: the server-rendered page, the JSON API the page polls, the API agents answer through,
// the workspace app's data, and file serving.
import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { RemixNode } from 'remix/component'
import { openLazyFile } from 'remix/fs'
import { render } from 'remix/middleware/render'
import { createFileResponse } from 'remix/response/file'
import { createRedirectResponse } from 'remix/response/redirect'
import { createRouter } from 'remix/router'
import type { UiAssets } from '../app/assets.ts'
import { conciergePage } from '../app/page.tsx'
import { type Desk, DeskError } from './desk.ts'
import { fileWithin, readPlainFile, writePlainFile } from './files.ts'

export interface AppOptions {
  desk: Desk
  workdir: string
  uiDir: string
  allowHosts: string[]
  ui: UiAssets
}

type Next = () => Response | Promise<Response>
// `context.render` as installed by the render middleware.
type Render = (node: RemixNode, init?: ResponseInit) => Response | Promise<Response>

// Applied to every agent-editable file so it runs in an opaque origin even when opened directly.
// CORS is open because module scripts inside the sandboxed (origin "null") frame are fetched in CORS mode.
const UI_HEADERS = {
  'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-modals; default-src 'self' 'unsafe-inline' data: blob:",
  'Access-Control-Allow-Origin': '*',
}

const hostname = (value: string) => URL.parse(value)?.hostname ?? ''
const idParam = (value: string | null | undefined) =>
  Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null

// Reject DNS-rebinding hosts and cross-site writes: only this machine's names, plus any name the operator
// allows (e.g. a `tailscale serve` name proxying to it).
function localOnly(allowHosts: string[]) {
  const allowed = new Set(['127.0.0.1', 'localhost', ...allowHosts])
  return ({ request }: { request: Request }, next: Next) => {
    if (!allowed.has(hostname(`http://${request.headers.get('host')}`))) return new Response('forbidden host', { status: 403 })
    const origin = request.headers.get('origin')
    const workspaceData = new URL(request.url).pathname.startsWith('/ui-data/') // open to any origin (see below)
    if (!['GET', 'HEAD'].includes(request.method) && origin && !allowed.has(hostname(origin)) && !workspaceData) {
      return new Response('cross-origin request rejected', { status: 403 })
    }
    return next()
  }
}

// Bodies are plain text, so `curl --data-binary @- … <<'EOF'` can post Markdown as is.
async function readText(request: Request) {
  const text = (await request.text()).trim()
  if (!text) throw new DeskError(400, 'empty text')
  return text
}

// Changes whenever a file in the editable UI is added, removed, or rewritten; the page reloads the UI then.
function uiVersion(dir: string) {
  const hash = createHash('sha256')
  for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()) {
    const { mtimeMs, size } = statSync(path.join(dir, file))
    hash.update(`${file}\0${mtimeMs}\0${size}\0`)
  }
  return hash.digest('hex').slice(0, 12)
}

async function serveFrom(root: string, relative: string | undefined, request: Request, headers: Record<string, string> = {}) {
  const full = fileWithin(root, relative || 'index.html')
  if (!full) return new Response('not found', { status: 404 })
  const response = await createFileResponse(openLazyFile(full), request, { etag: false, lastModified: false })
  response.headers.set('Cache-Control', 'no-store')
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value)
  return response
}

export function createApp({ desk, workdir, uiDir, allowHosts, ui }: AppOptions) {
  const router = createRouter({ middleware: [localOnly(allowHosts), render({ assets: ui.assets })] })
  const project = { name: path.basename(workdir) || workdir, path: workdir }
  const uiDataDir = path.join(path.dirname(uiDir), 'ui-data')

  // Everything the page shows. The page marks the open chat read (`read`); agents reading it do not.
  const state = (chatId: number | null, read = false) => {
    const chat = desk.chat(chatId)
    if (chat && read) desk.markRead(chat)
    return {
      chats: desk.chats(),
      chat: chat && { id: chat.id, title: chat.title },
      messages: chat?.messages ?? [],
      agent: desk.status(),
      uiVersion: uiVersion(uiDir),
      uiDir,
    }
  }
  const page = ({ render }: { render: Render }, chatId: number | null) =>
    render(conciergePage({ state: { ...state(chatId, true), project }, scriptEntry: ui.scriptEntry, stylesheet: ui.stylesheet }), {
      headers: { 'Cache-Control': 'no-store' },
    })
  // JSON response of `run`'s result; DeskError becomes its HTTP status.
  const json = async (run: () => unknown) => {
    try {
      return Response.json((await run()) ?? { ok: true })
    } catch (error) {
      if (error instanceof DeskError) return Response.json({ error: error.message }, { status: error.status })
      throw error
    }
  }

  router.get('/', (context) => {
    const latest = desk.chats()[0]
    return latest ? createRedirectResponse(`/c/${latest.id}`) : page(context, null)
  })
  router.get('/new', (context) => page(context, null))
  router.get('/c/:id', (context) => {
    const id = idParam(context.params.id)
    return desk.chat(id) ? page(context, id) : createRedirectResponse('/')
  })

  router.get('/api/state', ({ url }) => json(() => state(idParam(url.searchParams.get('chat')), url.searchParams.has('read'))))
  router.post('/api/chats', () => json(() => ({ chat: desk.createChat() })))
  router.post('/api/chats/:id/messages', ({ params, request }) => json(async () => desk.submit(idParam(params.id), await readText(request))))
  router.post('/api/chats/:id/abort', ({ params }) => json(() => desk.abort(idParam(params.id))))
  router.post('/api/chats/:id/unread', ({ params }) => json(() => desk.markUnread(idParam(params.id))))

  // 404 while nothing is waiting, so `until curl -fs …/api/agent/next; do sleep 1; done` waits for one.
  router.get('/api/agent/next', () => json(() => desk.next()))
  router.post('/api/agent/replies/:id/progress', ({ params, request }) => json(async () => desk.progress(idParam(params.id), await readText(request))))
  router.post('/api/agent/replies/:id/answer', ({ params, request }) => json(async () => desk.reply(idParam(params.id), await readText(request))))

  router.get('/assets/*path', async ({ request }) => (await ui.assets.fetch(request)) ?? new Response('not found', { status: 404 }))
  router.get('/ui/*path', ({ params, request }) => serveFrom(uiDir, params.path, request, UI_HEADERS))

  // The workspace app's saved data (ui.md): <data>/ui-data/<name>.json. Open to any origin: the sandboxed app
  // has an opaque origin ("null"), and the server is meant for one person. CORS as for UI_HEADERS.
  const uiData = (handler: (file: string, request: Request) => Response | Promise<Response>) =>
    async ({ params, request }: { params: { name: string }; request: Request }) => {
      const response = /^[\w-]{1,64}$/.test(params.name)
        ? await handler(`${params.name}.json`, request)
        : new Response('bad name', { status: 400 })
      response.headers.set('Access-Control-Allow-Origin', '*')
      return response
    }
  router.get('/ui-data/:name', uiData((file) => {
    const saved = readPlainFile(uiDataDir, file)
    return saved
      ? new Response(saved, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
      : new Response(null, { status: 204 }) // nothing saved yet; unlike 404 it logs no console error
  }))
  router.post('/ui-data/:name', uiData(async (file, request) => {
    writePlainFile(uiDataDir, file, await request.text())
    return new Response(null, { status: 204 })
  }))
  return router
}
