#!/usr/bin/env node
// End-to-end check of the skill-concierge skill against a real coding-agent CLI driven by a scripted mock
// model (no real model API is called):
//
//   node ci/agent-e2e.ts <claude|claude-sandbox|codex|omp> [--skill-dir DIR] [--keep]
//
// Starts the concierge server in a temporary project, posts a question, installs the skill (a symlink to
// skills/skill-concierge, or to --skill-dir) into a temporary HOME, and runs the agent non-interactively
// against ci/mock-llm.ts. The mock answers by running the skill's agent-side recipes through the agent's
// shell tool. Checks: the agent showed the skill (name and description) to the model, the reply is done
// with the expected Markdown, exactly one progress step was posted, and the agent finished the session.
// No agent runs with full-access permissions. Real API keys are not passed on; all non-loopback HTTP(S)
// goes to the mock as a proxy and is refused, and an attempt to reach a vendor model API fails the run.
import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { type MockLlm, type MockOptions, SHELL_TOOLS, startMockLlm } from './mock-llm.ts'

const AGENT_TIMEOUT_MS = 240_000
const repo = path.resolve(import.meta.dirname, '..')
const skillSource = path.join(repo, 'skills', 'skill-concierge')
// Hosts of the model APIs the agents would call by default; any attempt to reach them fails the run.
const MODEL_API_HOSTS = /(^|\.)(anthropic\.com|claude\.ai|openai\.com|chatgpt\.com)(:\d+)?$/i

interface Ctx {
  home: string
  codexHome: string
  mockUrl: string
}
interface Run {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  ms: number
}
/**
 * Per-agent setup. `prepare` writes config into the temporary HOME and returns the CLI arguments; `mock`
 * shapes the scripted commands; `checkOutput` returns failures found in the agent's output.
 */
interface Agent {
  bin: string
  skillPath: (home: string) => string
  env: (mockUrl: string, ctx: Ctx) => Record<string, string>
  mock?: Pick<MockOptions, 'curl'>
  prepare: (ctx: Ctx, prompt: string) => string[]
  checkOutput?: (run: Run) => string[]
}
interface Message {
  id: number
  status: string
  content: string
  steps: { text: string }[]
}

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'skill-dir': { type: 'string' }, keep: { type: 'boolean', default: false } },
})
const agentName = positionals[0]

// Claude Code never gets bypassPermissions. `claude`: default permission mode with an allowlist that permits
// no Bash beyond curl/sleep/timeout/node. `claude-sandbox`: the Bash sandbox with network limited to
// loopback and no Bash allow rule at all; its proxy is the only route to 127.0.0.1, so curl needs
// `--noproxy ''`. Both fail on any entry in the stream-json result's `permission_denials`.
const claude = (sandbox: boolean): Agent => ({
  bin: 'claude',
  skillPath: (home) => path.join(home, '.claude', 'skills', 'skill-concierge'),
  env: (mockUrl) => ({
    ANTHROPIC_BASE_URL: mockUrl,
    ANTHROPIC_API_KEY: 'sk-ant-mock-not-a-real-key',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }),
  mock: sandbox ? { curl: "curl --noproxy ''" } : {},
  prepare: (ctx, prompt) => {
    if (sandbox) {
      const settings = {
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          network: { allowedDomains: ['127.0.0.1', 'localhost'] },
        },
      }
      mkdirSync(path.join(ctx.home, '.claude'), { recursive: true })
      writeFileSync(path.join(ctx.home, '.claude', 'settings.json'), JSON.stringify(settings, null, 2))
    }
    const allowed = sandbox ? ['Read', 'Skill'] : ['Bash(curl:*)', 'Bash(sleep:*)', 'Read', 'Skill']
    return ['-p', `/skill-concierge ${prompt}`, '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-4-5', '--allowedTools', ...allowed]
  },
  checkOutput: (run) => {
    const events = run.stdout.split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
    const result = events.findLast((e) => e.type === 'result')
    if (!result) return ['claude printed no stream-json result event']
    return (result.permission_denials ?? []).map(
      (d: { tool_name: string; tool_input: unknown }) => `permission denied: ${d.tool_name} ${JSON.stringify(d.tool_input)}`,
    )
  },
})

const AGENTS: Record<string, Agent> = {
  claude: claude(false),
  'claude-sandbox': claude(true),
  codex: {
    bin: 'codex',
    skillPath: (home) => path.join(home, '.agents', 'skills', 'skill-concierge'),
    env: (_mockUrl, ctx) => ({ CODEX_HOME: ctx.codexHome, MOCK_API_KEY: 'mock-not-a-real-key' }),
    prepare: (ctx, prompt) => {
      mkdirSync(ctx.codexHome, { recursive: true })
      // The localhost-only permission profile the skill ships (no danger-full-access), installed as SKILL.md says.
      copyFileSync(path.join(skillSource, 'codex', 'concierge.config.toml'), path.join(ctx.codexHome, 'concierge.config.toml'))
      writeFileSync(
        path.join(ctx.codexHome, 'config.toml'),
        [
          'model = "mock-model"',
          'model_provider = "mock"',
          '',
          // No plugin marketplace sync (github.com, chatgpt.com) and no metrics export (ab.chatgpt.com).
          '[features]',
          'plugins = false',
          'remote_plugin = false',
          'apps = false',
          '',
          '[analytics]',
          'enabled = false',
          '',
          '[model_providers.mock]',
          'name = "Mock"',
          `base_url = "${ctx.mockUrl}/v1"`,
          'wire_api = "responses"',
          'env_key = "MOCK_API_KEY"',
          '',
        ].join('\n'),
      )
      return ['exec', '--skip-git-repo-check', '-p', 'concierge', `$skill-concierge ${prompt}`]
    },
  },
  omp: {
    bin: 'omp',
    skillPath: (home) => path.join(home, '.omp', 'agent', 'skills', 'skill-concierge'),
    env: () => ({ MOCK_API_KEY: 'mock-not-a-real-key', PI_NO_TITLE: '1', OMP_SKIP_SETUP: '1', OTEL_SDK_DISABLED: 'true' }),
    prepare: (ctx, prompt) => {
      const agentDir = path.join(ctx.home, '.omp', 'agent')
      mkdirSync(agentDir, { recursive: true })
      writeFileSync(
        path.join(agentDir, 'models.yml'),
        [
          'providers:',
          '  mock:',
          `    baseUrl: ${ctx.mockUrl}`,
          '    apiKey: MOCK_API_KEY',
          '    api: anthropic-messages',
          '    models:',
          '      - id: mock-model',
          '        name: Mock',
          '        reasoning: false',
          '        input: [text]',
          '        contextWindow: 200000',
          '        maxTokens: 8192',
          '',
        ].join('\n'),
      )
      return ['-p', '--no-session', '--model', 'mock/mock-model', `Use the skill-concierge skill. ${prompt}`]
    },
  },
}

const agent = AGENTS[agentName]
if (!agent) {
  console.error(`usage: node ci/agent-e2e.ts <${Object.keys(AGENTS).join('|')}> [--skill-dir DIR] [--keep]`)
  process.exit(2)
}

const say = (line: string) => console.error(`[agent-e2e ${agentName}] ${line}`)
const entry = path.join(skillSource, 'server', 'main.ts')
if (!existsSync(path.join(skillSource, 'node_modules'))) throw new Error(`run \`npm ci\` in ${skillSource} first`)
const frontmatter = readFileSync(path.join(skillSource, 'SKILL.md'), 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
const skillDescription = frontmatter.match(/^description:\s*(.+)$/m)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2')
if (!skillDescription) throw new Error('SKILL.md has no frontmatter description')

const tmp = mkdtempSync(path.join(os.tmpdir(), `concierge-e2e-${agentName}-`))
const home = path.join(tmp, 'home')
const project = path.join(tmp, 'project')
for (const dir of [home, project, path.join(tmp, 'tmp')]) mkdirSync(dir, { recursive: true })
const ctx: Ctx = { home, codexHome: path.join(tmp, 'codex-home'), mockUrl: '' }

const children = new Set<ChildProcess>()
let mock: MockLlm | undefined
const failures: string[] = []
try {
  const version = await capture(agent.bin, ['--version'], { env: { PATH: process.env.PATH, HOME: home } })
  say(`${agent.bin} ${version.trim()}`)

  const skillLink = agent.skillPath(home)
  mkdirSync(path.dirname(skillLink), { recursive: true })
  symlinkSync(path.resolve(opts['skill-dir'] ?? skillSource), skillLink)

  const U = await startConcierge(entry)
  say(`concierge at ${U}`)
  const chat: number = (await api(U, 'POST', '/api/chats')).chat.id
  const question = 'CIの確認です。このプロジェクトは何ですか?'
  const replyId: number = (await api(U, 'POST', `/api/chats/${chat}/messages`, question)).reply.id

  const nonce = randomUUID()
  const answer = [
    `## Concierge CI (${agentName})`,
    '',
    '- The quoted heredoc keeps `$HOME`, `$(date)` and `\\n` literal.',
    `- nonce: ${nonce}`,
  ].join('\n')
  mock = await startMockLlm({ skillName: 'skill-concierge', skillDescription, conciergeUrl: U, answer, ...agent.mock, log: say })
  const mockUrl = (ctx.mockUrl = mock.url)

  const args = agent.prepare(ctx, `Answer the question waiting on the Concierge server at ${U}.`)
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: home,
    USER: os.userInfo().username,
    LOGNAME: os.userInfo().username,
    SHELL: '/bin/bash',
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    TMPDIR: path.join(tmp, 'tmp'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    // Everything that is not loopback goes through the mock, which records and refuses it.
    ...Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].flatMap((k) => [[k, mockUrl], [k.toLowerCase(), mockUrl]])),
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    ...agent.env(mockUrl, ctx),
  }
  say(`running: ${agent.bin} ${args.map((a) => JSON.stringify(a)).join(' ')}`)
  const run = await runAgent(agent.bin, args, { cwd: project, env })
  say(`agent exited with ${run.code ?? run.signal} after ${(run.ms / 1000).toFixed(1)}s`)

  const messages: Message[] = (await api(U, 'GET', `/api/state?chat=${chat}`)).messages
  const reply = messages.find((m) => m.id === replyId)
  const s = mock.state
  const check = (ok: boolean, message: string) => ok || failures.push(message)
  check(s.mainRequests > 0, `the agent never sent a model request offering a shell tool (${SHELL_TOOLS.join(', ')})`)
  check(s.discovered, `skill not discovered: no model request offering a shell tool contained "skill-concierge" and the SKILL.md description "${skillDescription}" (longest description prefix seen: ${s.descriptionChars} characters)`)
  check(s.replyId === replyId, `the wait recipe did not hand reply #${replyId} to the model (got ${s.replyId})`)
  check(reply?.status === 'done', `reply #${replyId} status is ${reply?.status}, expected done`)
  check(reply?.content.trim() === answer, `reply #${replyId} content differs from the posted Markdown:\n--- expected\n${answer}\n--- actual\n${reply?.content}`)
  check(reply?.steps.length === 1 && reply.steps[0].text === 'checking', `expected one progress step "checking", got ${JSON.stringify(reply?.steps.map((x) => x.text))}`)
  check(s.lastStep >= 3, `the agent did not finish the scripted session (last step served: ${s.lastStep})`)
  check(run.code === 0, `the agent exited with ${run.code ?? run.signal}${run.timedOut ? ' (timed out)' : ''}`)
  const modelApi = s.outbound.filter((target) => MODEL_API_HOSTS.test(target.replace(/^[a-z]+:\/\//i, '').split('/')[0]))
  check(modelApi.length === 0, `the agent tried to reach real model APIs: ${modelApi.join(', ')}`)
  check(s.errors.length === 0, `mock errors:\n${s.errors.join('\n')}`)
  for (const failure of agent.checkOutput?.(run) ?? []) failures.push(failure)
  say(`skill description seen by the model: ${s.descriptionChars}/${skillDescription.length} characters`)
  if (s.outbound.length) say(`refused outbound requests: ${[...new Set(s.outbound)].join(', ')}`)

  writeFileSync(path.join(tmp, 'model-requests.json'), JSON.stringify(s.requests, null, 2))
  say(`model requests: ${s.requests.map((r) => `${r.method} ${r.path}${r.step === null ? '' : ` [step ${r.step}]`}`).join(', ')}`)
  if (failures.length) {
    say(`request bodies: ${path.join(tmp, 'model-requests.json')}`)
    say(`agent stdout:\n${run.stdout.trim()}\nagent stderr (last 4000 chars):\n${run.stderr.slice(-4000).trim()}`)
  }
} catch (error) {
  failures.push(`harness error: ${(error as Error).stack ?? error}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await mock?.close()
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`)
  say(`kept ${tmp} for inspection`)
  process.exit(1)
}
if (!opts.keep) rmSync(tmp, { recursive: true, force: true })
say('PASS')

function startConcierge(entry: string): Promise<string> {
  const child = spawn(process.execPath, [entry], {
    cwd: project,
    env: { ...process.env, HOME: home, CONCIERGE_DATA_DIR: path.join(tmp, 'concierge-data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  const log = createWriteStream(path.join(tmp, 'concierge.log'))
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  let out = ''
  const timer = setTimeout(() => reject(new Error(`concierge did not start within 30s:\n${out}`)), 30_000)
  child.stdout.on('data', (chunk) => {
    out += chunk
    const url = out.match(/concierge listening on (\S+)/)?.[1]
    if (url) clearTimeout(timer), resolve(url)
  })
  child.stderr.on('data', (chunk) => (out += chunk))
  child.on('exit', (code) => (clearTimeout(timer), reject(new Error(`concierge exited with ${code}:\n${out}`))))
  return promise
}

async function api(U: string, method: string, pathname: string, body?: string): Promise<any> {
  const response = await fetch(U + pathname, { method, body })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${pathname}: HTTP ${response.status} ${text}`)
  return JSON.parse(text)
}

function runAgent(bin: string, args: string[], options: SpawnOptions): Promise<Run> {
  const started = Date.now()
  const child = spawn(bin, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  children.add(child)
  let stdout = ''
  let stderr = ''
  const out = createWriteStream(path.join(tmp, 'agent.log'))
  child.stdout?.on('data', (chunk) => ((stdout += chunk), out.write(chunk)))
  child.stderr?.on('data', (chunk) => ((stderr += chunk), out.write(chunk)))
  let timedOut = false
  // The whole process group, so a hung wait loop does not outlive the agent.
  const kill = () => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {}
  }
  const timer = setTimeout(() => ((timedOut = true), kill()), AGENT_TIMEOUT_MS)
  const { promise, resolve, reject } = Promise.withResolvers<Run>()
  child.on('error', reject)
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    children.delete(child)
    kill()
    out.end()
    resolve({ code, signal, stdout, stderr, timedOut, ms: Date.now() - started })
  })
  return promise
}

function capture(bin: string, args: string[], options: SpawnOptions): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const child = spawn(bin, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout?.on('data', (chunk) => (out += chunk))
  child.on('error', reject)
  child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} ${args.join(' ')} exited with ${code}`))))
  return promise
}
