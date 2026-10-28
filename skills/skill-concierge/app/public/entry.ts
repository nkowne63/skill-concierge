// Browser entry: hydrates the client entries the server rendered.
import { run } from 'remix/component'

// Links and forms are ordinary document navigations; only the hydrated chat screen updates in place.
window.navigation?.addEventListener('navigate', (event) => event.stopImmediatePropagation())

run({
  // The module URL comes from the server-rendered page, so it is only known at runtime.
  loadModule: async (moduleUrl, exportName) => (await import(moduleUrl))[exportName],
}).addEventListener('error', (event) => console.error('Component error:', event.error))
