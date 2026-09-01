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
- JSON 前后有日志或其他无关文字时，仍可提取完整 JSON。
- 只解析 JSONL/NDJSON 光标所在行，不把整个文件当作一个 JSON。
- 右键字符串，递归打开转义或重复编码的嵌套 JSON。
- 将嵌套 JSON 反转义、解析并格式化到普通编辑器。
- 搜索字段名和基础值，过滤无关分支并逐个跳转结果。
- 复制值、解码字符串、原始转义字符串、JSONPath 和 jq 路径。
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
code --install-extension nested-json-tree-0.3.1.vsix
```

## 命令

| 命令 | 用途 |
| --- | --- |
| `Nested JSON Tree: Open Document as Tree` | 从当前文档提取 JSON 并打开 Tree View。 |
| `Nested JSON Tree: Open Current Line as Tree` | 从光标所在行提取 JSON 并打开 Tree View。 |

## Tree View 操作

- **Expand all / Collapse all**：一次展开或收起全部容器。
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
| `nestedJsonTree.autoExpandMaxNodes` | `200` | 节点数不超过此值时自动完全展开；设为 `0` 时只展开根节点。 |

## 解析边界

- 输入文件最大 100 MB。
- 支持 JSON 前后的无关内容。
- 提取候选时忽略空对象 `{}` 和空数组 `[]`。
- 不修复缺少引号、括号等结构损坏。
- Tree View 只读；需要编辑时可将解析结果打开到独立编辑器。

## 开发

```sh
npm install
npm test
npm run package
```

在 VS Code 中按 `F5` 启动 Extension Development Host。截图使用的虚构数据位于 [`examples/`](examples/)。

## 参与贡献

欢迎提交 Issue 和 Pull Request。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
