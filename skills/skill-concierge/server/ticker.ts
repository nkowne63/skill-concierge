// Agent-side helper: `node <skill>/server/ticker.ts --url U --reply R --file STATUS [--every 60]`.
// Keeps a long reply's progress fresh while the agent is busy elsewhere (subagents, builds, test runs):
// every --every seconds it posts the first line of STATUS as a progress line of reply R, prefixed with the
// minutes elapsed. The agent only rewrites STATUS when its step changes. Exits 0 when the reply stops
// accepting progress (answered, or the user pressed 停止: HTTP 409/404); connection failures (server
// restarting) are retried on the next tick.
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const { values: opts } = parseArgs({
  options: { url: { type: 'string' }, reply: { type: 'string' }, file: { type: 'string' }, every: { type: 'string', default: '60' } },
})
const every = Number(opts.every)
if (!opts.url || !/^\d+$/.test(opts.reply ?? '') || !opts.file || !(every >= 1)) {
  console.error('usage: node server/ticker.ts --url U --reply R --file STATUS [--every SECONDS]')
  process.exit(2)
}

const endpoint = `${opts.url.replace(/\/$/, '')}/api/agent/replies/${opts.reply}/progress`
const started = Date.now()

function status(): string {
  try {
    return readFileSync(opts.file!, 'utf8').split('\n').find((line) => line.trim())?.trim() ?? ''
  } catch {
    return ''
  }
}

while (true) {
  await sleep(every * 1000)
  const line = status()
  if (!line) continue
  const minutes = Math.round((Date.now() - started) / 60000)
  try {
    const response = await fetch(endpoint, { method: 'POST', body: `[${minutes}m] ${line}` })
    if (response.status === 409 || response.status === 404) process.exit(0)
  } catch {
    // server restarting: try again next tick
  }
}
