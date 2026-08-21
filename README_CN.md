# notes-sjtu-sync

[English README](README.md)

`notes-sjtu-sync` 用于在一篇本地 Markdown 与一篇 [SJTU Notes](https://notes.sjtu.edu.cn) 笔记之间同步。你可以用 `upload` 把本地 Markdown 和其中直接引用的图片上传为一篇新笔记，也可以用 `download` 把已有远端笔记及其原生图片保存到本地。首次传输会默认建立跟踪关系；对于两端都已存在的内容，也可以使用 `link` 手动关联。

建立跟踪后，`status` 会判断本地、远端或双方是否发生修改，`diff` 会分别显示它们相对上次共同基线的变化；`push` 将本地修改发送到 SJTU Notes，`pull` 将远端修改取回本地。如果两端同时改变，工具不会猜测如何合并或静默覆盖，而是生成冲突参考文件，交由用户手工处理。

它的使用感觉类似 Git：都有本地副本、远端副本、状态、差异以及 push/pull。但它的结构更简单——每次只处理一篇 Markdown，没有仓库初始化、暂存区、commit、分支或历史记录，也不进行自动合并。它只记录完成安全同步所需的最后共同基线和图片映射。本地 Markdown 始终保留适合离线使用的本地图片路径，远端则使用 CodiMD 图片 URL。

> **目前不支持 Windows。** v0.1 仅在 Linux 和 macOS 上进行测试并提供支持。

CLI 专用于 `notes.sjtu.edu.cn` 上的 CodiMD 2.4.1，不是通用 CodiMD 客户端，也不是版本控制系统。

## 环境与安装

- Node.js 22 或更高版本
- Linux 或 macOS
- 用于浏览器登录的系统 Chrome/Chromium；无桌面环境时可隐藏导入 `connect.sid`

### 从 GitHub Release 安装（推荐）

安装 GitHub Release 提供的 npm 安装包，无需克隆源码：

```sh
npm install -g https://github.com/ClancyChen1/notes-sjtu-sync/releases/download/v0.1.0/notes-sjtu-sync-0.1.0.tgz
```

也可以从 [GitHub Releases](https://github.com/ClancyChen1/notes-sjtu-sync/releases) 下载 `notes-sjtu-sync-0.1.0.tgz`，然后安装本地文件：

```sh
npm install -g ./notes-sjtu-sync-0.1.0.tgz
```

请选择 Release 附件中的 `notes-sjtu-sync-0.1.0.tgz`；GitHub 自动生成的 `Source code` 压缩包不是 npm 安装包。

### 从源码安装

```sh
npm install
npm run check
npm install -g .
```

### 安装 Agent Skill

配套 Agent Skill 需要单独显式安装：

```sh
npx skills add ClancyChen1/notes-sjtu-sync --skill notes-sjtu-sync
```

安装 CLI 不会修改任何 Agent 的 Skill 目录。

## 登录

打开隔离、可见的系统浏览器，并正常完成 SJTU OAuth：

```sh
notes-sjtu-sync auth login
notes-sjtu-sync auth status
```

如果运行 CLI 的机器没有 Chrome/Chromium 或桌面会话，`auth login` 就无法自动打开浏览器。此时可以先按照下文步骤，从已经登录 SJTU Notes 的浏览器中取得会话 Cookie `connect.sid`，再运行：

```sh
notes-sjtu-sync auth import
```

该命令会提示你粘贴 `connect.sid`。为了避免会话凭证显示在屏幕或终端记录中，输入过程不会回显任何字符，粘贴后终端看起来仍是空白，直接按 Enter 即可。下面说明如何取得需要粘贴的 `connect.sid`。

### 获取 `connect.sid`

1. 在你自己的 Chrome/Chromium 中打开并登录 `https://notes.sjtu.edu.cn`。
2. 保持该页面打开，按 `F12` 或 `Ctrl+Shift+I`（macOS 为 `Command+Option+I`）打开开发者工具。
3. 进入 **Application（应用）→ Storage（存储）→ Cookies**，选择 `https://notes.sjtu.edu.cn`。具体界面可参考 [Chrome 官方 Cookie 查看指南](https://developer.chrome.com/docs/devtools/application/cookies?hl=zh-cn)。
4. 在表格中找到名称为 `connect.sid` 的记录，复制 **Value（值）**。复制原始值，不要进行 URL 解码或修改其中的 `%`、`.` 等字符。
5. 回到终端运行 `notes-sjtu-sync auth import`，粘贴该值并按 Enter。输入是隐藏的，因此粘贴时终端不会显示任何字符，这是正常现象。

`connect.sid` 等同于临时登录凭证。不要把它发送给他人、粘贴到聊天中、写入 Git 仓库或截屏公开。`auth logout` 只删除 CLI 保存的副本；如需让浏览器中的原会话也失效，请在 SJTU Notes 中退出登录。

对于由本地脚本或密钥管理器提供 Cookie 的非交互场景，可以通过标准输入传递，不要把 Cookie 写进命令参数：

```sh
printf '%s' "$SJTU_NOTES_SESSION" | notes-sjtu-sync auth import --stdin
```

这条命令会读取环境变量 `SJTU_NOTES_SESSION` 的内容，并通过管道交给 `auth import --stdin`。普通交互使用不需要设置该变量，直接使用上面的隐藏输入方式即可。

CLI 不会索取或保存 SJTU 密码、MFA 验证码，只保存 `connect.sid`。它优先使用 macOS Keychain 或 Linux Secret Service；两者都不可用时，会警告并退回仅当前用户可读的 `0600` 配置文件。`auth logout` 会删除本地会话。

为保证安全，如果检测到 `NODE_TLS_REJECT_UNAUTHORIZED=0`，生产请求会被直接拒绝；应取消该环境变量，而不是绕过证书校验。

## 命令

```text
notes-sjtu-sync upload <file.md> [--no-track] [--dry-run]
notes-sjtu-sync download <url> [file.md] [--no-track] [--dry-run]
notes-sjtu-sync link <file.md> <url> [--pull|--push] [--dry-run]
notes-sjtu-sync unlink <file.md>
notes-sjtu-sync pull <file.md> [--force] [--dry-run]
notes-sjtu-sync push <file.md> [--force] [--dry-run]
notes-sjtu-sync status <file.md>
notes-sjtu-sync diff <file.md>
```

`upload` 和 `download` 默认建立跟踪；`--no-track` 仅执行一次传输。`link` 用于关联已经存在的两份内容：内容相同可直接建立基线，内容不同时必须明确选择 `--pull` 或 `--push`。

所有命令都接受 `--json`。人类可读信息默认使用英文；JSON 采用稳定外壳：

```json
{
  "ok": true,
  "command": "status",
  "result": {
    "status": "local_modified"
  }
}
```

退出码：`0` 成功，`2` 参数或校验错误，`3` 认证错误，`4` 文件缺失或未跟踪，`5` 冲突或拒绝覆盖，`6` 网络或服务端错误，`7` 本地状态或 I/O 错误。

## 同步行为

跟踪状态保存在 Markdown 同目录的 `.notes-sjtu-sync/`。第一次建立跟踪时，CLI 会幂等地向该目录的 `.gitignore` 添加 `/.notes-sjtu-sync/`。状态按目录和 Markdown 文件名区分；移动文档时先对旧路径执行 `unlink`，再对新路径执行 `link <新路径> <url>`。

CLI 会把本地逻辑内容和远端逻辑内容分别与最后共同基线比较。如果双方都发生修改，主文件保持不动，基线与远端参考内容写入 `.notes-sjtu-sync/conflicts/` 下的 `base.md` 和 `remote.md`。用户手工合并后再明确选择同步方向；CLI 不自动合并。

本地 Markdown 始终保留本地图片路径，远端笔记使用 CodiMD 上传 URL。CLI 识别 Markdown 行内图片、引用式图片、CodiMD 图片尺寸扩展以及 HTML `<img src>`；不会解析 CSS URL、公式、图表、通用附件或普通外链图片。

只能上传 Markdown 所在目录树内的图片。绝对路径、`..` 越界、符号链接逃逸、扩展名与内容不符以及非图片文件都会被拒绝。下载的 Notes 原生图片使用内容哈希命名，并放在 `<文档名>.assets/`。

### 重要：`push` 前必须关闭远端笔记

CodiMD 2.4.1 在**任何用户仍打开该笔记**时会拒绝 API 更新请求。执行 `push`（或 `link --push`）前，请在所有浏览器和设备中关闭该远端笔记，也请协作者暂时关闭；等待数秒让实时连接释放后再重试。这是服务端限制，不是同步冲突，`--force` 无法绕过。

## Agent 安全流程

Agent 在执行 `upload`、`push`、`link --push` 或任何 `--force` 操作前，应先运行 `--dry-run --json`，向用户概括目标和图片变化，并取得明确确认。不得自动使用 `--force` 绕过冲突。

## 开发与验收

```sh
npm run typecheck
npm test
npm run build
npm pack
```

自动化测试使用本地 CodiMD 兼容 HTTP 服务和伪造远端笔记。真实站点冒烟测试是非阻塞项，因为它需要 SJTU 会话并会创建远端内容：登录后上传一次性 Markdown，检查 `status`，分别修改两端并验证 `push`/`pull`，最后解除跟踪。不要用正式笔记测试冲突。

## 许可证

[MIT](LICENSE) © 2026 ClancyChen1

## 免责声明

本项目是非官方社区项目，与上海交通大学、SJTU Notes 及 CodiMD 项目不存在隶属、授权或背书关系。本项目依赖外部服务，其接口和可用性可能随时发生变化。请在执行前检查预检结果，并为重要笔记和图片保留独立备份。使用本项目产生的风险由使用者自行承担；维护者不对数据丢失、账号问题、服务中断或其他相关损失负责。
