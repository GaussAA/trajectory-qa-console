/** Markdown 报告里的外部文本转义：轨迹名、规则标题、证据、模型结论都来自不受信的一方。
 *
 *  这些报告会被贴进 PR、周报、聊天窗口，渲染它们的软件会自动取图、解析 HTML、跟随链接。
 *  不转义就等于把一份别人写的内容，以「质检台生成」的口吻原样转发：
 *  - 一个换行加 `# 总分 100 分` 就能在报告里伪造一个标题；
 *  - `![](https://…?leak=1)` 在渲染时会自动发出请求；
 *  - `[点此领奖](https://…)` 是现成的钓鱼链接；
 *  - 一个孤立的 ``` 会把后面整份报告吞进代码块。
 *
 *  分两档，别混用：
 *  - `mdInline` / `mdCell`：标题、列表项、粗体、表格里的**单行**文本，字符级转义；
 *  - `mdBlock`：模型写的多行结论，保留换行与基本排版，只拆掉能伪造结构、自动取资源的写法。
 *
 *  `_` 不转义：规则 id 与工具名（`search_kb`、`exec_tool`）到处是下划线，
 *  CommonMark 不把词内下划线当强调，转义只会让它们更难读。
 */

/** 把所有换行（含 \r、Unicode 行分隔符）折成一个空格；单行上下文里的换行就是注入点。 */
function flatten(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, ' ')
}

/** 单行内联文本：标题、列表项、粗体里用。 */
export function mdInline(text: string): string {
  // 反斜杠必须最先转义，否则输入里已有的 `\[` 会在后面被「补」成一个有效的链接起点。
  return flatten(text).replace(/[\\`*[\]<>]/g, '\\$&')
}

/** 表格单元格：在 `mdInline` 之上再转义竖线。 */
export function mdCell(text: string): string {
  return mdInline(text).replace(/\|/g, '\\|')
}

/** 行内代码：围栏取比文本里最长反引号串更长的一档，文本里的反引号就出不来。 */
export function mdCode(text: string): string {
  const flat = flatten(text)
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  // 首尾是反引号或空格时要补一个空格，CommonMark 会把它剥掉。
  const pad = /^[ `]|[ `]$/.test(flat) ? ' ' : ''
  return `${fence}${pad}${flat}${pad}${fence}`
}

/** 多行正文（模型结论、依据、理由）。保留换行，拆掉三类危险：
 *  1. 自动取资源：图片、原始 HTML 标签；
 *  2. 钓鱼：链接的方括号；
 *  3. 伪造结构：行首的标题、代码围栏。 */
export function mdBlock(text: string): string {
  return text
    .replace(/\r\n?|\u2028|\u2029/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/[\\<>[\]]/g, '\\$&')
        // 行首的 `#` 标题与 ``` / ~~~ 围栏：在最前面补一个反斜杠即失效
        .replace(/^(\s*)(#{1,6}(?=\s|$)|`{3,}|~{3,})/, '$1\\$2'),
    )
    .join('\n')
}
