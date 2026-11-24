# BiliWhale Bot

一个安静的 B 站观影伙伴。晚上按你设定的兴趣去找视频，自己决定看几条、怎么评、要不要分享。有想推荐给你的内容，它会写一两句具体感想。看完会分别留下一本给主人的日记和一本自留日记。

用 TypeScript、Node.js、Pi Agent Core 和 Pi AI 实现，一次启动跑完一晚。运行程序有自己的配置和数据目录。例程使用本地模拟资料，可以先体验，再配置自己的账号和人设。

## 安装与离线体验

使用 Linux 和 Node.js 22.19 或更高版本。下载源码后，在项目目录安装并运行演练。

```bash
npm ci --ignore-scripts
npm run build
npm pack --ignore-scripts
npm install --global --prefix "$HOME/.local" --ignore-scripts ./bili-whale-bot-0.1.0-alpha.1.tgz
export PATH="$HOME/.local/bin:$PATH"
bili-whale demo
```

演练的 `home` 是新生成的临时目录。打开其中的 `diaries/owner.md`、`diaries/private.md` 和 `state/night-2025-01-02/drafts.json`，可以看到两份日记和一条分享样本。`bilibiliReads` 在演练中统计的是模拟请求。

## 养自己的小鲸

用两个不同的 B 站数字 UID 初始化。`--owner` 是接收分享的主人账号，`--bot` 是负责浏览的账号。配置两个 UID 后，程序也会核对实际会话的登录账号。

```bash
bili-whale init --owner YOUR_UID --bot BOT_UID
```

默认目录为 `~/.local/share/bili-whale-bot`。初始化、夜间运行和分享预演都可用 `--home` 指定目录。初始化只创建新目录，两本日记从空白开始。

| 文件 | 用途 |
| --- | --- |
| `config.json` | 编辑名字、`interests`（1–6 个兴趣词）、`avoid`（希望避开的词）与 DeepSeek 模型。默认模型为 `deepseek-flash` |
| `persona.md` | 编辑你自己的角色设定和说话方式 |
| `diaries/owner.md` | 给主人读的日记，近期片段帮助它延续记忆 |
| `diaries/private.md` | Bot 的自留日记，留在本机 |
| `state/` | 每日决定、浏览额度、草稿和发送回执 |

在家目录下另存权限为 `0600` 的会话 JSON，使用现有的 Bot 账号会话。字段为 `sessdata`、`bili_jct` 和同一会话的可选 `buvid3`。在自己的终端配置 `DEEPSEEK_API_KEY`，然后在上海时间 21:00–24:00 启动 Bot。

```bash
bili-whale run --session "$HOME/.config/bili-whale-bot/session.json"
```

每个上海自然日最多做一次营业决定，30% 概率休息。一次最多读取 5 个视频的简介和可用字幕。过门槛的第一名可以分享，也可以略过。夜间流程生成日记和草稿，原评论及私信根据主人 UID 核验，回复草稿保留原消息的对应关系。

## 试发一条分享

用已完成的运行日期查看草稿。预演会给出目标视频、完整公开评论和当日确认码。

```bash
bili-whale share --day YYYY-MM-DD --session "$HOME/.config/bili-whale-bot/session.json"
```

确认正文后，可在同一个上海自然日的夜间窗口给上述命令加 `--send-approved` 和完整确认码。它只试发这一条视频评论并 @ 主人，发布前写入账本，回读时核对原视频、发帖账号和提及的 UID。`unknown` 表示需要查看平台是否已经收到评论，账本会保留这次占位。评论回复和私信回复在本版保留为草稿。

## 数据与权限

Agent 的工具只有列候选、读选中的视频、打分、生成互动草稿和写两本日记。唯一可试发的公开动作是向核验过的主人分享。换账号应初始化新的目录，让 UID 和额度账本保持绑定。平台拒绝、限流、登录失效或接口异常时会停止相关操作。

DeepSeek 会收到人设、兴趣词、近期主人日记的片段、模型选取的视频资料和核验过的主人来信。凭证由宿主进程持有。工具注册约束 Agent 的操作范围，操作系统权限由部署者管理。

## 当前版本与许可

`0.1.0-alpha.1` 为安装验收版。在 Linux 和 Node.js 24.22.3 上，从打包文件安装到全新目录，初始化成功。离线演练完成两本日记和一条分享草稿。类型检查与 5 项测试通过。实际 B 站试发和通知送达仍待实机验收。

依赖固定为 Pi Agent Core、Pi AI 和 Pi Schema 1.5.2。视频读取、评分和部分评论、私信适配源自 MIT 许可的 `dsh-bili-whale`。 [Pi SDK](https://github.com/earendil-works/pi) · [上游源码](https://github.com/Alterssss/dsh-bili-whale/tree/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6) · [上游许可](licenses/dsh-bili-whale-MIT.txt) · [本仓库许可](LICENSE)

```bash
npm run typecheck
npm test
```
