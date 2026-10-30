# dsh-compaction-threshold

在运行时覆盖 `@deepseek-ai/dsh-compaction-basic` 的自动压缩压力阈值（`thresholdRatio`），并提供可在 Harness Web 界面上手动修改它的设置页。

## 为什么需要它

DeepSeek Harness 的 web profile 把 compaction backend 放进 agent preset 的 `config.plugins` 内。profile patch（`cordis.patch.yml`）对一行是整体替换 `config`，而 preset 声明的插件行不在 patch 可递归的 group 结构里——想改 `thresholdRatio`，只能把上百行的 preset 声明完整复制一遍，而且 bundle 升级后容易失同步。

本插件在运行时替换 preset 内 compaction 引擎实例的已解析配置：profile 里只多一个插件行，不复制 preset。

## 工作原理

1. `thresholdRatio` 声明为插件 `Config` 的 `volatile` 字段。`@deepseek-ai/dsh-settings` 据此把它投影成可编辑表单，namespace 就是本行 Loader entry id（`compaction-threshold`）。
2. 监听 `agent/created`（此时 agent 的 preset generation 已挂载），通过 `agentPresets.serviceFor(agent, 'compaction')` 读取该 preset 的 `isolate` 域内 compaction 服务；没有 preset registry 或 registry 找不到该服务时，回退到 `agent.ctx.get('compaction')`。
3. 用**结构判断**识别 `dsh-compaction-basic` 的引擎（检查已解析 config 上是否有数值型 `thresholdRatio`），因此不依赖模块身份，也不会引入第二份引擎包副本。
4. 引擎的 `config` 被 `deepFreeze` 过，因此整体替换实例属性 `config`，而不是就地修改冻结对象。
5. 每次使用时从 volatile 引用实时读取阈值。保存设置时 Loader 不重启插件：它把新值提交进运行中 fiber 的引用并发出 `loader/volatile-update`，插件据此对 `ctx.agents.list()` 里的所有已存在 agent 重新应用。
6. 不修改任何 preset 声明或现有配置文件（设置页的保存写入 profile 的用户 patch 层）。

> 为什么不能只用 `agent.ctx.get('compaction')`：shipped preset 把 compaction group 声明为 `isolate: { compaction: true }`，服务注册在该 group 私有 realm 的符号下，父级 agent 作用域按根符号查找会得到 `undefined`。`agentPresets.serviceFor(agent, name)` 是 preset registry 提供的、能读到 mount 所拥有的服务实现的入口。

## 安装

### 方式一：Plugin Manager（推荐）

在 Harness Web UI 中让 agent 调用 `plugin_manager` 的 `install_bundle`，目标为本目录（或发布后的 GitHub 包）。它会完成依赖安装和 bundle 选择。

### 方式二：手动加入 profile

编辑 `$DSH_HOME/profiles/<name>/package.json`：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [/* 既有 bundles */, "dsh-compaction-threshold"]
    }
  },
  "dependencies": {
    "dsh-compaction-threshold": "github:<user>/<repo>"
  }
}
```

然后在 profile 目录执行 `pnpm install`，并重启 `dsh web`。

包名 `dsh-compaction-threshold` 同时出现在 `cordis.patch.yml` 的 `name` 字段；若重命名包（例如加 scope），请同步修改该字段。

本包唯一运行时依赖是 `@deepseek-ai/schemastery`（声明在 `dependencies`）。以 `link:` 方式安装时，Node 会按插件目录自身的 `node_modules` 解析它，因此在插件目录执行一次 `npm install`（或把该包链接进插件目录的 `node_modules`）是必需的；缺失时整行 Host 插件加载失败。

浏览器半部由 `package.json` 的 `dsh.client` 声明。client-modules 在 **Host 启动时**扫描各 Loader entry 的 `dsh.client`，并把否定结论缓存到进程退出；因此**首次加装或升级本包的浏览器半部后必须重启 `dsh web`**，只刷新页面不够。

## 在界面上修改阈值

1. 侧栏 **插件** → **已安装插件** → **压缩阈值覆盖**。
2. 在 bundle 详情里点该行 `compaction-threshold` 的 **配置**。
3. 改数值后点 **保存**。

配置页的行为：

- 输入框显示当前生效值；值来自 profile 用户层时带 **已覆盖** 徽章和 **恢复默认**。
- 空值或 **恢复默认** 表示清除用户层覆盖，回落到组合默认（bundle 默认 `0.5`）。保存一个等于组合默认的值同样会清除该字段，此时徽章消失。
- 保存写入 profile 的 `cordis.patch.yml`，形如 `- id: compaction-threshold` 下的 `config.thresholdRatio`。
- 非数字、小于等于 0 或大于 1 的输入会就地标红并禁用保存；Host 侧 schema 与插件自身再校验一次。
- 保存对插件当前打开的会话立即生效（下一次 `agent/pre-step` 起用新值），新会话直接使用新值。
- 保存被拒绝（例如 revision 冲突）时就地提示，草稿保留；离开该页会丢弃草稿。

## 配置（直接改 patch）

bundle 默认 `thresholdRatio: 0.5`。在 profile 的 `cordis.patch.yml` 覆盖（按行 id 替换整个 config）：

```yaml
- id: compaction-threshold
  config:
    thresholdRatio: 0.6
```

合法范围是 `(0, 1]`，且必须大于引擎的 `retainRatio`（默认 `0.16`），否则自动压缩会在运行时拒绝该配置。

实际触发阈值并不等于 `contextWindow × thresholdRatio`，而是：

```text
thresholdTokens = min(contextWindow × thresholdRatio,
                      contextWindow − maxTokens − headroomTokens)
```

例如：`contextWindow = 1,048,576`、`maxTokens = 256,000`、`headroomTokens = 65,536` 时，`0.8` 与 `0.5` 的实际阈值分别为 `727,040` 与 `524,288`。

## 验证

- **插件** 页出现 **压缩阈值覆盖** 卡片；bundle 详情里的 `compaction-threshold` 行有 **配置** 按钮，点开的表单显示当前阈值。
- 改值保存后，profile 的 `cordis.patch.yml` 出现对应 `thresholdRatio`；配置页不再处于 dirty 状态。
- 启动或保存日志出现 `dsh-compaction-threshold: pressure threshold set to 0.5` 等行。
- 若 preset 内没有 basic 引擎（例如换了其他压缩后端），插件会记录 debug 日志并跳过。
- 在 `isolate` preset 下，`agent.ctx.get('compaction')` 返回 `undefined` 属正常现象，插件会改走 preset registry；只有 registry 也取不到引擎时才跳过。
- 单元测试：`node --test`。

## 限制与风险

- 仅作用于 preset 内运行的 `dsh-compaction-basic`；host 层被禁用（`disabled: true`）的行不受影响。
- 手动 `/compact` 与自动压缩共用这份配置，因此也会使用覆盖后的阈值。
- 新阈值从下一次 `agent/pre-step` 生效，不改变正在进行的模型请求。
- 已存在 agent 的更新依赖 `ctx.agents` 服务：组合里没有该服务时只有新建 agent 会拿到新值（debug 日志说明）；agent 已存在但没有 preset registry 时按上面的回退路径处理。
- 浏览器半部只在 Host 启动时被扫描：升级本包后需要重启 `dsh web` 才能看到新界面。
- 依赖 `BasicCompactionEngine.config` 这一实例属性形态（`public readonly`，仅类型层只读）。harness 内部结构变化时，插件会记录 warning 并保持原阈值，不会中断会话。
- 依赖 `@deepseek-ai/dsh-agent-preset-registry` 的 `agentPresets.serviceFor(agent, name)` 读取 preset 隔离域内的服务；registry 缺失或改名时回退到 `agent.ctx.get('compaction')`，在 `isolate` preset 下即不再生效。
- 绕过 `resolveConfig` 的启动期校验；插件自行校验 `(0, 1]` 范围，并提示 `retainRatio` 冲突。
- 配置字段的描述文本（schema `description`）目前是中文，会显示在设置表单里；它是单语言 schema 元数据，不走 `locale/*.json`。
- 这是非官方扩展方式，不属于 Harness 文档化的扩展点。

## 卸载

从 profile 的 `dsh.profile.bundles` 中移除该 bundle（或删除插件行），执行 `pnpm install` 后重启。

## 开发

```sh
node --test
```

## License

MIT
