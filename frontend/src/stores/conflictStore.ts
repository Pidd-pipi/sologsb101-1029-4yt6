/**
 * 连戏差异 store：维护差异列表、严重程度筛选与解决状态流转。
 * 差异的落库重算由 reconcile 统一负责（批次合入后自动触发，或差异页手动全量重算）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Conflict } from '@/types/conflict'
import type { FilterModel } from '@/types/filter'
import { db, putConflict, removeConflict, reopenConflict, resolveConflict, ROW_REVISION } from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'
import { reconcileInTx } from '@/utils/reconcile'

export const CONFLICT_FILTER_KEYS = ['severities', 'states']

export const useConflictStore = defineStore('conflict', () => {
  const filters = ref<FilterModel>({ keyword: '', severities: [], states: [] })
  const lastGenerated = ref<number>(0)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', severities: [], states: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, CONFLICT_FILTER_KEYS)
  }

  /**
   * 全量重新比对：所有要素名下的自动差异失效并按当前生效记录重建。
   * 同一对记录的既有结论（含已解决留痕）沿用；手工登记条目不参与替换。
   * 返回重建后的自动条目数。
   */
  async function regenerateAll(): Promise<number> {
    return db.transaction('rw', [db.records, db.conflicts, db.elements, db.shootDays], async () => {
      const elements = await db.elements.toArray()
      const records = await db.records.toArray()
      const mutated = new Map(records.map((record) => [record.id, record]))
      const count = await reconcileInTx(
        elements.map((element) => element.id),
        mutated
      )
      lastGenerated.value = count
      return count
    })
  }

  /** 手工登记一条差异（用于现场口头发现的偏差，重算不会替换它） */
  async function createManual(payload: Omit<Conflict, 'id' | 'resolvedNote' | 'resolvedAt' | 'source'>): Promise<string> {
    const now = Date.now()
    const id = createId('conflict')
    await putConflict({
      ...payload,
      id,
      resolvedNote: '',
      resolvedAt: '',
      source: '手工登记',
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
    return id
  }

  /** 解决差异：写入留痕并回写要素初始状态 */
  async function resolve(id: string, note: string): Promise<void> {
    await resolveConflict(id, note)
  }

  async function reopen(id: string): Promise<void> {
    await reopenConflict(id)
  }

  async function remove(id: string): Promise<void> {
    await removeConflict(id)
  }

  return { filters, lastGenerated, setFilters, resetFilters, applyQuery, regenerateAll, createManual, resolve, reopen, remove }
})
