/**
 * 同拍摄日一组现场记录的批量原子提交（带基线修订的乐观并发控制）。
 *
 * 并发语义（多个浏览器标签页同时编辑同一拍摄日）：
 * - 单边新增：业务键（拍摄日+要素+镜次）无冲突 → 直接合入；
 * - 改到同一镜次：基线修订与库内当前修订不一致 → 不覆盖，两个版本并列「待确认」，
 *   现场页并排核对、人工裁决，落败方置「已作废」；
 * - 内容一致或基线未漂移：静默合入 / 记为无变化。
 *
 * 可靠性：
 * - 预检 + 全部写入 + 差异重算 + 基准同步在同一个 Dexie 事务内完成，任一写入失败整组回滚，
 *   不留下半批数据；
 * - 失败后用独立事务保存可重试草稿（submissions 表 state=failed），可一键重试或放弃。
 */
import { db } from './db'
import type { RecordRow, SubmissionRow } from './db'
import { ROW_REVISION } from './db'
import type { BatchCommitResult, SubmissionItem, SubmissionItemResult } from '../types/submission'
import { recordBusinessKey } from '../types/record'
import { createId } from './uuid'
import { reconcileInTx } from './reconcile'
import { countDayDuelGroups } from './timeline'

/** 组内条目预检：任一不合法直接抛错（事务回滚 + 草稿保留） */
function validateItem(item: SubmissionItem): void {
  const f = item.fields
  if (!f.shootDayId) throw new Error('组内存在未选择拍摄日的记录')
  if (!f.elementId) throw new Error('组内存在未选择连戏要素的记录')
  if (!f.sceneId) throw new Error('组内存在缺少所属场次的记录')
  if (!f.takeNo.trim()) throw new Error('组内存在未填写镜次的记录')
  if (!f.currentState.trim()) throw new Error('组内存在未填写当前状态的记录')
  if (!Number.isInteger(item.baseRevision) || item.baseRevision < 0) {
    throw new Error('组内条目的基线修订号不合法')
  }
}

/** 组内业务键去重，防止同一批次自己与自己并列 */
function assertNoDuplicateKeys(items: SubmissionItem[]): void {
  const seen = new Set<string>()
  items.forEach((item) => {
    const key = recordBusinessKey(item.fields)
    if (seen.has(key)) throw new Error(`同一批次中镜次「${item.fields.takeNo}」的该要素出现了多次，请先在草稿内合并`)
    seen.add(key)
  })
}

/** 两条记录内容是否一致（忽略并发元数据） */
function sameContent(a: Pick<SubmissionItem, 'fields'>, row: RecordRow): boolean {
  const f = a.fields
  return (
    f.elementId === row.elementId &&
    f.sceneId === row.sceneId &&
    f.takeNo === row.takeNo &&
    f.currentState === row.currentState &&
    f.photoNote === row.photoNote &&
    f.recordedBy === row.recordedBy
  )
}

/**
 * 批量合入一组记录。
 * @param items        组内条目（带基线修订）
 * @param shootDayId   整组归属拍摄日
 * @param source       提交来源标签（标签页/终端标识）
 * @param submissionId 重试时传入既有草稿 id，失败时在同一条草稿上累计重试次数
 */
export async function commitBatch(
  items: SubmissionItem[],
  shootDayId: string,
  source: string,
  submissionId?: string
): Promise<BatchCommitResult> {
  if (!shootDayId) throw new Error('请先选择拍摄日')
  if (items.length === 0) throw new Error('本组没有可提交的记录')
  items.forEach(validateItem)
  assertNoDuplicateKeys(items)
  if (!items.every((item) => item.fields.shootDayId === shootDayId)) {
    throw new Error('组内记录必须属于同一个拍摄日')
  }

  const id = submissionId ?? createId('submission')
  let result: BatchCommitResult
  try {
    result = await db.transaction(
      'rw',
      [db.records, db.conflicts, db.elements, db.shootDays, db.submissions],
      async () => {
        const results: SubmissionItemResult[] = []
        const mutated = new Map<string, RecordRow>()
        const touchedElements = new Set<string>()
        let created = 0
        let merged = 0
        let duels = 0
        let unchanged = 0
        const now = Date.now()

        for (const item of items) {
          const f = item.fields
          const key = recordBusinessKey(f)
          const targetByKey = (await db.records
            .where('shootDayId')
            .equals(f.shootDayId)
            .toArray())
            .filter((row) => recordBusinessKey(row) === key)
            .map((row) => mutated.get(row.id) ?? row)
          // 同业务键上的有效版本（待确认或生效）；已作废版本不占键
          const active = targetByKey.find((row) => row.status !== '已作废')

          const targetById: RecordRow | undefined = item.recordId
            ? mutated.get(item.recordId) ?? (await db.records.get(item.recordId))
            : undefined
          // 编辑目标已被裁决作废 → 不能再以它为基线合入
          if (item.recordId && targetById && targetById.status === '已作废') {
            throw new Error(`镜次「${f.takeNo}」原记录已在并列裁决中作废，请基于保留版本重新编辑后重试`)
          }

          // 业务键与 id 都指向同一条时以它为目标
          const target = active ?? targetById

          if (!target) {
            // 单边新增（也覆盖“原 id 已不存在”的重试场景）
            const row: RecordRow = {
              id: item.recordId || createId('record'),
              ...f,
              revision: ROW_REVISION,
              createdAt: now,
              updatedAt: now,
              source,
              status: '生效',
              duelGroupId: '',
              duelWinner: '',
              submissionId: id
            }
            await db.records.put(row)
            mutated.set(row.id, row)
            touchedElements.add(f.elementId)
            created += 1
            results.push({ recordId: row.id, outcome: 'created', duelGroupId: '' })
            continue
          }

          if (target.status === '生效' && sameContent(item, target)) {
            unchanged += 1
            results.push({ recordId: target.id, outcome: 'unchanged', duelGroupId: '' })
            continue
          }

          if (target.status === '生效' && target.revision === item.baseRevision) {
            // 基线未漂移：直接覆盖修订，修订号 +1
            const row: RecordRow = {
              ...target,
              ...f,
              revision: target.revision + 1,
              updatedAt: now,
              source,
              status: '生效',
              duelGroupId: '',
              duelWinner: '',
              submissionId: id
            }
            await db.records.put(row)
            mutated.set(row.id, row)
            touchedElements.add(f.elementId)
            merged += 1
            results.push({ recordId: row.id, outcome: 'merged', duelGroupId: '' })
            continue
          }

          // 基线漂移：两个标签页改到同一镜次 → 并列待确认，不覆盖
          const groupId = target.duelGroupId || createId('duel')
          const peer: RecordRow = {
            ...target,
            status: '待确认',
            duelGroupId: groupId,
            updatedAt: now
          }
          const challenger: RecordRow = {
            id: createId('record'),
            ...f,
            revision: ROW_REVISION,
            createdAt: now,
            updatedAt: now,
            source,
            status: '待确认',
            duelGroupId: groupId,
            duelWinner: '',
            submissionId: id
          }
          await db.records.put(peer)
          await db.records.put(challenger)
          mutated.set(peer.id, peer)
          mutated.set(challenger.id, challenger)
          touchedElements.add(f.elementId)
          touchedElements.add(peer.elementId)
          duels += 1
          results.push({ recordId: challenger.id, outcome: 'duel', duelGroupId: groupId })
        }

        // 合入后：相关差异失效重算 + 连戏要素基准同步
        const conflictsRecomputed = await reconcileInTx([...touchedElements], mutated)

        const allRecords = [
          ...(await db.records.toArray()).filter((row) => !mutated.has(row.id)),
          ...mutated.values()
        ]
        const pendingDuelGroups = countDayDuelGroups(shootDayId, allRecords)

        // 提交批次留痕；若是重试（草稿 id 已存在）则转为已合入
        const existing = await db.submissions.get(id)
        const row: SubmissionRow = {
          id,
          shootDayId,
          state: 'committed',
          source,
          items,
          errorMessage: '',
          retryCount: existing?.retryCount ?? 0,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        }
        await db.submissions.put(row)

        return {
          submissionId: id,
          merged,
          created,
          duels,
          unchanged,
          pendingDuelGroups,
          conflictsRecomputed,
          results
        }
      }
    )
  } catch (error) {
    // 事务已整体回滚：独立事务保留可重试草稿，不留半批业务数据
    const message = error instanceof Error ? error.message : '批量写入失败'
    await saveFailedDraft(id, items, shootDayId, source, submissionId ? 1 : 0, message)
    throw error instanceof Error ? error : new Error(message)
  }
  return result
}

/** 失败草稿落库（独立事务，确保主事务回滚后草稿仍在） */
async function saveFailedDraft(
  id: string,
  items: SubmissionItem[],
  shootDayId: string,
  source: string,
  retryInc: number,
  message: string
): Promise<void> {
  const now = Date.now()
  await db.transaction('rw', [db.submissions], async () => {
    const existing = await db.submissions.get(id)
    await db.submissions.put({
      id,
      shootDayId,
      state: 'failed',
      source,
      items,
      errorMessage: message,
      retryCount: (existing?.retryCount ?? 0) + retryInc,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    })
  })
}

/** 放弃草稿（删除失败批次） */
export async function discardDraft(submissionId: string): Promise<void> {
  await db.submissions.delete(submissionId)
}

export interface DuelResolutionResult {
  winnerId: string
  loserId: string
  groupId: string
  conflictsRecomputed: number
  /** 胜出版本落定后的最新记录（供页面提示来源） */
  winner: RecordRow
}

/**
 * 并列待确认裁决：胜出版本转生效并 +1 修订，落败版本置已作废；
 * 随后失效重算该要素差异并同步基准。
 */
export async function resolveDuel(groupId: string, winnerId: string): Promise<DuelResolutionResult> {
  return db.transaction('rw', [db.records, db.conflicts, db.elements, db.shootDays], async () => {
    const peers = (await db.records.where('duelGroupId').equals(groupId).toArray()).filter(
      (row) => row.status === '待确认'
    )
    if (peers.length < 2) throw new Error('该并列分组已不可裁决（可能已在其它标签页处理）')
    const winner = peers.find((row) => row.id === winnerId)
    if (!winner) throw new Error('所选胜出版本不存在')
    const now = Date.now()
    const mutated = new Map<string, RecordRow>()

    for (const peer of peers) {
      const isWinner = peer.id === winnerId
      const next: RecordRow = {
        ...peer,
        status: isWinner ? '生效' : '已作废',
        duelWinner: isWinner ? '' : winnerId,
        revision: isWinner ? peer.revision + 1 : peer.revision,
        updatedAt: now
      }
      await db.records.put(next)
      mutated.set(next.id, next)
    }

    const elementIds = [...new Set(peers.map((peer) => peer.elementId))]
    const conflictsRecomputed = await reconcileInTx(elementIds, mutated)
    const winnerRow = mutated.get(winnerId) as RecordRow
    return { winnerId, loserId: peers.find((row) => row.id !== winnerId)?.id ?? '', groupId, conflictsRecomputed, winner: winnerRow }
  })
}
