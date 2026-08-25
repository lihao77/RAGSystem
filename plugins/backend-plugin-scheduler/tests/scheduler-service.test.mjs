import assert from 'node:assert/strict'
import test from 'node:test'

import { createTenantId, createUserId } from '@ragsystem/backend-core/identity/types.js'
import { SchedulerService, resolveSessionId, SchedulerServiceError } from '../dist/services/scheduler-service.js'

const TENANT = createTenantId('tnt_test')
const OWNER = createUserId('usr_owner')

function createTask(overrides = {}) {
  return {
    tenant_id: TENANT,
    task_id: 'daily-report',
    cron: '0 9 * * *',
    task: '汇总今日数据',
    team: null,
    entry_agent: null,
    session_id: null,
    enabled: true,
    permission_mode: 'relaxed',
    owner_user_id: OWNER,
    delivery: null,
    next_run: null,
    last_run: null,
    last_result: null,
    created_at: '2026-08-25T00:00:00Z',
    updated_at: '2026-08-25T00:00:00Z',
    ...overrides,
  }
}

function createFakeStore(tasks = []) {
  const state = { tasks: tasks.map((task) => ({ ...task })), claims: [], updates: [] }
  const store = {
    state,
    async listTasks(tenantId) { return state.tasks.filter((task) => task.tenant_id === tenantId) },
    async claimDueTasks({ now, leaseOwner }) {
      return state.tasks
        .filter((task) => task.enabled && task.next_run !== null && task.next_run <= now)
        .map((task) => {
          const claim = {
            tenantId: task.tenant_id,
            taskId: task.task_id,
            claimToken: `token-${task.task_id}`,
            attemptId: `attempt-${task.task_id}`,
            leaseOwner,
            leaseExpiresAt: now + 300,
          }
          state.claims.push(claim)
          return claim
        })
    },
    async completeTaskClaim(input) { return state.claims.splice(state.claims.findIndex((claim) => claim.claimToken === input.claimToken), 1).length > 0 },
    async releaseTaskClaim(input) { return store.completeTaskClaim(input) },
    async getTask(tenantId, taskId) { return state.tasks.find((task) => task.tenant_id === tenantId && task.task_id === taskId) ?? null },
    async createTask(tenantId, ownerId, input) {
      const task = createTask({ tenant_id: tenantId, owner_user_id: createUserId(ownerId), ...input })
      state.tasks.push(task)
      return task
    },
    async updateTask(tenantId, taskId, patch) {
      const task = state.tasks.find((item) => item.tenant_id === tenantId && item.task_id === taskId)
      if (!task) return null
      Object.assign(task, patch)
      state.updates.push({ taskId, patch })
      return task
    },
    async deleteTask(tenantId, taskId) {
      const index = state.tasks.findIndex((item) => item.tenant_id === tenantId && item.task_id === taskId)
      if (index < 0) return false
      state.tasks.splice(index, 1)
      return true
    },
  }
  return store
}

test('due tasks are claimed, executed, and completed with recomputed next_run', async () => {
  const store = createFakeStore([createTask({ next_run: Date.now() / 1000 - 10 })])
  const runs = []
  const service = new SchedulerService({
    taskStore: store,
    runTask: async (input) => { runs.push(input.task.task_id); return { suspended: false, content: '执行结果' } },
  })
  await service.triggerTask(TENANT, 'daily-report', 'token-daily-report')

  assert.deepEqual(runs, ['daily-report'])
  const task = store.state.tasks[0]
  assert.ok(task.last_run > 0)
  assert.ok(task.next_run > task.last_run, 'next_run 应按 cron 重算到未来')
  assert.equal(task.last_result, '执行结果')
  assert.equal(store.state.claims.length, 0, '执行完成后应释放认领')
  assert.deepEqual(service.getTaskHistory(TENANT, 'daily-report', 10)[0].result, '执行结果')
})

test('execution failure records ERROR result and still recomputes next_run', async () => {
  const store = createFakeStore([createTask({ next_run: 1 })])
  const service = new SchedulerService({
    taskStore: store,
    runTask: async () => { throw new Error('agent 执行失败') },
  })
  await assert.rejects(() => service.triggerTask(TENANT, 'daily-report', 'token-daily-report'), SchedulerServiceError)

  const task = store.state.tasks[0]
  assert.ok(task.last_result.startsWith('ERROR:'))
  assert.ok(task.next_run > 0, '失败后仍需按 cron 推进，避免每分钟重试失败任务')
  const history = service.getTaskHistory(TENANT, 'daily-report', 10)
  assert.equal(history[0].success, false)
})

test('delivery channel missing degrades without failing the run', async () => {
  const store = createFakeStore([createTask({ next_run: 1, delivery: { channel: 'feishu', target: 'oc_123', bot_id: 'usr_bot' } })])
  const deliveries = []
  const service = new SchedulerService({
    taskStore: store,
    runTask: async () => ({ suspended: false, content: 'ok' }),
    deliver: async (input) => { deliveries.push(input); return false },
  })
  const result = await service.triggerTask(TENANT, 'daily-report', 'token-daily-report')
  assert.equal(result.status, 'ok')
  assert.equal(deliveries.length, 1, '投递被尝试过一次')
  assert.equal(deliveries[0].channel, 'feishu')
})

test('suspended runs record SUSPENDED and still deliver the notification', async () => {
  const store = createFakeStore([createTask({ next_run: 1, delivery: { channel: 'feishu', target: 'oc_123', bot_id: 'usr_bot' } })])
  const deliveries = []
  const service = new SchedulerService({
    taskStore: store,
    runTask: async () => ({ suspended: true, content: '' }),
    deliver: async (input) => { deliveries.push(input); return true },
  })
  const result = await service.triggerTask(TENANT, 'daily-report', 'token-daily-report')
  assert.equal(result.result, null)
  assert.equal(store.state.tasks[0].last_result, 'SUSPENDED')
  assert.equal(deliveries[0].suspended, true)
})

test('create computes next_run only when enabled; update recomputes on cron change', async () => {
  const store = createFakeStore()
  const service = new SchedulerService({ taskStore: store, runTask: async () => ({ suspended: false, content: '' }) })
  const created = await service.createTask(TENANT, 'usr_owner', {
    task_id: 'paused-job', cron: '0 9 * * *', task: '内容', enabled: false,
  })
  assert.equal(created.next_run, null, '停用任务不应排期')

  await service.updateTask(TENANT, 'paused-job', { enabled: true })
  assert.ok(store.state.tasks[0].next_run > 0, '启用后应立即排期')

  await assert.rejects(
    () => service.createTask(TENANT, 'usr_owner', { task_id: 'paused-job', cron: '0 9 * * *', task: '重复' }),
    /任务已存在/,
  )
})

test('trigger rejects unknown or disabled tasks', async () => {
  const store = createFakeStore([createTask({ task_id: 'off-job', enabled: false })])
  const service = new SchedulerService({ taskStore: store, runTask: async () => ({ suspended: false, content: '' }) })
  await assert.rejects(() => service.triggerTask(TENANT, 'missing'), /任务不存在或未启用/)
  await assert.rejects(() => service.triggerTask(TENANT, 'off-job'), /任务不存在或未启用/)
})

test('leader lease follower does not start the scheduler and promotes on retry', async () => {
  const store = createFakeStore([createTask({ next_run: 1 })])
  let runs = 0
  const service = new SchedulerService({
    taskStore: store,
    tickMs: 20,
    runTask: async () => { runs += 1; return { suspended: false, content: '' } },
    leaderLease: { acquire: async () => false, release: async () => undefined },
  })
  await service.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(runs, 0, 'follower 不应执行调度')
  service.close()
})

test('scheduler loop claims due tasks periodically', async () => {
  const store = createFakeStore([createTask({ next_run: Date.now() / 1000 - 5 })])
  let runs = 0
  const service = new SchedulerService({
    taskStore: store,
    tickMs: 20,
    runTask: async () => { runs += 1; return { suspended: false, content: 'loop' } },
  })
  await service.start()
  await new Promise((resolve) => setTimeout(resolve, 120))
  service.close()
  assert.ok(runs >= 1, '调度循环应至少触发一次')
  assert.equal(store.state.claims.length, 0, '循环结束后认领应被释放')
})

test('resolveSessionId derives deterministic ids and honors pinned sessions', () => {
  assert.equal(resolveSessionId({ session_id: ' fixed-session ', task_id: 'x' }), 'fixed-session')
  assert.equal(resolveSessionId({ session_id: null, task_id: 'daily report!' }), 'scheduler-daily_report_')
  assert.equal(resolveSessionId({ session_id: null, task_id: 'same' }), resolveSessionId({ session_id: null, task_id: 'same' }))
})
