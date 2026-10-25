/**
 * Import packages that the Harness ships (`@deepseek-ai/*`, `zod`).
 *
 * A bundle installed with `link:` resolves bare imports from its own directory,
 * where those packages are absent. The Host process is always started with a
 * script inside the Harness installation (`process.argv[1]`, e.g.
 * `.../app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`),
 * so lookups anchored there find the same copies the Harness itself loaded.
 * The ESM entry is chosen explicitly: `require.resolve` would pick a CommonJS
 * twin (schemastery ships both), whose classes differ from the Host's.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function esmEntry(exportsField, main) {
  let target = exportsField && typeof exportsField === 'object' && '.' in exportsField ? exportsField['.'] : exportsField
  while (target && typeof target === 'object') target = target.import ?? target.default ?? target.node
  return typeof target === 'string' ? target : (main ?? 'index.js')
}

function resolveFromInstallation(specifier) {
  const anchor = process.argv[1]
  if (!anchor) return undefined
  for (const base of createRequire(anchor).resolve.paths(specifier) ?? []) {
    const dir = join(base, specifier)
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    return pathToFileURL(join(dir, esmEntry(pkg.exports, pkg.main))).href
  }
  return undefined
}

/**
 * Prefer the installation's copy; fall back to ordinary resolution, which
 * covers a bundle installed from a registry with its own dependencies.
 * @param specifier - bare package name.
 * @returns the module namespace.
 */
export async function importShipped(specifier) {
  const url = resolveFromInstallation(specifier)
  return await import(url ?? specifier)
}
