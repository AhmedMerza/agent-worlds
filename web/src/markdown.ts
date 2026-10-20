import MarkdownIt from 'markdown-it'

// html:false escapes raw HTML, so a transcript can never put markup (or a script) on the page.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
const linkOpen = md.renderer.rules.link_open ?? ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts))
// A link opens beside the app, not in place of it.
md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
  tokens[i].attrSet('target', '_blank')
  tokens[i].attrSet('rel', 'noopener noreferrer')
  return linkOpen(tokens, i, opts, env, self)
}

export const renderMarkdown = (text: string): string => md.render(text)
