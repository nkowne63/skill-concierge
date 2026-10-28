// Browser assets for the chat screen, compiled by the Remix asset server.
import { createAssetServer, type AssetServer } from 'remix/assets'

const ENTRY = 'app/public/entry.ts'
const ROOTS = [ENTRY, 'app/public/concierge.tsx', 'app/public/app.css']

export interface ScriptEntry {
  href: string
  importMap: { imports?: Record<string, string>; scopes?: Record<string, Record<string, string>> }
  preloads: string[]
}

export interface UiAssets {
  assets: AssetServer
  scriptEntry: ScriptEntry
  stylesheet: string
}

// File watching stays off, so the asset server keeps the first compiled copy of each file. Compiling the
// whole browser graph at startup therefore freezes the chat screen as it was when the server started:
// later on-disk edits (for example by an agent) never reach the browser.
export async function createUiAssets(skillDir: string): Promise<UiAssets> {
  const assets = createAssetServer({
    basePath: '/assets',
    rootDir: skillDir,
    mounts: { app: 'app', npm: 'node_modules' },
    allowFiles: ['app/public/**'],
    allowPackages: ['remix', 'marked', 'marked-cjk-friendly'],
    watch: false,
  })
  const scriptEntry = await assets.getScriptEntry(ENTRY)
  const stylesheet = await assets.getHref('app/public/app.css')
  const urls = new Set([...(await assets.getPreloads(ROOTS)), scriptEntry.href, stylesheet])
  for (const url of urls) {
    const response = await assets.fetch(new Request(new URL(url, 'http://127.0.0.1')))
    if (!response?.ok) throw new Error(`could not compile browser asset ${url} (${response?.status ?? 'not served'})`)
    await response.arrayBuffer()
  }
  return { assets, scriptEntry, stylesheet }
}
