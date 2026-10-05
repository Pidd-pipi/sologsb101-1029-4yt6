/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbcontinuity-db，数据结构版本号 version(1) 与 upgrade() 迁移逻辑
 * - 场次 / 连戏要素 / 拍摄日 / 现场记录 / 连戏差异 五张表分表存储
 * - 首次打开自动播种互相引用的演示数据（含未解决冲突），保证每个页面打开都有内容
 */
import Dexie, { type Table } from 'dexie'
import { toRaw } from 'vue'
import type { Scene } from '../types/scene'
import type { Element } from '../types/element'
import type { ShootDay } from '../types/shootDay'
import type { Record as ContinuityRecord, RecordDraft } from '../types/record'
import type { Conflict } from '../types/conflict'
import { nowIso } from './uuid'
import { currentSource, SOURCE_IMPORT, SOURCE_LEGACY, SOURCE_SEED } from './source'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbcontinuity-db'

/**
 * 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移）
 * - v1：五张业务表，行级 revision / createdAt / updatedAt
 * - v2：现场记录增加 status / versionGroup / source（多标签页基线修订批量提交），
 *       全部业务行补 source 来源留痕，新增 recordDrafts 失败可重试草稿表
 */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号（新建行的起始修订号，每次覆盖写入 +1） */
export const ROW_REVISION = 1

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number
  createdAt: number
  updatedAt: number
  /** 写入来源留痕（标签页标识 / 历史数据 / 演示播种 / 备份导入） */
  source: string
}

export type SceneRow = Scene & Revisioned
export type ElementRow = Element & Revisioned
export type ShootDayRow = ShootDay & Revisioned
export type RecordRow = ContinuityRecord & Revisioned
export type ConflictRow = Conflict & Revisioned
export type RecordDraftRow = RecordDraft & Revisioned

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

/** 为业务行补齐行级修订元数据：新行取 ROW_REVISION，并打上写入来源 */
export function stampRow<T>(row: T, source: string = currentSource()): T & Revisioned {
  const now = Date.now()
  return { ...(row as object), revision: ROW_REVISION, createdAt: now, updatedAt: now, source } as T & Revisioned
}

class GbContinuityDatabase extends Dexie {
  scenes!: Table<SceneRow, string>
  elements!: Table<ElementRow, string>
  shootDays!: Table<ShootDayRow, string>
  records!: Table<RecordRow, string>
  conflicts!: Table<ConflictRow, string>
  recordDrafts!: Table<RecordDraftRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1)
      .stores({
        scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
        elements: 'id, sceneId, category, name, owner, critical, updatedAt',
        shootDays: 'id, date, director, scripty, updatedAt',
        records: 'id, shootDayId, elementId, sceneId, takeNo, updatedAt',
        conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
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

    this.version(2)
      .stores({
        scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
        elements: 'id, sceneId, category, name, owner, critical, updatedAt',
        shootDays: 'id, date, director, scripty, updatedAt',
        records: 'id, shootDayId, elementId, sceneId, takeNo, status, versionGroup, updatedAt',
        conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, updatedAt',
        recordDrafts: 'id, shootDayId, updatedAt'
      })
      .upgrade(async (tx) => {
        // v1 → v2：为旧行补齐来源；现场记录补齐修订状态与并列版本组
        const legacyTables = ['scenes', 'elements', 'shootDays', 'records', 'conflicts']
        for (const name of legacyTables) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.source !== 'string' || row.source.length === 0) row.source = SOURCE_LEGACY
            })
        }
        await tx
          .table('records')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.status !== '生效' && row.status !== '待确认' && row.status !== '已废弃') {
              row.status = '生效'
            }
            if (typeof row.versionGroup !== 'string') row.versionGroup = ''
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

/** 删除场次：级联删除其下要素、现场记录与差异（残留可重试草稿由记录批量模块清理） */
export async function removeScene(id: string): Promise<void> {
  await db.transaction('rw', [db.scenes, db.elements, db.records, db.conflicts], async () => {
    const elements = await db.elements.where('sceneId').equals(id).toArray()
    const elementIds = elements.map((item) => item.id)
    const records = await db.records.where('sceneId').equals(id).toArray()
    const recordIds = records.map((item) => item.id)
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
  await db.transaction('rw', [db.elements, db.records, db.conflicts, db.recordDrafts], async () => {
    await db.conflicts.where('elementId').equals(id).delete()
    await db.records.where('elementId').equals(id).delete()
    await db.recordDrafts.toCollection().modify((draft) => {
      const before = draft.items.length
      draft.items = draft.items.filter((item) => item.data.elementId !== id)
      if (draft.items.length !== before) draft.updatedAt = Date.now()
    })
    await db.recordDrafts.filter((draft) => draft.items.length === 0).delete()
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
  await db.transaction('rw', [db.shootDays, db.records, db.conflicts, db.recordDrafts], async () => {
    const records = await db.records.where('shootDayId').equals(id).toArray()
    const recordIds = records.map((item) => item.id)
    if (recordIds.length > 0) {
      await db.conflicts.filter((item) => recordIds.includes(item.recordIdA) || recordIds.includes(item.recordIdB)).delete()
    }
    await db.records.where('shootDayId').equals(id).delete()
    await db.recordDrafts.where('shootDayId').equals(id).delete()
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
    await db.conflicts.filter((item) => item.recordIdA === id || item.recordIdB === id).delete()
    await db.records.delete(id)
  })
}

/* ------------------------- 失败可重试草稿（批量提交） ------------------------- */

export async function listRecordDrafts(): Promise<RecordDraftRow[]> {
  const rows = await db.recordDrafts.toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function putRecordDraft(draft: RecordDraftRow): Promise<void> {
  await db.recordDrafts.put(toPlainRow(draft))
}

export async function getRecordDraft(id: string): Promise<RecordDraftRow | undefined> {
  return db.recordDrafts.get(id)
}

export async function removeRecordDraft(id: string): Promise<void> {
  await db.recordDrafts.delete(id)
}

/* ---------------------------- 连戏差异 ---------------------------- */

export async function listConflicts(): Promise<ConflictRow[]> {
  return db.conflicts.toArray()
}

export async function putConflict(row: ConflictRow): Promise<void> {
  await db.conflicts.put(toPlainRow(row))
}

/** 批量写入比对生成的差异条目（覆盖同一对记录上的旧条目） */
export async function saveConflicts(rows: ConflictRow[]): Promise<number> {
  let created = 0
  await db.transaction('rw', [db.conflicts], async () => {
    for (const row of rows) {
      const exists = await db.conflicts
        .filter(
          (item) =>
            item.elementId === row.elementId &&
            item.recordIdA === row.recordIdA &&
            item.recordIdB === row.recordIdB
        )
        .first()
      if (!exists) {
        await db.conflicts.put(toPlainRow(row))
        created += 1
      }
    }
  })
  return created
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
  /** 失败待重试的批量提交草稿；旧备份没有该字段时按空数组处理 */
  recordDrafts?: Array<RecordDraft & { revision?: number }>
}

/** 草稿导出只剥行修订号，创建 / 更新时间是草稿的业务字段需保留 */
function stripDraftRow(row: RecordDraftRow): RecordDraft {
  const copy: RecordDraft = {
    id: row.id,
    shootDayId: row.shootDayId,
    source: row.source,
    note: row.note,
    items: row.items,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastError: row.lastError,
    attemptCount: row.attemptCount
  }
  return copy
}

/** 导出时剥离纯存储元数据（修订号 / 时间戳），来源是业务留痕字段需保留 */
function stripRow<T extends Revisioned>(row: T): Omit<T, 'revision' | 'createdAt' | 'updatedAt'> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as Omit<T, 'revision' | 'createdAt' | 'updatedAt'>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [scenes, elements, shootDays, records, conflicts, recordDrafts] = await Promise.all([
    db.scenes.toArray(),
    db.elements.toArray(),
    db.shootDays.toArray(),
    db.records.toArray(),
    db.conflicts.toArray(),
    db.recordDrafts.toArray()
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    scenes: scenes.map(stripRow),
    elements: elements.map(stripRow),
    shootDays: shootDays.map(stripRow),
    records: records.map(stripRow),
    conflicts: conflicts.map(stripRow),
    recordDrafts: recordDrafts.map(stripDraftRow)
  }
}

/** 导入补行：v1 备份缺 source / status / versionGroup 时给出兼容缺省 */
function stampImported<T>(row: T): T & Revisioned {
  const stamped = stampRow(row, SOURCE_IMPORT)
  const candidate = row as Record<string, unknown>
  if (typeof candidate.source === 'string' && candidate.source.length > 0) {
    stamped.source = candidate.source
  }
  if (stamped.source === SOURCE_SEED) stamped.source = SOURCE_IMPORT
  return stamped
}

function stampImportedRecord(row: ContinuityRecord): RecordRow {
  const stamped = stampImported(row)
  if (stamped.status !== '生效' && stamped.status !== '待确认' && stamped.status !== '已废弃') {
    stamped.status = '生效'
  }
  if (typeof stamped.versionGroup !== 'string') stamped.versionGroup = ''
  return stamped
}

function stampImportedDraft(row: RecordDraft): RecordDraftRow {
  const now = Date.now()
  return { ...toPlainRow(row), revision: ROW_REVISION, createdAt: now, updatedAt: now, source: row.source || SOURCE_IMPORT }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.scenes, db.elements, db.shootDays, db.records, db.conflicts, db.recordDrafts],
    async () => {
      await Promise.all([
        db.scenes.clear(),
        db.elements.clear(),
        db.shootDays.clear(),
        db.records.clear(),
        db.conflicts.clear(),
        db.recordDrafts.clear()
      ])
      await db.scenes.bulkPut(snapshot.scenes.map(stampImported))
      await db.elements.bulkPut(snapshot.elements.map(stampImported))
      await db.shootDays.bulkPut(snapshot.shootDays.map(stampImported))
      await db.records.bulkPut(snapshot.records.map(stampImportedRecord))
      await db.conflicts.bulkPut(snapshot.conflicts.map(stampImported))
      await db.recordDrafts.bulkPut((snapshot.recordDrafts ?? []).map(stampImportedDraft))
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.scenes, db.elements, db.shootDays, db.records, db.conflicts, db.recordDrafts],
    async () => {
      await Promise.all([
        db.scenes.clear(),
        db.elements.clear(),
        db.shootDays.clear(),
        db.records.clear(),
        db.conflicts.clear(),
        db.recordDrafts.clear()
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [scenes, elements, shootDays, records, conflicts, recordDrafts] = await Promise.all([
    db.scenes.count(),
    db.elements.count(),
    db.shootDays.count(),
    db.records.count(),
    db.conflicts.count(),
    db.recordDrafts.count()
  ])
  return { scenes, elements, shootDays, records, conflicts, recordDrafts }
}
