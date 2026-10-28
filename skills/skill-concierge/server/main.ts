// Entry point: `node <skill>/server/main.ts [--port N] [--allow-host NAME]... [--status]`, run in the project
// directory. Starts the project's chat server on 127.0.0.1, or reports the one already running for this project;
// `--status` only reports (exit 1 when none runs).
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
// The page is rendered from TSX (app/*.tsx), which Node cannot strip on its own: register the loader before
// those modules load below.
import 'remix/node-tsx'
import { createRequestListener } from 'remix/node-fetch-server'
import { Desk } from './desk.ts'

interface ServerInfo {
  url: string
  pid: number
  workdir: string
  uiDir: string
}

const HOST = '127.0.0.1'
// The running server touches server.json this often; a fresher file means it is up.
const HEARTBEAT_MS = 3000
const skillDir = path.resolve(import.meta.dirname, '..')
const { values: opts } = parseArgs({
  options: { port: { type: 'string' }, 'allow-host': { type: 'string', multiple: true, default: [] }, status: { type: 'boolean' } },
})
const workdir = realpathSync('.')
// One data directory per project: $XDG_STATE_HOME/skill-concierge/projects/<name>-<hash of the real path>.
const projectKey = `${path.basename(workdir).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'root'}-${createHash('sha256').update(workdir).digest('hex').slice(0, 12)}`
const dataDir = path.resolve(
  process.env.CONCIERGE_DATA_DIR ??
    path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'skill-concierge', 'projects', projectKey),
)
const infoFile = path.join(dataDir, 'server.json')
// The port this project last listened on, kept across restarts so an open tab or a proxy keeps working.
const portFile = path.join(dataDir, 'port')
// Up if its PID answers, or, where PIDs of the host are hidden (an agent's sandbox has its own PID namespace),
// if it touched `file` within the last few heartbeats.
const isUp = (pid: number, file: string) => {
  try {
    return process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    try {
      return Date.now() - statSync(file).mtimeMs < 3 * HEARTBEAT_MS
    } catch {
      return false
    }
  }
}
const runningServer = (): ServerInfo | null => {
  const info: ServerInfo | null = existsSync(infoFile) ? JSON.parse(readFileSync(infoFile, 'utf8')) : null
  return info && isUp(info.pid, infoFile) ? info : null
}
const reportRunning = (info: ServerInfo) => {
  console.log(`concierge already running (pid ${info.pid})\nconcierge listening on ${info.url}`)
  process.exit(0)
}

const running = runningServer()
if (running) reportRunning(running)
if (opts.status) {
  console.log('concierge not running')
  process.exit(1)
}

mkdirSync(dataDir, { recursive: true })
// One server per data directory, or two would overwrite each other's chats.json. Whoever creates the lock
// starts; a concurrent start waits for that server's server.json and reports it. A lock whose owner is gone is
// taken over.
const lockFile = path.join(dataDir, 'lock')
const takeLock = (retry = true): boolean => {
  try {
    writeFileSync(lockFile, String(process.pid), { flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  let holder: number
  try {
    holder = Number(readFileSync(lockFile, 'utf8'))
  } catch {
    return retry && takeLock(false) // released in the meantime
  }
  if (isUp(holder, lockFile) || !retry) return false
  rmSync(lockFile, { force: true })
  return takeLock(false)
}
const giveUpAt = Date.now() + 60_000
while (!takeLock()) {
  if (Date.now() > giveUpAt) {
    console.error(`concierge: another start holds ${lockFile} but no server came up; remove it if no server runs`)
    process.exit(1)
  }
  await sleep(500)
  const started = runningServer()
  if (started) reportRunning(started)
}
// The heartbeat: keeps the lock, and later server.json, fresh while this process lives.
setInterval(() => {
  const now = new Date()
  for (const file of [lockFile, infoFile]) if (existsSync(file)) utimesSync(file, now, now)
}, HEARTBEAT_MS).unref()

const desk = new Desk(path.join(dataDir, 'chats.json'))
// The editable UI (workspace app and theme.css), seeded from the template on first start.
const uiDir = path.join(dataDir, 'ui')
if (!existsSync(uiDir)) cpSync(path.join(skillDir, 'template-ui'), uiDir, { recursive: true })
// Imported dynamically: modules that reach app/*.tsx must load after the TSX loader above is registered.
// The chat screen is compiled before the first request and never recompiled (see app/assets.ts).
const ui = await (await import('../app/assets.ts')).createUiAssets(skillDir)
const { createApp } = await import('./app.ts')

// No fixed port: --port N if given, else this project's previous port while it is free, else one the OS picks.
const server = http.createServer()
const listen = (port: number) => {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  server.once('error', reject).listen(port, HOST, resolve)
  return promise
}
const previous = existsSync(portFile) ? Number(readFileSync(portFile, 'utf8')) : 0
if (opts.port) await listen(Number(opts.port))
else await listen(previous).catch((error) => (previous && error.code === 'EADDRINUSE' ? listen(0) : Promise.reject(error)))
server.removeAllListeners('error')
const { port } = server.address() as AddressInfo
writeFileSync(portFile, String(port))
const url = `http://${HOST}:${port}`
const allowHosts = (opts['allow-host'] ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean)
const router = createApp({ desk, workdir, uiDir, allowHosts, ui })
server.on('request', createRequestListener((request) => router.fetch(request)))
writeFileSync(infoFile, JSON.stringify({ url, pid: process.pid, workdir, uiDir } satisfies ServerInfo, null, 2))

const shutdown = () => {
  rmSync(infoFile, { force: true })
  rmSync(lockFile, { force: true })
  server.close()
  server.closeAllConnections()
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
console.log(`concierge listening on ${url}\nproject ${workdir}\ndata ${dataDir}\nUI directory ${uiDir}`)
