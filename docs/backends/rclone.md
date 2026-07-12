# Rclone Backend

The default backend. Supports 40+ cloud storage providers.

## Setup

```bash
# Install rclone
brew install rclone        # macOS
sudo apt install rclone    # Linux
# Windows: https://rclone.org/install/

# Configure a remote
rclone config
```

Follow the interactive prompts to add your cloud drive (Dropbox, Google Drive, OneDrive, S3, WebDAV, etc.).

## Configuration

```json
{
  "BACKEND": "rclone",
  "REMOTE": "myremote:claude-sync/"
}
```

`REMOTE` format: `<remote-name>:<path>/`

To see configured remotes: `rclone listremotes`
