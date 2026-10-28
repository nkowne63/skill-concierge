import assert from 'node:assert/strict'
import test from 'node:test'
import { renderMarkdown } from '../app/public/markdown.ts'

test('raw HTML in chat text is shown as text, never interpreted', () => {
  const html = renderMarkdown('before <img src=x onerror=alert(1)> after\n\n<script>alert(1)</script>')
  assert.doesNotMatch(html, /<img|<script/)
  assert.match(html, /&lt;script&gt;/)
})

test('links that could run script are neutralised; http(s) and same-origin paths are kept', () => {
  const html = renderMarkdown('[a](javascript:alert(1)) [b](https://example.com/) [c](/shots/x.png) ![d](data:text/html,x)')
  assert.doesNotMatch(html, /javascript:|data:/)
  assert.match(html, /href="https:\/\/example\.com\/"/)
  assert.match(html, /href="\/shots\/x\.png"/)
})

test('strong emphasis closes next to Japanese punctuation', () => {
  assert.match(renderMarkdown('合言葉は**「青いみかん」**です。'), /<strong>「青いみかん」<\/strong>/)
})
