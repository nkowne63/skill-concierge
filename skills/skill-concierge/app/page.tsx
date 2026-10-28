// Server-rendered document for the chat screen; ConciergeApp hydrates inside it.
import type { RemixNode } from 'remix/component'
import { ImportMap } from 'remix/component/server'

import type { ScriptEntry } from './assets.ts'
import { ConciergeApp, type InitialState } from './public/concierge.tsx'

export interface PageInput {
  state: InitialState
  scriptEntry: ScriptEntry
  stylesheet: string
}

export function conciergePage({ state, scriptEntry, stylesheet }: PageInput): RemixNode {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"
        />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#171b21" />
        <title>{`${state.project.name} · Concierge`}</title>
        <link rel="stylesheet" href={stylesheet} />
        <ImportMap value={scriptEntry.importMap} />
        {scriptEntry.preloads.map((href) => (
          <link key={href} rel="modulepreload" href={href} />
        ))}
        <script type="module" src={scriptEntry.href}></script>
      </head>
      <body>
        <ConciergeApp {...state} />
      </body>
    </html>
  )
}
