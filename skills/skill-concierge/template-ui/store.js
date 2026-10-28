// Saved data for the workspace app (the sandbox blocks browser storage). Values are JSON, kept on the server
// as <data>/ui-data/<name>.json.
//   import { load, save } from './store.js'
//   const todos = await load('todos', [])
//   await save('todos', todos)
const url = (name) => `/ui-data/${encodeURIComponent(name)}`

export async function load(name, fallback = null) {
  const response = await fetch(url(name))
  if (response.status === 204) return fallback
  if (!response.ok) throw new Error(`load ${name}: HTTP ${response.status}`)
  return response.json()
}

export async function save(name, value) {
  const response = await fetch(url(name), { method: 'POST', body: JSON.stringify(value) })
  if (!response.ok) throw new Error(`save ${name}: HTTP ${response.status}`)
}
