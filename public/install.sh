#!/usr/bin/env bash
# ==============================================================================
# FlareLens Agent: Linux 30-Second Cloud-Init & Host Bootstrap Installer
# Usage:
#   curl -fsSL https://control.flarelens.dev/install.sh | sh
#   curl -fsSL https://control.flarelens.dev/install.sh | bash -s -- --control "https://control.flarelens.dev" --token "xyz"
# ==============================================================================
set -euo pipefail

CONTROL_URL="https://control.flarelens.dev"
ENROLL_TOKEN=""
INSTALL_DIR="/opt/flarelens/bin"
CONFIG_DIR="/etc/flarelens"
SERVICE_NAME="flarelens-agent"
MODE="client"

# Parse CLI flags if provided
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server|--node)
      MODE="server"
      shift
      ;;
    --client)
      MODE="client"
      shift
      ;;
    --control)
      CONTROL_URL="$2"
      shift 2
      ;;
    --token)
      ENROLL_TOKEN="$2"
      MODE="server"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

echo "================================================================"
echo "  FlareLens Unified Host Agent & Mesh - Linux Bootstrap Installer"
echo "================================================================"

# 1. Check Root Privileges
if [[ $EUID -ne 0 ]]; then
  echo "[-] Error: This installer must be run as root (use sudo)."
  exit 1
fi

# 2. Detect System Architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)
    TARGET_ARCH="amd64"
    ;;
  aarch64|arm64)
    TARGET_ARCH="arm64"
    ;;
  *)
    echo "[-] Unsupported CPU architecture: $ARCH"
    exit 1
    ;;
esac

echo "[*] Detected Architecture: linux-$TARGET_ARCH"

# 3. Create Required Directories
mkdir -p "$INSTALL_DIR"
mkdir -p "$CONFIG_DIR"
mkdir -p "/opt/flarelens/logs/wal"

# 4. Download FlareLens Agent Binary
BINARY_URL="$CONTROL_URL/api/v1/agent/binary/linux-$TARGET_ARCH"
AGENT_PATH="$INSTALL_DIR/flarelens-agent"

echo "[*] Downloading FlareLens binary from $BINARY_URL..."
if curl -fsSL "$BINARY_URL" -o "$AGENT_PATH.tmp"; then
  mv "$AGENT_PATH.tmp" "$AGENT_PATH"
  chmod +x "$AGENT_PATH"
  ln -sf "$AGENT_PATH" /usr/local/bin/flarelens-agent
  echo "[+] Binary installed to $AGENT_PATH and symlinked to /usr/local/bin/flarelens-agent"
else
  echo "[!] Live binary download failed. Using local binary if present."
  if [[ -f "/tmp/flarelens-agent" ]]; then
    cp "/tmp/flarelens-agent" "$AGENT_PATH"
    chmod +x "$AGENT_PATH"
    ln -sf "$AGENT_PATH" /usr/local/bin/flarelens-agent
    echo "[+] Copied existing local binary to $AGENT_PATH and /usr/local/bin/flarelens-agent"
  fi
fi

if [[ "$MODE" == "server" ]]; then
  # 5. Generate Server Configuration (/etc/flarelens/agent.yaml)
  CONFIG_FILE="$CONFIG_DIR/agent.yaml"
  HOSTNAME=$(hostname -s || echo "linux-node")

  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "[*] Generating configuration: $CONFIG_FILE"
    cat <<EOF > "$CONFIG_FILE"
identity:
  node_id: "node-$HOSTNAME"
  hostname: "$HOSTNAME"
  provider: "bare-metal"
  region: "default"
  tags:
    - "app"
    - "prod"

control_plane:
  endpoint: "$CONTROL_URL"
  enroll_token: "$ENROLL_TOKEN"
  heartbeat_interval: 15s

mesh:
  enabled: true
  interface: "flarelens0"
  port: 51820
  key_path: "$CONFIG_DIR/mesh.key"
  overlay_ip: "100.64.0.1"
  subnet: "100.64.0.0/10"

docker:
  socket: "unix:///var/run/docker.sock"
  default_network: "flarelens-edge"

telemetry:
  log_level: "info"
  docker_tailing_enabled: true
  wal_buffer:
    enabled: true
    path: "/opt/flarelens/logs/wal"
    max_size_mb: 2048
EOF
    chmod 600 "$CONFIG_FILE"
    echo "[+] Created $CONFIG_FILE"
  fi

  # 6. Install Systemd Service
  SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
  echo "[*] Installing systemd service: $SERVICE_FILE"
  cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=FlareLens Host Agent & WireGuard Mesh Daemon
Documentation=https://github.com/antwig2/flarelens
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=root
ExecStart=$AGENT_PATH --config $CONFIG_FILE
Restart=always
RestartSec=5s
LimitNOFILE=65536
OOMScoreAdjust=-1000

# Security Hardening
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  # 7. Reload and Enable Systemd Service
  if command -v systemctl >/dev/null 2>&1; then
    echo "[*] Enabling and starting $SERVICE_NAME..."
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME"
    systemctl restart "$SERVICE_NAME" || true
    echo "[+] $SERVICE_NAME is active and enabled on boot"
  fi

  echo "================================================================"
  echo "  [✓] FlareLens Host Agent Successfully Installed!"
  echo "  • Node ID   : node-$HOSTNAME"
  echo "  • Config    : $CONFIG_FILE"
  echo "  • Service   : systemctl status $SERVICE_NAME"
  echo "================================================================"
else
  echo "================================================================"
  echo "  [✓] FlareLens CLI Successfully Installed to /usr/local/bin/flarelens-agent"
  echo ""
  echo "  👉 Connect this device to the sovereign mesh:"
  echo "     sudo flarelens-agent login"
  echo "================================================================"
fi
