import { describe, expect, it } from 'vitest'
import { osc52Text } from '../src/clipboard'

describe('osc52Text', () => {
  it('decodes the base64 payload, including UTF-8', () => {
    expect(osc52Text('c;' + btoa('hello'))).toBe('hello')
    expect(osc52Text(';' + btoa(String.fromCharCode(...new TextEncoder().encode('مرحبا ✓'))))).toBe('مرحبا ✓')
  })
  it('ignores clipboard queries and malformed payloads', () => {
    expect(osc52Text('c;?')).toBeNull()
    expect(osc52Text('c;')).toBeNull()
    expect(osc52Text('nosemicolon')).toBeNull()
    expect(osc52Text('c;!!!not base64')).toBeNull()
  })
})
