// Scripted stand-in for the model APIs used by Claude Code (Anthropic Messages), Codex (OpenAI Responses)
// and omp (configured for Anthropic Messages). No real model is called: every request is answered from a
// fixed script that runs the agent-side recipes of the skill-concierge skill through the agent's own shell
// tool. The same server doubles as the agents' HTTP(S) proxy so that any attempt to reach the internet is
// recorded and refused.
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import zlib from 'node:zlib'

// Request bodies are whatever the agents send; they are read loosely.
type Wire = any
interface Tool {
  name?: string
  type?: string
  input_schema?: Schema
  parameters?: Schema
}
interface Schema {
  properties?: Record<string, { type?: string | string[] }>
  required?: string[]
}
type Turn = { command: string; text?: undefined } | { text: string; command?: undefined }

export interface MockOptions {
  skillName: string
  skillDescription: string
  /** The concierge server URL, written literally into every scripted command. */
  conciergeUrl: string
  /** Markdown the scripted answer posts. */
  answer: string
  /** How the scripted commands invoke curl (Claude Code's sandbox needs `curl --noproxy ''`). */
  curl?: string
  log?: (line: string) => void
}

export interface RequestEntry {
  method?: string
  path: string
  model?: string
  tools: string[]
  /** Script step served, or null for a request without a shell tool (titles, probes, …). */
  step: number | null
  body: Wire
}

export interface MockState {
  /** Whether a main-agent request (one offering a shell tool) named the skill and carried its description
   * (at least its first DESCRIPTION_MIN_CHARS characters: omp truncates long descriptions in its listing). */
  discovered: boolean
  /** Longest prefix of the description found in a main-agent request. */
  descriptionChars: number
  mainRequests: number
  /** Highest script step served; 3 is the final text message. */
  lastStep: number
  replyId: number | null
  /** Proxy requests (CONNECT or absolute-URI) the agents attempted; all of them are refused. */
  outbound: string[]
  requests: RequestEntry[]
  errors: string[]
}

// Shell tools by name, in preference order: Claude Code `Bash`, omp `bash` (sent to Anthropic-style APIs as
// `_bash`), Codex `exec_command` / `shell_command` / `shell`.
export const SHELL_TOOLS = ['Bash', 'bash', 'exec_command', 'shell_command', 'shell']

// omp lists skills with descriptions cut to roughly 90 characters plus an ellipsis.
const DESCRIPTION_MIN_CHARS = 60

function findShellTool(tools: Tool[] | undefined, usable: (tool: Tool) => unknown): Tool | undefined {
  const candidates = (tools ?? []).filter(usable)
  for (const name of SHELL_TOOLS) {
    const tool = candidates.find((t) => t.name?.replace(/^_+/, '') === name)
    if (tool) return tool
  }
}

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`

export interface MockLlm {
  url: string
  state: MockState
  close: () => Promise<void>
}

export async function startMockLlm({ skillName, skillDescription, conciergeUrl, answer, curl = 'curl', log = () => {} }: MockOptions): Promise<MockLlm> {
  const state: MockState = {
    discovered: false,
    descriptionChars: 0,
    mainRequests: 0,
    lastStep: -1,
    replyId: null,
    outbound: [],
    requests: [],
    errors: [],
  }

  const server = http.createServer(async (req, res) => {
    if (/^[a-z]+:\/\//i.test(req.url ?? '')) return refuseProxy(req.url, () => res.writeHead(403).end('blocked by agent-e2e'))
    const url = new URL(req.url ?? '/', 'http://mock')
    let body: Wire = null
    try {
      const raw = await readBody(req)
      if (raw.length) body = JSON.parse(raw.toString('utf8'))
    } catch (error) {
      state.errors.push(`${req.method} ${url.pathname}: unreadable body (${(error as Error).message})`)
    }
    const tools = ((body?.tools ?? []) as Tool[]).map((t) => t.name ?? t.type ?? '?')
    const entry: RequestEntry = { method: req.method, path: url.pathname, model: body?.model, tools, step: null, body }
    state.requests.push(entry)
    try {
      if (req.method === 'POST' && url.pathname.endsWith('/messages/count_tokens')) return json(res, { input_tokens: 1000 })
      if (req.method === 'POST' && url.pathname.endsWith('/messages')) return anthropic(res, body ?? {}, entry)
      if (req.method === 'POST' && url.pathname.endsWith('/responses')) return responses(res, body ?? {}, entry)
      if (req.method === 'GET' && url.pathname.endsWith('/models')) return json(res, { object: 'list', data: [], models: [] })
      log(`mock: generic reply to ${req.method} ${url.pathname}`)
      return json(res, {})
    } catch (error) {
      state.errors.push(`${req.method} ${url.pathname}: ${(error as Error).stack}`)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  server.on('connect', (req, socket) => {
    socket.on('error', () => {})
    refuseProxy(req.url, () => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'))
  })
  server.on('clientError', (_error, socket) => socket.destroy())

  function refuseProxy(target: string | undefined, refuse: () => void) {
    state.outbound.push(target ?? '?')
    log(`mock: refused outbound request to ${target}`)
    refuse()
  }

  // Decides the next turn of a main-agent conversation from the tool results it already contains.
  function scriptTurn(body: Wire, toolResults: string[], entry: RequestEntry): Turn {
    state.mainRequests += 1
    const haystack = strings(body).join('\n')
    const chars = longestPrefixIn(haystack, skillDescription)
    state.descriptionChars = Math.max(state.descriptionChars, chars)
    if (haystack.includes(skillName) && chars >= Math.min(skillDescription.length, DESCRIPTION_MIN_CHARS)) state.discovered = true
    const step = toolResults.length
    entry.step = step
    state.lastStep = Math.max(state.lastStep, step)
    // The URL is literal in every command so prefix allow rules such as `Bash(curl:*)` match.
    const U = conciergeUrl
    if (step === 0) return { command: `until ${curl} -fs "${U}/api/agent/next"; do sleep 1; done` }
    const match = toolResults[0].match(/"reply"\s*:\s*(\d+)/)
    if (!match) return { text: `The wait printed no reply id:\n${toolResults[0]}` }
    const R = (state.replyId = Number(match[1]))
    if (step === 1) return { command: `${curl} -sS --fail-with-body --data-binary 'checking' "${U}/api/agent/replies/${R}/progress"` }
    if (step === 2)
      return { command: `${curl} -sS --fail-with-body --data-binary @- "${U}/api/agent/replies/${R}/answer" <<'EOF'\n${answer}\nEOF` }
    return { text: `Answered concierge reply #${R}.` }
  }

  // Anthropic Messages API (Claude Code, omp).
  function anthropic(res: http.ServerResponse, body: Wire, entry: RequestEntry) {
    const tool = findShellTool(body.tools, (t) => t.input_schema)
    const results: string[] = []
    for (const m of body.messages ?? [])
      if (m.role === 'user' && Array.isArray(m.content))
        for (const block of m.content) if (block.type === 'tool_result') results.push(strings(block.content).join('\n'))
    const turn: Turn = tool ? scriptTurn(body, results, entry) : { text: 'OK' }
    const block =
      tool && turn.command !== undefined
        ? { type: 'tool_use', id: id('toolu'), name: tool.name, input: shellArgs(tool.input_schema, turn.command) }
        : { type: 'text', text: turn.text }
    const message = {
      id: id('msg'),
      type: 'message',
      role: 'assistant',
      model: body.model ?? 'mock',
      content: [block],
      stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }
    if (!body.stream) return json(res, message)
    const sse = startSse(res)
    sse('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 1 } } })
    if (block.type === 'tool_use') {
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { ...block, input: {} } })
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    } else {
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } })
    }
    sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } })
    sse('message_stop', { type: 'message_stop' })
    res.end()
  }

  // OpenAI Responses API (Codex).
  function responses(res: http.ServerResponse, body: Wire, entry: RequestEntry) {
    const tool = findShellTool(body.tools, (t) => t.type === 'function')
    const input: Wire[] = Array.isArray(body.input) ? body.input : []
    const results = input.filter((item) => /_call_output$/.test(item.type ?? '')).map((item) => strings(item.output).join('\n'))
    const turn: Turn = tool ? scriptTurn(body, results, entry) : { text: 'OK' }
    const item =
      tool && turn.command !== undefined
        ? { type: 'function_call', id: id('fc'), call_id: id('call'), name: tool.name, arguments: JSON.stringify(shellArgs(tool.parameters, turn.command)), status: 'completed' }
        : { type: 'message', id: id('msg'), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: turn.text, annotations: [] }] }
    const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 120 }
    const response = { id: id('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: body.model ?? 'mock', output: [item], usage }
    if (body.stream === false) return json(res, response)
    const sse = startSse(res)
    sse('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })
    sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item })
    if (item.type === 'message')
      sse('response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: turn.text })
    sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item })
    sse('response.completed', { type: 'response.completed', response })
    res.end()
  }

  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    close: () => {
      const closed = Promise.withResolvers<void>()
      server.closeAllConnections()
      server.close(() => closed.resolve())
      return closed.promise
    },
  }
}

// Length of the longest prefix of `needle` that occurs in `haystack` (occurrence is monotonic in length).
function longestPrefixIn(haystack: string, needle: string): number {
  let lo = 0
  let hi = needle.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (haystack.includes(needle.slice(0, mid))) lo = mid
    else hi = mid - 1
  }
  return lo
}

// Arguments for the shell tool's JSON schema: the command (string, or argv for array-typed schemas) plus
// placeholders for any other required property, and a long yield for Codex's `exec_command`.
function shellArgs(schema: Schema | undefined, command: string): Record<string, unknown> {
  const props = schema?.properties ?? {}
  const key = ['command', 'cmd'].find((k) => k in props) ?? 'command'
  const args: Record<string, unknown> = { [key]: props[key]?.type === 'array' ? ['bash', '-lc', command] : command }
  for (const name of schema?.required ?? []) {
    if (name in args) continue
    const type = [props[name]?.type].flat()[0]
    args[name] = type === 'number' || type === 'integer' ? 60000 : type === 'boolean' ? false : type === 'array' ? [] : type === 'object' ? {} : 'Running the skill-concierge recipe'
  }
  if ('yield_time_ms' in props) args.yield_time_ms = 30000
  return args
}

// Every string inside a JSON value, depth first.
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) strings(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out)
  return out
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)
  switch (req.headers['content-encoding']) {
    case 'zstd':
      return zlib.zstdDecompressSync(raw)
    case 'gzip':
      return zlib.gunzipSync(raw)
    case 'br':
      return zlib.brotliDecompressSync(raw)
    case 'deflate':
      return zlib.inflateSync(raw)
    default:
      return raw
  }
}

function json(res: http.ServerResponse, value: unknown) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
}

function startSse(res: http.ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  return (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}
