// The package must run on Cloudflare Workers: no Node-only imports anywhere in src (fetch + WebCrypto only).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  )
}

describe('Workers safety', () => {
  it('imports no Node-only module and no SDK', () => {
    const offenders: string[] = []
    for (const file of files(join(import.meta.dirname, '..', 'src'))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g)) {
        const spec = m[1] ?? m[2]
        if (/^(node:|fs$|path$|crypto$|better-sqlite3|pg$|stripe$)/.test(spec))
          offenders.push(`${file}: ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
