# BaiduPCS Backend (百度网盘)

For Baidu Netdisk users in China.

## Setup

```bash
# Install BaiduPCS-Go
# Download from: https://github.com/qjfoidnh/BaiduPCS-Go/releases

# Login
BaiduPCS-Go login
```

Follow the prompts to authenticate with your Baidu account.

## Configuration

```json
{
  "BACKEND": "baidupcs",
  "REMOTE": "/claude-sync"
}
```

`REMOTE` is the folder path on your Baidu Netdisk. The folder will be created if it doesn't exist.
