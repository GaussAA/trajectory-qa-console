import { Icon } from './Icons'

interface Props {
  onPick: () => void
  onSample: () => void
  issues: { file: string; message: string }[]
}

const SNIPPET = `[
  { "role": "user", "content": "查一下报销标准" },
  { "role": "assistant", "tool_calls": [
      { "id": "c1", "type": "function",
        "function": { "name": "search", "arguments": "{\\"q\\":\\"报销\\"}" } } ] },
  { "role": "tool", "tool_call_id": "c1", "content": "住宿上限 500 元" },
  { "role": "assistant", "content": "住宿上限为 500 元。" }
]`

export function EmptyState({ onPick, onSample, issues }: Props) {
  return (
    <main className="empty-wrap" aria-label="导入轨迹">
      <div className="empty-card glass">
        <div className="empty-icon">
          <Icon name="spark" size={26} />
        </div>
        <h2>把轨迹拖进来，四面体检</h2>
        <p>
          结构合法性、执行健康度、效率与成本、语义质量一次跑完。解析与质检全部在浏览器内完成，
          文件不出本机，也没有任何网络请求。
        </p>

        <div className="empty-formats">
          <span className="format-chip">OpenAI messages</span>
          <span className="format-chip">tool_calls / tool_use</span>
          <span className="format-chip">JSONL 多会话</span>
          <span className="format-chip">自动配对与容错</span>
        </div>

        <div className="empty-actions">
          <button type="button" className="btn primary" onClick={onPick}>
            <Icon name="upload" size={14} />
            选择轨迹文件
          </button>
          <button type="button" className="btn ghost" onClick={() => onSample()}>
            载入示例（4 条）
          </button>
        </div>

        <p className="empty-drop-hint">也可以把 .json / .jsonl 直接拖到窗口任意位置</p>

        <pre className="empty-snippet">{SNIPPET}</pre>

        {issues.length > 0 && (
          <div className="empty-issues">
            {issues.map((issue) => (
              <div key={issue.file}>
                <b>{issue.file}</b>：{issue.message}
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
