// The chat screen: one client entry that hydrates the server-rendered page and then polls /api/state.
// Switching chats is ordinary page navigation; only the open chat and the chat list update in place.
import { clientEntry, on, ref, unsafeHTML, type Handle, type RemixNode } from 'remix/component'

import { renderMarkdown } from './markdown.ts'

interface Message {
  id: number
  role: 'user' | 'assistant'
  content: string
  status: 'queued' | 'running' | 'done' | 'interrupted'
  created_at: number
  steps: { text: string; at: number }[]
}

interface ChatSummary {
  id: number
  title: string
  unread: number
  running: boolean
}

interface State {
  chats: ChatSummary[]
  chat: { id: number; title: string } | null
  messages: Message[]
  agent: { waiting: boolean }
  uiVersion: string
}

// Serializable server data the page starts from (client-entry props).
export interface InitialState extends State {
  project: { name: string; path: string }
}

const POLL_MS = 1500
const STATUS_LABEL: Record<string, string> = { queued: '待機中', running: '処理中', interrupted: '中断' }
const ROLE_LABEL = { user: 'あなた', assistant: 'エージェント' }

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

async function post<T>(url: string, text?: string): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text ?? '' })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`)
  return json
}

export const ConciergeApp = clientEntry(import.meta.url, function ConciergeApp(handle: Handle<InitialState>) {
  const { project } = handle.props
  let state: State = handle.props
  let lastJson = ''
  // Narrow screens show one pane at a time; phones also slide the chat list in as a drawer.
  let view: 'chat' | 'ui' = 'chat'
  let drawerOpen = false
  let error = ''
  // After 未読に戻す the open chat stays unread: polling stops marking it read until the next page load or send.
  let keepUnread = false
  // Progress logs the user opened or closed; others follow the running/done default.
  const toggled = new Map<number, boolean>()
  let messagesEl: HTMLElement | undefined

  async function poll() {
    if (document.hidden) return
    const response = await fetch(`/api/state${state.chat ? `?chat=${state.chat.id}${keepUnread ? '' : '&read'}` : ''}`)
    const json = await response.text()
    if (json === lastJson) return
    lastJson = json
    const next: State = JSON.parse(json)
    const stick = !messagesEl || messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120
    state = next
    const unread = state.chats.reduce((n, c) => n + c.unread, 0)
    document.title = `${unread ? `(${unread}) ` : ''}${project.name} · Concierge`
    await handle.update()
    if (stick && messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight
  }

  handle.queueTask(() => {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight
    const timer = setInterval(() => void poll().catch(() => {}), POLL_MS)
    handle.signal.addEventListener('abort', () => clearInterval(timer))
    document.addEventListener('keydown', (event) => event.key === 'Escape' && show({ drawer: false }), { signal: handle.signal })
  })

  function show(next: { view?: 'chat' | 'ui'; drawer?: boolean }) {
    view = next.view ?? view
    drawerOpen = next.drawer ?? drawerOpen
    handle.update()
  }

  async function send(input: HTMLTextAreaElement) {
    const text = input.value.trim()
    if (!text) return
    try {
      const chatId = state.chat?.id ?? (await post<{ chat: { id: number } }>('/api/chats')).chat.id
      await post(`/api/chats/${chatId}/messages`, text)
      input.value = ''
      error = ''
      keepUnread = false
      if (!state.chat) location.assign(`/c/${chatId}`)
      else await poll()
    } catch (caught) {
      error = `送信できませんでした: ${caught instanceof Error ? caught.message : caught}`
      handle.update()
    }
  }

  async function markUnread(chatId: number) {
    try {
      await post(`/api/chats/${chatId}/unread`)
      keepUnread = true
      error = ''
      await poll()
    } catch (caught) {
      error = `未読に戻せませんでした: ${caught instanceof Error ? caught.message : caught}`
      handle.update()
    }
  }

  function renderMessage(message: Message): RemixNode {
    const running = message.status === 'running'
    const open = toggled.get(message.id) ?? running
    const latest = message.steps.at(-1)
    return (
      <article key={message.id} class={`msg msg-${message.role}`} id={`msg-${message.id}`} data-status={message.status}>
        <header>
          <span class="msg-who">{ROLE_LABEL[message.role]}</span>
          <span class="msg-time">{clock(message.created_at)}</span>
          {STATUS_LABEL[message.status] ? <span class={`msg-status status-${message.status}`}>{STATUS_LABEL[message.status]}</span> : null}
        </header>
        {message.steps.length > 0 || running ? (
          <details class="steps" open={open}>
            <summary mix={on('click', () => void toggled.set(message.id, !open))}>
              {running ? <><span class="spinner" /> {latest?.text ?? '開始しています…'}</> : `進捗ログ ${message.steps.length} 件`}
            </summary>
            <ol>
              {message.steps.map((step, i) => (
                <li key={i} class="step">
                  <span class="step-icon">✎</span>
                  <span class="step-time">{clock(step.at)}</span> {step.text}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
        {message.status === 'queued' ? (
          <p class="note">エージェントの受付待ちです。前の返答が終わり、エージェントが受け付けると始まります。</p>
        ) : message.content || !running ? (
          <div class="md" innerHTML={unsafeHTML(renderMarkdown(message.content))} />
        ) : null}
      </article>
    )
  }

  return () => {
    const { chats, chat, messages, agent, uiVersion } = state
    const unreadElsewhere = chats.reduce((n, c) => n + (c.id === chat?.id ? 0 : c.unread), 0)
    const canMarkUnread =
      chat !== null &&
      !chats.find((c) => c.id === chat.id)?.unread &&
      messages.some((m) => m.role === 'assistant' && m.status !== 'queued' && m.status !== 'running')
    return (
      <div id="shell" data-view={view} data-drawer={drawerOpen ? 'open' : 'closed'}>
        <link rel="stylesheet" id="theme-css" href={`/ui/theme.css?v=${uiVersion}`} />
        <aside id="sidebar" aria-label="チャット一覧">
          <div class="sidebar-head">
            <div class="brand">
              Concierge <span class="project" title={project.path}>{project.name}</span>
            </div>
            <button type="button" class="icon drawer-only" aria-label="閉じる" mix={on('click', () => show({ drawer: false }))}>✕</button>
          </div>
          <a id="new-chat" class="button" href="/new">＋ 新しいチャット</a>
          <ul id="chat-list">
            {chats.length === 0 ? <li class="note">チャットはまだありません</li> : null}
            {chats.map((c) => (
              <li key={c.id} class={`chat-item${c.id === chat?.id ? ' current' : ''}${c.unread ? ' unread' : ''}`}>
                <a href={`/c/${c.id}`}>
                  <span class="chat-title">{c.title}</span>
                  {c.running ? <span class="spinner" title="処理中" /> : null}
                  {c.unread ? <span class="badge" title={`新着 ${c.unread} 件`}>{c.unread}</span> : null}
                </a>
              </li>
            ))}
          </ul>
          <div id="agent-status" data-state={agent.waiting ? 'waiting' : 'offline'}>
            エージェント: {agent.waiting ? '待ち受け中' : '未接続'}
          </div>
        </aside>
        <div class="scrim" mix={on('click', () => show({ drawer: false }))} />
        <main id="workspace" aria-label="UI ワークスペース">
          <div class="bar">
            <button type="button" class="narrow-only" mix={on('click', () => show({ view: 'chat' }))}>← チャット</button>
            <span class="bar-title">UI ワークスペース</span>
          </div>
          <iframe id="app-frame" title="編集可能な UI" sandbox="allow-scripts allow-forms allow-modals" src={`/ui/index.html?v=${uiVersion}`} />
        </main>
        <section id="chat-panel">
          <header class="bar">
            <button type="button" class="icon drawer-only" id="open-drawer" aria-label="チャット一覧" mix={on('click', () => show({ drawer: true }))}>
              ☰{unreadElsewhere ? <span class="badge dot">{unreadElsewhere}</span> : null}
            </button>
            <h1 id="chat-title" class="bar-title">{chat?.title ?? '新しいチャット'}</h1>
            {messages.some((m) => m.status === 'running') ? (
              <button type="button" id="abort" mix={on('click', () => void post(`/api/chats/${chat?.id}/abort`).then(poll))}>停止</button>
            ) : null}
            {chat && canMarkUnread ? (
              <button type="button" id="mark-unread" title="最後の返答を未読に戻す" mix={on('click', () => void markUnread(chat.id))}>未読に戻す</button>
            ) : null}
            <button type="button" class="icon narrow-only" aria-label="UI ワークスペース" mix={on('click', () => show({ view: 'ui', drawer: false }))}>UI</button>
          </header>
          <div
            id="messages"
            mix={[
              ref((node) => (messagesEl = node)),
              on('click', (event) => {
                const link = (event.target as Element).closest('.md a[href]') as HTMLAnchorElement | null
                if (link && link.origin !== location.origin) {
                  event.preventDefault()
                  window.open(link.href, '_blank', 'noopener')
                }
              }),
            ]}
          >
            {messages.length === 0 ? <p class="note">質問や依頼を送ると、エージェントが答えます。</p> : messages.map(renderMessage)}
          </div>
          <form
            id="composer"
            mix={on('submit', (event) => {
              event.preventDefault()
              void send(event.currentTarget.elements.namedItem('text') as HTMLTextAreaElement)
            })}
          >
            <textarea
              id="composer-input"
              name="text"
              rows={2}
              placeholder="質問や依頼を入力"
              aria-label="質問や依頼"
              mix={on('keydown', (event) => {
                // Enter sends on keyboards; touch keyboards keep Enter for new lines and use the button.
                if (event.key !== 'Enter' || event.shiftKey || event.isComposing || matchMedia('(pointer: coarse)').matches) return
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              })}
            />
            <button type="submit" id="send-button">送信</button>
            <p class={error ? 'hint error' : 'hint'}>{error || 'Enter で送信 / Shift+Enter で改行'}</p>
          </form>
        </section>
      </div>
    )
  }
})
