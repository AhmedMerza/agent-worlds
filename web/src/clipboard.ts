/** Puts `text` on the clipboard: the Clipboard API, else the old execCommand route (plain-http pages have no Clipboard API). */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true } catch { /* fall back below */ }
  const ta = document.createElement('textarea')
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.appendChild(ta); ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { /* ignore */ }
  ta.remove()
  return ok
}

/**
 * The text of an OSC 52 "set clipboard" sequence (`<targets>;<base64>`), which is how programs in the
 * terminal (Claude Code, tmux) copy. Null for a clipboard query ("?") or a malformed payload.
 */
export function osc52Text(data: string): string | null {
  const b64 = data.slice(data.indexOf(';') + 1)
  if (!data.includes(';') || !b64 || b64 === '?') return null
  try { return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))) } catch { return null }
}
