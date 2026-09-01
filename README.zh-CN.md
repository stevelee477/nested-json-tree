# Nested JSON Tree

<p align="center">
  <img src="assets/icon.png" width="112" alt="Nested JSON Tree 图标">
</p>

<p align="center">
  在 VS Code 中用交互式树查看 JSON、JSONL、日志中的 JSON，以及转义字符串里的嵌套 JSON。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="https://github.com/stevelee477/nested-json-tree/actions/workflows/ci.yml"><img src="https://github.com/stevelee477/nested-json-tree/actions/workflows/ci.yml/badge.svg" alt="CI"></a> ·
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-59DDF2" alt="MIT License"></a>
</p>

Nested JSON Tree 专门处理普通格式化工具不擅长的 JSON：日志行中夹杂的 JSON、JSONL 文件里的单条记录，以及嵌套多层的转义 JSON 字符串。

![在 JSON Tree 中搜索](assets/screenshots/tree-search.png)

## 主要功能

- 将 JSON/JSONC 文档打开为可折叠的树。
- 支持 JSONC 的行注释、块注释和尾逗号。
- JSON 前后有日志或其他无关文字时，仍可提取完整 JSON。
- 只读取并解析 JSONL/NDJSON 光标所在行，不把整个文档送入解析器。
- 右键字符串，递归打开转义或重复编码的嵌套 JSON。
- 将嵌套 JSON 反转义、解析并格式化到普通编辑器。
- 大整数以及 `"\u0061"`、`"\/"` 这样的原始 token 在显示、搜索、复制和格式化时都不会失真。
- 分片搜索解码值与原始字段/值，过滤无关分支并逐个跳转结果。
- 复制无损值、解码字符串、完全原样的转义字符串、JSONPath 和 jq 路径。
- 检出多个 JSON 时弹出候选列表。
- 小树自动展开，大树保持易于浏览。

## 嵌套 JSON

右键任意字符串节点，即可打开其中编码的 JSON。新打开的 Tree View 仍支持相同操作，因此可以继续逐层深入。

![打开转义的嵌套 JSON](assets/screenshots/nested-json-menu.png)

也可以选择 **Open parsed JSON in new editor**，把字符串反转义并格式化为普通 JSON 文档。

## JSONL / NDJSON

把光标放到目标记录上，通过编辑器右键菜单或命令面板执行 **Nested JSON Tree: Open Current Line as Tree**。

![打开当前 JSONL 行](assets/screenshots/jsonl-current-line.png)

编辑器右键入口只在 JSON/JSONC 和 JSONL/NDJSON 文件中显示。对于文本和日志文件，仍可通过 `Cmd+Shift+P` / `Ctrl+Shift+P` 调用两个命令。

## 安装

### 从 GitHub Release 安装

1. 从 [Releases](https://github.com/stevelee477/nested-json-tree/releases) 下载最新 `.vsix`。
2. 在 VS Code 中打开扩展面板。
3. 选择 **… → Install from VSIX…**，然后选择下载的文件。

也可以使用命令行：

```sh
code --install-extension nested-json-tree-0.4.0.vsix
```

## 命令

| 命令 | 用途 |
| --- | --- |
| `Nested JSON Tree: Open Document as Tree` | 从当前文档提取 JSON 并打开 Tree View。 |
| `Nested JSON Tree: Open Current Line as Tree` | 从光标所在行提取 JSON 并打开 Tree View。 |

## Tree View 操作

- **Expand all / Collapse all**：一次展开或收起全部容器；**Expand all** 上限为 10,000 个节点。
- `Cmd+F` / `Ctrl+F`：聚焦搜索框。
- `Enter` / `Shift+Enter`：跳转下一个或上一个结果。
- `Esc`：清空搜索并恢复搜索前的展开状态。
- 右键节点：复制值、字段名、JSONPath 或 jq 路径。

jq 路径示例：

```jq
.users[0]["display-name"]
```

## 设置

| 设置项 | 默认值 | 说明 |
| --- | ---: | --- |
| `nestedJsonTree.autoExpandMaxNodes` | `200` | 节点数不超过此值时自动完全展开；设为 `0` 时禁用后代自动展开，超过 10,000 个节点的根节点仍保持折叠。 |

## 解析边界

- 输入文件最大 100 MB。
- 安全上限：最多 1,024 层嵌套、合计 100,000 个值节点、5,000 个提取候选和 50,000 个潜在容器片段。
- 支持常见日志前后缀；如果无关内容同时混有多组未闭合引号或注释，提取只能尽力而为。
- 支持 JSONC 注释和尾逗号；打开到编辑器时会输出严格 JSON。
- 保留数字和字符串 token、字段名转义、字段顺序与重复字段。
- 提取候选时忽略空对象 `{}` 和空数组 `[]`。
- 不修复缺少引号、括号等结构损坏。
- 格式化结果超过 16 Mi 字符时自动改用紧凑 JSON；复制或打开到编辑器的内容超过 50 Mi 字符时会拒绝操作。
- 超长字段名、值和界面路径最多显示 10,000 个首尾字符。搜索只覆盖 Tree View 中缩短后的字段；复制和嵌套打开仍使用 Extension Host 中的完整数据。
- Tree View 只读；需要编辑时可将解析结果打开到独立编辑器。

## 开发

```sh
npm install
npm test
npm run test:integration
npm run package
```

在 VS Code 中按 `F5` 启动 Extension Development Host。截图使用的虚构数据位于 [`examples/`](examples/)。

## 参与贡献

欢迎提交 Issue 和 Pull Request。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
