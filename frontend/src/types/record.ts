/** 现场记录修订状态：生效中 / 与其它标签页并列待确认 / 已废弃版本 */
export type RecordStatus = '生效' | '待确认' | '已废弃'

/** 现场记录：某拍摄日某镜次下，一个连戏要素的实际状态 */
export interface Record {
  id: string
  /** 拍摄日 */
  shootDayId: string
  /** 连戏要素 */
  elementId: string
  /** 所属场次（冗余存储，便于按场次统计） */
  sceneId: string
  /** 镜次 */
  takeNo: string
  /** 当前状态描述 */
  currentState: string
  /** 照片说明 */
  photoNote: string
  /** 记录人 */
  recordedBy: string
  /** 修订状态：两个标签页改到同一镜次且分叉时，相关版本转为「待确认」 */
  status: RecordStatus
  /** 并列版本组 id：同组记录是同一镜次的多个候选版本，空串表示无分叉 */
  versionGroup: string
  /** 来源标签（标签页标识 / 历史数据 / 演示播种 / 备份导入 / 自动比对等留痕） */
  source: string
}

/** 批量提交中可编辑的业务字段（并发控制字段由提交层补齐） */
export type RecordFormData = Pick<
  Record,
  'shootDayId' | 'elementId' | 'sceneId' | 'takeNo' | 'currentState' | 'photoNote' | 'recordedBy'
>

export const RECORD_STATUSES: RecordStatus[] = ['生效', '待确认', '已废弃']

/** 批量提交单条动作：新建（无 targetId）或在基线修订上修改（带 targetId + baseRevision） */
export interface RecordBatchItem {
  /** 提交方生成的临时 id，便于去重与错误回显 */
  clientId: string
  targetId: string | null
  /** 修改时所依据的行修订号；与当前行不一致说明被其它标签页抢先保存 */
  baseRevision: number | null
  data: RecordFormData
}

/** 批量提交逐条结果，供提交后提示哪些条目发生分叉 */
export type RecordBatchOutcomeStatus = 'merged' | 'created' | 'noop' | 'conflict' | 'rejected'

export interface RecordBatchOutcome {
  clientId: string
  targetId: string
  status: RecordBatchOutcomeStatus
  /** 并列版本组 id（仅分叉待确认时有值） */
  versionGroup: string
  detail: string
}

export interface RecordBatchResult {
  outcomes: RecordBatchOutcome[]
  /** 本次提交是否产生了并列待确认版本 */
  hasConflicts: boolean
}

/** 整组写入失败后保留的可重试草稿（单独持久化在 recordDrafts 表） */
export interface RecordDraft {
  id: string
  shootDayId: string
  /** 提交来源标签 */
  source: string
  note: string
  items: RecordBatchItem[]
  createdAt: number
  updatedAt: number
  /** 最近一次重试失败信息 */
  lastError: string
  attemptCount: number
}

export function createEmptyRecord(): RecordFormData {
  return {
    shootDayId: '',
    elementId: '',
    sceneId: '',
    takeNo: '',
    currentState: '',
    photoNote: '',
    recordedBy: ''
  }
}
