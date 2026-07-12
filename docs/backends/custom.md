# Custom Backend

高级用户：自定义上传/下载命令，接入任意存储系统。

## 配置

```json
{
  "BACKEND": "custom",
  "REMOTE": "user@myserver:/backups/claude-sync/",
  "UPLOAD_CMD": "scp {file} {remote}",
  "DOWNLOAD_CMD": "scp {remote} {file}"
}
```

### 占位符

| 占位符 | 替换为 |
|--------|--------|
| `{file}` | 本地文件路径 |
| `{remote}` | 远程路径 |

### 更多示例

**rsync**: `"UPLOAD_CMD": "rsync -avz {file} {remote}"`
**AWS CLI**: `"UPLOAD_CMD": "aws s3 cp {file} {remote}"`
