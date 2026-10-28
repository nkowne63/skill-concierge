import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Desk, DeskError } from '../server/desk.ts'

function withFile(fn: (file: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'concierge-desk-'))
  try {
    return fn(path.join(dir, 'chats.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const status = (code: number) => (e: unknown) => e instanceof DeskError && e.status === code

test('history survives a restart; replies cut off by it are handed out again, queued ones kept', () =>
  withFile((file: string) => {
    let desk = new Desk(file)
    const chat = desk.createChat()
    const first = desk.submit(chat.id, 'first')
    desk.submit(chat.id, 'second')
    assert.equal(desk.next().reply, first.reply.id)

    desk = new Desk(file)
    assert.deepEqual(
      desk.chat(chat.id)!.messages.map((m) => [m.role, m.content, m.status]),
      [['user', 'first', 'done'], ['assistant', '', 'queued'], ['user', 'second', 'done'], ['assistant', '', 'queued']],
    )
    assert.equal(desk.chat(chat.id)!.title, 'first')
    assert.equal(desk.next().question, 'first')
  }))

test('a question sent while its chat is being answered waits, then follows in order; other chats are not blocked', () =>
  withFile((file: string) => {
    const desk = new Desk(file)
    const a = desk.createChat()
    const b = desk.createChat()
    const a1 = desk.submit(a.id, 'a1').reply
    const a2 = desk.submit(a.id, 'a2').reply
    desk.submit(b.id, 'b1')

    assert.equal(desk.next().reply, a1.id)
    assert.equal(desk.next().question, 'b1', 'a2 waits while a1 runs; chat b is free')
    assert.throws(() => desk.next(), status(404))

    desk.reply(a1.id, 'done')
    assert.deepEqual(desk.next(), { thread: a.id, title: 'a1', reply: a2.id, question: 'a2' })
  }))

test('stopping ends only the running reply, and its agent then gets 409', () =>
  withFile((file: string) => {
    const desk = new Desk(file)
    const chat = desk.createChat()
    const r1 = desk.submit(chat.id, 'one').reply
    const r2 = desk.submit(chat.id, 'two').reply
    desk.next()
    desk.progress(r1.id, 'working')
    desk.abort(chat.id)
    assert.equal(r1.status, 'interrupted')
    assert.equal(r2.status, 'queued')
    assert.throws(() => desk.progress(r1.id, 'more'), status(409))
    assert.throws(() => desk.reply(r1.id, 'late'), status(409))
    assert.equal(desk.next().reply, r2.id)
  }))

test('a chat is unread once an answer finishes after it was last read, and reading clears it', () =>
  withFile((file: string) => {
    const desk = new Desk(file)
    const chat = desk.createChat()
    const { reply } = desk.submit(chat.id, 'q')
    desk.next()
    const unread = () => desk.chats().find((c) => c.id === chat.id)!.unread
    assert.equal(unread(), 0, 'a running reply is not new yet')
    desk.chat(chat.id)!.read_at -= 10 // last read before the answer, even within one millisecond
    desk.reply(reply.id, 'a')
    assert.equal(unread(), 1)
    desk.markRead(desk.chat(chat.id)!)
    assert.equal(unread(), 0)
  }))

test('marking a chat unread makes its latest answer new again until it is read; it needs a finished answer', () =>
  withFile((file: string) => {
    const desk = new Desk(file)
    const chat = desk.createChat()
    const { reply } = desk.submit(chat.id, 'q')
    const unread = () => desk.chats().find((c) => c.id === chat.id)!.unread
    assert.throws(() => desk.markUnread(chat.id), status(409), 'the only answer is still queued')
    desk.next()
    desk.reply(reply.id, 'a')
    desk.markRead(desk.chat(chat.id)!)
    assert.equal(unread(), 0)

    desk.markUnread(chat.id)
    assert.equal(unread(), 1)
    assert.equal(new Desk(file).chats().find((c) => c.id === chat.id)!.unread, 1, 'kept across a restart')
    desk.markRead(desk.chat(chat.id)!)
    assert.equal(unread(), 0)
    assert.throws(() => desk.markUnread(chat.id + 999), status(404))
  }))
