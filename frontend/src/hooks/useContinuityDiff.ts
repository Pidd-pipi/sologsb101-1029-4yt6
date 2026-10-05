/**
 * 按要素取最近两次「生效」现场记录做字段级比对，派生差异列表与严重程度。
 * 被差异比对页、现场记录页与报告页共同消费；与批次合入后的落库重算共用 timeline 逻辑。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import type { ConflictSeverity } from '@/types/conflict'
import type { ElementCategory } from '@/types/element'
import type { ShootDayRow, ElementRow, RecordRow } from '@/utils/db'
import { candidatesForElements } from '@/utils/timeline'
import { diffRecords, describeDiffs, severityOf, sortBySeverity, type FieldDiff } from '@/utils/diff'

/** 一条候选差异：同一要素最近两次生效记录之间的比对结果 */
export interface DiffCandidate {
  elementId: string
  elementName: string
  category: ElementCategory
  owner: string
  critical: boolean
  sceneId: string
  /** 较早的一次记录 */
  a: RecordRow
  /** 较晚的一次记录 */
  b: RecordRow
  diffs: FieldDiff[]
  severity: ConflictSeverity
  desc: string
}

export interface ContinuityDiffResult {
  /** 全部存在差异的候选条目（按严重程度倒序） */
  candidates: ComputedRef<DiffCandidate[]>
  /** 差异条目数 */
  diffCount: ComputedRef<number>
  /** 阻断级差异数 */
  blockingCount: ComputedRef<number>
  /** 指定要素是否存在差异 */
  hasDiff: (elementId: string) => boolean
  /** 指定场次的差异条数 */
  countByScene: (sceneId: string) => number
}

/**
 * @param records    全部现场记录（含待确认/已作废版本，内部会过滤）
 * @param elements   全部连戏要素
 * @param shootDays  全部拍摄日（用于把记录排到时间轴上）
 */
export function useContinuityDiff(
  records: Ref<RecordRow[]>,
  elements: Ref<ElementRow[]>,
  shootDays: Ref<ShootDayRow[]>
): ContinuityDiffResult {
  const candidates = computed<DiffCandidate[]>(() => {
    const result: DiffCandidate[] = []
    const rawCandidates = candidatesForElements(
      elements.value.map((item) => item.id),
      records.value,
      elements.value,
      shootDays.value
    )
    rawCandidates.forEach((candidate) => {
      const element = elements.value.find((item) => item.id === candidate.elementId)
      if (!element) return
      // 重新计算字段级明细，供页面并排展示
      const diffs = diffRecords(candidate.a, candidate.b)
      const severity = severityOf(diffs, element.critical)
      if (!severity) return
      result.push({
        elementId: element.id,
        elementName: element.name,
        category: element.category,
        owner: element.owner,
        critical: element.critical,
        sceneId: element.sceneId,
        a: candidate.a,
        b: candidate.b,
        diffs,
        severity,
        desc: describeDiffs(diffs)
      })
    })
    return sortBySeverity(result)
  })

  return {
    candidates,
    diffCount: computed(() => candidates.value.length),
    blockingCount: computed(() => candidates.value.filter((item) => item.severity === '阻断').length),
    hasDiff: (elementId: string) => candidates.value.some((item) => item.elementId === elementId),
    countByScene: (sceneId: string) => candidates.value.filter((item) => item.sceneId === sceneId).length
  }
}
