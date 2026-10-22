# dsh-compaction-threshold

在运行时覆盖 `@deepseek-ai/dsh-compaction-basic` 的自动压缩压力阈值（`thresholdRatio`），**无需重述 agent preset 声明**。

## 为什么需要它

DeepSeek Harness 的 web profile 把 compaction backend 放进 agent preset 的 `config.plugins` 内。profile patch（`cordis.patch.yml`）对一行是整体替换 `config`，而 preset 声明的插件行不在 patch 可递归的 group 结构里——想改 `thresholdRatio`，只能把上百行的 preset 声明完整复制一遍，而且 bundle 升级后容易失同步。

本插件在运行时替换 preset 内 compaction 引擎实例的已解析配置：profile 里只多一个插件行，不复制 preset。

## 工作原理

1. 监听 `agent/created`（此时 agent 的 preset generation 已挂载）。
2. 通过 `agentPresets.serviceFor(agent, 'compaction')` 读取该 preset 的 `isolate` 域内 compaction 服务；没有 preset registry 或 registry 找不到该服务时，回退到 `agent.ctx.get('compaction')`。
3. 用**结构判断**识别 `dsh-compaction-basic` 的引擎（检查已解析 config 上是否有数值型 `thresholdRatio`），因此不依赖模块身份，也不会引入第二份引擎包副本。
4. 引擎的 `config` 被 `deepFreeze` 过，因此整体替换实例属性 `config`，而不是就地修改冻结对象。
5. 不修改任何 preset 声明或现有配置文件。

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

## 配置

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

- 启动日志出现 `dsh-compaction-threshold: pressure threshold set to 0.5`。
- 用量接近阈值时出现 `compaction (step pressure)` 日志。
- 若 preset 内没有 basic 引擎（例如换了其他压缩后端），插件会记录 debug 日志并跳过。
- 在 `isolate` preset 下，`agent.ctx.get('compaction')` 返回 `undefined` 属正常现象，插件会改走 preset registry；只有 registry 也取不到引擎时才跳过。

## 限制与风险

- 仅作用于 preset 内运行的 `dsh-compaction-basic`；host 层被禁用（`disabled: true`）的行不受影响。
- 手动 `/compact` 与自动压缩共用这份配置，因此也会使用覆盖后的阈值。
- 只对插件加载后创建的 agent 生效；HMR 重载后，新会话才会应用。
- 依赖 `BasicCompactionEngine.config` 这一实例属性形态（`public readonly`，仅类型层只读）。harness 内部结构变化时，插件会记录 warning 并保持原阈值，不会中断会话。
- 依赖 `@deepseek-ai/dsh-agent-preset-registry` 的 `agentPresets.serviceFor(agent, name)` 读取 preset 隔离域内的服务；registry 缺失或改名时回退到 `agent.ctx.get('compaction')`，在 `isolate` preset 下即不再生效。
- 绕过 `resolveConfig` 的启动期校验；插件自行校验 `(0, 1]` 范围，并提示 `retainRatio` 冲突。
- 这是非官方扩展方式，不属于 Harness 文档化的扩展点。

## 卸载

从 profile 的 `dsh.profile.bundles` 中移除该 bundle（或删除插件行），执行 `pnpm install` 后重启。

## 开发

```sh
node --test
```

## License

MIT
