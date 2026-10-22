/** Built-in demo traces.
 *
 *  They are stored as raw JSON text on purpose: loading a sample must exercise
 *  exactly the same parse path as dropping a user file, otherwise the demo can
 *  hide parser regressions.
 */

export interface SampleFile {
  name: string
  hint: string
  content: string
}

const t = (seconds: number) => new Date(Date.UTC(2026, 9, 20, 1, 12, seconds)).toISOString()

const HEALTHY = [
  {
    role: 'system',
    content: '你是医保政策助手。回答必须引用检索到的条款，不得凭记忆作答。',
  },
  {
    role: 'user',
    content: '合肥职工医保住院报销比例是多少？',
    timestamp: t(1),
  },
  {
    role: 'assistant',
    content: '',
    timestamp: t(2),
    usage: { prompt_tokens: 412, completion_tokens: 38, total_tokens: 450 },
    tool_calls: [
      {
        id: 'call_01',
        type: 'function',
        function: {
          name: 'search_policy',
          arguments: '{"query":"合肥 职工医保 住院 报销比例","top_k":3}',
        },
      },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'call_01',
    name: 'search_policy',
    timestamp: t(3),
    content:
      '[1] 《合肥市职工基本医疗保险办法》第二十三条：参保人员在三级定点医疗机构住院，起付标准为 800 元，政策范围内费用报销比例为 85%。\n[2] 《安徽省异地就医管理办法》第九条：异地转诊需先备案。',
  },
  {
    role: 'assistant',
    content: '',
    timestamp: t(4),
    usage: { prompt_tokens: 780, completion_tokens: 44, total_tokens: 824 },
    tool_calls: [
      {
        id: 'call_02',
        type: 'function',
        function: {
          name: 'calc_reimburse',
          arguments: '{"amount":12000,"hospital_level":"三级","insured":true}',
        },
      },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'call_02',
    name: 'calc_reimburse',
    timestamp: t(5),
    content: '{"payable":9520,"ratio":0.85,"deductible":800,"currency":"CNY"}',
  },
  {
    role: 'assistant',
    content:
      '按合肥市职工医保政策，三级医院起付标准 800 元，政策范围内费用报销比例为 85%。以 12000 元住院费计算，扣除起付线后可报销 9520 元。\n\n依据：《合肥市职工基本医疗保险办法》第二十三条。',
    timestamp: t(6),
    usage: { prompt_tokens: 880, completion_tokens: 126, total_tokens: 1006 },
  },
]

const FAILURE = [
  { role: 'user', content: '把 contract.pdf 的关键条款抽出来，生成风险清单。', timestamp: t(11) },
  {
    role: 'assistant',
    content: '',
    timestamp: t(12),
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"contract.pdf"}' } },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'c1',
    name: 'read_file',
    timestamp: t(13),
    content: 'Error: file not found: contract.pdf',
  },
  {
    role: 'assistant',
    content: '',
    timestamp: t(14),
    tool_calls: [
      { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"contract.pdf"}' } },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'c2',
    name: 'read_file',
    timestamp: t(15),
    content: 'Error: file not found: contract.pdf',
  },
  {
    role: 'assistant',
    content: '',
    timestamp: t(16),
    tool_calls: [
      { id: 'c3', type: 'function', function: { name: 'read_file', arguments: '{"path":"contract.pdf"}' } },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'c3',
    name: 'read_file',
    timestamp: t(17),
    content: 'Error: file not found: contract.pdf',
  },
]

function loopSample(): unknown[] {
  const steps: unknown[] = [
    { role: 'system', content: '你是资料整理助手，可用 search_notes 检索内部知识库。' },
    { role: 'user', content: '整理一下 2026 年 Q3 的客户投诉，按主题归类。' },
  ]
  for (let i = 0; i < 20; i += 1) {
    const callId = `loop_${i}`
    steps.push({
      role: 'assistant',
      content: '',
      timestamp: t(30 + i * 2),
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: { name: 'search_notes', arguments: '{"query":"2026 Q3 客户投诉"}' },
        },
      ],
    })
    steps.push({
      role: 'tool',
      tool_call_id: callId,
      name: 'search_notes',
      timestamp: t(31 + i * 2),
      content: `命中 3 条：投诉-00${(i % 3) + 1}、投诉-00${((i + 1) % 3) + 1}、投诉-00${((i + 2) % 3) + 1}`,
    })
  }
  steps.push({
    role: 'assistant',
    content: '共整理出三类主题：物流延迟、退款进度、客服响应。',
    timestamp: t(80),
  })
  return steps
}

const STRUCTURE = [
  { role: 'user', content: '你好，帮我看下这份合同。', timestamp: t(51) },
  { role: 'user', content: '在吗？', timestamp: t(52) },
  {
    role: 'assistant',
    content: '',
    timestamp: t(53),
    tool_calls: [{ id: 'bad_1', function: { name: 'write_file', arguments: '{"path": ' } }],
  },
  { role: 'tool', tool_call_id: 'ghost_call', name: 'read_file', timestamp: t(54), content: '' },
  { role: 'assistant', content: '', timestamp: t(55) },
  {
    role: 'assistant',
    timestamp: t(56),
    content: [
      { type: 'text', text: '已收到附件。' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ],
  },
  {
    role: 'assistant',
    content:
      '根据文档，合同金额为 1200000 元，签署方联系人 13812345678，邮箱 legal@example.com，请尽快确认。',
    timestamp: t(57),
  },
]

export const SAMPLE_FILES: SampleFile[] = [
  {
    name: 'demo-01-合规问答.json',
    hint: '健康基线：结构完整、工具配对、有最终答复',
    content: JSON.stringify(HEALTHY, null, 2),
  },
  {
    name: 'demo-02-工具失败.json',
    hint: '执行异常：工具连续失败、重复重试、任务未收尾',
    content: JSON.stringify(FAILURE, null, 2),
  },
  {
    name: 'demo-03-死循环.json',
    hint: '效率问题：44 步、同一调用重复 20 次',
    content: JSON.stringify(loopSample(), null, 2),
  },
  {
    name: 'demo-04-结构损坏.json',
    hint: '结构缺陷：非法参数、孤立结果、连续 user、隐私泄露',
    content: JSON.stringify(STRUCTURE, null, 2),
  },
]

/** Synthetic long trace used by the `#stress:N` deep link and by manual
 *  performance checks. Shapes stay realistic: user → tool call → tool result. */
export function buildStressTrace(steps = 5000): string {
  const messages: unknown[] = [{ role: 'system', content: '你是压力测试用的助手，回答需引用检索结果。' }]
  let turn = 0

  while (messages.length < steps - 1) {
    messages.push({ role: 'user', content: `第 ${turn} 轮：请检索并总结第 ${turn} 号文档。` })
    messages.push({
      role: 'assistant',
      tool_calls: [
        {
          id: `stress-${turn}`,
          type: 'function',
          function: {
            name: turn % 7 === 0 ? 'search_docs' : 'fetch_doc',
            arguments: `{"q":"doc-${turn}","top_k":3}`,
          },
        },
      ],
    })
    messages.push({
      role: 'tool',
      tool_call_id: `stress-${turn}`,
      name: turn % 7 === 0 ? 'search_docs' : 'fetch_doc',
      content: `doc-${turn}: ${'内容片段 '.repeat(28)}`,
    })
    turn += 1
  }

  messages.push({ role: 'assistant', content: '压力测试轨迹结束，共整理若干结论。' })
  return JSON.stringify(messages)
}
