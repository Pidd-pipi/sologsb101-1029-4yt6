<script setup lang="ts">
/** /shootdays 现场状态记录：按拍摄日与镜次成组录入，带基线修订的批量原子提交 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus, CircleCheck, WarningFilled, RefreshLeft, Delete } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import ConflictTag from '@/components/common/ConflictTag.vue'
import {
  db,
  type ConflictRow,
  type ElementRow,
  type RecordRow,
  type SceneRow,
  type ShootDayRow,
  type SubmissionRow
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useRecordStore } from '@/stores/recordStore'
import { createEmptyShootDay, type ShootDay } from '@/types/shootDay'
import { createEmptyRecord, type RecordFields } from '@/types/record'
import type { SubmissionItem } from '@/types/submission'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'
import { getClientLabel } from '@/utils/source'

const route = useRoute()
const router = useRouter()
const store = useRecordStore()
const clientLabel = getClientLabel()

const { rows: shootDays, ready } = useIdbTable<ShootDayRow>(() => db.shootDays, {
  compare: (a, b) => b.date.localeCompare(a.date)
})
const { rows: records } = useIdbTable<RecordRow>(() => db.records)
const { rows: elements } = useIdbTable<ElementRow>(() => db.elements)
const { rows: scenes } = useIdbTable<SceneRow>(() => db.scenes, { compare: (a, b) => a.shootOrder - b.shootOrder })
const { rows: conflicts } = useIdbTable<ConflictRow>(() => db.conflicts)
const { rows: submissions } = useIdbTable<SubmissionRow>(() => db.submissions, {
  compare: (a, b) => b.updatedAt - a.updatedAt
})

const selects = computed<FilterSelectConfig[]>(() => [
  { key: 'sceneIds', label: '场次', options: scenes.value.map((item) => ({ label: `第 ${item.sceneNo} 场`, value: item.id })) },
  { key: 'takes', label: '镜次', options: [...new Set(records.value.filter((r) => r.status === '生效').map((item) => item.takeNo))].map((item) => ({ label: item, value: item })) }
])

function sceneLabel(sceneId: string): string {
  const scene = scenes.value.find((item) => item.id === sceneId)
  return scene ? `第 ${scene.sceneNo} 场 · ${scene.location}` : '场次已删除'
}

function elementOf(elementId: string): ElementRow | null {
  return elements.value.find((item) => item.id === elementId) ?? null
}

const currentDay = computed<ShootDayRow | null>(
  () => shootDays.value.find((day) => day.id === store.currentShootDayId) ?? null
)

/** 当前拍摄日的生效 / 已作废现场记录（待确认并列版本单独在裁决面板处理） */
const dayRecords = computed(() =>
  records.value
    .filter((record) => record.shootDayId === store.currentShootDayId)
    .filter((record) => record.status !== '待确认')
    .filter((record) => {
      const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
      const sceneIds = Array.isArray(store.filters.sceneIds) ? store.filters.sceneIds : []
      const takes = Array.isArray(store.filters.takes) ? store.filters.takes : []
      const element = elementOf(record.elementId)
      const label = `${element ? element.name : ''} ${record.currentState} ${record.photoNote} ${record.recordedBy}`.toLowerCase()
      if (keyword && !label.includes(keyword)) return false
      if (sceneIds.length > 0 && !sceneIds.includes(record.sceneId)) return false
      if (takes.length > 0 && !takes.includes(record.takeNo)) return false
      return true
    })
    .sort((a, b) => a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN'))
)

/** 当前拍摄日待人工裁决的并列分组（两个标签页改到同一镜次） */
interface DuelGroup {
  groupId: string
  elementId: string
  takeNo: string
  peers: RecordRow[]
}

const dayDuelGroups = computed<DuelGroup[]>(() => {
  const map = new Map<string, DuelGroup>()
  records.value
    .filter((record) => record.shootDayId === store.currentShootDayId && record.status === '待确认')
    .forEach((record) => {
      if (!map.has(record.duelGroupId)) {
        map.set(record.duelGroupId, { groupId: record.duelGroupId, elementId: record.elementId, takeNo: record.takeNo, peers: [] })
      }
      map.get(record.duelGroupId)?.peers.push(record)
    })
  return [...map.values()]
})

/** 当前拍摄日的可重试失败草稿 */
const dayDrafts = computed(() =>
  submissions.value.filter((item) => item.shootDayId === store.currentShootDayId && item.state === 'failed')
)

/** 该记录是否涉及未解决差异 */
function conflictOf(recordId: string): ConflictRow | null {
  return conflicts.value.find((item) => item.recordIdA === recordId || item.recordIdB === recordId) ?? null
}

const totals = computed(() => {
  const open = conflicts.value.filter((item) => item.state === '待确认')
  return {
    shootDayCount: shootDays.value.length,
    recordCount: records.value.filter((item) => item.status !== '已作废').length,
    dayRecordCount: dayRecords.value.filter((item) => item.status === '生效').length,
    openConflictCount: open.length,
    blockingCount: open.filter((item) => item.severity === '阻断').length,
    elementCount: elements.value.length,
    pendingDuelCount: dayDuelGroups.value.length,
    draftCount: dayDrafts.value.length
  }
})

/** 当前拍摄日涉及的连戏要素（供记录表单选择） */
const dayElements = computed(() => {
  if (!currentDay.value) return []
  const sceneIds = currentDay.value.sceneIds
  return elements.value.filter((item) => sceneIds.includes(item.sceneId))
})

/* ------------------------------ 拍摄日 ------------------------------ */
const dayDialog = ref(false)
const editingDayId = ref<string | null>(null)
const dayFormRef = ref<FormInstance>()
const dayForm = reactive<Omit<ShootDay, 'id'>>(createEmptyShootDay())

const dayRules: FormRules = {
  date: [{ required: true, message: '请选择拍摄日期', trigger: 'change' }]
}

function openCreateDay(): void {
  editingDayId.value = null
  Object.assign(dayForm, createEmptyShootDay())
  dayDialog.value = true
}

function openEditDay(day: ShootDayRow): void {
  editingDayId.value = day.id
  Object.assign(dayForm, {
    date: day.date,
    sceneIds: [...day.sceneIds],
    director: day.director,
    scripty: day.scripty,
    weatherNote: day.weatherNote
  })
  dayDialog.value = true
}

async function submitDay(): Promise<void> {
  const valid = await dayFormRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    if (editingDayId.value) {
      await store.updateShootDay(editingDayId.value, { ...dayForm })
      ElMessage.success('拍摄日已更新')
    } else {
      await store.createShootDay({ ...dayForm })
      ElMessage.success('拍摄日已建立')
    }
    dayDialog.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

async function removeDay(day: ShootDayRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除拍摄日 ${day.date} 会同时删除当日现场记录、草稿与相关差异，是否继续？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '确认删除'
    })
  } catch {
    return
  }
  await store.deleteShootDay(day.id)
  ElMessage.success('拍摄日及其记录已删除')
}

/* --------------------------- 单条记录（也走批次） --------------------------- */
const recordDialog = ref(false)
const editingRecordId = ref<string | null>(null)
/** 编辑打开时读取到的基线修订号 */
const editingBaseRevision = ref(0)
const recordFormRef = ref<FormInstance>()
const recordForm = reactive<RecordFields>(createEmptyRecord())

const recordRules: FormRules = {
  elementId: [{ required: true, message: '请选择连戏要素', trigger: 'change' }],
  takeNo: [{ required: true, message: '请填写镜次', trigger: 'blur' }],
  currentState: [{ required: true, message: '请填写当前状态', trigger: 'blur' }]
}

function openCreateRecord(): void {
  if (!currentDay.value) {
    ElMessage.warning('请先选择或新建拍摄日')
    return
  }
  editingRecordId.value = null
  editingBaseRevision.value = 0
  Object.assign(recordForm, createEmptyRecord())
  recordForm.shootDayId = currentDay.value.id
  recordForm.recordedBy = currentDay.value.scripty
  const preset = typeof route.query.elementId === 'string' ? route.query.elementId : ''
  if (preset && dayElements.value.some((item) => item.id === preset)) recordForm.elementId = preset
  else if (dayElements.value.length > 0) recordForm.elementId = dayElements.value[0].id
  recordDialog.value = true
}

function openEditRecord(record: RecordRow): void {
  editingRecordId.value = record.id
  editingBaseRevision.value = record.revision
  Object.assign(recordForm, {
    shootDayId: record.shootDayId,
    elementId: record.elementId,
    sceneId: record.sceneId,
    takeNo: record.takeNo,
    currentState: record.currentState,
    photoNote: record.photoNote,
    recordedBy: record.recordedBy
  })
  recordDialog.value = true
}

/** 选中要素后自动带出所属场次与初始状态，减少手填 */
function onElementChange(elementId: string): void {
  const element = elementOf(elementId)
  if (!element) return
  recordForm.sceneId = element.sceneId
  if (!recordForm.currentState) recordForm.currentState = element.initialState
}

async function submitRecord(): Promise<void> {
  const valid = await recordFormRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    if (editingRecordId.value) {
      const result = await store.updateRecord(editingRecordId.value, { ...recordForm }, editingBaseRevision.value)
      if (result.duels > 0) {
        ElMessage.warning('该镜次已被另一个标签页修改，两个版本已并列待确认，请在下方裁决')
      } else {
        ElMessage.success('现场记录已修订，相关差异已重算')
      }
    } else {
      const result = await store.createRecord({ ...recordForm })
      if (result.duels > 0) ElMessage.warning('该镜次已存在另一标签页版本，已并列待确认')
      else ElMessage.success('现场记录已合入，相关差异已重算')
    }
    recordDialog.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败，已保留可重试草稿')
  }
}

async function removeRecord(record: RecordRow): Promise<void> {
  try {
    await ElMessageBox.confirm('删除该现场记录会同时删除与之关联的差异条目，是否继续？', '删除确认', { type: 'warning' })
  } catch {
    return
  }
  await store.deleteRecord(record.id)
  ElMessage.success('现场记录已删除')
}

/* ------------------------------ 批量编辑 ------------------------------ */
interface BatchRow {
  key: string
  recordId: string
  baseRevision: number
  elementId: string
  takeNo: string
  currentState: string
  photoNote: string
  recordedBy: string
}

const batchDialog = ref(false)
const batchSubmitting = ref(false)
const batchRows = ref<BatchRow[]>([])
/** 批量编辑器是从哪份失败草稿装入的（提交时复用该草稿 id，成功后自动转正） */
const editingDraftId = ref<string | null>(null)

function newBatchRow(): BatchRow {
  return {
    key: createRowKey(),
    recordId: '',
    baseRevision: 0,
    elementId: dayElements.value[0]?.id ?? '',
    takeNo: '',
    currentState: '',
    photoNote: '',
    recordedBy: currentDay.value?.scripty ?? ''
  }
}

function createRowKey(): string {
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 打开批量编辑器：默认带入当日全部生效记录（整组修订），可继续追加新增行 */
function openBatch(): void {
  const day = currentDay.value
  if (!day) {
    ElMessage.warning('请先选择或新建拍摄日')
    return
  }
  batchRows.value = records.value
    .filter((record) => record.shootDayId === day.id && record.status === '生效')
    .map((record) => ({
      key: createRowKey(),
      recordId: record.id,
      baseRevision: record.revision,
      elementId: record.elementId,
      takeNo: record.takeNo,
      currentState: record.currentState,
      photoNote: record.photoNote,
      recordedBy: record.recordedBy
    }))
  batchRows.value.push(newBatchRow())
  editingDraftId.value = null
  batchDialog.value = true
}

function addBatchRow(): void {
  batchRows.value.push(newBatchRow())
}

function removeBatchRow(key: string): void {
  if (batchRows.value.length === 1) return
  batchRows.value = batchRows.value.filter((row) => row.key !== key)
}

function onBatchElementChange(row: BatchRow, elementId: string): void {
  const element = elementOf(elementId)
  if (element && !row.currentState) row.currentState = element.initialState
}

function batchToItems(): SubmissionItem[] {
  return batchRows.value
    .filter((row) => row.elementId && (row.takeNo.trim() || row.currentState.trim()))
    .map((row) => {
      const element = elementOf(row.elementId)
      const fields: RecordFields = {
        shootDayId: currentDay.value!.id,
        elementId: row.elementId,
        sceneId: element?.sceneId ?? '',
        takeNo: row.takeNo.trim(),
        currentState: row.currentState.trim(),
        photoNote: row.photoNote.trim(),
        recordedBy: row.recordedBy.trim()
      }
      return { recordId: row.recordId, fields, baseRevision: row.baseRevision }
    })
}

async function submitBatch(): Promise<void> {
  if (!currentDay.value) return
  const items = batchToItems()
  if (items.length === 0) {
    ElMessage.warning('请至少填写一条完整的现场记录')
    return
  }
  batchSubmitting.value = true
  try {
    const result = await store.commitRecords(currentDay.value.id, items, editingDraftId.value ?? undefined)
    const parts: string[] = []
    if (result.created > 0) parts.push(`新增 ${result.created}`)
    if (result.merged > 0) parts.push(`修订 ${result.merged}`)
    if (result.unchanged > 0) parts.push(`无变化 ${result.unchanged}`)
    if (result.duels > 0) {
      ElMessage.warning(`已合入（${parts.join('、') || '无写入'}）；${result.duels} 条与其它标签页撞版并列待确认，请裁决`)
    } else {
      ElMessage.success(`整组已合入：${parts.join('、') || '无写入'}；相关差异与基准已同步`)
    }
    editingDraftId.value = null
    batchDialog.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? `整组回滚：${error.message}（草稿已保留，可在页面上方重试）` : '整组回滚，草稿已保留')
  } finally {
    batchSubmitting.value = false
  }
}

/* --------------------------- 并列裁决与失败草稿 --------------------------- */
async function chooseWinner(group: DuelGroup, winnerId: string): Promise<void> {
  const winner = group.peers.find((item) => item.id === winnerId)
  const loser = group.peers.find((item) => item.id !== winnerId)
  try {
    await ElMessageBox.confirm(
      `确认保留「${winner?.source}」的版本（镜次 ${group.takeNo}：${winner?.currentState}）？另一版本（${loser?.source ?? '—'}）将作废，差异与连戏基准随之重算。`,
      '并列版本裁决',
      { type: 'warning', confirmButtonText: '保留此版本' }
    )
  } catch {
    return
  }
  try {
    const result = await store.resolveRecordDuel(group.groupId, winnerId)
    ElMessage.success(`已采用 ${result.winner.source} 的版本，差异重算 ${result.conflictsRecomputed} 条`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '裁决失败')
  }
}

async function retryDraft(draft: SubmissionRow): Promise<void> {
  // 直接以原草稿 id 重试（保留原基线修订，撞版条目仍会自动并列）
  batchSubmitting.value = true
  try {
    const result = await store.commitRecords(draft.shootDayId, draft.items, draft.id)
    const parts: string[] = []
    if (result.created > 0) parts.push(`新增 ${result.created}`)
    if (result.merged > 0) parts.push(`修订 ${result.merged}`)
    if (result.duels > 0) {
      ElMessage.warning(`草稿已重试合入（${parts.join('、')}）；${result.duels} 条并列待确认，请裁决`)
    } else {
      ElMessage.success(`草稿已重试合入：${parts.join('、') || '无写入'}`)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? `仍失败：${error.message}（草稿已更新，可调整后再次重试）` : '重试失败，草稿已更新')
  } finally {
    batchSubmitting.value = false
  }
}

async function discardDraft(draft: SubmissionRow): Promise<void> {
  try {
    await ElMessageBox.confirm('放弃后该组未合入的草稿将被删除，且不可恢复，是否继续？', '放弃草稿', { type: 'warning' })
  } catch {
    return
  }
  await store.discardSubmission(draft.id)
  ElMessage.success('失败草稿已放弃')
}

/** 从失败草稿装入编辑器（调整后提交会复用该草稿 id，成功后自动转正） */
function loadDraftToEditor(draft: SubmissionRow): void {
  store.selectShootDay(draft.shootDayId)
  editingDraftId.value = draft.id
  batchRows.value = draft.items.map((item) => ({
    key: createRowKey(),
    recordId: item.recordId,
    baseRevision: item.baseRevision,
    elementId: item.fields.elementId,
    takeNo: item.fields.takeNo,
    currentState: item.fields.currentState,
    photoNote: item.fields.photoNote,
    recordedBy: item.fields.recordedBy
  }))
  batchDialog.value = true
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-Hans-CN', { hour12: false })
}

onMounted(() => {
  store.applyQuery(route.query)
  if (!store.currentShootDayId && shootDays.value.length > 0) {
    store.selectShootDay(shootDays.value[0].id)
  }
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)

watch(currentDay, (day) => {
  if (day) {
    void router.replace({ path: route.path, query: { ...filtersToQuery(store.filters), shootDayId: day.id } })
  }
})
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">现场状态记录</h2>
        <p class="page__subtitle">
          同一拍摄日的记录成组批量提交（带基线修订）；跨标签页改到同一镜次会并列待确认，单边新增直接合入，写入失败整组回滚并保留草稿。
        </p>
      </div>
      <div>
        <el-button type="primary" :icon="Plus" @click="openCreateDay">新建拍摄日</el-button>
        <el-button :icon="Plus" @click="openCreateRecord">录入单条</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="拍摄日" :value="totals.shootDayCount" suffix="天" icon="Files" tone="primary" />
      <StatBadge label="现场记录" :value="totals.recordCount" suffix="条" icon="DataLine" tone="info" />
      <StatBadge label="当日生效" :value="totals.dayRecordCount" suffix="条" icon="Grid" tone="success" />
      <StatBadge label="待裁决并列" :value="totals.pendingDuelCount" suffix="组" icon="WarningFilled" tone="danger" />
      <StatBadge label="失败草稿" :value="totals.draftCount" suffix="份" icon="WarningFilled" tone="warning" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索要素 / 当前状态 / 记录人…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <!-- 可重试失败草稿 -->
    <el-alert
      v-for="draft in dayDrafts"
      :key="draft.id"
      class="draft-alert"
      type="error"
      :closable="false"
      show-icon
    >
      <template #title>
        有一组记录在 {{ formatTime(draft.updatedAt) }} 提交失败并已整组回滚（第 {{ draft.retryCount + 1 }} 次尝试，来源 {{ draft.source }}）：{{ draft.errorMessage }}
      </template>
      <div class="draft-alert__body">
        <span class="muted">{{ draft.items.length }} 条记录未合入，数据保持提交前状态。</span>
        <div class="draft-alert__actions">
          <el-button size="small" type="primary" :icon="RefreshLeft" @click="retryDraft(draft)">整组重试</el-button>
          <el-button size="small" @click="loadDraftToEditor(draft)">装入编辑器调整</el-button>
          <el-button size="small" type="danger" plain :icon="Delete" @click="discardDraft(draft)">放弃草稿</el-button>
        </div>
      </div>
    </el-alert>

    <el-row :gutter="16">
      <el-col :span="9">
        <el-card shadow="never">
          <template #header>
            <div class="card-title"><span>拍摄日（{{ shootDays.length }}）</span><span class="muted">点击选择</span></div>
          </template>
          <EmptyPanel
            v-if="ready && shootDays.length === 0"
            title="暂无拍摄日"
            description="先建立拍摄日并勾选当日要拍的场次。"
            create-text="新建拍摄日"
            @create="openCreateDay"
          />
          <div v-else class="day-list">
            <div
              v-for="day in shootDays"
              :key="day.id"
              class="day-item"
              :class="{ 'is-active': day.id === store.currentShootDayId }"
              @click="store.selectShootDay(day.id)"
            >
              <div class="day-item__head">
                <strong>{{ day.date }}</strong>
                <el-tag size="small" effect="plain">{{ day.sceneIds.length }} 场</el-tag>
              </div>
              <div class="day-item__meta">
                导演 {{ day.director || '—' }} · 场记 {{ day.scripty || '—' }} ·
                {{ records.filter((item) => item.shootDayId === day.id && item.status === '生效').length }} 条记录
              </div>
              <div class="day-item__scenes">
                <el-tag v-for="sceneId in day.sceneIds" :key="sceneId" size="small" effect="plain">
                  {{ sceneLabel(sceneId) }}
                </el-tag>
              </div>
              <div class="day-item__note">{{ day.weatherNote }}</div>
              <div class="day-item__actions">
                <el-button link type="primary" size="small" @click.stop="openEditDay(day)">编辑</el-button>
                <el-button link type="danger" size="small" @click.stop="removeDay(day)">删除</el-button>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :span="15">
        <!-- 并列待确认裁决面板 -->
        <el-card v-if="dayDuelGroups.length > 0" shadow="never" class="duel-card">
          <template #header>
            <div class="card-title">
              <span class="duel-card__title"><el-icon><WarningFilled /></el-icon> 并列待确认（{{ dayDuelGroups.length }} 组）</span>
              <span class="muted">两个标签页改到同一镜次，选择一个版本保留，另一版本作废并重算差异</span>
            </div>
          </template>
          <div v-for="group in dayDuelGroups" :key="group.groupId" class="duel-group">
            <div class="duel-group__head">
              <strong>{{ elementOf(group.elementId)?.name ?? '要素已删除' }}</strong>
              <el-tag size="small" effect="plain">镜次 {{ group.takeNo }}</el-tag>
              <el-tag size="small" type="danger" effect="plain">{{ sceneLabel(elementOf(group.elementId)?.sceneId ?? '') }}</el-tag>
            </div>
            <div class="duel-group__peers">
              <div v-for="peer in group.peers" :key="peer.id" class="duel-peer">
                <div class="duel-peer__meta">
                  <el-tag size="small" type="warning">{{ peer.source }}</el-tag>
                  <span class="muted">修订 v{{ peer.revision }} · {{ peer.recordedBy || '未署名' }} · {{ formatTime(peer.updatedAt) }}</span>
                </div>
                <div class="duel-peer__state">{{ peer.currentState }}</div>
                <div class="muted duel-peer__note">照片说明：{{ peer.photoNote || '—' }}</div>
                <el-button size="small" type="success" :icon="CircleCheck" @click="chooseWinner(group, peer.id)">保留此版本</el-button>
              </div>
            </div>
          </div>
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div class="card-title">
              <span>
                现场记录
                <template v-if="currentDay"> · {{ currentDay.date }}</template>
              </span>
              <div>
                <el-button type="success" plain size="small" @click="openBatch">整组批量编辑 / 提交</el-button>
                <el-button type="primary" size="small" :icon="Plus" @click="openCreateRecord">录入记录</el-button>
              </div>
            </div>
          </template>

          <EmptyPanel
            v-if="!currentDay"
            title="未选择拍摄日"
            description="在左侧选择一个拍摄日后即可录入当日现场记录。"
            :show-create="false"
          />
          <EmptyPanel
            v-else-if="dayRecords.length === 0 && dayDuelGroups.length === 0"
            title="当日还没有现场记录"
            description="按镜次记录各连戏要素的实际状态，作为跨日比对的依据。"
            create-text="录入记录"
            @create="openCreateRecord"
          />
          <el-table v-else :data="dayRecords" stripe border row-key="id">
            <el-table-column label="连戏要素" min-width="170">
              <template #default="{ row }">
                <div>{{ elementOf(row.elementId)?.name ?? '要素已删除' }}</div>
                <div class="muted">{{ elementOf(row.elementId)?.category ?? '—' }} · {{ elementOf(row.elementId)?.owner ?? '—' }}</div>
              </template>
            </el-table-column>
            <el-table-column label="场次" width="150">
              <template #default="{ row }">{{ sceneLabel(row.sceneId) }}</template>
            </el-table-column>
            <el-table-column prop="takeNo" label="镜次" width="80" />
            <el-table-column prop="currentState" label="当前状态" min-width="180" />
            <el-table-column prop="photoNote" label="照片说明" min-width="130" />
            <el-table-column label="来源 / 版本" width="130">
              <template #default="{ row }">
                <el-tag size="small" effect="plain">{{ row.source }}</el-tag>
                <div class="muted">v{{ row.revision }}<el-tag v-if="row.status === '已作废'" size="small" type="info" effect="plain" class="state-tag">已作废</el-tag></div>
              </template>
            </el-table-column>
            <el-table-column label="差异" width="140">
              <template #default="{ row }">
                <ConflictTag
                  v-if="conflictOf(row.id)"
                  :severity="conflictOf(row.id)?.severity"
                  :state="conflictOf(row.id)?.state"
                />
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="130" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" :disabled="row.status === '已作废'" @click="openEditRecord(row)">编辑</el-button>
                <el-button link type="danger" size="small" @click="removeRecord(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dayDialog" :title="editingDayId ? '编辑拍摄日' : '新建拍摄日'" width="580px">
      <el-form ref="dayFormRef" :model="dayForm" :rules="dayRules" label-width="100px">
        <el-form-item label="拍摄日期" prop="date">
          <el-date-picker v-model="dayForm.date" type="date" value-format="YYYY-MM-DD" class="full" />
        </el-form-item>
        <el-form-item label="当日场次">
          <el-select v-model="dayForm.sceneIds" class="full" multiple placeholder="勾选当日要拍的场次">
            <el-option v-for="item in scenes" :key="item.id" :label="`第 ${item.sceneNo} 场 · ${item.location}`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="导演">
          <el-input v-model="dayForm.director" />
        </el-form-item>
        <el-form-item label="场记">
          <el-input v-model="dayForm.scripty" />
        </el-form-item>
        <el-form-item label="现场备注">
          <el-input v-model="dayForm.weatherNote" type="textarea" :rows="2" placeholder="天气、突发情况等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dayDialog = false">取消</el-button>
        <el-button type="primary" @click="submitDay">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="recordDialog" :title="editingRecordId ? '编辑现场记录（带基线修订）' : '录入现场记录'" width="580px">
      <el-form ref="recordFormRef" :model="recordForm" :rules="recordRules" label-width="100px">
        <el-form-item label="连戏要素" prop="elementId">
          <el-select v-model="recordForm.elementId" class="full" placeholder="选择当日场次下的要素" @change="onElementChange">
            <el-option
              v-for="item in dayElements"
              :key="item.id"
              :label="`${item.name}（${item.category} · ${sceneLabel(item.sceneId)}）`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="镜次" prop="takeNo">
          <el-input v-model="recordForm.takeNo" placeholder="如：3/1" />
        </el-form-item>
        <el-form-item label="当前状态" prop="currentState">
          <el-input v-model="recordForm.currentState" type="textarea" :rows="2" placeholder="现场实际状态，越具体越好" />
        </el-form-item>
        <el-form-item label="照片说明">
          <el-input v-model="recordForm.photoNote" placeholder="如：正面全身 / 木箱标识特写" />
        </el-form-item>
        <el-form-item label="记录人">
          <el-input v-model="recordForm.recordedBy" />
        </el-form-item>
        <el-form-item label="提交来源">
          <el-tag effect="plain">{{ clientLabel }}</el-tag>
          <span class="muted form-hint">基线修订 v{{ editingBaseRevision }}；另一标签页改到同镜次时会并列待确认而非覆盖</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="recordDialog = false">取消</el-button>
        <el-button type="primary" @click="submitRecord">保存</el-button>
      </template>
    </el-dialog>

    <!-- 批量编辑器 -->
    <el-dialog
      v-model="batchDialog"
      :title="editingDraftId ? '调整失败草稿后重新提交' : '同一拍摄日整组批量提交'"
      width="920px"
      :close-on-click-modal="false"
      @closed="editingDraftId = null"
    >
      <el-alert type="info" :closable="false" show-icon class="batch-hint">
        整组在一个事务内合入：任一记录写入失败则全部回滚并保留可重试草稿；与其它标签页改到同一镜次的记录会并列待确认。
        当前来源：{{ clientLabel }}
      </el-alert>
      <el-alert v-if="editingDraftId" type="error" :closable="false" show-icon class="batch-hint">
        正在调整此前失败的草稿：成功后该草稿自动转为已合入；再次失败仍保留为可重试草稿。
      </el-alert>
      <el-table :data="batchRows" border size="small">
        <el-table-column label="连戏要素" min-width="200">
          <template #default="{ row }">
            <el-select v-model="row.elementId" placeholder="选择要素" size="small" @change="onBatchElementChange(row, row.elementId)">
              <el-option
                v-for="item in dayElements"
                :key="item.id"
                :label="`${item.name}（${item.category}）`"
                :value="item.id"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="镜次" width="100">
          <template #default="{ row }"><el-input v-model="row.takeNo" size="small" placeholder="如 3/1" /></template>
        </el-table-column>
        <el-table-column label="当前状态" min-width="200">
          <template #default="{ row }"><el-input v-model="row.currentState" size="small" type="textarea" :autosize="{ minRows: 1, maxRows: 3 }" /></template>
        </el-table-column>
        <el-table-column label="照片说明" min-width="140">
          <template #default="{ row }"><el-input v-model="row.photoNote" size="small" /></template>
        </el-table-column>
        <el-table-column label="记录人" width="110">
          <template #default="{ row }"><el-input v-model="row.recordedBy" size="small" /></template>
        </el-table-column>
        <el-table-column label="基线" width="70" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.baseRevision > 0 ? 'info' : 'success'" effect="plain">
              {{ row.baseRevision > 0 ? `v${row.baseRevision}` : '新增' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="70" align="center">
          <template #default="{ row }">
            <el-button link type="danger" size="small" :disabled="batchRows.length === 1" @click="removeBatchRow(row.key)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-button class="batch-add" size="small" :icon="Plus" @click="addBatchRow">追加一条</el-button>
      <template #footer>
        <el-button @click="batchDialog = false">取消</el-button>
        <el-button type="primary" :loading="batchSubmitting" @click="submitBatch()">整组合入并提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.form-hint {
  margin-left: 8px;
  font-size: 12px;
}

.state-tag {
  margin-left: 6px;
}

.day-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 620px;
  overflow-y: auto;
}

.day-item {
  padding: 10px 12px;
  border: 1px solid #dde7ef;
  border-radius: 10px;
  background: #fbfcfe;
  cursor: pointer;
}

.day-item.is-active {
  border-color: #5b8bb8;
  background: #f0f5fa;
}

.day-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.day-item__meta {
  margin-top: 4px;
  font-size: 12px;
  color: #7d8b98;
}

.day-item__scenes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.day-item__note {
  margin-top: 6px;
  font-size: 12px;
  color: #9aa5ad;
}

.draft-alert {
  margin: 12px 0;
}

.draft-alert__body {
  margin-top: 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.draft-alert__actions {
  display: flex;
  gap: 8px;
}

.duel-card {
  margin-bottom: 16px;
  border-color: #e6a23c;
}

.duel-card__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #b88230;
}

.duel-group {
  border: 1px solid #f0d9b5;
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: #fffaf2;
}

.duel-group:last-child {
  margin-bottom: 0;
}

.duel-group__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.duel-group__peers {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.duel-peer {
  border: 1px dashed #d9a85f;
  border-radius: 8px;
  padding: 8px 10px;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.duel-peer__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.duel-peer__state {
  font-weight: 600;
}

.duel-peer__note {
  font-size: 12px;
}

.batch-hint {
  margin-bottom: 12px;
}

.batch-add {
  margin-top: 10px;
}
</style>
