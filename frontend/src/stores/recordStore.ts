/**
 * 现场记录 store：维护现场记录、当前拍摄日上下文与批量提交入口。
 * 单条保存与批量保存都走 commitBatch（带基线修订、整组事务、失败留草稿）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { ShootDay } from '@/types/shootDay'
import type { FilterModel } from '@/types/filter'
import type { RecordFields } from '@/types/record'
import type { BatchCommitResult, SubmissionItem } from '@/types/submission'
import {
  nextShootOrder,
  putShootDay,
  removeRecord,
  removeShootDay,
  updateShootDay as updateShootDayRow,
  ROW_REVISION
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'
import { commitBatch, discardDraft, resolveDuel, type DuelResolutionResult } from '@/utils/batch'
import { getClientLabel } from '@/utils/source'

export const RECORD_FILTER_KEYS = ['sceneIds', 'takes']

export const useRecordStore = defineStore('record', () => {
  const filters = ref<FilterModel>({ keyword: '', sceneIds: [], takes: [] })
  /** 当前选中的拍摄日（现场记录页的上下文） */
  const currentShootDayId = ref<string | null>(null)

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

  async function createShootDay(payload: Omit<ShootDay, 'id'>): Promise<string> {
    if (!payload.date) throw new Error('请选择拍摄日期')
    if (payload.sceneIds.length === 0) throw new Error('请至少选择一个当日场次')
    const now = Date.now()
    const id = createId('shootday')
    await putShootDay({ ...payload, id, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    currentShootDayId.value = id
    return id
  }

  async function updateShootDay(id: string, patch: Partial<ShootDay>): Promise<void> {
    await updateShootDayRow(id, patch)
  }

  async function deleteShootDay(id: string): Promise<void> {
    await removeShootDay(id)
    if (currentShootDayId.value === id) currentShootDayId.value = null
  }

  /**
   * 批量合入同一拍摄日的一组记录（带基线修订）。
   * 任一写入失败整组回滚并保留可重试草稿，错误向上抛出由页面提示。
   */
  async function commitRecords(
    shootDayId: string,
    items: SubmissionItem[],
    submissionId?: string
  ): Promise<BatchCommitResult> {
    return commitBatch(items, shootDayId, getClientLabel(), submissionId)
  }

  /** 单条新增：作为单元素批次合入（单边新增直接合入） */
  async function createRecord(payload: RecordFields): Promise<BatchCommitResult> {
    if (!payload.shootDayId) throw new Error('请先选择拍摄日')
    if (!payload.elementId) throw new Error('请选择连戏要素')
    if (!payload.currentState.trim()) throw new Error('请填写当前状态')
    return commitRecords(payload.shootDayId, [{ recordId: '', fields: payload, baseRevision: 0 }])
  }

  /** 单条修订：携带编辑时基线，基线漂移则与其它标签页版本并列待确认 */
  async function updateRecord(
    id: string,
    patch: RecordFields,
    baseRevision: number
  ): Promise<BatchCommitResult> {
    return commitRecords(patch.shootDayId, [{ recordId: id, fields: patch, baseRevision }])
  }

  async function deleteRecord(id: string): Promise<void> {
    await removeRecord(id)
  }

  /** 并列待确认裁决：选择胜出方 */
  async function resolveRecordDuel(groupId: string, winnerId: string): Promise<DuelResolutionResult> {
    return resolveDuel(groupId, winnerId)
  }

  /** 放弃失败草稿 */
  async function discardSubmission(submissionId: string): Promise<void> {
    await discardDraft(submissionId)
  }

  /** 保留给后续扩展：拍摄顺序号 */
  async function peekNextOrder(): Promise<number> {
    return nextShootOrder()
  }

  return {
    filters,
    currentShootDayId,
    setFilters,
    resetFilters,
    applyQuery,
    selectShootDay,
    createShootDay,
    updateShootDay,
    deleteShootDay,
    commitRecords,
    createRecord,
    updateRecord,
    deleteRecord,
    resolveRecordDuel,
    discardSubmission,
    peekNextOrder
  }
})
