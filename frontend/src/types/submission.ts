/**
 * 批量提交：同一拍摄日的一组现场记录作为一个原子批次合入。
 * - committed：已合入（组内可能留有并列待确认版本，待人工裁决）
 * - failed：任一写入失败后整组回滚，保留为可重试草稿
 */
import type { RecordFields } from './record'

/** 批次状态 */
export type SubmissionState = 'committed' | 'failed'

/** 组内单条条目：带基线修订的 upsert */
export interface SubmissionItem {
  /** 已存在记录的 id；新增时为空串 */
  recordId: string
  fields: RecordFields
  /** 编辑时读取到的基线版本号；新增为 0 */
  baseRevision: number
}

/** 一条记录的最终合入去向（回执用） */
export type ItemOutcomeKind = 'merged' | 'created' | 'duel' | 'unchanged'

export interface SubmissionItemResult {
  recordId: string
  outcome: ItemOutcomeKind
  /** 并列待确认时的分组 id */
  duelGroupId: string
}

/** 提交回执 */
export interface BatchCommitResult {
  submissionId: string
  merged: number
  created: number
  duels: number
  unchanged: number
  /** 合入后该拍摄日仍待人工裁决的并列分组数 */
  pendingDuelGroups: number
  /** 重算的差异条目数（受影响要素范围） */
  conflictsRecomputed: number
  results: SubmissionItemResult[]
}

/** 持久化的提交批次（含失败草稿，可重试） */
export interface Submission {
  id: string
  /** 整组归属的拍摄日 */
  shootDayId: string
  state: SubmissionState
  /** 提交来源标签（标签页/终端标识） */
  source: string
  items: SubmissionItem[]
  /** 失败原因（仅 failed） */
  errorMessage: string
  /** 已重试次数 */
  retryCount: number
  createdAt: number
  updatedAt: number
}
