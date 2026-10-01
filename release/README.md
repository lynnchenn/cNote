# cNote 使用说明（v0.1）

轻量 Markdown 笔记编辑器。**绿色免安装**：既拿即用
双击 `cNote.exe` 即可，不写注册表，也不解压任何临时文件。

> 这份说明只讲怎么用。构建方法和实现细节见项目主页的 README。

## 系统要求

- Windows 10 1803+ 或 Windows 11
- Microsoft Edge WebView2 Runtime：Windows 11 自带，Windows 10 装了新版 Edge 通常也有。
  缺失时启动会提示，装上即可。

## 开始使用

- 双击 `cNote.exe`，或者把 `.md` 文件拖进窗口。
- 命令行也可以：`cNote.exe 笔记.md`。
- 已经启动时再次打开不会开出第二个窗口，而是把文件交给已运行的窗口并把它带到前台。
- `Ctrl+1 / 2 / 3` 切换源码 / 分栏 / 阅读；`F1` 查看全部快捷键。

## 常用快捷键

| 操作 | 快捷键 | 操作 | 快捷键 |
| --- | --- | --- | --- |
| 新建 / 打开 / 保存 | `Ctrl+N` `Ctrl+O` `Ctrl+S` | 查找 / 替换 | `Ctrl+F` |
| 源码 / 分栏 / 阅读 | `Ctrl+1` `Ctrl+2` `Ctrl+3` | 专注模式 / 打字机模式 | `F8` / `F9` |
| 加粗 / 斜体 / 删除线 / 高亮 | `Ctrl+B` `Ctrl+I` `Ctrl+D` `Ctrl+E` | 插入链接 / 图片 / 公式 | `Ctrl+K` `Ctrl+Shift+I` `Ctrl+Shift+M` |
| 切换侧边栏 | `Ctrl+\` | 导出 HTML / PDF | `Ctrl+Shift+E` / `Ctrl+Shift+P` |
| 打印 | `Ctrl+P` | 快捷键帮助 | `F1` |

## 数据放在哪

默认都在 `cNote.exe` 旁边（这样拷走整个文件夹就连配置一起带走）：

| 文件 | 内容 |
| --- | --- |
| `cNote.config.json` | 主题、字号、视图模式、窗口位置、最近的笔记 |
| `cNote.log` | 启动耗时与错误记录，出问题时可以看这里 |
| `cNote.data/` | WebView2 的用户数据目录 |

如果 exe 放在没有写权限的位置（例如 `C:\Program Files`），这些文件会自动改放到
`%LOCALAPPDATA%\cNote`。

## 卸载

删掉这个文件夹即可；如果曾经把它放在只读目录里，再顺手删掉 `%LOCALAPPDATA%\cNote`。

---

MIT License，详见项目根目录的 `LICENSE`。
