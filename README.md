# 影视场景连戏与道具接续核对台（gbcontinuity）

面向剧组场记与服装道具部门的本地化核对工具：把剧本场次拆成连戏要素清单，按拍摄日逐条记录现场服装、道具、妆发与陈设的实际状态，自动比对同一场景在不同拍摄日之间的差异，提示冲突并跟踪解决，最后生成连戏核对报告。

核心动作：**建场次与拍摄顺序 → 登记连戏要素 → 录现场状态与镜次 → 比对差异 → 消解冲突并导出报告**。

纯前端单页应用（Vue 3 + TypeScript + Element Plus + Vite + Pinia + Vue Router + Dexie），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB），刷新或重启浏览器后仍然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22829**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbcontinuity}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地，迁移设备请使用应用内「导出整库备份 / 导入备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + Composition API） | 全部页面与组件使用组合式 API |
| 语言 | TypeScript（`strict: true`，无 `any`） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Element Plus 2.x（含 `@element-plus/icons-vue`） | 表格、卡片、对话框、表单、下拉菜单交互 |
| 构建工具 | Vite 6 | 开发服务器端口 22829 |
| 状态管理 | Pinia（setup store） | `sceneStore` / `elementStore` / `recordStore` / `conflictStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装） | 库名 `gbcontinuity-db`，含结构版本号与 upgrade 迁移 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段执行类型检查与打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22829
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22829）
```

---

## 四、页面与路由

| 路由 | 模块 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/scenes` | 剧本场次与拍摄顺序台账 | Scene、Conflict | 新建/编辑/删除场次、**拖拽调序并自动重编号**、按内外景与日/夜筛选、卡片回显要素数与未解决冲突数、筛选同步 URL query |
| `/elements` | 连戏要素登记 | Element、Scene | 按场次与类别分组展示、维护初始状态与责任人、关键要素标记与高亮、增删改 |
| `/shootdays` | 现场状态记录 | ShootDay、Record、Element | 建立拍摄日并勾选当日场次、按镜次录入当前状态与照片说明；**同一拍摄日一组记录先入提交盘，再带基线修订整组提交**，多标签页改到同一镜次时并列待确认、单边新增直接合入，写入失败整组回滚并留可重试草稿 |
| `/conflicts` | 连戏差异比对与冲突提示 | Conflict、Record | **重新比对生成差异**、并排展示记录 A / 记录 B、严重程度与解决状态流转、解决后回写要素初始状态并留痕 |
| `/report` | 连戏核对报告与结构版本导出 | 全部模型 | 场次核对小结、风险分统计、本地库版本查看、报告 / 整库 JSON 导出与导入 |

---

## 五、目录结构

```
sologsb101-1029/
├── README.md
├── docker-compose.yml
├── .env / .env.example
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files SPA fallback + gzip
    ├── .dockerignore
    ├── index.html / vite.config.ts / tsconfig.json / package.json
    ├── public/favicon.svg
    └── src/
        ├── main.ts  App.vue  env.d.ts
        ├── types/              # scene.ts element.ts shootDay.ts record.ts conflict.ts filter.ts
        ├── stores/             # sceneStore elementStore recordStore conflictStore
        ├── components/common/  # ConflictTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useContinuityDiff.ts useIdbTable.ts
        ├── utils/              # diff.ts db.ts export.ts seed.ts uuid.ts query.ts recordBatch.ts source.ts
        ├── pages/              # SceneList ElementRegistry ShootDayLog ConflictBoard ReportExport
        ├── styles/main.css
        └── router/index.ts
```

---

## 六、数据存储说明

- **IndexedDB 库名**：`gbcontinuity-db`，当前结构版本号 `version(2)`，并带 `upgrade()` 迁移逻辑：
  - v1：五张业务表，每行带 `revision` / `createdAt` / `updatedAt`；
  - v2：现场记录增加 `status`（生效 / 待确认 / 已废弃）、`versionGroup`（并列版本组）、`source`（写入来源），全部业务行补齐来源留痕，新增 `recordDrafts` 失败可重试草稿表。旧数据升级后状态为「生效」、来源标「历史数据」，切回拍摄日仍可核对修订号与来源。
- **分表存储**：`scenes` 场次、`elements` 连戏要素、`shootDays` 拍摄日、`records` 现场记录、`conflicts` 连戏差异，共 5 张业务表 + `recordDrafts` 待重试草稿表；每行带 `revision` / `createdAt` / `updatedAt` / `source`。
- **批量提交与并发控制**：同一拍摄日的记录先进页面提交盘，点「整组提交」时在单个 IndexedDB 事务内完成「基线校验 + 写入 + 差异重算 + 基准同步」，任一写入失败整组回滚（不留半批数据）并把整组条目落 `recordDrafts`，可修好后一键重试。修改携带打开编辑时的基线修订号：另一标签页已抢先保存且内容分叉时，两个版本都转为「待确认」并编入同一 `versionGroup`（支持采纳 / 废弃裁定）；内容一致或单边新增则直接合入，修订号 +1。
- **合入后联动重算**：批量合入或版本裁定后，受影响要素的旧差异全部失效，按最近两次「生效」记录重新比对；该要素已无待确认差异时，连戏要素基准（`initialState`）自动对齐最近一次生效状态，差异列表与报告页风险分（对 `conflicts` 表的 liveQuery）响应式同步。
- **首屏自动播种**：`utils/db.ts` 的 `initDatabase()` 在 `scenes` 表为空时调用 `seedDatabase()`，灌入互相引用的三层演示数据（场次 → 连戏要素 → 拍摄日 → 现场记录 → 差异），其中包含 1 条「阻断 / 待确认」与 1 条「轻微 / 待确认」差异，保证差异页与报告页首次打开就有内容；播种幂等。
- **差异算法**：`utils/diff.ts` 对状态文本做归一化（去掉空白与标点、颜色/款式同义写法归组，如「藏青 / 深蓝」视为同一色），归一后仍有差异才生成条目；关键要素的状态变化判为「阻断」，一般要素的状态变化判为「需处理」，仅照片说明 / 镜次变化判为「轻微」。
- **无后端**：没有 API 服务、没有数据库容器；容器本身无状态，不挂载任何卷。
- **级联规则**：删除场次会级联删除其要素、现场记录与相关差异；删除拍摄日会删除当日记录与相关差异。
