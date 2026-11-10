import { afterEach, describe, expect, test } from 'bun:test'
import { actOnInbox } from '../src/inbox/actions.ts'
import {
  createInboxReactor,
  createNodeProtocol,
  createTaskService,
  openLedger,
} from '../src/index.ts'
import {
  anyRole,
  contractInput,
  drafts,
  must,
  startTask,
  tempLedger,
  WS,
} from './ledger-helpers.ts'
import { FakeClock } from './server-fixtures.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function setup() {
  const clock = new FakeClock(Date.parse('2026-10-25T08:00:00Z'))
  const temp = await tempLedger({ now: clock.now })
  cleanups.push(temp.cleanup)
  const ledger = temp.store
  const protocol = createNodeProtocol({ ledger, clock, leaseTtlS: 60, leaseWaitMaxS: 30 })
  const reactor = createInboxReactor({ ledger })
  const tasks = createTaskService({ ledger, roles: anyRole, workspaceExists: () => true })
  cleanups.push(() => {
    reactor.stop()
    protocol.stop()
  })
  reactor.start()
  const task = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
  must(
    protocol.service.registerNode(
      { node_id: 'n1', hostname: 'test', version: '0', capabilities: ['executor:fake'] },
      'user',
    ),
  )
  const lease = must(
    await protocol.service.acquire({ node_id: 'n1', capabilities: ['executor:fake'], wait_s: 0 }),
  ).lease
  if (!lease) throw new Error('缺少租约')
  const renew = (fields: Record<string, unknown>) =>
    protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token, ...fields })
  return { ...temp, ledger, protocol, reactor, tasks, task, lease, renew }
}

const approval = {
  id: 'approval-1',
  kind: 'approval_outside_raindown',
  command: 'git push',
  message: '终端已执行',
}

describe('带外上报与收件箱', () => {
  test('带外批准恢复任务、关闭原授权；续约重试与重放不重复；用户可忽略', async () => {
    const ctx = await setup()
    const { ledger, task, reactor, renew } = ctx
    must(renew({ blocked: { reason: 'awaiting_approval', message: '批准 git push？' } }))
    await reactor.idle()
    const original = ledger.listInboxItems({ source: 'task', state: 'open' })[0]
    if (!original) throw new Error('缺少授权条目')
    must(renew({ out_of_band: [approval, approval] }))
    await reactor.idle()
    expect(ledger.getTask(task.id)?.status).toBe('running')
    expect(ledger.getInboxItem(original.id)?.closed?.reason).toBe('handled_externally')
    const item = ledger.listInboxItems({ source: 'out_of_band', state: 'open' })[0]
    expect(item).toMatchObject({
      level: 'interrupt',
      source: 'out_of_band',
      task_id: task.id,
      actions: [],
    })
    expect(item?.body).toContain(task.id)
    expect(item?.body).toContain('git push')
    expect(item?.body).toContain('终端已执行')
    must(renew({ out_of_band: [approval], resumed: {} }))
    await reactor.idle()
    expect(ledger.taskEvents(task.id).filter((e) => e.type === 'task.out_of_band')).toHaveLength(1)
    expect(ledger.taskEvents(task.id).filter((e) => e.type === 'task.unblocked')).toHaveLength(1)
    must(
      await actOnInbox(
        { ledger, tasks: ctx.tasks, home: ctx.dir, scanProposals: async () => {} },
        item?.id ?? '',
        { action: 'dismiss' },
        'user',
      ),
    )
    reactor.reconcile()
    await reactor.idle()
    expect(ledger.getInboxItem(item?.id ?? '')?.closed?.reason).toBe('dismissed')
    must(ledger.rebuild())
    expect(ledger.getInboxItem(original.id)?.closed?.reason).toBe('handled_externally')
    expect(ledger.getInboxItem(item?.id ?? '')?.closed?.reason).toBe('dismissed')
    expect(ledger.listInboxItems({ source: 'out_of_band', state: 'closed' })).toHaveLength(1)
    must(renew({ blocked: { reason: 'awaiting_approval', message: '新的授权请求' } }))
    await reactor.idle()
    must(renew({ out_of_band: [approval] }))
    reactor.reconcile()
    await reactor.idle()
    expect(ledger.getTask(task.id)?.status).toBe('blocked')
    expect(ledger.listInboxItems({ source: 'task', state: 'open' })).toHaveLength(1)
  })

  test('卡住后会话删除仍被保留，恢复任务不会关闭带外条目', async () => {
    const { ledger, task, renew, reactor } = await setup()
    must(
      renew({
        blocked: { reason: 'workdir_missing', message: '任务工作目录不存在' },
        out_of_band: [{ id: 'removed', kind: 'session_removed', message: '目录被删除' }],
      }),
    )
    await reactor.idle()
    expect(ledger.getTask(task.id)?.blocked?.reason).toBe('workdir_missing')
    const item = ledger.listInboxItems({ source: 'out_of_band', state: 'open' })[0]
    expect(item?.body).toContain('目录被删除')
    must(renew({ resumed: {} }))
    await reactor.idle()
    expect(ledger.getInboxItem(item?.id ?? '')?.state).toBe('open')
    must(
      ledger.append(
        {
          task_id: task.id,
          workspace: WS,
          type: 'task.blocked',
          payload: { reason: 'workdir_missing', message: '会话已关闭' },
        },
        { actor: 'node:n1' },
      ),
    )
    must(
      ledger.append(
        {
          task_id: task.id,
          workspace: WS,
          type: 'task.out_of_band',
          payload: { id: 'removed-after-blocked', kind: 'session_removed' },
        },
        { actor: 'node:n1' },
      ),
    )
    await reactor.idle()
    expect(ledger.listInboxItems({ source: 'out_of_band', state: 'open' })).toHaveLength(2)
    must(ledger.rebuild())
    expect(ledger.getTask(task.id)?.blocked?.reason).toBe('workdir_missing')
    expect(ledger.listInboxItems({ source: 'out_of_band', state: 'open' })).toHaveLength(2)
  })

  test('旧账本打开后接受新原因与事件，反应器跨游标补开且不重复', async () => {
    const temp = await tempLedger()
    cleanups.push(temp.cleanup)
    must(temp.store.append(drafts('legacy')['task.created'], { actor: 'user' }))
    startTask(temp.store, 'legacy')
    temp.store.close()
    const ledger = await openLedger(temp.path)
    cleanups.push(() => ledger.close())
    must(
      ledger.append(
        {
          task_id: 'legacy',
          workspace: WS,
          type: 'task.blocked',
          payload: { reason: 'workdir_missing', message: '目录丢失' },
        },
        { actor: 'node:n1' },
      ),
    )
    const event = must(
      ledger.append(
        {
          task_id: 'legacy',
          workspace: WS,
          type: 'task.out_of_band',
          payload: { id: 'removed', kind: 'session_removed' },
        },
        { actor: 'node:n1' },
      ),
    )
    // 模拟其他条目已推进反应器账本游标，但带外条目尚未写入。
    must(
      ledger.append(
        {
          type: 'inbox.item_created',
          payload: {
            item_id: 'pol.later',
            level: 'digest',
            source: 'policy',
            source_ref: 'later',
            source_seq: event.seq + 1,
            title: '稍后条目',
            body: '记录',
          },
        },
        { actor: 'hub' },
      ),
    )
    const reactor = createInboxReactor({ ledger })
    reactor.start()
    await reactor.idle()
    reactor.stop()
    const resumed = createInboxReactor({ ledger })
    resumed.start()
    await resumed.idle()
    resumed.stop()
    expect(ledger.listInboxItems({ source: 'out_of_band', state: 'open' })).toHaveLength(1)
    must(ledger.rebuild())
    expect(ledger.getTask('legacy')?.blocked?.reason).toBe('workdir_missing')
    expect(ledger.listInboxItems({ source: 'out_of_band', state: 'open' })).toHaveLength(1)
  })
})

describe('mds 重置（worker-credential-isolation 4.5）', () => {
  test('节点上报 mds_reset：写任务事件与 Digest 级收件箱条目（来源 isolation，只列文件名），不改变任务状态；重试与重放不重复', async () => {
    const { ledger, task, reactor, renew } = await setup()
    const signal = {
      id: 'mds-reset:l-1',
      kind: 'mds_reset',
      files: ['mdsDirectory.db', 'planted.db', 'evil\n- 伪造的行'],
    }
    must(renew({ out_of_band: [signal] }))
    must(renew({ out_of_band: [signal] }))
    await reactor.idle()
    expect(ledger.getTask(task.id)?.status).toBe('running')
    expect(ledger.taskEvents(task.id).filter((e) => e.type === 'task.out_of_band')).toMatchObject([
      { payload: signal },
    ])
    const items = ledger.listInboxItems({ source: 'isolation', state: 'open' })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      level: 'digest',
      source: 'isolation',
      task_id: task.id,
      reason: 'mds_reset',
      actions: [],
    })
    expect(items[0]?.body).toContain('mdsDirectory.db')
    expect(items[0]?.body).toContain('"planted.db"')
    // worker 控制的文件名逐个 JSON 引号转义，不能伪造换行（审查第一轮）。
    expect(items[0]?.body).toContain('"evil\\n- 伪造的行"')
    expect(items[0]?.body).not.toContain('evil\n')
    expect(ledger.listInboxItems({ source: 'out_of_band' })).toHaveLength(0)
    reactor.reconcile()
    await reactor.idle()
    must(ledger.rebuild())
    expect(ledger.listInboxItems({ source: 'isolation' })).toHaveLength(1)
    // 文件名列表不能为空。
    expect(renew({ out_of_band: [{ id: 'mds-x', kind: 'mds_reset', files: [] }] }).ok).toBe(false)
  })

  test('审查第三轮：inbox=none 只写任务事件；inbox=repeated 写一条“反复重置”的 Digest 条目', async () => {
    const { ledger, task, reactor, renew } = await setup()
    must(
      renew({
        out_of_band: [
          {
            id: 'mds-count',
            kind: 'mds_reset',
            files: ['mdsObject.db'],
            repeats: { 'mdsObject.db': 3 },
            inbox: 'none',
          },
          {
            id: 'mds-repeated',
            kind: 'mds_reset',
            files: ['mdsObject.db'],
            repeats: { 'mdsObject.db': 6 },
            inbox: 'repeated',
          },
        ],
      }),
    )
    await reactor.idle()
    expect(ledger.taskEvents(task.id).filter((e) => e.type === 'task.out_of_band')).toHaveLength(2)
    const items = ledger.listInboxItems({ source: 'isolation' })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ level: 'digest', reason: 'mds_reset_repeated' })
    expect(items[0]?.title).toContain('反复重置')
    expect(items[0]?.body).toContain('"mdsObject.db"（6 次）')
  })
})
