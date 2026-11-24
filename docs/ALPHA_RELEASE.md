# BiliWhale Bot v0.1.0-alpha.1

BiliWhale Bot 是一个独立的 B 站观影伙伴，源自 DSH 的 `bili-whale` 插件。你给它取名、写人设、选几个感兴趣的主题。晚上它可以去看看，给视频打分，遇到值得推荐的内容就写一两句自己的感想。看过什么、想到什么，会分别写进给主人和给自己的两本日记。

这个版本用 Node.js 和 Pi Agent Core 独立运行。手动启动一次后，程序办完当晚的事就退出。上海时间 21:00–24:00，每天最多做一次营业决定，三成概率休息。营业时最多读取五条视频资料。

## 从离线演练开始

从 [GitHub Release](https://github.com/e16a/bili-whale-bot/releases/tag/v0.1.0-alpha.1) 下载 `bili-whale-bot-0.1.0-alpha.1.tgz`。使用 Linux 和 Node.js 22.19 或更新版本，建议使用已验收的 Node.js 24。在下载目录运行。

```bash
npm install --global --prefix "$HOME/.local" --ignore-scripts ./bili-whale-bot-0.1.0-alpha.1.tgz
"$HOME/.local/bin/bili-whale" demo
```

演练使用模拟视频和账号。它会生成一个临时目录，里面有两本日记和一条分享草稿。要养自己的小鲸，初始化后编辑 `config.json` 和 `persona.md`。主人日记可补记或更正，近期内容会在下次营业时随人设一起交给模型。默认目录、会话文件、模型配置和迁移人设的步骤都在 [README](https://github.com/e16a/bili-whale-bot/blob/v0.1.0-alpha.1/README.md)。

## Alpha 的联网互动

- 营业结束后会留下两本日记，有合适的互动时会写草稿。评论和私信的回复草稿只针对 UID 已核验的主人来信。
- 分享可预演单条公开评论。主人确认正文和当日确认码后，才会在夜间窗口试发一次并回读。
- 本版通过 Linux 上的打包、全新安装、初始化和离线验收。该安装包的实际 B 站评论送达待验收。

遇到问题时，请提供 Node.js 版本、执行的命令和不含账号、正文或凭证的状态字段。软件与上游适配的 MIT 许可随包提供。 [本项目许可](https://github.com/e16a/bili-whale-bot/blob/v0.1.0-alpha.1/LICENSE) · [上游许可](https://github.com/e16a/bili-whale-bot/blob/v0.1.0-alpha.1/licenses/dsh-bili-whale-MIT.txt)
