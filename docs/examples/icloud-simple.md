# 案例：iCloud Drive 同步

## 场景

两台 Mac，同一个 Apple ID，iCloud Drive 已开启。

## 步骤

### 机器 A（源机）

```bash
npm install -g @whfnihaoa/claude-sync
claude-sync init
# 选 manual → BUNDLE_DIR 设为 iCloud 目录

# 配置示例:
# BACKEND=manual, BUNDLE_DIR=~/Library/Mobile Documents/com~apple~CloudDocs/claude-sync

claude-sync push
# 等待 iCloud 同步完成
```

### 机器 B（目标机）

```bash
# 等待 iCloud 同步完成（确认有 manifest.json + bundle.tar.gz）
claude-sync pull --cover
```
