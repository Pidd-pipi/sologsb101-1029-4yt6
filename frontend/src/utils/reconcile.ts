/**
 * 合入后派生数据重算（必须在已开启的 records/conflicts/elements 读写事务内调用）：
 * 1. 受影响要素的「自动重算」差异整体失效，按最近两次生效记录重建；同一对记录的既有结论
 *    （待确认 / 已解决留痕）沿用，避免重算把已解决差异又翻成待确认。
 * 2. 没有待确认并列、也没有待确认差异的要素，连戏基准回写为最新生效记录的状态。
 * 手工登记的差异永不参与失效替换。
 */
import { db } from './db'
import type { ElementRow, RecordRow, ShootDayRow } from './db'
import { buildConflictRows, buildTimeline, candidatesForElements, elementHasOpenDuel } from './timeline'

/** 比对记录对的业务键（同一对记录的差异结论可沿用） */
function pairKey(recordIdA: string, recordIdB: string): string {
  return `${recordIdA}::${recordIdB}`
}

/** 把事务内刚写入的记录合并进全量快照，得到重算所用的最新视图 */
function mergeMutated(records: RecordRow[], mutated: Map<string, RecordRow>): RecordRow[] {
  const merged = new Map<string, RecordRow>()
  records.forEach((record) => merged.set(record.id, record))
  mutated.forEach((record, id) => merged.set(id, record))
  return [...merged.values()]
}

/**
 * 失效并重算指定要素的自动差异，返回重建后的条目数。
 * @param elementIds 本次合入触及的要素
 * @param mutatedRecords 事务内已写入 / 改状态的记录（快照读不到，由调用方显式传入）
 */
export async function reconcileInTx(
  elementIds: string[],
  mutatedRecords: Map<string, RecordRow>
): Promise<number> {
  if (elementIds.length === 0) return 0
  const idSet = new Set(elementIds)

  const [elements, shootDays, storedRecords] = await Promise.all([
    db.elements.toArray(),
    db.shootDays.toArray(),
    db.records.toArray()
  ])
  const shootDayList: ShootDayRow[] = shootDays
  const records = mergeMutated(storedRecords, mutatedRecords)

  // 1) 失效：删除这些要素名下的全部自动条目（重建时沿用同对记录的结论）
  const previous = (await db.conflicts.where('elementId').anyOf([...idSet]).toArray()).filter(
    (item) => item.source === '自动重算'
  )
  await db.conflicts
    .where('elementId')
    .anyOf([...idSet])
    .filter((item) => item.source === '自动重算')
    .delete()

  // 2) 重算：最近两次生效记录之间的差异
  const candidates = candidatesForElements([...idSet], records, elements, shootDayList)
  const now = Date.now()
  const rows = buildConflictRows(candidates, now).map((row) => {
    const prior = previous.find(
      (item) => pairKey(item.recordIdA, item.recordIdB) === pairKey(row.recordIdA, row.recordIdB)
    )
    if (!prior) return row
    // 同一对记录：沿用既有 id、修订号与解决结论，只刷新差异描述 / 严重程度
    return {
      ...row,
      id: prior.id,
      revision: prior.revision,
      createdAt: prior.createdAt,
      state: prior.state,
      resolvedNote: prior.resolvedNote,
      resolvedAt: prior.resolvedAt
    }
  })
  if (rows.length > 0) await db.conflicts.bulkPut(rows)

  // 3) 连戏要素基准同步：稳定要素（无并列、无未决差异）以最新生效状态为基准
  const scopedElements: ElementRow[] = elements.filter((element) => idSet.has(element.id))
  for (const element of scopedElements) {
    if (elementHasOpenDuel(element.id, records)) continue
    const openCount = await db.conflicts
      .where('elementId')
      .equals(element.id)
      .filter((item) => item.state === '待确认')
      .count()
    if (openCount > 0) continue
    const own = buildTimeline(
      records.filter((record): record is RecordRow => record.elementId === element.id),
      shootDayList
    )
    const latest = own[own.length - 1]
    if (latest && element.initialState !== latest.currentState) {
      await db.elements.update(element.id, { initialState: latest.currentState, updatedAt: now } as never)
    }
  }

  return rows.length
}
