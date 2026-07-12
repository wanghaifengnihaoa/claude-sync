# Rclone Backend

claude-sync 的默认传输后端，支持 40+ 云存储提供商。

## 安装 rclone

```bash
# macOS
brew install rclone

# Linux
curl https://rclone.org/install.sh | sudo bash

# Windows
winget install rclone
# 或从 https://rclone.org/downloads/ 下载
```

## 配置云盘

```bash
rclone config
```

按交互提示添加 remote。

## 查看已配置的 remote

```bash
rclone listremotes
```

## claude-sync 配置

```json
{
  "BACKEND": "rclone",
  "REMOTE": "myremote:claude-sync/"
}
```

### 常见云盘的 REMOTE 格式

| 云盘 | REMOTE 格式 | 说明 |
|------|------------|------|
| Google Drive | `gdrive:claude-sync/` | 需在 rclone config 中配置 gdrive remote |
| Dropbox | `dropbox:claude-sync/` | 同上 |
| OneDrive | `onedrive:claude-sync/` | 同上 |
| Amazon S3 | `s3:mybucket/claude-sync/` | 同上 |
| 坚果云 (WebDAV) | `nutstore:claude-sync/` | 选 WebDAV 类型配置 |

## 初始化

```bash
claude-sync init
# 选择 rclone，从已有 remote 列表中选取，填路径
```

## 注意事项

- rclone 不原生支持百度网盘，请用 `baidupcs` 后端
- 首次使用需先执行 `rclone config` 配置云盘
