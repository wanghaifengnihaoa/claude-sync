# claude-sync

中文 | [English](README.en.md)

Claude Code 跨机器配置同步工具。

**痛点：** Claude Code 的所有配置（设置、技能、插件、memory、快捷键）都存储在本地。换一台机器就得从头配置。

**方案：** `claude-sync` 一键把你的 Claude Code 配置推送到云盘，另一台机器上一键拉取合并。

## 功能

- **可插拔后端** — rclone（40+ 云盘）、百度网盘、iCloud/手动、自定义命令
- **密钥处理** — `keep`（随包加密传输）或 `strip`（替换为 `***` 占位符）
- **智能合并** — `--cover`（完全同步）或 `--keep`（只补缺）。绝不盲目覆盖
- **自动识别** — 5 种 skill 类型：skills.sh、git 仓库、symlink、子 symlink、普通目录
- **跨平台** — macOS、Linux、Windows。机器间路径自动转换
- **安全** — pull 前自动备份，`restore` 随时回退

## 快速开始

```bash
npm install -g claude-sync

# 主力机上
claude-sync init     # 交互式配置（选后端 + 填远程路径）
claude-sync push     # 上传配置

# 其他机器上
claude-sync init     # 同样的后端 + 远程路径
claude-sync pull     # 下载并合并配置
```

## 命令

| 命令 | 说明 |
|---------|-------------|
| `init` | 交互式初始化（后端、远程路径、机器标识） |
| `push [--force]` | 上传本机配置 |
| `pull [--cover\|--keep\|--interactive\|--dry-run]` | 下载并合并配置 |
| `status` | 查看本地与远端差异摘要 |
| `diff` | 查看详细内容差异（字段级别） |
| `restore --backup <时间戳>` | 回退到某次 pull 前的备份 |
| `restore --list` | 列出所有可用备份 |
| `restore --cleanup <时间戳>` | 删除指定备份 |
| `restore --cleanup-all` | 删除所有备份 |

## 后端选择

| 后端 | 适用 | 准备工作 |
|---------|---------|---------|
| **rclone**（默认） | Dropbox、Google Drive、OneDrive、S3、坚果云 WebDAV 等 | 先执行 `rclone config` |
| **baidupcs** | 百度网盘 | 先执行 `BaiduPCS-Go login` |
| **manual** | iCloud Drive、任意同步文件夹 | 将 BUNDLE_DIR 设为同步目录 |
| **custom** | 自定义上传/下载命令 | 配置 UPLOAD_CMD / DOWNLOAD_CMD |

### 云盘快速参考

| 云盘 | BACKEND | REMOTE 格式 |
|-------|---------|--------|
| Dropbox / GDrive / OneDrive / S3 | `rclone` | `myremote:claude-sync/` |
| 坚果云 | `rclone`（WebDAV） | `mynutstore:claude-sync/` |
| 百度网盘 | `baidupcs` | `/claude-sync` |
| iCloud Drive | `manual` | 留空（设定 BUNDLE_DIR 即可） |

## 配置

`~/.claude-sync.json`（由 `claude-sync init` 生成）：

```json
{
  "REMOTE": "gdrive:claude-sync/",
  "BACKEND": "rclone",
  "SECRETS": "keep",
  "MACHINE_ID": "my-macbook"
}
```

## 同步内容

| ✅ 同步 | ❌ 不同步 |
|-----------|--------------|
| `settings.json` + `settings.local.json` | `sessions/` |
| `CLAUDE.md`（`~/` 和 `~/.claude/` 双位置） | `projects/` |
| `keybindings.json` | `debug/` `tasks/` `plans/` |
| `commands/` `agents/` `hooks/` | `plugins/cache/` `plugins/marketplaces/` |
| `skills/`（全部类型） | `history.jsonl` |
| `plugins/installed_plugins.json` | `.claude.json` 机器特定字段 |
| `mcpServers`（从 `.claude.json` 提取） | |
| `shared-memory/`（若开启全局化） | |

## 密钥处理

### `keep` 模式（默认）

密钥随 tar.gz 包原样传输。使用私有云盘后端时安全（rclone 自己的账号、百度网盘私有空间）。

### `strip` 模式

密钥值在上传前替换为 `***` 占位符：
```json
{ "env": { "ANTHROPIC_AUTH_TOKEN": "***" } }
```
拉取时，如果目标机已有真实值则保留；没有则删除占位符——你手动填入真实值。键名结构始终保留，一眼就能看到需要配置哪些字段。

## License

MIT
