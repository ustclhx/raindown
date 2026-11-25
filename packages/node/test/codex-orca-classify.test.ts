import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskContract } from '@raindown/core'
import {
  analyzeTail,
  approvalExecutionLines,
  atShellPrompt,
  classifyCodexOrca,
  composerReady,
  isBusy,
  lastMessage,
} from '../src/codex-orca/classify.ts'
import { TUI_FIXTURES, tuiFixture } from './codex-orca-helpers.ts'

/**
 * classify 的 fixture 测试（add-m1-executors 2.3）：`test/fixtures/codex-tui/` 下是
 * Codex 0.164.0 在 Orca 1.4.218 终端中的真实片段（`orca terminal read --json` 的完整输出，已脱敏）。
 */

const contract = taskContract.parse({
  goal: 'g',
  workspace: 'ws/product-res',
  role: 'dev',
  executor: 'codex-orca',
})
const snapshot = (name: string, trigger: 'idle' | 'no_progress' = 'idle') => ({
  trigger,
  tail: [],
  idle_ms: 60_000,
  hint: { tail: tuiFixture(name).tail },
  contract,
})

describe('fixture 清单', () => {
  test('每个 fixture 都能按 Orca 的输出 schema 解析，且都列在 TUI_FIXTURES 中', () => {
    const files = readdirSync(join(import.meta.dir, 'fixtures', 'codex-tui'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort()
    expect(files).toEqual([...TUI_FIXTURES].sort())
    for (const name of TUI_FIXTURES) expect(Array.isArray(tuiFixture(name).tail)).toBe(true)
  })

  test('所有 fixture 目录（codex-tui、orca、codex-exec）都不含用户信息与疑似令牌', () => {
    // 真实的账号名与主机名在运行时拼出，避免它们以字面量出现在公开仓库里。
    const names = [['ust', 'clhx'].join(''), ['hx', 'lee'].join(''), ['hxde', 'MacBook'].join('')]
    const forbidden: RegExp[] = [
      /\/Users\/(?!user\b)[^/\s"]+/,
      /\/home\/(?!user\b)[^/\s"]+/,
      ...names.map((n) => new RegExp(n, 'i')),
      /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/,
      /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/,
      /\bxox[abposr]-[A-Za-z0-9-]{8,}/,
      /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/,
      /\bglpat-[A-Za-z0-9_-]{8,}/,
      /\bnpm_[A-Za-z0-9]{16,}/,
      /\bAIza[0-9A-Za-z_-]{20,}/,
      /\beyJ[A-Za-z0-9_-]{8,}\.eyJ/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /actions\/runs\/(?!1000000001\b)\d+/,
    ]
    const root = join(import.meta.dir, 'fixtures')
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.json') || f.endsWith('.jsonl'),
    )
    expect(files.some((f) => f.startsWith('orca'))).toBe(true)
    expect(files.some((f) => f.startsWith('codex-tui'))).toBe(true)
    expect(files.some((f) => f.startsWith('codex-exec'))).toBe(true)
    for (const f of files) {
      const text = readFileSync(join(root, f), 'utf8')
      for (const re of forbidden) {
        if (re.test(text)) throw new Error(`${f} 命中 ${re}`)
      }
    }
  })
})

describe('analyzeTail', () => {
  test.each(['trust-prompt', 'trust-prompt-0167'])('信任提示：%s', (fixture) => {
    const a = analyzeTail(tuiFixture(fixture).tail)
    expect(a.kind).toBe('trust_prompt')
  })

  test('Working：忙碌标记在末尾', () => {
    const t = tuiFixture('working').tail
    expect(isBusy(t)).toBe(true)
    expect(analyzeTail(t).kind).toBe('working')
    // 启动时加载 MCP 也带 esc to interrupt。
    expect(analyzeTail(tuiFixture('starting').tail).kind).toBe('working')
  })

  test('流式输出中途可能没有忙碌标记（所以要连续两次才算停下）', () => {
    const t = tuiFixture('streaming').tail
    expect(isBusy(t)).toBe(false)
    expect(analyzeTail(t).kind).toBe('other')
  })

  test('提问：输入框之上的最后一条消息以问号结尾', () => {
    const t = tuiFixture('question').tail
    expect(isBusy(t)).toBe(false)
    expect(lastMessage(t)).toEqual([
      '• 根目录 package.json 的 name 字段是 raindown。未做任何修改。',
      '  下一步你希望我查看什么？',
    ])
    const a = analyzeTail(t)
    expect(a).toMatchObject({
      kind: 'question',
      message:
        '根目录 package.json 的 name 字段是 raindown。未做任何修改。 下一步你希望我查看什么？',
    })
  })

  test('真实标题选择提问：保留选项，去掉终端装饰', () => {
    const a = analyzeTail(tuiFixture('question-options').tail)
    expect(a.kind).toBe('question')
    expect(a.message).toContain('标题去掉“（Amazon + eBay）”后，你选择哪种表述？')
    expect(a.message).toContain('A. 跨境电商选品工作台：流程与实施方案')
    expect(a.message).toContain('B. 跨境电商选品工作台（多平台）：流程与实施方案')
    expect(a.message).not.toContain('Worked for')
    expect(a.message).not.toContain('Ask Codex')
  })

  test.each([
    ['A.', 'B.'],
    ['A)', 'B)'],
    ['A：', 'B：'],
    ['A:', 'B:'],
    ['A）', 'B）'],
    ['A、', 'B、'],
    ['G.', 'H.'],
    ['1.', '2.'],
    ['1)', '2)'],
    ['1）', '2）'],
    ['①', '②'],
    ['(1)', '(2)'],
    ['（1）', '（2）'],
    ['8.', '9.'],
  ])('选项支持前导空白和 %s / %s 标记', (first, second) => {
    const a = analyzeTail([
      '• 采用方案甲还是方案乙？',
      '',
      `  ${first} 方案甲`,
      '   ',
      `\t${second} 方案乙`,
    ])
    expect(a.kind).toBe('question')
    expect(a.message).toContain(`${first} 方案甲`)
    expect(a.message).toContain(`${second} 方案乙`)
  })

  test('问句后跟普通正文且没有基础关键词时不阻塞', () => {
    expect(
      analyzeTail([
        '• 采用方案甲还是方案乙？',
        '  A. 方案甲',
        '  B. 方案乙',
        '  我已采用默认表述并完成修改。',
      ]).kind,
    ).toBe('other')
  })

  test.each(['回复 A 或 B。', '请回复 A 或 B。', 'Reply with the letter.', 'Answer with A or B.'])(
    '末尾一行回复指令保留选择提问：%s',
    (instruction) => {
      const a = analyzeTail(['• 采用方案甲还是方案乙？', '  A. 方案甲', '  B. 方案乙', instruction])
      expect(a.kind).toBe('question')
      expect(a.message).toContain('采用方案甲还是方案乙？')
      expect(a.message).toContain('A. 方案甲')
      expect(a.message).toContain('B. 方案乙')
    },
  )

  test.each([
    [8, 'question'],
    [9, 'other'],
  ] as const)('选项上限边界：%i 项（含续行）判为 %s', (count, kind) => {
    const options = Array.from({ length: count }, (_, i) => [
      `  ${i + 1}. 方案${i + 1}`,
      '    补充说明',
    ]).flat()
    const a = analyzeTail(['• 采用方案甲还是方案乙？', ...options])
    expect(a.kind).toBe(kind)
    if (kind === 'question') expect(a.message).toContain(`${count}. 方案${count}`)
  })

  test.each([
    ['-', '-'],
    ['*', '*'],
    ['a.', 'b.'],
    ['I.', 'J.'],
    ['0.', '1.'],
    ['10.', '11.'],
    ['1:', '2:'],
    ['1：', '2：'],
    ['10:30', '11:30'],
    ['e.g.', 'e.g.'],
    ['A.foo', 'B.bar'],
    ['A)foo', 'B)bar'],
    ['A）foo', 'B）bar'],
    ['A:foo', 'B:bar'],
    ['A：foo', 'B：bar'],
    ['1.foo', '2.bar'],
    ['1)foo', '2)bar'],
    ['1）foo', '2）bar'],
  ])('普通列表或正文标记 %s / %s 不算选择项', (first, second) => {
    expect(
      analyzeTail(['• 采用方案甲还是方案乙？', `  ${first} 已完成甲`, `  ${second} 已完成乙`]).kind,
    ).toBe('other')
  })

  test.each([
    'A.方案甲\nB.方案乙',
    'A)方案甲\nB)方案乙',
    'A:方案甲\nB:方案乙',
    '1.方案甲\n2.方案乙',
  ])('后缀标记可紧贴非 ASCII 选项：%s', (options) => {
    expect(analyzeTail(['• 采用方案甲还是方案乙？', ...options.split('\n')]).kind).toBe('question')
  })

  test.each([
    { label: '单项', options: ['A. 方案甲'] },
    { label: '混合字母数字', options: ['A. 方案甲', '2. 方案乙'] },
    { label: '混合字母后缀', options: ['A. 方案甲', 'B) 方案乙'] },
    { label: '混合数字后缀', options: ['1. 方案甲', '2） 方案乙'] },
    { label: '混合全半角括号', options: ['A)方案甲', 'B）方案乙'] },
    { label: '混合全半角冒号', options: ['A:方案甲', 'B：方案乙'] },
  ])('不接受 $label 选项', ({ options }) => {
    expect(analyzeTail(['• 采用方案甲还是方案乙？', ...options]).kind).toBe('other')
  })

  test('PR 总结中的无问号数字列表不算提问', () => {
    expect(
      analyzeTail(['• PR 已完成，验证结果如下：', '  1. bun test 通过', '  2. bun run lint 通过'])
        .kind,
    ).toBe('other')
    expect(analyzeTail(['• 已完成修改，说明了哪种情况下会触发重试。']).kind).toBe('other')
  })

  test('更深缩进的非标记行保留为选项续行', () => {
    const a = analyzeTail([
      '• 采用方案甲还是方案乙？',
      '  A. 方案甲',
      '     优点：保留现有流程',
      '  B. 方案乙',
      '    延续方案乙的说明',
    ])
    expect(a.kind).toBe('question')
    expect(a.message).toContain('A. 方案甲 优点：保留现有流程 B. 方案乙 延续方案乙的说明')
  })

  test.each(['  已完成修改。', ' 已完成修改。'])(
    '选项后相同或更浅缩进的正文不算续行：%s',
    (body) => {
      expect(
        analyzeTail(['• 采用方案甲还是方案乙？', '  A. 方案甲', '  B. 方案乙', body]).kind,
      ).toBe('other')
    },
  )

  test('折行问句从当前段落开头保留上下文', () => {
    const prompt = ['  针对跨境电商的多平台标题，', '  你希望采用方案甲还是方案乙？']
    const a = analyzeTail(['• 前文总结已完成。', '', ...prompt, '  A. 方案甲', '  B. 方案乙'])
    expect(a.kind).toBe('question')
    expect(a.message).toBe(
      '针对跨境电商的多平台标题， 你希望采用方案甲还是方案乙？ A. 方案甲 B. 方案乙',
    )
    const b = analyzeTail(['• 历史消息。', '• 针对跨境电商的多平台标题，', prompt[1] ?? ''])
    expect(b.message).toBe('针对跨境电商的多平台标题， 你希望采用方案甲还是方案乙？')
  })

  test.each([
    '这个接口是不是已经废弃了？\n如果是，请确认是否继续删除。',
    'Should I also update the README?\nLet me know before I push.',
  ])('问号后继续请求确认时仍然提问：%s', (text) => {
    expect(
      analyzeTail(text.split('\n').map((line, index) => (index === 0 ? `• ${line}` : `  ${line}`)))
        .kind,
    ).toBe('question')
  })

  test.each([
    '根因是什么？\n1. 配置缺失\n2. 缓存未清理',
    'Why did the test fail?\n1. The fixture was stale.\n2. The timeout was too short.',
    '**What changed?**\n1. Added retry.\n2. Added tests.',
    '改了什么？\n① 修复空指针\n② 增加测试。',
  ])('没有选择信号的问句加列表不阻塞：%s', (text) => {
    expect(
      analyzeTail(text.split('\n').map((line, i) => (i === 0 ? `• ${line}` : line))).kind,
    ).toBe('other')
  })

  test.each([
    ['已按你的要求完成修复。\n根因是什么？\n1. 配置缺失\n2. 缓存未清理', 'other'],
    ['我比较了哪种方案更快。\n结论是什么？\n1. 甲\n2. 乙', 'other'],
    [
      '已按你的要求开 PR https://github.com/u/raindown/pull/3 。改了什么？\n1. 加重试\n2. 加测试',
      'pr_opened',
    ],
  ] as const)('背景中的选择信号不影响当前问句：%s', (text, kind) => {
    expect(
      analyzeTail(text.split('\n').map((line, i) => (i === 0 ? `• ${line}` : line))).kind,
    ).toBe(kind)
  })

  test.each(['。', '！', '!', '.'])('句末 %s 之前的选择信号不属于当前问句', (end) => {
    expect(
      analyzeTail([`• 已按你的要求完成修复${end}`, '根因是什么？', '1. 配置缺失', '2. 缓存未清理'])
        .kind,
    ).toBe('other')
  })

  test.each([
    ['你倾向 v1.2 还是 v2.0？', 'A. v1.2', 'B. v2.0'],
    ['Keep config.ts or move to env.ts?', '1. config.ts', '2. env.ts'],
    ['改 classify.ts 还是 exec.ts？', 'A. classify', 'B. exec'],
  ])('版本号和文件名中的点不切断选择问句：%s', (prompt, first, second) => {
    const a = analyzeTail([`• ${prompt}`, first, second])
    expect(a.kind).toBe('question')
    expect(a.message).toContain(first)
    expect(a.message).toContain(second)
  })

  test.each(['？', '?'])('之前问句的 %s 隔开其选择信号', (end) => {
    expect(
      analyzeTail([`• 你看过日志吗${end}根因是什么？`, '1. 配置缺失', '2. 缓存未清理']).kind,
    ).toBe('other')
  })

  test.each(['采用方案甲还是方案乙？', '采用方案甲还是\n方案乙？', 'Keep the cache or\nclear it?'])(
    '选择信号可在问句内部跨行：%s',
    (text) => {
      const a = analyzeTail([
        `• ${text.split('\n')[0]}`,
        ...text.split('\n').slice(1),
        'A. 方案甲',
        'B. 方案乙',
      ])
      expect(a.kind).toBe('question')
      expect(a.message).toContain('A. 方案甲 B. 方案乙')
    },
  )

  test.each([
    ['单行长背景', [`• ${'背景说明'.repeat(100)}采用方案甲还是方案乙？`], '采用方案甲还是方案乙？'],
    [
      '多行长背景',
      [
        '• 背景说明',
        ...Array.from({ length: 8 }, (_, i) => `  ${'背景说明'.repeat(30)}${i}`),
        '  你希望我继续合并吗？',
      ],
      '你希望我继续合并吗？',
    ],
  ] as const)('%s 截断后仍保留问句及全部选项', (_label, prompt, question) => {
    const a = analyzeTail([...prompt, '  A. 方案甲', '  B. 方案乙'])
    expect(a.kind).toBe('question')
    expect(a.message).toContain(question)
    expect(a.message).toContain('A. 方案甲')
    expect(a.message).toContain('B. 方案乙')
    expect(a.message.length).toBeLessThanOrEqual(1000)
  })

  test('单行极长问句保留末尾的提问', () => {
    const a = analyzeTail([`• ${'背景说明'.repeat(1000)}采用方案甲还是方案乙？`])
    expect(a.kind).toBe('question')
    expect(a.message).toContain('采用方案甲还是方案乙？')
    expect(a.message.length).toBeLessThanOrEqual(1000)
  })

  test('八个长选项逐项限长，仍保留全部标记与标识', () => {
    const options = Array.from(
      { length: 8 },
      (_, i) => `  ${i + 1}. 方案标识${i + 1}：${'说明'.repeat(100)}`,
    )
    const a = analyzeTail([`• ${'背景说明'.repeat(100)}采用方案甲还是方案乙？`, ...options])
    expect(a.kind).toBe('question')
    expect(a.message.length).toBeLessThanOrEqual(1000)
    expect(a.message).toContain('采用方案甲还是方案乙？')
    for (let i = 1; i <= 8; i++) {
      expect(a.message).toContain(`${i}. 方案标识${i}：`)
    }
    expect(a.message).not.toContain('说明'.repeat(61))
  })

  test('选项截断前脱敏，不泄漏边界处的令牌片段', () => {
    const secret = `sk-${'a'.repeat(80)}`
    const a = analyzeTail([
      '• 采用方案甲还是方案乙？',
      `  A. ${'甲'.repeat(105)} ${secret}`,
      '  B. 方案乙',
    ])
    expect(a.kind).toBe('question')
    expect(a.message).toContain('B. 方案乙')
    expect(a.message).not.toContain('sk-aaaa')
    expect(a.message).not.toContain(secret)
  })

  test('授权请求：说明中带上命令；"esc to cancel" 不是忙碌标记', () => {
    const t = tuiFixture('approval').tail
    expect(isBusy(t)).toBe(false)
    const a = analyzeTail(t)
    expect(a.kind).toBe('awaiting_approval')
    expect(a.command).toBe('mkdir -p /tmp/raindown-tui-probe-dir2')
    expect(a.message).toContain('mkdir -p /tmp/raindown-tui-probe-dir2')
  })

  test('开完 PR：最后一条消息中的 PR 链接', () => {
    const a = analyzeTail(tuiFixture('pr-opened').tail)
    expect(a).toMatchObject({
      kind: 'pr_opened',
      pr_url: 'https://github.com/example-user/raindown/pull/20',
    })
  })

  test('无输出：终端已退出且没有任何行', () => {
    const t = tuiFixture('no-output')
    expect(t.status).toBe('exited')
    expect(analyzeTail(t.tail).kind).toBe('empty')
  })

  test('其他：普通的陈述、被拒绝后中断、回到 shell', () => {
    expect(analyzeTail(tuiFixture('stopped-statement').tail)).toMatchObject({
      kind: 'other',
      message: '已执行 mkdir -p /tmp/raindown-tui-probe-dir，命令成功，退出码为 0。',
    })
    expect(analyzeTail(tuiFixture('approval-denied').tail).kind).toBe('other')
    const exited = analyzeTail(tuiFixture('codex-exited').tail)
    // 回到 shell 提示符单独成一类（不是"回合结束后的空闲输入框"），卡住原因仍为 other。
    expect(exited.kind).toBe('shell_prompt')
    expect(exited.message).toContain('shell 提示符')
    expect(analyzeTail(tuiFixture('shell-prompt').tail).message).toContain('shell 提示符')
  })

  test('历史中的 "Working (" 不算忙碌：只看末尾 15 行', () => {
    const t = [
      '• Working (1m 00s • esc to interrupt)',
      ...Array.from({ length: 20 }, (_, i) => `  line ${i}`),
      '• 要基于哪个分支？',
    ]
    expect(isBusy(t)).toBe(false)
    expect(analyzeTail(t).kind).toBe('question')
  })

  test('提问的关键词：没有问号也算', () => {
    expect(analyzeTail(['• 请确认是否删除旧目录']).kind).toBe('question')
    expect(analyzeTail(['• Let me know which approach you prefer.'])).toMatchObject({
      kind: 'question',
      message: 'Let me know which approach you prefer.',
    })
    expect(analyzeTail(['• 已完成全部修改。']).kind).toBe('other')
  })

  test.each([
    '你选择哪种',
    '你选哪一个',
    '你倾向哪种表述',
    '你要哪一个',
    '你倾向哪个方案',
    '您想选择哪种表述',
  ])('新增选择词无问号也无选项时不扩展基础判断：%s', (prompt) => {
    expect(analyzeTail([`• ${prompt}`])).toMatchObject({ kind: 'other', message: prompt })
  })

  test('说明经过脱敏', () => {
    const token = ['ghp', 'A'.repeat(36)].join('_')
    const a = analyzeTail([`• 用这个令牌可以吗 ${token}？`])
    expect(a.kind).toBe('question')
    expect(a.message).not.toContain(token)
    expect(a.message).toContain('[REDACTED:github-token]')
  })
})

describe('对抗与顺序（PR #24 审查第 1、2、5 条）', () => {
  const trust = () => tuiFixture('trust-prompt').tail
  const approval = () => tuiFixture('approval').tail

  test('授权弹窗上方的历史输出里有信任提示文字：判为授权请求，不是信任提示', () => {
    const t = ['• Ran cat trust-prompt.json', ...trust(), ...approval().slice(-9)]
    expect(analyzeTail(t).kind).toBe('awaiting_approval')
  })

  test('授权弹窗的 Reason 里写着信任提示的文字：仍是授权请求', () => {
    const t = approval().map((l) =>
      l.startsWith('  Reason:')
        ? '  Reason: Trust this folder? Trust and continue · enter continue'
        : l,
    )
    expect(analyzeTail(t).kind).toBe('awaiting_approval')
  })

  test('对抗：不在授权规则里的未知弹窗含信任文案、最后一行是 "enter continue · esc cancel"，不判为信任提示', () => {
    const unknown = [
      '  Folder access',
      '  /tmp/scratch',
      '  Trust this folder? Codex can read, edit, and run files here.',
      '› 1. Trust and continue',
      '  2. Quit',
      '  enter continue · esc cancel',
    ]
    expect(analyzeTail(unknown).kind).not.toBe('trust_prompt')
    // 布局缺一段（没有 Folder access 标题或没有 2. Quit）也不算。
    expect(analyzeTail(trust().filter((l) => !l.includes('Folder access'))).kind).not.toBe(
      'trust_prompt',
    )
    expect(analyzeTail(trust().filter((l) => !l.includes('2. Quit'))).kind).not.toBe('trust_prompt')
    // 真实布局仍然识别。
    expect(analyzeTail(trust()).kind).toBe('trust_prompt')
    const current = tuiFixture('trust-prompt-0167').tail
    expect(analyzeTail(current.filter((l) => !l.includes('Folder access'))).kind).not.toBe(
      'trust_prompt',
    )
    expect(analyzeTail(current.map((l) => l.replace('esc back', 'esc quit'))).kind).not.toBe(
      'trust_prompt',
    )
  })

  test('信任提示的三段文字必须同时出现在末尾 8 行内，且最后一行是 enter continue', () => {
    expect(
      analyzeTail([...trust(), '› Ask Codex to do anything', '  ? for shortcuts']).kind,
    ).not.toBe('trust_prompt')
    expect(analyzeTail(trust().filter((l) => !l.includes('Trust and continue'))).kind).not.toBe(
      'trust_prompt',
    )
    expect(analyzeTail([...trust(), ...Array(8).fill('x'), 'enter continue']).kind).not.toBe(
      'trust_prompt',
    )
  })

  test('历史中的授权文字、底部是输入框：不是授权请求', () => {
    const t = [
      ...approval(),
      '• 已取消。还需要别的吗？',
      '› Ask Codex to do anything',
      '  ? for shortcuts',
    ]
    expect(analyzeTail(t).kind).toBe('question')
  })

  test('提问排在 PR 链接之前', () => {
    const t = [
      '• 已开 PR https://github.com/example-user/raindown/pull/20，要我顺便合并吗？',
      '› Ask Codex to do anything',
    ]
    expect(analyzeTail(t).kind).toBe('question')
  })
})

describe('基础提问规则兼容 origin/main', () => {
  const token = ['ghp', 'A'.repeat(36)].join('_')
  const cases: [string, readonly string[]][] = [
    ['真实提问 fixture', tuiFixture('question').tail],
    [
      '历史 Working 不影响最终提问',
      [
        '• Working (1m 00s • esc to interrupt)',
        ...Array.from({ length: 20 }, (_, i) => `  line ${i}`),
        '• 要基于哪个分支？',
      ],
    ],
    ['中文关键词无问号', ['• 请确认是否删除旧目录']],
    ['英文关键词无问号', ['• Let me know which approach you prefer.']],
    ['令牌脱敏提问', [`• 用这个令牌可以吗 ${token}？`]],
    [
      '授权历史之后的新提问',
      [
        ...tuiFixture('approval').tail,
        '• 已取消。还需要别的吗？',
        '› Ask Codex to do anything',
        '  ? for shortcuts',
      ],
    ],
    [
      'PR 链接中的提问',
      [
        '• 已开 PR https://github.com/example-user/raindown/pull/20，要我顺便合并吗？',
        '› Ask Codex to do anything',
      ],
    ],
    ['英文问句后有陈述', ['• Should I also delete the old API?', 'I have not touched it yet.']],
    ['中文问句后有陈述', ['• 是否需要同时删除旧接口？', '目前我还没有改动它。']],
    [
      '英文选项及回复指令',
      ['• Which approach do you prefer?', 'A. Keep it', 'B. Drop it', 'Reply with the letter.'],
    ],
    ['基础关键词后接普通列表', ['• 要不要继续？', '- 继续', '- 停止']],
    ['基础关键词后接代码块', ['• Should I apply this patch?', '```diff', '+ fix()', '```']],
    [
      '基础关键词位于 PR 总结前文',
      [
        '• 此前是否需要调整方案？',
        '已开 PR https://github.com/example-user/raindown/pull/20。',
        '- 已完成修改。',
      ],
    ],
  ]
  test.each(cases)('%s 仍判为 question', (_label, tail) => {
    const a = analyzeTail(tail)
    expect(a.kind).toBe('question')
    expect(
      classifyCodexOrca({ trigger: 'idle', tail: [...tail], idle_ms: 60_000, contract })?.reason,
    ).toBe('question')
  })
})

describe('classifyCodexOrca', () => {
  test('授权请求 → awaiting_approval，说明包含命令', () => {
    const v = classifyCodexOrca(snapshot('approval'))
    expect(v?.reason).toBe('awaiting_approval')
    expect(v?.message).toContain('mkdir -p /tmp/raindown-tui-probe-dir2')
  })

  test('提问 → question', () => {
    expect(classifyCodexOrca(snapshot('question'))).toEqual({
      reason: 'question',
      message:
        '根目录 package.json 的 name 字段是 raindown。未做任何修改。 下一步你希望我查看什么？',
    })
  })

  test('自动确认没生效的信任提示 → awaiting_approval', () => {
    expect(classifyCodexOrca(snapshot('trust-prompt'))?.reason).toBe('awaiting_approval')
  })

  test('其他：idle 触发时为 other，无进展触发时交给节点（null）', () => {
    expect(classifyCodexOrca(snapshot('stopped-statement'))?.reason).toBe('other')
    expect(classifyCodexOrca(snapshot('stopped-statement', 'no_progress'))).toBeNull()
    expect(classifyCodexOrca(snapshot('no-output', 'no_progress'))).toBeNull()
  })

  test('没有 hint 时用节点累积的末尾输出', () => {
    const v = classifyCodexOrca({
      trigger: 'no_progress',
      tail: tuiFixture('question').tail,
      idle_ms: 1,
      contract,
    })
    expect(v?.reason).toBe('question')
  })
})

describe('approvalExecutionLines', () => {
  test.each([
    [
      'working',
      'bunx biome check --write packages/node/src/node.ts packages/node/test/verification.test.ts && bun test packages/node/test/verification.test.ts',
    ],
    [
      'pr-opened',
      "gh run view 1000000001 --json status,conclusion,jobs --jq '{status,conclusion,jobs:[.jobs[] | {databaseId,status,conclusion}]}'",
    ],
  ])('真实 %s 的省略号 Ran 记录匹配完整命令', (fixture, command) => {
    const evidence = approvalExecutionLines(tuiFixture(fixture).tail, command)
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toStartWith('• Ran ')
    expect(evidence[0]).toEndWith('…')
    expect(
      approvalExecutionLines(tuiFixture(fixture).tail, 'git push --force origin HEAD'),
    ).toEqual([])
  })

  test('按 approval-denied 的屏幕折行布局拼接 Ran 命令，包括词内断行', () => {
    const tail = tuiFixture('approval-denied').tail
    const command = 'mkdir -p /tmp/raindown-tui-probe-dir3'
    // 复用真实拒绝场景，注入执行后的 Ran 行；fixture 原本的 Exited 不算批准。
    const wrapped = tail.flatMap((line) =>
      line.startsWith('• Exited') ? ['• Ran mkdir -p /tmp/raindown-', '  tui-probe-dir3'] : [line],
    )
    expect(approvalExecutionLines(tail, command)).toEqual([])
    expect(approvalExecutionLines(wrapped, command)).toEqual([
      '• Ran mkdir -p /tmp/raindown-\n  tui-probe-dir3',
    ])
    expect(
      approvalExecutionLines(['• Ran mkdir -p', '  /tmp/raindown-tui-probe-dir3'], command),
    ).toHaveLength(1)
  })

  test('保留每次相同执行记录，方便调用方按数量识别新增证据', () => {
    const command = 'mkdir -p /tmp/raindown-tui-probe-dir2'
    const ran = `• Ran ${command}`
    const old = [ran, '  └ (no output)', '• 已完成。']
    expect(approvalExecutionLines(old, command)).toEqual([ran])
    expect(approvalExecutionLines([...old, ran, '  └ (no output)'], command)).toEqual([ran, ran])
    // 已完整匹配的历史记录不会吞入后面的终端标题和待批弹窗。
    expect(approvalExecutionLines([ran, ...tuiFixture('approval').tail], command)).toEqual([ran])
  })

  test('批准文案兼容上游源码，并可折行', () => {
    const command = 'mkdir -p /tmp/raindown-tui-probe-dir2'
    // 这两种批准文字来自上游 approvals.rs，没有声称是真实屏幕 fixture。
    expect(
      approvalExecutionLines(
        [
          `✓ You approved codex to run ${command} this time`,
          'You approved codex to run mkdir -p',
          '  /tmp/raindown-tui-probe-dir2 every time this session',
        ],
        command,
      ),
    ).toHaveLength(2)
    expect(
      approvalExecutionLines(
        ['✔ You approved codex to run mkdir -p /tmp/raindown-tui-probe… this time'],
        command,
      ),
    ).toHaveLength(1)
  })

  test('短前缀、不同命令、输出文字和批准前 Running 均不算执行证据', () => {
    const command = 'mkdir -p /tmp/raindown-tui-probe-dir2'
    expect(
      approvalExecutionLines(
        [
          ...tuiFixture('approval').tail,
          '• Ran mkdir…',
          '• Ran mkdir -p…',
          '• Ran mkdir -p /tmp/another-directory…',
          '• Ran mkdir -p /tmp/raindown-tui-probe-dir20',
          '• Ran git push --force origin HEAD',
          `  └ • Ran ${command}`,
          `✗ You did not approve codex to run ${command}`,
          `You approved codex to run ${command}…`,
        ],
        command,
      ),
    ).toEqual([])
    expect(approvalExecutionLines([`• Ran ${command}`], 'git push --force origin HEAD')).toEqual([])
    expect(approvalExecutionLines([`• Ran ${command}`, '  --other'], command)).toEqual([])
  })
})

describe('composerReady：只有最后几行是 Codex 输入框才能敲入文字', () => {
  const exitedWithComposerInScrollback = [
    '• Done.',
    '',
    '› Ask Codex to do anything',
    '  ? for shortcuts',
    '',
    'Token usage: total=1',
    'user@host repo %',
  ]
  test('Codex 已退出、滚动历史中残留输入框：不算输入框，分类为 shell 提示符', () => {
    expect(composerReady(exitedWithComposerInScrollback)).toBe(false)
    expect(atShellPrompt(exitedWithComposerInScrollback)).toBe(true)
    expect(analyzeTail(exitedWithComposerInScrollback).kind).toBe('shell_prompt')
  })
  test('末尾就是输入框及其状态行时可以敲入', () => {
    expect(
      composerReady(['• 已完成。', '', '› Ask Codex to do anything', '  ? for shortcuts']),
    ).toBe(true)
    expect(composerReady(['› ', ''])).toBe(true)
    expect(composerReady(['› Ask Codex', 'a', 'b', 'c'])).toBe(false)
    expect(composerReady([])).toBe(false)
    // 末行只剩裸提示符（精简主题的 shell）也不算输入框。
    expect(composerReady(['› Ask Codex to do anything', '  ? for shortcuts', '$ '])).toBe(false)
    expect(composerReady(['› Ask Codex to do anything', '  ? for shortcuts', '  ❯'])).toBe(false)
    expect(composerReady(['› Ask Codex to do anything', '  ? for shortcuts', 'repo %'])).toBe(false)
    // 输入框本身与 Codex 状态行不按裸提示符判断。
    expect(composerReady(['› Ask Codex', '  ⏎ send … · 3%'])).toBe(true)
    expect(composerReady(['› fix #'])).toBe(true)
    expect(composerReady(['› Ask Codex', '$ '])).toBe(false)
  })
  test('终端标题过长、Codex 页脚折成三行时仍可敲入（2026-11-25 实测）', () => {
    const wrappedFooter = [
      '  Worked for 1m 6s • 22:14',
      '› Ask Codex to do anything',
      '  GPT-6.1-Sol high · ~/raindown-home/run/tasks/t-20261124-141125-dcc9b6/repo · Raindown 任务 t-20261124-141125-dcc9b6',
      '  workspace：ws/product-r…',
      '  ← for agents · ? for shortcuts                                         ⚠ 1 warning · f2 to view',
    ]
    expect(composerReady(wrappedFooter)).toBe(true)
    // 多于两行时末行必须是 Codex 页脚；输入框之后跟任意输出仍不算。
    expect(composerReady(['› Ask Codex', '  a · b', '  c', '  d'])).toBe(false)
    expect(composerReady(['› Ask Codex', '  a', '  b', '  c', '  ? for shortcuts', '  e'])).toBe(
      false,
    )
    // 输入框离末尾超过四行：不算。
    expect(composerReady(['› Ask Codex', 'a', 'b', 'c', 'd', '  ? for shortcuts'])).toBe(false)
    // 折行页脚之后出现 shell 提示符：Codex 已退出。
    expect(composerReady([...wrappedFooter, 'user@host repo %'])).toBe(false)
  })
})
