# BaiduPCS Backend (百度网盘)

claude-sync 的百度网盘专用后端，基于 BaiduPCS-Go。

## 安装 BaiduPCS-Go

从 GitHub Releases 下载: https://github.com/qjfoidnh/BaiduPCS-Go/releases

## 登录

```bash
BaiduPCS-Go login
BaiduPCS-Go who   # 验证登录状态
```

## claude-sync 配置

```json
{
  "BACKEND": "baidupcs",
  "REMOTE": "/claude-sync"
}
```

`REMOTE` 是百度网盘中的绝对路径。

## 注意事项

- 首次使用需手动 cookies 登录
- 登录过期后重新 `BaiduPCS-Go login`
