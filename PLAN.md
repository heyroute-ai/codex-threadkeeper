# 开发计划：修复 sync 后线程侧边栏项目消失

## 1. 问题是什么

现象：

- 执行 `sync` 或 `switch` 之后，线程本身仍然存在
- 线程在 SQLite 和 rollout 中都还能找到
- 但 Codex / Codex App 左侧项目列表里不显示对应项目
- 用户手动 `Add Project` 之后，该项目下的历史会话又会重新出现

影响：

- 用户会误以为历史会话“丢了”
- 实际上是项目侧边栏没有把这些线程归到可见项目下
- 当前工具虽然修复了 provider 维度的可见性，但还没有修复项目侧边栏维度的可见性

## 2. 问题出在哪里

当前实现只同步两类元数据：

- rollout 首行 `session_meta.payload.model_provider`
- SQLite `threads.model_provider`

但没有同步侧边栏项目列表相关状态。

当前已确认的事实：

- `.codex-global-state.json` 中保存了侧边栏项目列表与顺序
- 关键字段包括：
  - `electron-saved-workspace-roots`
  - `project-order`
  - `active-workspace-roots`
- `state_5.sqlite` 中没有单独的 `projects` 表
- `threads` 表里有 `cwd` 字段
- 真实环境里很多线程的 `cwd` 指向实际项目路径
- 手动 `Add Project` 后，`.codex-global-state.json` 会变化
- `config.toml` 在手动 `Add Project` 前后没有变化

因此，问题很可能出在：

- App 的项目侧边栏依赖 `.codex-global-state.json` 中的项目列表
- 线程是否能出现在某个项目下，还依赖 SQLite `threads.cwd`
- 手动 `Add Project` 本质上是在补写 `.codex-global-state.json` 的 workspace/project 列表，所以历史会话会重新出现

另一个放大问题的因素：

- `threads.cwd` 中存在路径不一致的情况，例如：
  - `E:\repo`
  - `\\?\E:\repo`
- 如果不做路径归一化，同一个项目可能会被识别成两个不同项目，或者无法和已有项目项匹配

## 3. 如何修改

### 修改目标

在 `sync` / `switch` 过程中，除了同步 provider 之外，还要补齐侧边栏项目列表，让项目侧边栏能够重新显示对应项目。

### 设计原则

- 不改线程内容本身，不重写 `cwd`
- 不改 rollout 中除 provider 外的历史内容
- 只补齐缺失的侧边栏项目路径
- 保留已有侧边栏项目顺序与活动项目状态，不覆盖用户手动设置的其他 UI 状态
- 将路径做最小必要归一化，避免 `\\?\` 前缀导致的重复或丢失

### 具体实现

#### A. 新增全局状态文件读写能力

新增 `.codex-global-state.json` 相关能力，建议新增独立模块，例如：

- `src/global-state.js`

需要提供的能力：

- 读取 `.codex-global-state.json`
- 解析并返回：
  - `electron-saved-workspace-roots`
  - `project-order`
  - `active-workspace-roots`
  - 其余原始 JSON 内容
- 仅更新缺失的项目路径相关字段
- 保留其他字段原样不变
- 写回时保持 UTF-8 JSON

写入规则：

- 若候选项目路径不在 `electron-saved-workspace-roots` 中，则追加
- 若候选项目路径不在 `project-order` 中，则追加
- `active-workspace-roots` 不主动改写，避免抢占当前活动项目
- 若文件缺少上述字段，则按最小结构补齐
- 不覆盖不相关 UI 状态字段

#### B. 新增项目候选收集逻辑

项目候选来源优先使用 SQLite `threads.cwd`，理由：

- 侧边栏线程展示本身依赖 SQLite
- `threads.cwd` 已经是 App 侧可见线程的直接元数据
- 不需要重新扫描所有 rollout 来推断项目

在 `sqlite-state.js` 中新增方法，例如：

- `readSqliteProjectPaths(codexHome)`

查询规则：

- 从 `threads` 表读取去重后的 `cwd`
- 过滤空值

#### C. 新增路径归一化逻辑

新增 Windows 路径归一化辅助方法，规则固定为：

- 去掉开头的 `\\?\`
- 使用 `path.win32.normalize(...)`
- 去掉末尾多余的 `\`
- 路径比较时按不区分大小写处理

首版明确不做下面这些事：

- 不尝试把 `.codex\worktrees\...` 反推回原仓库根目录
- 不自动合并 basename 相同但路径不同的项目
- 不推断 trust_level 以外的项目设置

即：

- 对可直接归一化为普通路径的 `cwd`，补进侧边栏项目列表
- 对无法安全归一化或明显属于内部工作目录的路径，先跳过

跳过规则首版固定为：

- 跳过空路径
- 跳过 `codexHome` 本身
- 跳过 `codexHome\worktrees\...`

#### D. 将项目同步接入 `runSync` / `runSwitch`

在 `runSync` 中新增“侧边栏项目同步”步骤：

1. 读取 SQLite 中的候选项目路径
2. 归一化并过滤
3. 与 `.codex-global-state.json` 中现有侧边栏项目列表做差集
4. 若有缺失项目：
   - 在创建 backup 之后、返回 summary 之前写回 `.codex-global-state.json`
   - 记录新增项目数量

建议阶段顺序：

- 扫描 rollout 文件
- 检查锁文件
- 创建备份
- 更新 SQLite
- 改写 rollout 文件
- 同步侧边栏项目
- 清理备份

CLI summary 追加一行：

- `Added sidebar projects: <n>`

#### E. 失败回滚

当前 `sync` 失败时会回滚 rollout 改写，但不会回滚本次运行中新增的 config 修改。

因为下一版 `sync` 将修改 `.codex-global-state.json`，必须补上这一点：

- 在 `runSync` 开始时保存原始 `.codex-global-state.json` 文本
- 若本次运行中已经写入新的侧边栏项目项，而后续步骤失败：
  - 将 `.codex-global-state.json` 恢复为原始文本
- `switch` 现有的 `config.toml` 回滚逻辑保留，不扩展其语义

这样可以保证：

- `sync` 的全局状态文件修改与 rollout / SQLite 修改在失败时具有一致的回退行为

## 4. 需要改哪些地方

重点文件：

- `src/global-state.js`（新增）
- `src/sqlite-state.js`
- `src/service.js`
- `src/cli.js`
- `test/sync-service.test.js`

必要时可补一个独立测试文件：

- `test/global-state.test.js`

## 5. 目标是什么

本轮目标：

- 执行 `sync` / `switch` 后，缺失的项目会自动补进侧边栏项目列表
- 用户无需再手动 `Add Project` 才能在侧边栏看到项目
- 项目路径大小写或 `\\?\` 前缀差异不会导致同一项目丢失或分裂
- 现有 provider 同步逻辑、备份逻辑、恢复逻辑不回退

## 6. 验收标准

至少满足以下条件：

- 当 `threads.cwd` 存在项目路径、而 `.codex-global-state.json` 缺少对应项目路径时，`sync` 会补写侧边栏项目列表
- 同一路径的 `E:\repo` 和 `\\?\E:\repo` 不会写成两个侧边栏项目
- 已存在的侧边栏项目路径不会被重复写入
- `sync` summary 能显示新增侧边栏项目数量
- `restore` 仍能恢复到同步前的全局状态和元数据状态
- 失败场景下 `.codex-global-state.json` 不会留下半完成写入

## 7. 测试场景

需要补的测试：

- SQLite `threads.cwd` 有项目路径，全局状态文件无该项目，`sync` 后新增侧边栏项目路径
- 全局状态文件已存在同一路径项目，`sync` 后不重复新增
- `cwd` 为 `\\?\E:\repo`，全局状态文件为 `E:\repo`，`sync` 后不重复新增
- `cwd` 同时含 `E:\repo` 与 `\\?\E:\repo`，最终只新增一个侧边栏项目
- `cwd` 位于 `.codex\worktrees\...`，首版跳过，不写侧边栏项目
- `sync` 中途失败时，`.codex-global-state.json` 回滚到原始文本
- `switch` 仍然同时完成 provider 同步与侧边栏项目同步

## 8. 非目标

这轮先不做：

- 修改 `config.toml [projects.'...']`
- 自动推断 worktree 对应的原仓库根目录
- 自动清理“无线程引用”的旧侧边栏项目
- 修改线程 `cwd`
- 修改 rollout 内除 provider 外的任何字段

## 9. 当前结论

这轮问题的根因判断为：

- 当前工具修复了 provider 可见性
- 但没有修复侧边栏项目列表可见性
- 线程仍在，项目消失，本质上是侧边栏项目列表缺失或路径不一致

实现方向应当是：

- 基于 SQLite `threads.cwd` 补齐 `.codex-global-state.json` 中的项目列表
- 同时做 Windows 路径归一化
- 将全局状态文件修改纳入 `sync` 的备份与失败回滚模型
