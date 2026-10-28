// Markdown rendering shared by server rendering and the browser.
import { Marked, type Token } from 'marked'
import markedCjkFriendly from 'marked-cjk-friendly'

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
}

// Only links/images that cannot run script are kept: http(s), mailto, and same-origin paths.
function safeUrl(href: unknown): string | null {
  const value = String(href ?? '').trim()
  if (/^(https?:|mailto:)/i.test(value)) return value
  if (value.startsWith('/') && !value.startsWith('//')) return value
  if (value.startsWith('#')) return value
  return null
}

// CommonMark does not close `**「強調」**は` next to CJK punctuation; the extension fixes that.
const marked = new Marked(markedCjkFriendly(), {
  gfm: true,
  breaks: true,
  walkTokens(token: Token) {
    if (token.type === 'link' || token.type === 'image') {
      token.href = safeUrl(token.href) ?? '#'
    }
  },
  renderer: {
    // Raw HTML in chat text is shown as text, never interpreted.
    html({ text }) {
      return escapeHtml(text)
    },
  },
})

export function renderMarkdown(source: unknown): string {
  return marked.parse(String(source ?? ''), { async: false })
}
