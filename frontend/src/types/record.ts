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
}

/** 记录生命周期状态：生效 / 待确认（与另一版本并列待裁决） / 已作废（裁决落败） */
export type RecordLifecycle = '生效' | '待确认' | '已作废'

/** 编辑表单使用的字段 */
export type RecordFields = Omit<Record, 'id'>

export function createEmptyRecord(): RecordFields {
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

/** 同一拍摄日下一条记录的业务键：同一镜次同一要素只允许有一条生效记录 */
export function recordBusinessKey(record: Pick<Record, 'shootDayId' | 'elementId' | 'takeNo'>): string {
  return `${record.shootDayId}::${record.elementId}::${record.takeNo}`
}
