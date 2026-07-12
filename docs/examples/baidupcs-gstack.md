# 案例：百度网盘 + gstack skill

## 场景

- 公司机器 (macOS)：主力开发机，装了 gstack skill、figma MCP、自定义 commands
- 家里机器 (macOS)：也想用同样的配置

两机都装了 BaiduPCS-Go。

## 步骤

### 公司机器（源机）

```bash
npm install -g @whfnihaoa/claude-sync
claude-sync init
# 选 baidupcs → 路径 /claude-sync

claude-sync push
# 上传并推送到百度网盘 /claude-sync/ 目录
```

### 家里机器（目标机）

```bash
npm install -g @whfnihaoa/claude-sync
claude-sync init
# 选 baidupcs → 路径 /claude-sync（与源机相同）

claude-sync pull --cover
# 下载配置、合并 skills、恢复插件注册表
```

### 验证

```bash
claude-sync status  # 确认本地与远端一致
```
