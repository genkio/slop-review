# slop-review

[![npm version](https://img.shields.io/npm/v/slop-review)](https://www.npmjs.com/package/slop-review)
[![npm downloads](https://img.shields.io/npm/dm/slop-review)](https://www.npmjs.com/package/slop-review)
[![node](https://img.shields.io/node/v/slop-review)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![website](https://img.shields.io/badge/website-genkio.github.io-5b6cff)](https://genkio.github.io/slop-review/)

[English](./README.md) · **简体中文** · [日本語](./README.ja.md)

为你和你的 LLM 打造的本地 PR 评审闭环。在任意 git 仓库中运行：在 diff 上留下行内评论，再通过内置 skill 把这些线程交给充当评审者或被评审者的 LLM（Claude Code、Cursor、Codex 等）。评论以 JSON 文件形式保存在 `<repo>/.reviews/` 下，无需剪贴板传递，agent 闭环也不需要运行任何服务器。

一个 diff 页面：可选择完整分支 diff、本地工作副本 diff，或任意单个 commit。线程和 LLM 生成的分支概览都以模态框形式从顶栏打开。Agent 的回复会直接写入 JSON，刷新或重新打开线程即可看到。

# 演示

https://github.com/user-attachments/assets/3058c57d-74b0-4bba-9c99-73cca13925f0

## 亮点

- **以 blob 为锚点的「已评审」标记，配合 HEAD 速览。** 点击文件头即可将其标记为已评审（同时折叠该文件）。标记锚定在标记当时该文件的 blob SHA 上，因此后续推送若只改动*某一个*文件，仅会使该文件的标记失效，未改动的文件依旧保持绿色。从单个 commit 视图标记时会有「之后无改动」的约束门槛，因此你永远不会对自己没看过的内容签字确认。当门槛触发时，按 `p` 可在不离开 commit 视图的前提下速览该文件在 HEAD 处的样子：一个以光标行为中心的聚焦窗口，会沿着 commit 到 HEAD 的 diff 推进，使得中间的编辑不会让你偏离目标行。

- **每个 diff 都按重要性排序文件。** 无论完整 diff 还是单个 commit 的 diff，都会按文件对本次变更集的核心程度排序：先按被引用次数（有多少*其他变更文件*引入了它），再按状态（modified 在 added 之前，added 在 removed 之前），再按源码优先于支撑文件（源码文件排在测试、文档、fixtures、changesets 以及 JSON / YAML / TOML 或锁文件等配置/数据文件之前），最后按路径。这样你会先看到承重的关键改动，而不是按字母顺序排列的噪声。移植自 [pi-slopchop](https://github.com/robzolkos/pi-slopchop) 的 PR #2。

- **通过内置 skill 让 LLM 进入闭环。** 位于 `skills/slop-review/SKILL.md` 的 Claude Code skill 让 agent 可以扮演评审者（留下行内评论）或被评审者（处理未关闭的线程、编辑源码、回复），方式是直接读写 `.reviews/` 下的 JSON，无需任何 HTTP 集成。

- **三种 diff 模式，同一页面。** 完整 diff（相对 base 的累计变更）、任意单个 commit，或本地工作副本 diff。`Shift+←` / `Shift+→` 在它们之间切换；评论在三种模式下都可用。

- **跨文件符号面板，支持多搜索停靠。** 双击 diff 中的任意标识符，即可列出它在所有变更文件中的每一处出现，当前行就地高亮。打开第二个符号时，第一个会停靠到右侧边栏（保留其匹配列表和跳转历史），因此你可以在并行的多个搜索之间切换而不丢失上下文。Esc 停靠当前搜索；点击停靠条即可恢复。

- **Vim 风格键位，配合上下文感知的提示栏。** 单字母动词驱动行级操作（评论、复制、深链、删除），全程无需离开键盘。首次按键时会显示一个 which-key 提示栏，并在每次状态变化时重新渲染，只展示当前光标行和模式下生效的键位。被隐藏的提示是严格的空操作，因此提示栏绝不会宣传一个失效的键。

- **通过 Carbonyl 实现纯终端评审。** `--carbonyl`（缩写 `-c`）借助 [Carbonyl](https://github.com/fathyb/carbonyl)（一个把画面绘制到终端里的 Chromium 分支）将 diff 界面直接渲染进 TTY，使整个闭环都停留在编辑器和 agent 旁边的同一个面板里：无需浏览器，无需切换上下文。所有键位都得以保留（一个 shim 覆盖了 Carbonyl 会剥离的少数几个修饰键组合）。参见 [Carbonyl 集成](#carbonyl-集成)。

- **单向的 GitHub 评审线程同步。** `slop-review --sync` 会把当前分支对应 GitHub PR 中*未解决*的评审线程拉取为完整 diff 上的本地线程，并保留每条线程的 GitHub 作者。再次运行时会以 GitHub 为镜像：新回复流入，在 GitHub 上已解决的线程会在本地删除，而任何你在本地编辑过 / 回复过 / 解决过的线程都会被标记，使你的改动得以保留。新的 GitHub 回复仍会追加，但你的成果绝不会被覆盖或重新排序。参见 [GitHub 评审线程同步](#github-评审线程同步)。

## 快速开始

```bash
cd /path/to/your-feature-branch
npx slop-review
```

当前工作目录会被自动引导为评审目标，服务器会挑选一个空闲端口（范围 9410-9419，之后任意空闲端口），并打开你的浏览器。线程保存在 `<repo>/.reviews/` 下，将其加入该仓库的 `.gitignore` 即可让它们只保留在本地。

所有 flag 均为可选：

| Flag         | 别名  | 参数       | 说明                                                                                                          |
|--------------|-------|------------|---------------------------------------------------------------------------------------------------------------|
| `--port`     | `-p`  | `<n>`      | 绑定的端口。默认：`9410-9419` 中第一个空闲端口，之后任意空闲端口                                              |
| `--host`     |       | `<h>`      | 绑定的主机名。默认 `0.0.0.0`                                                                                  |
| `--no-open`  |       |            | 不自动打开浏览器                                                                                              |
| `--carbonyl` | `-c`  | `[<path>]` | 在 [Carbonyl](#carbonyl-集成) 终端浏览器中打开；不带参数时从 `PATH` 解析 `carbonyl`，也可传入二进制文件或目录 |
| `--sync`     | `-s`  |            | 将 GitHub PR 中未解决的评审线程镜像为本地线程后退出。需要 `gh`。参见 [sync](#github-评审线程同步)             |
| `--browser`  | `-b`  |            | 接在 `--sync` 之后，在同步完成后用默认浏览器打开界面                                                          |
| `--threads`  | `-t`  |            | 不同步，直接进入线程巡览（完整 diff，浮现第一个未解决线程）                                                   |
| `--overview` | `-o`  |            | 在终端生成分支概览（选择生成器与可选附加指令），然后打开界面并直接浮现该概览。需要可交互终端                    |
| `--agent`    | `-a`  | `<name>`   | 直接指定生成器（`codex`、`claude`、`opencode`），不再交互选择。可重复传入或用逗号分隔。隐含 `--overview`，跳过两个提示，因此不需要 TTY |
| `--prompt`   | `-P`  | `<text>`   | 传给生成器的附加指令，例如 `-P '同时使用英文和中文'`。隐含 `--overview`，并替代附加指令的交互输入（`-p` 已是 `--port`，故用大写） |
| `--detach`   | `-d`  |            | 把服务器交给后台进程，确认可访问后即退出；界面继续运行，shell 立刻可用。会打印 pid。不能与 `--carbonyl` 同用    |
| `--kill`     | `-k`  |            | 停止当前仓库正在运行的服务器后退出（不再启动）。没有可停止的进程时也返回 0                                      |
| `--help`     | `-h`  |            | 显示帮助                                                                                                      |

`--sync` 在镜像完成后会退出，除非你接上 `--browser`、`--carbonyl` 或 `--threads`，这些会打开界面并每 5 分钟持续重新同步。`--threads` 无需同步即可到达同一个续看视图。

前置条件：Node ≥ 20，`PATH` 中有 `git`；生成概览时还需要 Python 3。无运行时依赖，服务器仅由 `node:http` 加标准库构成，因此 `npx slop-review` 不会拉取任何间接依赖包。

概览模态框会通过 `codex exec`、`claude` 或 `opencode run` 运行内置的 `explain-diff-html` skill，生成包含背景、直觉说明、代码导读、必要的图表和交互式测验的自包含 HTML。生成器支持多选，所选 CLI 会并行运行，完成后可通过 Overview 标题栏中的标签页切换结果。选择界面还可填写“同时使用英文和中文说明”等附加指令。每个生成器的 HTML 分别缓存在 `.reviews/` 下，并显示在沙箱化的 frame 中。

你也可以完全在终端中完成同样的生成，无需界面：`slop-review --overview`（`-o`）会检测可用的 agent CLI，弹出复选框选择器（空格切换、`a` 全选）以及可选的附加指令输入，带实时进度地运行所选生成器，然后打开应用并直接浮现 Overview 模态框。它可与启动类参数（`--carbonyl`、`--port`、`--no-open` 等）组合使用。

用 `--agent`（`-a`）指定生成器即可跳过两个提示，全程非交互运行；不需要 TTY，因此可以嵌入 shell 函数或脚本中：

```bash
slop-review -o -a opencode              # 单个生成器，无提示
slop-review -a codex,claude --no-open   # 两个生成器；-a 隐含 -o
```

名称拼错或 `PATH` 中找不到对应 agent 时，会在开始生成之前就报错退出。

`--prompt`（`-P`）是附加指令输入的参数形式，与模态框里的那一栏相同，会用于指定语言或重点关注的部分，因此脚本化运行也能引导生成器：

```bash
slop-review -o -a opencode -P '同时使用英文和中文'
slop-review -P '重点讲迁移部分' -a codex   # 选择由 -a 跳过，附加指令由 -P 跳过
```

附加指令上限 2000 字符（超出会截断并提示）。传入 `-P` 同样隐含 `-o`；交互运行时它只替代附加指令的输入，生成器选择器仍会显示。注意是大写：`-p` 是 `--port`。

若希望概览就绪后继续往下执行，加上 `--detach`（`-d`）：它会把服务器交给后台进程、打开浏览器并立刻交还 shell，于是你可以在同一条命令链里接一个耗时较久的命令，同时阅读概览：

```bash
slop-review -o -a opencode -d && your-long-review-command
```

命令会打印 pid，看完界面后用它结束进程。`--detach` 可与 `--port`、`--host`、`--threads`、`--sync`、`--no-open`（后台运行但不开浏览器）组合；但不能与 `--carbonyl` 同用，后者需要启动它的那个终端。

收尾用 `--kill`（`-k`），不必去找那个 pid：

```bash
slop-review -k          # 停止当前仓库的服务器后退出
```

它会停止当前仓库下所有正在运行的 slop-review 服务器（后台的，以及留在别的终端里的前台会话）；没有可停止的进程时同样返回 0，因此可以放在脚本末尾无条件调用。服务器记录在 `<repo>/.reviews/_servers.json` 中，所以 `-k` 以仓库为范围，不会影响服务其他 checkout 的进程。发送信号前会与真实进程核对（先 SIGTERM，3 秒后 SIGKILL），因此不会误杀被复用的 pid；未能自行清理就退出的条目只会被清除。

状态保存在 `~/.config/slop-review/state.json`（遵循 `XDG_CONFIG_HOME`）：包含 schema 版本以及每个仓库的 UI 状态（最近视图 + 线程续看游标）。

## 预期行为

有几个刻意设计的行为，可能会与 GitHub 评审养成的肌肉记忆相悖。

### 启动后落在哪里

冷启动会先尝试恢复该分支的最近视图，再回退到按 commit 的默认值：

| 场景                                                  | 落在                            |
|-------------------------------------------------------|---------------------------------|
| URL 明确指定了某个 sha 或 `local`                     | 能解析时遵循（否则落入下方逻辑）|
| 存在已保存的最近视图且仍能解析                        | 恢复该视图                      |
| feature 分支，领先 base 若干 commit                   | 第一个 commit（分支中最早的）   |
| 处于 `main`/`master`，无领先 commit                   | 最新 commit                     |
| 处于 `main`/`master`，无领先 commit，但有本地编辑      | 本地视图                        |
| 空分支（完全没有 commit）                             | 完整 diff（退化回退）           |

理由：feature 分支评审从 base 向前推进，因此第一个 commit 是自然的入口。处于 base 的路径使用空树 merge-base 回退，它可能合成出整个仓库历史，此时最新 commit 胜过项目伊始的那个 commit。完整 diff 始终只需一次 `Shift+→` 即可到达。

### 续看

每次导航（Shift+←/→、导航按钮，或一个全新的 hash URL）都会把当前视图以 `full`、`local` 或 `commit:<sha>` 的形式记录在 `state.config.repo_ui_state.<repoId>.last_view:<branchId>` 下。下一次冷启动会据此重建视图，除非已保存的 commit 不复存在（强推、rebase、被 GC 掉的 sha），这种情况下上面的智能默认值表就会接管。按分支隔离作用域意味着切换分支时绝不会把错误的 sha 带过去。

## Carbonyl 集成

slop-review 可在任意浏览器中运行，也可借助 [Carbonyl](https://github.com/fathyb/carbonyl)（一个把画面绘制到 TTY 的基于 Chromium 的浏览器）完全在终端内运行。`--carbonyl` 会启动它，取代你的默认 GUI 浏览器：

```bash
# 一次性安装（macOS，通过 genkio/tap homebrew tap 提供预编译包）：
brew install genkio/tap/carbonyl

# 每次启动按需选用：
slop-review --carbonyl
```

不带参数的 `--carbonyl` 会从 `PATH` 解析 `carbonyl` 二进制文件（brew 安装会把它放在那里）。对于开发版构建或自定义安装位置，可传入一个二进制文件，或一个包含它的目录：

```bash
slop-review --carbonyl ~/code/carbonyl/dist
slop-review --carbonyl ~/code/carbonyl/dist/carbonyl
```

Carbonyl 会继承 slop-review 的终端，因此你得到一个无需切换窗口的单面板闭环。退出 Carbonyl（Ctrl+C）会连同把服务器一起关闭。

### 键位绑定

diff 视图完全由键盘驱动。同一套绑定在普通浏览器和 Carbonyl 中都能用，仅有下面标注的两个修饰键组合除外：Carbonyl 的 Chromium 分支在转发 keydown 之前会剥离 Ctrl/Cmd/Shift，因此任何带修饰键的绑定都需要替代方案。

| 键                    | 操作                                               | Carbonyl                       |
|-----------------------|----------------------------------------------------|--------------------------------|
| `j` / `k`             | 光标下移 / 上移一行                                | 是                             |
| `J` / `K`             | 光标下移 / 上移五行                                | 是                             |
| `gg` / `G`            | 光标移到 diff 的首行 / 末行                        | 是                             |
| `c` / `C`             | 在新侧 / 旧侧行打开评论编辑器                      | 是                             |
| `v` / `V`             | 开始可视行选择（新侧 / 旧侧）                      | 是                             |
| `y` / `Y`             | 复制对光标行的 `path:line` 引用（新侧 / 旧侧）     | 是                             |
| `o` / `O`             | 在 forge 中打开光标行（新侧 / 旧侧）               | 是                             |
| `r`                   | 切换光标行所在文件的已评审状态                     | 是                             |
| `n` / `N`             | 跳到视图中的下一个 / 上一个线程                    | 是                             |
| `d`                   | 删除光标下的线程                                   | 是                             |
| `p`                   | 速览光标行在 HEAD 处的样子（仅 commit 视图）       | 是                             |
| `e`                   | 展开光标所在 hunk 周围的上下文行                   | 是                             |
| `Enter`               | 提交可视行选择 / 确认模态框                        | 是                             |
| `Escape`              | 取消选择、最小化面板、关闭模态框                   | 是                             |
| `Backspace`           | 弹出活动符号面板的跳转栈帧                         | 是                             |
| `Cmd/Ctrl+Enter`      | 提交评论编辑器                                     | 改用 `;;`                      |
| `Shift+←` / `Shift+→` | 切到上一个 / 下一个 commit（或本地 / 完整）        | 改用 `‹` / `›` 导航按钮        |
| `←` / `→`             | 线程模态框内的上一个 / 下一个线程                  | 是                             |

`;;`（编辑器获得焦点时在 400ms 内连按两个分号）由 `public/carbonyl-key-shim.js` 处理：它检测到双击后，会把第一个 `;` 从 textarea 中拼接移除，并派发一个合成的 `Ctrl+Enter`，从而让现有的提交处理器（它根据带 `metaKey` 或 `ctrlKey` 的 `Enter` 触发）原样触发。该 shim 无条件加载，但只会在 Carbonyl 那种被剥离修饰键的事件特征下触发，因此在普通浏览器中它是空操作。

若想在评论正文里输入字面量的 `;;`，请在两个字符之间停顿超过 400ms（或输入带空格的 `; ;` 再把空格删掉）。

## GitHub 评审线程同步

`slop-review --sync` 是一次性的单向镜像：它把你分支对应 GitHub PR 中**未解决**的评审线程拉取为本地线程，然后退出（无服务器，无浏览器）。它使用 `gh` CLI 进行认证和取数（GraphQL，这是 GitHub 唯一暴露线程*已解决*状态的地方），因此 `gh` 必须已安装并登录。非 GitHub 的 origin，或没有开放 PR 的分支，都是空操作。

```bash
slop-review --sync
```

语义：

- **锚定。** GitHub 评审线程位于 PR 的「Files」标签页，因此它们会落在 slop 的**完整 diff**（`view: "full"`）上。GitHub 的 `RIGHT` / `LEFT` 映射到 slop 的 `new` / `old`；多行范围会被保留。文件级评论（无行锚点）会被报告为跳过。
- **作者归属。** 同步进来的评论会把 GitHub 作者的 login 保留为 `user`，线程会显示一个 **GitHub** 徽章，每条评论的时间戳都链接回 GitHub 上的原文。
- **再次运行即镜像。** 每次同步都会刷新已有的同步线程（新回复出现）、**删除**在 GitHub 上已解决的本地线程，并**创建**新开放的线程。
- **本地编辑优先。** 一旦你编辑、回复、删除某条同步线程中的评论，或解决了某条同步线程，它就会被标记为 `locally_modified`；之后每次同步都不会动你的编辑，只会**追加**任何新的 GitHub 回复，绝不会覆盖或重新排序你的成果。徽章会变为暗色以表明它已分叉。
- **单向。** 同步绝不会回写到 GitHub。
- **直接进入评审。** 接上 `--browser` 或 `--carbonyl`（例如 `slop-review --sync --browser`）即可在同步完成时启动界面，落在完整 diff 上并打开第一个未解决线程的模态框。单纯的 `slop-review --sync` 只会打印摘要后退出。
- **界面打开期间持续镜像。** 当 `--sync` 打开界面时（接上 `--browser` / `--carbonyl` / `--threads`），服务器每 5 分钟从 GitHub 重新同步一次，使新回复和已解决状态持续流入。diff 顶栏中的 **"Synced …"** 徽章会显示上一次拉取的落地时间（它在 carbonyl 中也会渲染）；拉取失败则显示 **"Sync failed"**。该循环运行在服务器进程中，因此退出 slop-review（在终端或 carbonyl 面板中按 Ctrl-C）会连同停止拉取。页面不会实时重载线程，因此一旦某次后台同步改动了线程，徽章就会追加 **"· N behind"**（琥珀色）来告诉你值得手动重载一次；重载或导航会清除它。

每次运行都会打印一份摘要：created / updated / deleted / skipped，外加 GitHub 上未解决的总数。

## AI agent 集成

slop-review 在 `skills/slop-review/SKILL.md` 提供了一个 Claude Code skill，教 agent 读取线程、作为评审者留下评论，或作为被评审者处理未关闭的线程。它直接在 `.reviews/` 的 JSON 上工作，无需 HTTP API，无需运行服务器。

两种角色，开发者或 LLM 均可扮演：

- **评审者** - 在 diff 行上留下行内评论 / 提问。
- **被评审者** - 通过编辑源码 + 追加回复来处理评论。

### 安装

通过 [`skills`](https://www.npmjs.com/package/skills) npm 包（Vercel Labs）：

```bash
npx skills add genkio/slop-review
```

这会把 `SKILL.md` 复制到你的 agent CLI 对应的位置（Claude Code：`~/.claude/skills/slop-review/SKILL.md`）。然后自然地下达指令，比如 *"act as reviewer for this slop-review branch"*、*"address the unresolved slop-review threads"*，LLM 就会通过自动发现机制识别并使用它。

### 贡献者安装（热迭代）

要编辑 skill 本身？把它做成符号链接，这样改动无需重新运行 `npx skills add` 即可生效：

```bash
mkdir -p ~/.claude/skills
ln -sfn "$PWD/skills/slop-review" ~/.claude/skills/slop-review
```

此后在本检出中对 `skills/slop-review/SKILL.md` 的编辑会在下一次下达指令时即时生效。用 `rm ~/.claude/skills/slop-review` 移除。（如果你之前运行过 `npx skills add genkio/slop-review`，请先 `rm -rf` 安装路径处的真实目录。）

## 开发

```bash
git clone <this-repo> && cd slop-review
```

无依赖。HTTP 层（`server/http.js`）是对 `node:http` 的一个小型自研封装，负责路由、JSON 和静态文件；如果你改动它，请手动覆盖完整的请求面，`npm test` 只覆盖 diff/state 逻辑。前端（`public/**`）的改动只需硬刷新即可。

针对外部仓库测试真实的 `npx slop-review` 流程：

```bash
cd /path/to/slop-review
npm link              # `slop-review` 现在指向本检出
cd /some/target/repo
slop-review           # 针对当前工作目录的仓库运行你的本地代码

# 或直接运行
node /path/to/slop-review/bin/slop-review.js
```
