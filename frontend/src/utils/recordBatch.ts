/**
 * 现场记录批量提交（带基线修订的乐观并发控制）
 *
 * - 同一拍摄日的一组记录在单个 IndexedDB 事务内整组提交：任一写入失败整组回滚，不留半批数据。
 * - 修改携带编辑时的基线修订号：被其它标签页抢先保存且内容分叉时，两个版本并列转「待确认」；
 *   单边新增（同镜次此前没有记录）直接合入。
 * - 合入后受影响要素的旧差异失效并按生效记录重算；该要素已无待确认差异时，把要素基准回写为
 *   最近一次生效状态。
 * - 事务外捕获失败并落 recordDrafts 表，保留为可重试草稿（重试时重新读取基线再判定）。
 */
import {
  db,
  putRecordDraft,
  removeRecordDraft,
  type ElementRow,
  type RecordRow,
  type ConflictRow,
  type RecordDraftRow
} from './db'
import type {
  Record as ContinuityRecord,
  RecordBatchItem,
  RecordBatchOutcome,
  RecordBatchResult,
  RecordDraft
} from '../types/record'
import { createId } from './uuid'
import { currentSource } from './source'
import { describeDiffs, diffRecords, normalizeStateText, severityOf } from './diff'

/** 参与「同镜次」判定与内容比较的字段（不含修订元数据） */
type ComparableRecord = Pick<
  ContinuityRecord,
  'shootDayId' | 'elementId' | 'takeNo' | 'currentState' | 'photoNote' | 'recordedBy'
>

/** 两条记录内容是否一致（状态文本走归一化，同义词写法不判分叉） */
function sameContent(a: ComparableRecord, b: ComparableRecord): boolean {
  return (
    a.shootDayId === b.shootDayId &&
    a.elementId === b.elementId &&
    a.takeNo.trim() === b.takeNo.trim() &&
    normalizeStateText(a.currentState) === normalizeStateText(b.currentState) &&
    a.photoNote.trim() === b.photoNote.trim() &&
    a.recordedBy.trim() === b.recordedBy.trim()
  )
}

/** 记录时间轴：先按拍摄日日期，再按镜次排序（与 useContinuityDiff 口径一致） */
function buildTimeline(records: RecordRow[], dateOf: (row: RecordRow) => string): RecordRow[] {
  return [...records]
    .filter((item) => item.status === '生效')
    .sort(
      (a, b) =>
        dateOf(a).localeCompare(dateOf(b)) || a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN')
    )
}

/** 找到同一拍摄日同一要素同一镜次下的其它候选记录（并列版本） */
function findPeers(all: RecordRow[], data: ComparableRecord, excludeId: string): RecordRow[] {
  return all.filter(
    (item) =>
      item.id !== excludeId &&
      item.status !== '已废弃' &&
      item.shootDayId === data.shootDayId &&
      item.elementId === data.elementId &&
      item.takeNo.trim() === data.takeNo.trim()
  )
}

/**
 * 合入后处理：受影响要素的差异失效重算，并在无待确认差异时回写连戏要素基准。
 * 必须在批量提交事务内调用。
 */
async function reconcileAfterMerge(
  affectedElementIds: Set<string>,
  allRecords: RecordRow[]
): Promise<void> {
  if (affectedElementIds.size === 0) return
  const elements = await db.elements.where('id').anyOf([...affectedElementIds]).toArray()
  const shootDays = await db.shootDays.toArray()
  const dateOf = (record: RecordRow): string =>
    shootDays.find((day) => day.id === record.shootDayId)?.date ?? ''

  const conflicts: ConflictRow[] = []
  const now = Date.now()
  const baselineUpdates: Array<{ element: ElementRow; state: string }> = []

  for (const element of elements) {
    // 旧差异全部失效：相邻记录对变了，老的 recordIdA/recordIdB 不再代表最新比对
    await db.conflicts.where('elementId').equals(element.id).delete()

    const own = buildTimeline(
      allRecords.filter((record) => record.elementId === element.id),
      dateOf
    )
    if (own.length >= 2) {
      const a = own[own.length - 2]
      const b = own[own.length - 1]
      const diffs = diffRecords(a, b)
      const severity = severityOf(diffs, element.critical)
      if (severity) {
        conflicts.push({
          id: createId('conflict'),
          elementId: element.id,
          recordIdA: a.id,
          recordIdB: b.id,
          diffDesc: describeDiffs(diffs),
          severity,
          state: '待确认',
          resolvedNote: '',
          resolvedAt: '',
          revision: 1,
          createdAt: now,
          updatedAt: now,
          source: '自动比对'
        })
      }
    }

    // 基准回写：重算后该要素没有待确认差异时，基准对齐最近一次生效状态
    const latest = own[own.length - 1]
    if (latest && normalizeStateText(latest.currentState) !== normalizeStateText(element.initialState)) {
      baselineUpdates.push({ element, state: latest.currentState })
    }
  }

  if (conflicts.length > 0) await db.conflicts.bulkPut(conflicts)
  for (const { element, state } of baselineUpdates) {
    // 刚生成的待确认差异以最新两条记录为准；若已生成差异则保留旧基准，等差异消解
    const stillOpen = conflicts.some((item) => item.elementId === element.id)
    if (!stillOpen) {
      await db.elements.update(element.id, { initialState: state, updatedAt: Date.now() } as never)
    }
  }
}

/**
 * 整组提交同一拍摄日的现场记录（带基线修订）。
 *
 * @returns 逐条合入结果；调用失败时（事务回滚）抛出异常，由调用方落草稿
 */
export async function commitRecordBatch(
  items: RecordBatchItem[],
  source: string = currentSource()
): Promise<RecordBatchResult> {
  if (items.length === 0) return { outcomes: [], hasConflicts: false }
  const shootDayId = items[0].data.shootDayId
  if (!shootDayId) throw new Error('请先选择拍摄日')
  if (items.some((item) => item.data.shootDayId !== shootDayId)) {
    throw new Error('一次批量提交只能包含同一拍摄日的记录')
  }

  const outcomes: RecordBatchOutcome[] = []
  const affectedElementIds = new Set<string>()

  await db.transaction('rw', [db.records, db.conflicts, db.elements, db.shootDays], async () => {
    // 单事务内读全表，保证「基线校验 + 写入 + 重算」期间没有其它事务穿插
    let all = await db.records.toArray()

    for (const item of items) {
      const data = item.data
      if (!data.elementId) throw new Error(`${item.clientId}：请选择连戏要素`)
      if (!data.takeNo.trim()) throw new Error(`${item.clientId}：请填写镜次`)
      if (!data.currentState.trim()) throw new Error(`${item.clientId}：请填写当前状态`)
      const element = await db.elements.get(data.elementId)
      if (!element) throw new Error(`${item.clientId}：连戏要素不存在或已被删除`)
      if (!data.sceneId) data.sceneId = element.sceneId
      affectedElementIds.add(data.elementId)

      if (item.targetId) {
        const existing = all.find((row) => row.id === item.targetId)
        if (!existing) throw new Error(`${item.clientId}：原记录已被删除，请刷新后重试`)
        if (existing.status === '已废弃') {
          throw new Error(`${item.clientId}：该版本已废弃，不能继续编辑`)
        }

        const incoming: ComparableRecord = { ...data }
        if (existing.status === '待确认') {
          // 已经在并列待确认：允许继续编辑自己的版本，不改变并列状态与版本组
          const next: RecordRow = {
            ...existing,
            ...incoming,
            revision: existing.revision + 1,
            status: '待确认',
            updatedAt: Date.now()
          }
          await db.records.put(next)
          all = all.map((row) => (row.id === next.id ? next : row))
          outcomes.push({
            clientId: item.clientId,
            targetId: next.id,
            status: 'conflict',
            versionGroup: next.versionGroup,
            detail: '已更新你的待确认版本'
          })
          continue
        }

        if (sameContent(existing, incoming)) {
          outcomes.push({
            clientId: item.clientId,
            targetId: existing.id,
            status: 'noop',
            versionGroup: '',
            detail: '内容无变化'
          })
          continue
        }

        const stale = item.baseRevision !== null && existing.revision !== item.baseRevision
        // 他人的抢先保存可能是原地修订（当前行就是对方版本），也可能已与另一行并列待确认
        const peerAll = stale ? findPeers(all, incoming, existing.id) : []
        const divergentPeers = peerAll.filter((peer) => !sameContent(peer, incoming))
        const currentDiverged = stale && !sameContent(existing, incoming)

        if (stale && (currentDiverged || divergentPeers.length > 0)) {
          // 两个标签页改到同一镜次且分叉：保留对方版本（当前行 / 已并列的 peer）+ 提交版本
          const groupId = existing.versionGroup || createId('vgrp')
          const now = Date.now()
          const retainedRows: RecordRow[] = []
          if (currentDiverged) {
            retainedRows.push({
              ...existing,
              status: '待确认',
              versionGroup: groupId,
              revision: existing.revision + 1,
              updatedAt: now
            })
          }
          divergentPeers.forEach((peer) => {
            if (retainedRows.some((row) => row.id === peer.id)) return
            retainedRows.push({
              ...peer,
              status: '待确认',
              versionGroup: groupId,
              revision: peer.revision + 1,
              updatedAt: now
            })
          })
          const maxRevision = Math.max(existing.revision, ...retainedRows.map((row) => row.revision))
          // 当前行内容与提交一致时，提交版本直接落回当前行；否则作为新版本另存
          const incomingRow: RecordRow = currentDiverged
            ? {
                ...existing,
                ...incoming,
                id: createId('record'),
                status: '待确认',
                versionGroup: groupId,
                source,
                revision: maxRevision + 1,
                createdAt: now,
                updatedAt: now
              }
            : {
                ...existing,
                ...incoming,
                status: '待确认',
                versionGroup: groupId,
                source,
                revision: maxRevision + 1,
                updatedAt: now
              }
          const toWrite = [...retainedRows, incomingRow]
          await db.records.bulkPut(toWrite)
          all = [...all.filter((row) => !toWrite.some((candidate) => candidate.id === row.id)), ...toWrite]
          const otherSource = retainedRows[0]?.source || '另一标签页'
          outcomes.push({
            clientId: item.clientId,
            targetId: incomingRow.id,
            status: 'conflict',
            versionGroup: groupId,
            detail: `与 ${otherSource} 在镜次 ${incoming.takeNo} 的保存分叉，${toWrite.length} 个版本并列待确认`
          })
          continue
        }

        // 基线未变（单边修改）或他人改动内容相同：直接覆盖合入，修订号 +1
        const next: RecordRow = {
          ...existing,
          ...incoming,
          status: '生效',
          versionGroup: '',
          revision: existing.revision + 1,
          updatedAt: Date.now()
        }
        await db.records.put(next)
        all = all.map((row) => (row.id === next.id ? next : row))
        outcomes.push({
          clientId: item.clientId,
          targetId: next.id,
          status: 'merged',
          versionGroup: '',
          detail: stale ? '他人改动与你的内容一致，已合入' : '已在基线上修订并合入'
        })
        continue
      }

      // 新增：同镜次已有非废弃记录时视为「两个标签页同时新增」
      const peers = findPeers(all, { ...data }, '')
      const divergentPeer = peers.find((peer) => !sameContent(peer, data))
      const now = Date.now()
      if (divergentPeer) {
        const groupId = createId('vgrp')
        const updatedPeer: RecordRow = {
          ...divergentPeer,
          status: '待确认',
          versionGroup: groupId,
          revision: divergentPeer.revision + 1,
          updatedAt: now
        }
        const created: RecordRow = {
          ...data,
          id: createId('record'),
          status: '待确认',
          versionGroup: groupId,
          source,
          revision: 1,
          createdAt: now,
          updatedAt: now
        }
        await db.records.bulkPut([updatedPeer, created])
        all = [...all, updatedPeer, created].filter(
          (row, index, list) => list.findIndex((candidate) => candidate.id === row.id) === index
        )
        outcomes.push({
          clientId: item.clientId,
          targetId: created.id,
          status: 'conflict',
          versionGroup: groupId,
          detail: `与 ${divergentPeer.source || '另一标签页'} 同时新增镜次 ${data.takeNo} 且内容不同，并列待确认`
        })
      } else {
        // 单边新增直接合入
        const created: RecordRow = {
          ...data,
          id: createId('record'),
          status: '生效',
          versionGroup: '',
          source,
          revision: 1,
          createdAt: now,
          updatedAt: now
        }
        await db.records.put(created)
        all = [...all, created]
        outcomes.push({
          clientId: item.clientId,
          targetId: created.id,
          status: 'created',
          versionGroup: '',
          detail: '新增记录已合入'
        })
      }
    }

    await reconcileAfterMerge(affectedElementIds, all)
  })

  return { outcomes, hasConflicts: outcomes.some((item) => item.status === 'conflict') }
}

/* --------------------------- 并列版本裁定 --------------------------- */

/** 裁定动作：采纳某版本（其余废弃）/ 废弃某版本 */
export type RecordVersionAction = '采纳' | '废弃'

/**
 * 处理并列待确认版本：
 * - 采纳：目标版本转生效，同组其它版本转已废弃并清空版本组；
 * - 废弃：仅目标版本转已废弃；组内剩一个版本时自动采纳。
 * 处理后差异失效重算、要素基准同步。
 */
export async function resolveRecordVersions(
  recordId: string,
  action: RecordVersionAction
): Promise<void> {
  await db.transaction('rw', [db.records, db.conflicts, db.elements, db.shootDays], async () => {
    const target = await db.records.get(recordId)
    if (!target) throw new Error('记录不存在或已被删除')
    if (!target.versionGroup) throw new Error('该记录不在并列待确认版本组中')

    let all = await db.records.toArray()
    const group = all.filter((row) => row.versionGroup === target.versionGroup && row.status !== '已废弃')
    const now = Date.now()
    const affected = new Set<string>()

    const mark = (row: RecordRow, patch: Partial<RecordRow>): RecordRow => {
      const next: RecordRow = {
        ...row,
        ...patch,
        revision: row.revision + 1,
        updatedAt: now
      }
      return next
    }

    if (action === '废弃') {
      const abandoned = mark(target, { status: '已废弃', versionGroup: '' })
      const remaining = group.filter((row) => row.id !== target.id)
      const changed = [abandoned]
      if (remaining.length === 1) {
        changed.push(mark(remaining[0], { status: '生效', versionGroup: '' }))
      }
      group.forEach((row) => affected.add(row.elementId))
      await db.records.bulkPut(changed)
      all = all.map((row) => {
        const hit = changed.find((item) => item.id === row.id)
        return hit ?? row
      })
    } else {
      const changed: RecordRow[] = group.map((row) =>
        mark(row, row.id === target.id ? { status: '生效', versionGroup: '' } : { status: '已废弃', versionGroup: '' })
      )
      group.forEach((row) => affected.add(row.elementId))
      await db.records.bulkPut(changed)
      all = all.map((row) => {
        const hit = changed.find((item) => item.id === row.id)
        return hit ?? row
      })
    }

    await reconcileAfterMerge(affected, all)
  })
}

/* ----------------------------- 草稿留存 ----------------------------- */

/** 整组提交失败后，把这批条目持久化为可重试草稿（事务已回滚，库内不留半批数据） */
export async function persistFailedBatch(
  items: RecordBatchItem[],
  error: unknown,
  existingDraftId?: string,
  source: string = currentSource()
): Promise<RecordDraftRow> {
  const message = error instanceof Error ? error.message : '未知写入错误'
  const shootDayId = items[0]?.data.shootDayId ?? ''
  const now = Date.now()

  if (existingDraftId) {
    const previous = await db.recordDrafts.get(existingDraftId)
    if (previous) {
      const next: RecordDraftRow = {
        ...previous,
        items: toPlainItems(items),
        source,
        note: message,
        lastError: message,
        attemptCount: previous.attemptCount + 1,
        updatedAt: now
      }
      await putRecordDraft(next)
      return next
    }
  }

  const draft: RecordDraftRow = {
    id: createId('draft'),
    shootDayId,
    source,
    note: message,
    items: toPlainItems(items),
    createdAt: now,
    updatedAt: now,
    lastError: message,
    attemptCount: 1,
    revision: 1
  }
  await putRecordDraft(draft)
  return draft
}

/** Vue 代理对象深拷贝为可结构化克隆的普通草稿条目 */
function toPlainItems(items: RecordBatchItem[]): RecordBatchItem[] {
  return items.map((item) => ({
    clientId: item.clientId,
    targetId: item.targetId,
    baseRevision: item.baseRevision,
    data: { ...item.data }
  }))
}

/** 重试草稿：重新走一遍基线判定；成功后删除草稿，失败则更新错误信息与尝试次数 */
export async function retryRecordDraft(draft: RecordDraft): Promise<RecordBatchResult> {
  try {
    const result = await commitRecordBatch(toPlainItems(draft.items), draft.source || currentSource())
    await removeRecordDraft(draft.id)
    return result
  } catch (error) {
    await persistFailedBatch(toPlainItems(draft.items), error, draft.id, draft.source || currentSource())
    throw error
  }
}
