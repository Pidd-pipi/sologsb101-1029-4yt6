/**
 * 现场记录 store：维护当前拍摄日上下文、批量提交暂存盘与写入结果。
 *
 * 现场记录不再逐条直写：同一拍摄日的新建 / 修改先进入暂存盘，点「整组提交」时
 * 一次性走带基线修订的批量事务；失败后由批量模块落可重试草稿（页面侧响应式订阅）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { ShootDay } from '@/types/shootDay'
import type {
  Record as ContinuityRecord,
  RecordBatchItem,
  RecordBatchResult,
  RecordFormData
} from '@/types/record'
import type { FilterModel } from '@/types/filter'
import {
  nextShootOrder,
  putShootDay,
  removeShootDay,
  removeRecord as removeRecordRow,
  updateShootDay as updateShootDayRow,
  stampRow,
  type RecordRow
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'
import { commitRecordBatch, persistFailedBatch } from '@/utils/recordBatch'

export const RECORD_FILTER_KEYS = ['sceneIds', 'takes']

/** 暂存盘条目：待整组提交的新建 / 修改 */
export interface StagedRecordItem {
  clientId: string
  /** 修改目标记录 id；新建为 null */
  targetId: string | null
  /** 修改时依据的行修订号（打开编辑对话框时抓取） */
  baseRevision: number | null
  data: RecordFormData
}

export const useRecordStore = defineStore('record', () => {
  const filters = ref<FilterModel>({ keyword: '', sceneIds: [], takes: [] })
  /** 当前选中的拍摄日（现场记录页的上下文） */
  const currentShootDayId = ref<string | null>(null)
  /** 待整组提交的暂存条目 */
  const stagedItems = ref<StagedRecordItem[]>([])
  /** 最近一次整组提交结果（供页面提示分叉与合入情况） */
  const lastBatchResult = ref<RecordBatchResult | null>(null)
  /** 最近一次提交失败后留存的草稿 id（页面据此提示重试） */
  const lastDraftId = ref<string | null>(null)
  const submitting = ref(false)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', sceneIds: [], takes: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, RECORD_FILTER_KEYS)
    if (typeof query.shootDayId === 'string' && query.shootDayId.length > 0) {
      currentShootDayId.value = query.shootDayId
    }
  }

  function selectShootDay(id: string | null): void {
    currentShootDayId.value = id
  }

  /* ------------------------------ 拍摄日 ------------------------------ */

  async function createShootDay(payload: Omit<ShootDay, 'id'>): Promise<string> {
    if (!payload.date) throw new Error('请选择拍摄日期')
    if (payload.sceneIds.length === 0) throw new Error('请至少选择一个当日场次')
    const id = createId('shootday')
    await putShootDay(stampRow({ ...payload, id }))
    currentShootDayId.value = id
    return id
  }

  async function updateShootDay(id: string, patch: Partial<ShootDay>): Promise<void> {
    await updateShootDayRow(id, patch)
  }

  async function deleteShootDay(id: string): Promise<void> {
    await removeShootDay(id)
    stagedItems.value = stagedItems.value.filter((item) => item.data.shootDayId !== id)
    if (currentShootDayId.value === id) currentShootDayId.value = null
  }

  /* ------------------------- 暂存盘：先攒后整组提交 ------------------------- */

  function validateRecordData(data: RecordFormData): void {
    if (!data.shootDayId) throw new Error('请先选择拍摄日')
    if (!data.elementId) throw new Error('请选择连戏要素')
    if (!data.currentState.trim()) throw new Error('请填写当前状态')
    if (!data.takeNo.trim()) throw new Error('请填写镜次')
  }

  /** 新建入暂存盘（不直接写库） */
  function stageCreate(data: RecordFormData): string {
    validateRecordData(data)
    const clientId = createId('staged')
    stagedItems.value.push({ clientId, targetId: null, baseRevision: null, data: { ...data } })
    return clientId
  }

  /** 修改入暂存盘，携带基线修订号 */
  function stageUpdate(row: RecordRow, data: RecordFormData): string {
    validateRecordData(data)
    const clientId = createId('staged')
    stagedItems.value.push({ clientId, targetId: row.id, baseRevision: row.revision, data: { ...data } })
    return clientId
  }

  /** 编辑同一目标时复用同一暂存条目，避免重复堆叠 */
  function replaceStagedTarget(targetId: string, data: RecordFormData, baseRevision: number): void {
    validateRecordData(data)
    const index = stagedItems.value.findIndex(
      (item) => item.targetId === targetId && item.data.shootDayId === data.shootDayId
    )
    if (index >= 0) {
      stagedItems.value[index] = {
        ...stagedItems.value[index],
        baseRevision,
        data: { ...data }
      }
      return
    }
    stagedItems.value.push({
      clientId: createId('staged'),
      targetId,
      baseRevision,
      data: { ...data }
    })
  }

  function unstage(clientId: string): void {
    stagedItems.value = stagedItems.value.filter((item) => item.clientId !== clientId)
  }

  function clearStaging(shootDayId?: string): void {
    if (!shootDayId) {
      stagedItems.value = []
      return
    }
    stagedItems.value = stagedItems.value.filter((item) => item.data.shootDayId !== shootDayId)
  }

  function stagedOfDay(shootDayId: string): StagedRecordItem[] {
    return stagedItems.value.filter((item) => item.data.shootDayId === shootDayId)
  }

  /**
   * 整组提交同一拍摄日的暂存记录（带基线修订的批量事务）。
   * 任一写入失败整组回滚，并把这批条目留成可重试草稿。
   */
  async function submitBatch(shootDayId: string): Promise<RecordBatchResult> {
    const items: RecordBatchItem[] = stagedOfDay(shootDayId).map((item) => ({
      clientId: item.clientId,
      targetId: item.targetId,
      baseRevision: item.baseRevision,
      data: { ...item.data }
    }))
    if (items.length === 0) throw new Error('暂存盘没有待提交记录')
    submitting.value = true
    try {
      const result = await commitRecordBatch(items)
      lastBatchResult.value = result
      lastDraftId.value = null
      clearStaging(shootDayId)
      return result
    } catch (error) {
      const draft = await persistFailedBatch(items, error)
      lastDraftId.value = draft.id
      clearStaging(shootDayId)
      throw error
    } finally {
      submitting.value = false
    }
  }

  /** 删除单条现场记录（并列版本 / 关联差异由页面经批量模块处理） */
  async function deleteRecord(id: string): Promise<void> {
    await removeRecordRow(id)
  }

  /** 保留给后续扩展：拍摄顺序号 */
  async function peekNextOrder(): Promise<number> {
    return nextShootOrder()
  }

  return {
    filters,
    currentShootDayId,
    stagedItems,
    lastBatchResult,
    lastDraftId,
    submitting,
    setFilters,
    resetFilters,
    applyQuery,
    selectShootDay,
    createShootDay,
    updateShootDay,
    deleteShootDay,
    validateRecordData,
    stageCreate,
    stageUpdate,
    replaceStagedTarget,
    unstage,
    clearStaging,
    stagedOfDay,
    submitBatch,
    deleteRecord,
    peekNextOrder
  }
})

export type { ContinuityRecord }
