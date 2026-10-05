<script setup lang="ts">
/** /shootdays 现场状态记录：同一拍摄日的记录先入暂存盘，再整组带基线修订批量提交 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import ConflictTag from '@/components/common/ConflictTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import {
  db,
  type ConflictRow,
  type ElementRow,
  type RecordDraftRow,
  type RecordRow,
  type SceneRow,
  type ShootDayRow
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useRecordStore } from '@/stores/recordStore'
import { createEmptyShootDay, type ShootDay } from '@/types/shootDay'
import { createEmptyRecord, type RecordFormData } from '@/types/record'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'
import { resolveRecordVersions, retryRecordDraft } from '@/utils/recordBatch'

const route = useRoute()
const router = useRouter()
const store = useRecordStore()

const { rows: shootDays, ready } = useIdbTable<ShootDayRow>(() => db.shootDays, {
  compare: (a, b) => b.date.localeCompare(a.date)
})
const { rows: records } = useIdbTable<RecordRow>(() => db.records)
const { rows: elements } = useIdbTable<ElementRow>(() => db.elements)
const { rows: scenes } = useIdbTable<SceneRow>(() => db.scenes, { compare: (a, b) => a.shootOrder - b.shootOrder })
const { rows: conflicts } = useIdbTable<ConflictRow>(() => db.conflicts)
const { rows: drafts } = useIdbTable<RecordDraftRow>(() => db.recordDrafts)

const selects = computed<FilterSelectConfig[]>(() => [
  { key: 'sceneIds', label: '场次', options: scenes.value.map((item) => ({ label: `第 ${item.sceneNo} 场`, value: item.id })) },
  { key: 'takes', label: '镜次', options: [...new Set(records.value.map((item) => item.takeNo))].map((item) => ({ label: item, value: item })) }
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

/** 当前拍摄日的现场记录（含并列待确认 / 已废弃版本，便于核对） */
const dayRecords = computed(() =>
  records.value
    .filter((record) => record.shootDayId === store.currentShootDayId)
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
    .sort((a, b) => a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN') || a.updatedAt - b.updatedAt)
)

/** 当前拍摄日的待重试草稿 */
const dayDrafts = computed(() => drafts.value.filter((draft) => draft.shootDayId === store.currentShootDayId))

/** 该记录是否涉及未解决差异 */
function conflictOf(recordId: string): ConflictRow | null {
  return conflicts.value.find((item) => item.recordIdA === recordId || item.recordIdB === recordId) ?? null
}

/** 同组并列版本 */
function versionPeers(row: RecordRow): RecordRow[] {
  if (!row.versionGroup) return []
  return records.value.filter(
    (item) => item.versionGroup === row.versionGroup && item.id !== row.id && item.status !== '已废弃'
  )
}

const totals = computed(() => {
  const open = conflicts.value.filter((item) => item.state === '待确认')
  return {
    shootDayCount: shootDays.value.length,
    recordCount: records.value.filter((item) => item.status !== '已废弃').length,
    dayRecordCount: dayRecords.value.filter((item) => item.status !== '已废弃').length,
    openConflictCount: open.length,
    blockingCount: open.filter((item) => item.severity === '阻断').length,
    elementCount: elements.value.length,
    pendingVersionCount: records.value.filter((item) => item.status === '待确认').length
  }
})

/** 当前拍摄日涉及的连戏要素（供记录表单选择） */
const dayElements = computed(() => {
  if (!currentDay.value) return []
  const sceneIds = currentDay.value.sceneIds
  return elements.value.filter((item) => sceneIds.includes(item.sceneId))
})

/** 当前拍摄日暂存条目 */
const staged = computed(() => (currentDay.value ? store.stagedOfDay(currentDay.value.id) : []))

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
    await ElMessageBox.confirm(`删除拍摄日 ${day.date} 会同时删除当日现场记录与相关差异，是否继续？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '确认删除'
    })
  } catch {
    return
  }
  await store.deleteShootDay(day.id)
  ElMessage.success('拍摄日及其记录已删除')
}

/* ------------------------ 现场记录：先暂存再整组提交 ------------------------ */
const recordDialog = ref(false)
const editingRecord = ref<RecordRow | null>(null)
const recordFormRef = ref<FormInstance>()
const recordForm = reactive<RecordFormData>(createEmptyRecord())

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
  editingRecord.value = null
  Object.assign(recordForm, createEmptyRecord())
  recordForm.shootDayId = currentDay.value.id
  recordForm.recordedBy = currentDay.value.scripty
  const preset = typeof route.query.elementId === 'string' ? route.query.elementId : ''
  if (preset && dayElements.value.some((item) => item.id === preset)) recordForm.elementId = preset
  else if (dayElements.value.length > 0) recordForm.elementId = dayElements.value[0].id
  recordDialog.value = true
}

function openEditRecord(record: RecordRow): void {
  if (record.status === '已废弃') {
    ElMessage.warning('该版本已废弃，不能编辑；可改选其它版本。')
    return
  }
  editingRecord.value = record
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

/** 保存到暂存盘（不直接写库），提示还有多少条待整组提交 */
async function stageRecord(): Promise<void> {
  const valid = await recordFormRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    if (editingRecord.value) {
      const countBefore = staged.value.length
      store.replaceStagedTarget(editingRecord.value.id, { ...recordForm }, editingRecord.value.revision)
      ElMessage.success(`已放入提交盘（基线 r${editingRecord.value.revision}），共 ${Math.max(countBefore, 1)} 条待提交`)
    } else {
      store.stageCreate({ ...recordForm })
      ElMessage.success(`已放入提交盘，共 ${staged.value.length} 条待提交`)
    }
    recordDialog.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加入提交盘失败')
  }
}

/** 整组提交当前拍摄日暂存盘 */
async function submitStaged(): Promise<void> {
  if (!currentDay.value || staged.value.length === 0) return
  try {
    const result = await store.submitBatch(currentDay.value.id)
    const conflicts = result.outcomes.filter((item) => item.status === 'conflict').length
    if (conflicts > 0) {
      ElMessageBox.alert(
        result.outcomes
          .filter((item) => item.status === 'conflict')
          .map((item) => `· ${item.detail}`)
          .join('\n'),
        `整组已提交，${conflicts} 条与另一标签页分叉并列待确认`,
        { type: 'warning', confirmButtonText: '去核对' }
      ).catch(() => undefined)
    } else {
      ElMessage.success(`整组 ${result.outcomes.length} 条已提交，差异与要素基准已同步重算`)
    }
  } catch (error) {
    ElMessage.error(`整组写入失败已回滚，未留下半批数据；已保存为可重试草稿：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

/** 采纳 / 废弃并列版本 */
async function resolveVersion(row: RecordRow, action: '采纳' | '废弃'): Promise<void> {
  try {
    await resolveRecordVersions(row.id, action)
    ElMessage.success(action === '采纳' ? '已采纳该版本，其它版本标记废弃' : '该版本已废弃')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败')
  }
}

/** 重试失败草稿：重新走基线判定，成功后草稿消失 */
async function retryDraft(draft: RecordDraftRow): Promise<void> {
  try {
    await retryRecordDraft(draft)
    ElMessage.success('草稿已重试成功，差异与要素基准已同步重算')
  } catch (error) {
    ElMessage.error(`重试仍失败，草稿已更新：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

async function discardDraft(draft: RecordDraftRow): Promise<void> {
  try {
    await ElMessageBox.confirm('放弃后这批未提交记录将被删除，是否继续？', '放弃草稿', { type: 'warning' })
  } catch {
    return
  }
  await db.recordDrafts.delete(draft.id)
  ElMessage.success('草稿已放弃')
}

function unstageStaged(clientId: string): void {
  store.unstage(clientId)
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

function statusTagType(status: RecordRow['status']): 'success' | 'warning' | 'info' {
  if (status === '待确认') return 'warning'
  if (status === '已废弃') return 'info'
  return 'success'
}

function rowClassName({ row }: { row: RecordRow }): string {
  return `row-${row.status}`
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
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
          同一拍摄日的记录先进提交盘，再整组带基线修订提交；与其它标签页分叉的镜次并列待确认。
        </p>
      </div>
      <div>
        <el-button type="primary" :icon="Plus" @click="openCreateDay">新建拍摄日</el-button>
        <el-button :icon="Plus" @click="openCreateRecord">录入现场记录</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="拍摄日" :value="totals.shootDayCount" suffix="天" icon="Files" tone="primary" />
      <StatBadge label="现场记录" :value="totals.recordCount" suffix="条" icon="DataLine" tone="info" />
      <StatBadge label="当日记录" :value="totals.dayRecordCount" suffix="条" icon="Grid" tone="success" />
      <StatBadge label="并列待确认" :value="totals.pendingVersionCount" suffix="版" icon="WarningFilled" tone="warning" />
      <StatBadge label="未解决冲突" :value="totals.openConflictCount" suffix="条" icon="WarningFilled" tone="danger" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索要素 / 当前状态 / 记录人…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

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
                {{ records.filter((item) => item.shootDayId === day.id && item.status !== '已废弃').length }} 条记录
                <el-tag v-if="drafts.some((item) => item.shootDayId === day.id)" size="small" type="danger" effect="plain">
                  {{ drafts.filter((item) => item.shootDayId === day.id).length }} 份失败草稿
                </el-tag>
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
        <el-card shadow="never">
          <template #header>
            <div class="card-title">
              <span>
                现场记录
                <template v-if="currentDay"> · {{ currentDay.date }}</template>
              </span>
              <el-button type="primary" size="small" :icon="Plus" @click="openCreateRecord">录入记录</el-button>
            </div>
          </template>

          <EmptyPanel
            v-if="!currentDay"
            title="未选择拍摄日"
            description="在左侧选择一个拍摄日后即可录入当日现场记录。"
            :show-create="false"
          />
          <template v-else>
            <!-- 失败可重试草稿 -->
            <el-alert
              v-for="draft in dayDrafts"
              :key="draft.id"
              class="draft-alert"
              type="error"
              :closable="false"
              show-icon
            >
              <template #title>
                一组 {{ draft.items.length }} 条记录写入失败已回滚（来源 {{ draft.source }}，第 {{ draft.attemptCount }} 次）
              </template>
              <div class="muted">原因：{{ draft.lastError || draft.note }}</div>
              <div class="draft-actions">
                <el-button size="small" type="primary" @click="retryDraft(draft)">重试整组</el-button>
                <el-button size="small" @click="discardDraft(draft)">放弃</el-button>
              </div>
            </el-alert>

            <!-- 整组提交盘 -->
            <div v-if="staged.length > 0" class="staging">
              <div class="staging__head">
                <strong>提交盘 · {{ staged.length }} 条待整组提交</strong>
                <div>
                  <el-button size="small" @click="store.clearStaging(currentDay.id)">清空</el-button>
                  <el-button size="small" type="primary" :loading="store.submitting" @click="submitStaged">
                    整组提交（同生共死）
                  </el-button>
                </div>
              </div>
              <div v-for="item in staged" :key="item.clientId" class="staging__item">
                <el-tag size="small" :type="item.targetId ? 'warning' : 'success'" effect="plain">
                  {{ item.targetId ? `改 r${item.baseRevision ?? '?'}` : '新增' }}
                </el-tag>
                <span>{{ elementOf(item.data.elementId)?.name ?? '要素已删除' }} · 镜次 {{ item.data.takeNo }}</span>
                <span class="muted">{{ item.data.currentState }}</span>
                <el-button link type="danger" size="small" @click="unstageStaged(item.clientId)">移出</el-button>
              </div>
            </div>

            <EmptyPanel
              v-if="dayRecords.length === 0 && dayDrafts.length === 0"
              title="当日还没有现场记录"
              description="按镜次记录各连戏要素的实际状态；多条记录攒在提交盘后整组提交。"
              create-text="录入记录"
              @create="openCreateRecord"
            />
            <el-table v-else :data="dayRecords" stripe border :row-class-name="rowClassName">
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
              <el-table-column label="当前状态" min-width="190">
                <template #default="{ row }">
                  <div>{{ row.currentState }}</div>
                  <div v-if="versionPeers(row).length > 0" class="muted">
                    并列版本 {{ versionPeers(row).length + 1 }} 份：
                    <el-tag
                      v-for="peer in versionPeers(row)"
                      :key="peer.id"
                      size="small"
                      type="info"
                      effect="plain"
                    >{{ peer.source }}：{{ peer.currentState }}</el-tag>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="修订 / 状态" width="130">
                <template #default="{ row }">
                  <el-tag :type="statusTagType(row.status)" size="small" effect="dark">
                    r{{ row.revision }} · {{ row.status }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="来源" min-width="120">
                <template #default="{ row }">
                  <div>{{ row.source || '—' }}</div>
                  <div class="muted">{{ row.recordedBy }}</div>
                </template>
              </el-table-column>
              <el-table-column label="差异" width="120">
                <template #default="{ row }">
                  <ConflictTag
                    v-if="conflictOf(row.id)"
                    :severity="conflictOf(row.id)?.severity"
                    :state="conflictOf(row.id)?.state"
                  />
                  <span v-else class="muted">—</span>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="210" fixed="right">
                <template #default="{ row }">
                  <template v-if="row.status === '待确认'">
                    <el-button link type="success" size="small" @click="resolveVersion(row, '采纳')">采纳本版</el-button>
                    <el-button link type="warning" size="small" @click="resolveVersion(row, '废弃')">废弃</el-button>
                  </template>
                  <el-button v-else link type="primary" size="small" :disabled="row.status === '已废弃'" @click="openEditRecord(row)">
                    编辑
                  </el-button>
                  <el-button link type="danger" size="small" @click="removeRecord(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </template>
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

    <el-dialog v-model="recordDialog" :title="editingRecord ? `编辑现场记录（基线 r${editingRecord.revision}）` : '录入现场记录'" width="580px">
      <el-alert
        v-if="editingRecord"
        class="baseline-hint"
        type="info"
        :closable="false"
        show-icon
        :title="`保存到提交盘时携带基线修订 r${editingRecord.revision}；若另一标签页已改同一镜次且内容分叉，提交后两版并列待确认。`"
      />
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
      </el-form>
      <template #footer>
        <el-button @click="recordDialog = false">取消</el-button>
        <el-button type="primary" @click="stageRecord">放入提交盘</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
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
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
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

.staging {
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid #e3b341;
  border-radius: 10px;
  background: #fdf8ec;
}

.staging__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.staging__item {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  padding: 3px 0;
}

.draft-alert {
  margin-bottom: 10px;
}

.draft-actions {
  margin-top: 6px;
  display: flex;
  gap: 8px;
}

.baseline-hint {
  margin-bottom: 12px;
}

:deep(.row-已废弃) {
  opacity: 0.55;
}
</style>
