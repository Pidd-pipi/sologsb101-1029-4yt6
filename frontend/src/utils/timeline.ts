/**
 * 记录时间轴与差异候选构建。
 * - 只把「生效」版本排上时间轴；「待确认」并列版本与「已作废」落败版本一律不参与比对，
 *   直到人工裁决出唯一胜出方。
 * - 被 useContinuityDiff（页面派生视图）与 reconcile（批次合入后的落库重算）共同消费。
 */
import type { ConflictRow, ElementRow, RecordRow, ShootDayRow } from './db'
import { ROW_REVISION } from './db'
import type { ConflictSeverity } from '../types/conflict'
import { describeDiffs, diffRecords, severityOf, sortBySeverity } from './diff'
import { createId } from './uuid'

/** 记录时间轴：先按拍摄日日期，再按镜次排序 */
export function buildTimeline(records: RecordRow[], shootDays: ShootDayRow[]): RecordRow[] {
  const dateOf = (record: RecordRow): string =>
    shootDays.find((day) => day.id === record.shootDayId)?.date ?? ''
  return [...records]
    .filter((record) => record.status === '生效')
    .sort(
      (a, b) =>
        dateOf(a).localeCompare(dateOf(b)) ||
        a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN')
    )
}

/** 一条候选差异：同一要素最近两次生效记录之间的比对结果 */
export interface ConflictCandidate {
  elementId: string
  a: RecordRow
  b: RecordRow
  diffDesc: string
  severity: ConflictSeverity
}

/** 为指定要素集合计算最近两次生效记录的差异候选（无差异不产出） */
export function candidatesForElements(
  elementIds: string[],
  records: RecordRow[],
  elements: ElementRow[],
  shootDays: ShootDayRow[]
): ConflictCandidate[] {
  const idSet = new Set(elementIds)
  const result: ConflictCandidate[] = []
  elements
    .filter((element) => idSet.has(element.id))
    .forEach((element) => {
      const own = buildTimeline(
        records.filter((record) => record.elementId === element.id),
        shootDays
      )
      if (own.length < 2) return
      const a = own[own.length - 2]
      const b = own[own.length - 1]
      const diffs = diffRecords(a, b)
      const severity = severityOf(diffs, element.critical)
      if (!severity) return
      result.push({ elementId: element.id, a, b, diffDesc: describeDiffs(diffs), severity })
    })
  return sortBySeverity(result)
}

/** 把候选差异落成 ConflictRow（来源统一为「自动重算」） */
export function buildConflictRows(candidates: ConflictCandidate[], now: number): ConflictRow[] {
  return candidates.map((item) => ({
    id: createId('conflict'),
    elementId: item.elementId,
    recordIdA: item.a.id,
    recordIdB: item.b.id,
    diffDesc: item.diffDesc,
    severity: item.severity,
    state: '待确认',
    resolvedNote: '',
    resolvedAt: '',
    source: '自动重算',
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  }))
}

/** 某要素当前是否没有卷入任何待确认并列（裁决完成才可作为稳定基准） */
export function elementHasOpenDuel(elementId: string, records: RecordRow[]): boolean {
  return records.some((record) => record.elementId === elementId && record.status === '待确认')
}

/** 该拍摄日下待人工裁决的并列分组数 */
export function countDayDuelGroups(shootDayId: string, records: RecordRow[]): number {
  const groupIds = new Set(
    records
      .filter((record) => record.shootDayId === shootDayId && record.status === '待确认' && record.duelGroupId)
      .map((record) => record.duelGroupId)
  )
  return groupIds.size
}
