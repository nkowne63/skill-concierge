// Chat history and the hand-off of questions to answering agents, kept in one JSON file. A question is saved
// before any agent sees it, so nothing the user sends is lost while nobody is answering.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export type Status = 'queued' | 'running' | 'done' | 'interrupted'

export interface Step {
  text: string
  at: number
}

export interface Message {
  id: number
  role: 'user' | 'assistant'
  content: string
  status: Status
  created_at: number
  updated_at: number
  steps: Step[]
}

export interface Chat {
  id: number
  title: string
  updated_at: number
  read_at: number
  messages: Message[]
}

export interface ChatSummary {
  id: number
  title: string
  updated_at: number
  unread: number
  running: boolean
}

// What `GET /api/agent/next` hands an answering agent.
export interface Question {
  thread: number
  title: string
  reply: number
  question: string
}

interface Data {
  nextId: number
  chats: Chat[]
}

const WAITING_MS = 5000
const isOpen = (m: Message) => m.status === 'queued' || m.status === 'running'

export class DeskError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class Desk {
  readonly file: string
  readonly data: Data
  #lastSeen = 0

  constructor(file: string) {
    this.file = file
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Data) : { nextId: 1, chats: [] }
    // A previous server's agents cannot report back to this one: hand their replies out again.
    for (const chat of this.data.chats) for (const m of chat.messages) if (m.status === 'running') m.status = 'queued'
    this.#save()
  }

  #save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data))
    renameSync(`${this.file}.tmp`, this.file)
  }

  // Whether an agent has polled for questions within the last few seconds.
  status(): { waiting: boolean } {
    return { waiting: Date.now() - this.#lastSeen < WAITING_MS }
  }

  chat(id: number | null): Chat | null {
    return this.data.chats.find((c) => c.id === id) ?? null
  }

  // Newest activity first. An answer is unread when it finished after the chat was last looked at.
  chats(): ChatSummary[] {
    return this.data.chats
      .map((c) => ({
        id: c.id,
        title: c.title,
        updated_at: c.updated_at,
        unread: c.messages.filter((m) => m.role === 'assistant' && !isOpen(m) && m.updated_at > c.read_at).length,
        running: c.messages.some(isOpen),
      }))
      .sort((a, b) => b.updated_at - a.updated_at || b.id - a.id)
  }

  markRead(chat: Chat) {
    if (chat.messages.some((m) => m.updated_at > chat.read_at)) {
      chat.read_at = Date.now()
      this.#save()
    }
  }

  // Makes the latest finished answer new again, as if the chat had not been looked at since it arrived.
  markUnread(chatId: number | null) {
    const chat = this.chat(chatId)
    if (!chat) throw new DeskError(404, 'chat not found')
    const last = chat.messages.findLast((m) => m.role === 'assistant' && !isOpen(m))
    if (!last) throw new DeskError(409, 'no answer to mark unread')
    chat.read_at = Math.min(chat.read_at, last.updated_at - 1)
    this.#save()
  }

  createChat(): Chat {
    const now = Date.now()
    const chat: Chat = { id: this.data.nextId++, title: '新しいチャット', updated_at: now, read_at: now, messages: [] }
    this.data.chats.push(chat)
    this.#save()
    return chat
  }

  submit(chatId: number | null, text: string): { user: Message; reply: Message } {
    const chat = this.chat(chatId)
    if (!chat) throw new DeskError(404, 'chat not found')
    if (chat.messages.length === 0) chat.title = text.split('\n')[0].trim().slice(0, 40) || chat.title
    const now = Date.now()
    const add = (role: Message['role'], content: string, status: Status): Message =>
      ({ id: this.data.nextId++, role, content, status, created_at: now, updated_at: now, steps: [] })
    const user = add('user', text, 'done')
    const reply = add('assistant', '', 'queued')
    chat.messages.push(user, reply)
    chat.updated_at = now
    this.#save()
    return { user, reply }
  }

  // Stops only the reply in progress; questions sent after it stay queued.
  abort(chatId: number | null) {
    const running = this.chat(chatId)?.messages.find((m) => m.status === 'running')
    if (running) this.#finish(running, running.content || '_中断しました_', 'interrupted')
  }

  // The first queued reply of a chat with nothing running, now assigned to the caller. Replies within a chat
  // are answered one at a time and in order; different chats in parallel. 404 while none is waiting.
  next(): Question {
    this.#lastSeen = Date.now()
    for (const chat of this.data.chats) {
      const reply = chat.messages.find(isOpen)
      if (!reply || reply.status !== 'queued') continue
      reply.status = 'running'
      this.#save()
      const question = chat.messages.findLast((m) => m.role === 'user' && m.id < reply.id)
      return { thread: chat.id, title: chat.title, reply: reply.id, question: question?.content ?? '' }
    }
    throw new DeskError(404, 'no question waiting')
  }

  progress(replyId: number | null, text: string) {
    this.#running(replyId).steps.push({ text, at: Date.now() })
    this.#save()
  }

  reply(replyId: number | null, text: string) {
    this.#finish(this.#running(replyId), text, 'done')
  }

  #finish(reply: Message, content: string, status: Status) {
    Object.assign(reply, { content, status, updated_at: Date.now() })
    this.data.chats.find((c) => c.messages.includes(reply))!.updated_at = reply.updated_at
    this.#save()
  }

  // Only the reply an agent is working on accepts reports; a stopped reply tells the agent to quit.
  #running(replyId: number | null): Message {
    const reply = this.data.chats.flatMap((c) => c.messages).find((m) => m.id === replyId && m.role === 'assistant')
    if (!reply) throw new DeskError(404, `no reply #${replyId}`)
    if (reply.status !== 'running') throw new DeskError(409, `reply #${replyId} is ${reply.status}: stop working on it`)
    return reply
  }
}
