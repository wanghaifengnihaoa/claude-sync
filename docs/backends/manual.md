# Manual Backend

无需安装 CLI 工具，claude-sync 只负责打包/解包，用户自行处理文件传输。

适用：iCloud Drive、任意同步文件夹、USB 手动拷贝。

## claude-sync 配置

```json
{
  "BACKEND": "manual",
  "BUNDLE_DIR": "/path/to/sync/folder"
}
```

### iCloud Drive 示例

```json
{
  "BACKEND": "manual",
  "BUNDLE_DIR": "~/Library/Mobile Documents/com~apple~CloudDocs/claude-sync"
}
```

## 工作流程

1. 源机 `claude-sync push` → 等待云盘同步完成
2. 目标机确保同步完成 → `claude-sync pull`

## 注意事项

- 冲突检测不可用，push 前请确认远端包是最新的
- 两端 BUNDLE_DIR 设为同一云盘同步目录
