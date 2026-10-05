/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbcontinuity-db，数据结构版本号 version(2) 与逐版本 upgrade() 迁移逻辑
 * - 场次 / 连戏要素 / 拍摄日 / 现场记录 / 连戏差异 / 提交批次 六张表分表存储
 * - 首次打开自动播种互相引用的演示数据（含未解决冲突），保证每个页面打开都有内容
 */
import Dexie, { type Table } from 'dexie'
import { toRaw } from 'vue'
import type { Scene } from '../types/scene'
import type { Element } from '../types/element'
import type { ShootDay } from '../types/shootDay'
import type { Record as ContinuityRecord, RecordLifecycle } from '../types/record'
import type { Conflict, ConflictSource } from '../types/conflict'
import type { Submission } from '../types/submission'
import { nowIso } from './uuid'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbcontinuity-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号：新行首版内容修订号，之后每次内容合入 +1 */
export const ROW_REVISION = 1

/** 旧数据升级时的来源标记 */
export const LEGACY_SOURCE = '历史导入'

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number
  createdAt: number
  updatedAt: number
}

export type SceneRow = Scene & Revisioned
export type ElementRow = Element & Revisioned
export type ShootDayRow = ShootDay & Revisioned

/** 现场记录持久化行：领域字段 + 修订 + 带基线并发控制元数据 */
export type RecordRow = ContinuityRecord &
  Revisioned & {
    /** 来源标签：录入的标签页/终端标识 */
    source: string
    /** 生命周期：生效 / 待确认（并列版本） / 已作废（裁决落败） */
    status: RecordLifecycle
    /** 待确认并列分组 id（同业务键两个版本共享），未卷入为空串 */
    duelGroupId: string
    /** 并列裁决胜出方记录 id，未裁决为空串 */
    duelWinner: string
    /** 最近一次写入本行的提交批次 id */
    submissionId: string
  }

export type ConflictRow = Conflict & Revisioned

/** 提交批次持久化行（含可重试草稿） */
export type SubmissionRow = Submission

/**
 * 深度剥掉 Vue 响应式代理（Proxy），得到可被 IndexedDB 结构化克隆的普通对象。
 * 页面里 `v-model` 绑定的数组字段（如 `ShootDay.sceneIds`）是 Vue 的 Proxy 数组，
 * 直接交给 Dexie 会抛 `DataCloneError: [object Object] could not be cloned`，
 * 表现为“保存按钮点了没反应、列表不增加、刷新后丢失”。所有写库入口都必须先过这一层。
 */
export function toPlainRow<T>(value: T): T {
  const raw = toRaw(value) as unknown
  if (Array.isArray(raw)) return raw.map((item) => toPlainRow(item)) as unknown as T
  if (raw !== null && typeof raw === 'object') {
    const proto = Object.getPrototypeOf(raw)
    // 只深拷贝普通对象/数组，Date、Map 等结构化克隆本身支持的对象原样返回
    if (proto === Object.prototype || proto === null) {
      const plain: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(raw)) plain[key] = toPlainRow(item)
      return plain as T
    }
  }
  return raw as T
}

class GbContinuityDatabase extends Dexie {
  scenes!: Table<SceneRow, string>
  elements!: Table<ElementRow, string>
  shootDays!: Table<ShootDayRow, string>
  records!: Table<RecordRow, string>
  conflicts!: Table<ConflictRow, string>
  submissions!: Table<SubmissionRow, string>

  constructor() {
    super(DB_NAME)

    // v1 初始结构：五张业务表
    this.version(1)
      .stores({
        scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
        elements: 'id, sceneId, category, name, owner, critical, updatedAt',
        shootDays: 'id, date, director, scripty, updatedAt',
        records: 'id, shootDayId, elementId, sceneId, takeNo, updatedAt',
        conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // v1 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['scenes', 'elements', 'shootDays', 'records', 'conflicts']
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now()
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            })
        }
      })

    // v2：现场记录增加并发控制字段与状态索引、差异增加来源、新增提交批次表
    this.version(2)
      .stores({
        scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
        elements: 'id, sceneId, category, name, owner, critical, updatedAt',
        shootDays: 'id, date, director, scripty, updatedAt',
        records: 'id, shootDayId, elementId, sceneId, takeNo, status, duelGroupId, updatedAt',
        conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, source, updatedAt',
        submissions: 'id, shootDayId, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // 旧数据升级：历史记录全部视为生效版本，补齐修订、来源与并发字段
        await tx
          .table('records')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.revision !== 'number') row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'number') row.createdAt = Date.now()
            if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            if (typeof row.source !== 'string' || !row.source) row.source = LEGACY_SOURCE
            if (row.status !== '待确认' && row.status !== '已作废') row.status = '生效'
            if (typeof row.duelGroupId !== 'string') row.duelGroupId = ''
            if (typeof row.duelWinner !== 'string') row.duelWinner = ''
            if (typeof row.submissionId !== 'string') row.submissionId = ''
          })
        // 旧差异补齐来源：统一标记为自动重算，下一次合入会整体替换为最新结果
        await tx
          .table('conflicts')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.source !== 'string' || !row.source) row.source = '自动重算'
          })
      })
  }
}

export const db = new GbContinuityDatabase()

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.scenes.count()) === 0) {
    await seedDatabase()
  }
}

/* ------------------------------ 场次 ------------------------------ */

export async function listScenes(): Promise<SceneRow[]> {
  const rows = await db.scenes.toArray()
  return rows.sort((a, b) => a.shootOrder - b.shootOrder)
}

export async function putScene(row: SceneRow): Promise<void> {
  await db.scenes.put(toPlainRow(row))
}

export async function updateScene(id: string, patch: Partial<Scene>): Promise<void> {
  await db.scenes.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

/** 拖拽调序后按新顺序批量写回 shootOrder（从 1 开始自动重编号） */
export async function reorderScenes(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.scenes, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.scenes.update(orderedIds[index], { shootOrder: index + 1, updatedAt: Date.now() } as never)
    }
  })
}

/** 下一个可用拍摄顺序号 */
export async function nextShootOrder(): Promise<number> {
  const rows = await db.scenes.toArray()
  return rows.reduce((max, row) => Math.max(max, row.shootOrder), 0) + 1
}

/** 删除场次：级联删除其下要素、现场记录与差异 */
export async function removeScene(id: string): Promise<void> {
  await db.transaction('rw', [db.scenes, db.elements, db.records, db.conflicts, db.submissions], async () => {
    const elements = await db.elements.where('sceneId').equals(id).toArray()
    const elementIds = elements.map((item) => item.id)
    const records = await db.records.where('sceneId').equals(id).toArray()
    const recordIds = records.map((item) => item.id)
    const shootDayIds = [...new Set(records.map((item) => item.shootDayId))]
    if (elementIds.length > 0) {
      await db.conflicts.where('elementId').anyOf(elementIds).delete()
    }
    if (recordIds.length > 0) {
      await db.conflicts.filter((item) => recordIds.includes(item.recordIdA) || recordIds.includes(item.recordIdB)).delete()
    }
    await db.records.where('sceneId').equals(id).delete()
    await db.elements.where('sceneId').equals(id).delete()
    await db.shootDays.toCollection().modify((day) => {
      if (day.sceneIds.includes(id)) {
        day.sceneIds = day.sceneIds.filter((sceneId) => sceneId !== id)
        day.updatedAt = Date.now()
      }
    })
    if (shootDayIds.length > 0) await db.submissions.where('shootDayId').anyOf(shootDayIds).delete()
    await db.scenes.delete(id)
  })
}

/* ---------------------------- 连戏要素 ---------------------------- */

export async function listElements(): Promise<ElementRow[]> {
  const rows = await db.elements.toArray()
  return rows.sort((a, b) => a.category.localeCompare(b.category, 'zh-Hans-CN') || a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function putElement(row: ElementRow): Promise<void> {
  await db.elements.put(toPlainRow(row))
}

export async function updateElement(id: string, patch: Partial<Element>): Promise<void> {
  await db.elements.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

export async function removeElement(id: string): Promise<void> {
  await db.transaction('rw', [db.elements, db.records, db.conflicts], async () => {
    await db.conflicts.where('elementId').equals(id).delete()
    await db.records.where('elementId').equals(id).delete()
    await db.elements.delete(id)
  })
}

/* ------------------------------ 拍摄日 ------------------------------ */

export async function listShootDays(): Promise<ShootDayRow[]> {
  const rows = await db.shootDays.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putShootDay(row: ShootDayRow): Promise<void> {
  await db.shootDays.put(toPlainRow(row))
}

export async function updateShootDay(id: string, patch: Partial<ShootDay>): Promise<void> {
  await db.shootDays.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

export async function removeShootDay(id: string): Promise<void> {
  await db.transaction('rw', [db.shootDays, db.records, db.conflicts, db.submissions], async () => {
    const records = await db.records.where('shootDayId').equals(id).toArray()
    const recordIds = records.map((item) => item.id)
    if (recordIds.length > 0) {
      await db.conflicts.filter((item) => recordIds.includes(item.recordIdA) || recordIds.includes(item.recordIdB)).delete()
    }
    await db.records.where('shootDayId').equals(id).delete()
    await db.submissions.where('shootDayId').equals(id).delete()
    await db.shootDays.delete(id)
  })
}

/* ---------------------------- 现场记录 ---------------------------- */

export async function listRecords(): Promise<RecordRow[]> {
  const rows = await db.records.toArray()
  return rows.sort((a, b) => a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN'))
}

export async function putRecord(row: RecordRow): Promise<void> {
  await db.records.put(toPlainRow(row))
}

export async function updateRecord(id: string, patch: Partial<ContinuityRecord>): Promise<void> {
  await db.records.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

export async function removeRecord(id: string): Promise<void> {
  await db.transaction('rw', [db.records, db.conflicts], async () => {
    const target = await db.records.get(id)
    await db.conflicts.filter((item) => item.recordIdA === id || item.recordIdB === id).delete()
    // 同要素的自动差异因删除而失效（最近两次记录组合变了），交给下一次合入重算；手工条目保留
    if (target) {
      await db.conflicts
        .filter((item) => item.elementId === target.elementId && item.source === '自动重算')
        .delete()
    }
    await db.records.delete(id)
  })
}

/* ---------------------------- 提交批次 ---------------------------- */

export async function listSubmissions(): Promise<SubmissionRow[]> {
  const rows = await db.submissions.toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function putSubmission(row: SubmissionRow): Promise<void> {
  await db.submissions.put(toPlainRow(row))
}

export async function removeSubmission(id: string): Promise<void> {
  await db.submissions.delete(id)
}

/* ---------------------------- 连戏差异 ---------------------------- */

export async function listConflicts(): Promise<ConflictRow[]> {
  return db.conflicts.toArray()
}

export async function putConflict(row: ConflictRow): Promise<void> {
  await db.conflicts.put(toPlainRow(row))
}

/** 解决差异：写入解决留痕并回写要素的初始状态（以最新现场状态为准） */
export async function resolveConflict(id: string, resolvedNote: string): Promise<void> {
  await db.transaction('rw', [db.conflicts, db.records, db.elements], async () => {
    const conflict = await db.conflicts.get(id)
    if (!conflict) throw new Error('差异条目不存在')
    const latest = await db.records.get(conflict.recordIdB)
    await db.conflicts.update(id, {
      state: '已解决',
      resolvedNote,
      resolvedAt: nowIso(),
      updatedAt: Date.now()
    } as never)
    if (latest) {
      await db.elements.update(conflict.elementId, {
        initialState: latest.currentState,
        updatedAt: Date.now()
      } as never)
    }
  })
}

/** 重新打开差异（误判回退） */
export async function reopenConflict(id: string): Promise<void> {
  await db.conflicts.update(id, { state: '待确认', resolvedNote: '', resolvedAt: '', updatedAt: Date.now() } as never)
}

export async function removeConflict(id: string): Promise<void> {
  await db.conflicts.delete(id)
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  scenes: Scene[]
  elements: Element[]
  shootDays: ShootDay[]
  records: ContinuityRecord[]
  conflicts: Conflict[]
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as Omit<T, keyof Revisioned>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [scenes, elements, shootDays, records, conflicts] = await Promise.all([
    db.scenes.toArray(),
    db.elements.toArray(),
    db.shootDays.toArray(),
    db.records.toArray(),
    db.conflicts.toArray()
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    scenes: scenes.map(stripRow),
    elements: elements.map(stripRow),
    shootDays: shootDays.map(stripRow),
    records: records.map(stripRow),
    conflicts: conflicts.map(stripRow)
  }
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now()
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now }
}

/** 旧备份 / 历史行导入：补齐 v2 的并发控制字段，缺省视为已生效的历史版本 */
function normalizeRecordRow(row: Partial<RecordRow>): RecordRow {
  const stamped = stamp(row) as RecordRow
  return {
    ...stamped,
    source: typeof row.source === 'string' && row.source ? row.source : LEGACY_SOURCE,
    status: row.status === '待确认' || row.status === '已作废' ? row.status : '生效',
    duelGroupId: typeof row.duelGroupId === 'string' ? row.duelGroupId : '',
    duelWinner: typeof row.duelWinner === 'string' ? row.duelWinner : '',
    submissionId: typeof row.submissionId === 'string' ? row.submissionId : ''
  }
}

/** 旧备份导入：差异缺少来源时标记为自动重算 */
function normalizeConflictRow(row: Partial<ConflictRow>): ConflictRow {
  const stamped = stamp(row) as ConflictRow
  const source: ConflictSource = row.source === '手工登记' ? '手工登记' : '自动重算'
  return { ...stamped, source }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.scenes, db.elements, db.shootDays, db.records, db.conflicts, db.submissions],
    async () => {
      await Promise.all([
        db.scenes.clear(),
        db.elements.clear(),
        db.shootDays.clear(),
        db.records.clear(),
        db.conflicts.clear(),
        db.submissions.clear()
      ])
      await db.scenes.bulkPut(snapshot.scenes.map(stamp))
      await db.elements.bulkPut(snapshot.elements.map(stamp))
      await db.shootDays.bulkPut(snapshot.shootDays.map(stamp))
      await db.records.bulkPut((snapshot.records as Array<Partial<RecordRow>>).map(normalizeRecordRow))
      await db.conflicts.bulkPut((snapshot.conflicts as Array<Partial<ConflictRow>>).map(normalizeConflictRow))
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.scenes, db.elements, db.shootDays, db.records, db.conflicts, db.submissions],
    async () => {
      await Promise.all([
        db.scenes.clear(),
        db.elements.clear(),
        db.shootDays.clear(),
        db.records.clear(),
        db.conflicts.clear(),
        db.submissions.clear()
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [scenes, elements, shootDays, records, conflicts, submissions] = await Promise.all([
    db.scenes.count(),
    db.elements.count(),
    db.shootDays.count(),
    db.records.count(),
    db.conflicts.count(),
    db.submissions.count()
  ])
  return { scenes, elements, shootDays, records, conflicts, submissions }
}
