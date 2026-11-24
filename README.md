# BiliWhale Bot

一个安静的 B 站观影伙伴。晚上按你设定的兴趣去找视频，自己决定看几条、怎么评、要不要分享。有想推荐给你的内容，它会写一两句具体感想。看完会分别留下一本给主人的日记和一本自留日记。

## 为什么从 DSH 独立出来

BiliWhale Bot 源自 DSH 的 `bili-whale` 插件。在当时的部署里，逐次授权会让夜间活动停下来等人确认。要让它安静地自己跑完一晚，就得给整个 DSH 会话开「完全访问」，权限也就超出了看视频、分享和写日记实际需要的范围。[原插件源码](https://github.com/Alterssss/dsh-bili-whale/tree/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6)

独立版用 Pi Agent Core 跑 Agent 循环，用 Pi AI 调用模型，整个程序随 Node.js 启动，办完一晚的事就退出。Agent 只有选片、读视频、打分、拟互动和写日记所需的工具。宿主管理 B 站凭证，把日记写进指定目录，并按 UID 核验分享对象。浏览和记日记可以按设定自行完成。[Pi SDK](https://github.com/earendil-works/pi)

## 安装与离线体验

使用 Linux 和 Node.js 22.19 或更高版本。下载源码后，在项目目录安装并用本地模拟资料跑一晚。

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
| `config.json` | 改名字、选片兴趣和避开的词。模型默认为 `deepseek-flash` |
| `persona.md` | 写它的性格、称呼、口吻，以及想让它长期记住的几件事 |
| `diaries/owner.md` | 查看它写给你的日记，也可以补记或更正近期经历 |
| `diaries/private.md` | Bot 自己的日记，保存在本机 |
| `state/` | 每日决定、浏览额度、草稿和发送回执 |

### 设定名字、兴趣和性格

在初始化生成的 `config.json` 里改 `name`、`interests` 和 `avoid` 三个字段。`interests` 填 1–6 个想让它主动去找的主题词，`avoid` 填想滤掉的标题关键词。下面是这三个字段的例子，修改时保留初始化生成的其他字段。

```json
{
  "name": "苔灯",
  "interests": ["阳台种植", "昆虫观察", "旧物修复"],
  "avoid": ["开箱带货"]
}
```

`persona.md` 是这只鲸的 soul，用普通 Markdown 写就行。可以写得具体些，告诉它平时留意什么、怎么称呼你、哪些发现值得提一句。

```markdown
## 性格和口吻

我是个慢吞吞的观察者，喜欢看人把旧东西修好。叫主人「园丁」，
说话短一点，偶尔吐槽。分享时先说一个具体细节，再说我为什么想到你。
没有想聊的，可以把今晚的见闻留在日记里。

## 想一直记住的事

- 园丁今年开始记录阳台来过的昆虫。遇到能看清辨认特征的视频，可以想到这件事。
```

`persona.md` 上限为 8 KiB，整份文件会随每次营业交给模型。保存为 UTF-8，保留文件权限 `0600`。选片和口吻的改动在下一次营业时生效。

### 补记和更正记忆

每晚的日记会继续追加。模型当晚会收到 `diaries/owner.md` 末尾最多 8,000 个字符，作为近期回忆。等 Bot 收工后，可以在这本日记末尾写个有日期的「主人补记」，添上遗漏或更正。例如写「上次我说的是阳台窗边那盆薄荷」。编辑时保留原有日期和隐藏的运行标记。

希望几个月后仍能想起来的事，可以写成一两条短句放在 `persona.md`。`diaries/private.md` 由程序在本机续写和保存。

### 带一只已有的宠物搬家

这个项目的原型曾保留原角色的 soul、两本日记和历史归档，让同一个角色继续生活。用独立版接续已有的宠物时，先初始化它自己的目录，再把旧 `SOUL.md` 或原人设文件的文字复制进 `persona.md`，并在 `config.json` 填上原来的名字和兴趣。完整的旧日记和会话留作本机档案。希望它下一晚就能想起的经历，可以挑几条带日期的主人可见内容，放进 `diaries/owner.md` 的末尾。

## 第一次正式运行

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

在 Linux x86_64 上用安装后的 `bili-whale demo` 跑了 5 次。离线演练的进程峰值 RSS 为 56.7–57.0 MiB，中位耗时 0.22 秒。含 npm 依赖的安装目录约 98 MiB。树莓派联网运行时的内存和耗时还待实测。

依赖固定为 Pi Agent Core、Pi AI 和 Pi Schema 1.5.2。视频读取、评分和部分评论、私信适配复用了 `dsh-bili-whale` 的实现。[上游 MIT 许可](licenses/dsh-bili-whale-MIT.txt) · [本仓库许可](LICENSE)

```bash
npm run typecheck
npm test
```
