package mesh

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// CommandExecutor defines the interface for running system commands (mockable for tests)
type CommandExecutor interface {
	Run(ctx context.Context, cmd string, args ...string) ([]byte, error)
}

// OSCommandExecutor executes real Linux kernel commands
type OSCommandExecutor struct{}

func (e *OSCommandExecutor) Run(ctx context.Context, cmd string, args ...string) ([]byte, error) {
	c := exec.CommandContext(ctx, cmd, args...)
	return c.CombinedOutput()
}

// Manager orchestrates the kernel WireGuard interface and peer synchronization
type Manager struct {
	cfg        Config
	privKey    string
	pubKey     string
	executor   CommandExecutor
	logger     *slog.Logger
	knownPeers map[string]Peer // key: public_key
	mu         sync.RWMutex
}

// NewManager creates a new WireGuard mesh manager
func NewManager(cfg Config, privKey, pubKey string, executor CommandExecutor, logger *slog.Logger) *Manager {
	if cfg.InterfaceName == "" {
		cfg.InterfaceName = "flarelens0"
	}
	if cfg.ListenPort == 0 {
		cfg.ListenPort = 51820
	}
	if cfg.Subnet == "" {
		cfg.Subnet = "10.42.0.0/16"
	}
	if executor == nil {
		executor = &OSCommandExecutor{}
	}
	if logger == nil {
		logger = slog.Default()
	}

	return &Manager{
		cfg:        cfg,
		privKey:    privKey,
		pubKey:     pubKey,
		executor:   executor,
		logger:     logger,
		knownPeers: make(map[string]Peer),
	}
}

// PublicKey returns the agent's local WireGuard public key
func (m *Manager) PublicKey() string {
	return m.pubKey
}

// OverlayIP returns the assigned overlay IP
func (m *Manager) OverlayIP() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.cfg.OverlayIP
}

// SetOverlayIP updates the local overlay IP if assigned by control plane
func (m *Manager) SetOverlayIP(ip string) {
	m.mu.Lock()
	m.cfg.OverlayIP = ip
	m.mu.Unlock()
}

// InitInterface initializes the Linux WireGuard kernel interface (flarelens0)
func (m *Manager) InitInterface(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	iface := m.cfg.InterfaceName
	m.logger.Info("Initializing FlareLens WireGuard mesh interface", "interface", iface, "port", m.cfg.ListenPort)

	// 1. Check if interface exists; if not, create it
	_, err := m.executor.Run(ctx, "ip", "link", "show", iface)
	if err != nil {
		out, addErr := m.executor.Run(ctx, "ip", "link", "add", "dev", iface, "type", "wireguard")
		if addErr != nil {
			return fmt.Errorf("failed to create wireguard interface %s: %s (%w)", iface, strings.TrimSpace(string(out)), addErr)
		}
	}

	// 2. Write private key to secure temporary file for wg set
	tmpKeyFile, err := os.CreateTemp("", "flarelens-mesh-*.key")
	if err != nil {
		return fmt.Errorf("failed to create temp key file: %w", err)
	}
	defer os.Remove(tmpKeyFile.Name())

	if _, err := tmpKeyFile.WriteString(m.privKey + "\n"); err != nil {
		_ = tmpKeyFile.Close()
		return fmt.Errorf("failed to write private key: %w", err)
	}
	_ = tmpKeyFile.Close()

	// 3. Configure interface listen port and private key
	out, err := m.executor.Run(ctx, "wg", "set", iface, "listen-port", strconv.Itoa(m.cfg.ListenPort), "private-key", tmpKeyFile.Name())
	if err != nil {
		return fmt.Errorf("failed to configure wireguard private key: %s (%w)", strings.TrimSpace(string(out)), err)
	}

	// 4. Assign IP address if configured
	if m.cfg.OverlayIP != "" {
		cidr := fmt.Sprintf("%s/16", m.cfg.OverlayIP)
		out, err := m.executor.Run(ctx, "ip", "addr", "replace", cidr, "dev", iface)
		if err != nil {
			return fmt.Errorf("failed to assign overlay ip %s to %s: %s (%w)", cidr, iface, strings.TrimSpace(string(out)), err)
		}
	}

	// 5. Bring interface up
	out, err = m.executor.Run(ctx, "ip", "link", "set", "up", "dev", iface)
	if err != nil {
		return fmt.Errorf("failed to bring up interface %s: %s (%w)", iface, strings.TrimSpace(string(out)), err)
	}

	m.logger.Info("FlareLens WireGuard mesh interface is UP", "interface", iface, "overlay_ip", m.cfg.OverlayIP)
	return nil
}

// SyncPeers dynamically adds, updates, or removes peers in the kernel without restarting the interface
func (m *Manager) SyncPeers(ctx context.Context, peers []Peer) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	iface := m.cfg.InterfaceName
	newPeerMap := make(map[string]Peer)

	for _, p := range peers {
		// Do not add self as a peer
		if p.PublicKey == m.pubKey || p.OverlayIP == "" {
			continue
		}
		newPeerMap[p.PublicKey] = p

		// Dynamic wg set peer
		args := []string{
			"set", iface,
			"peer", p.PublicKey,
			"allowed-ips", fmt.Sprintf("%s/32", p.OverlayIP),
			"persistent-keepalive", "25",
		}
		if p.Endpoint != "" {
			args = append(args, "endpoint", p.Endpoint)
		}

		out, err := m.executor.Run(ctx, "wg", args...)
		if err != nil {
			m.logger.Warn("Failed to configure WireGuard peer",
				"peer_name", p.Name,
				"peer_ip", p.OverlayIP,
				"error", err,
				"output", strings.TrimSpace(string(out)),
			)
			continue
		}
	}

	// Remove stale peers that are no longer in the mesh
	for oldPub := range m.knownPeers {
		if _, exists := newPeerMap[oldPub]; !exists {
			m.logger.Info("Removing stale WireGuard peer from mesh", "public_key", oldPub)
			_, _ = m.executor.Run(ctx, "wg", "set", iface, "peer", oldPub, "remove")
		}
	}

	m.knownPeers = newPeerMap
	m.logger.Debug("Synced WireGuard mesh peers", "active_peers", len(newPeerMap))
	return nil
}

// GetPeerStats parses `wg show <iface> dump` to return real-time kernel peer telemetry
func (m *Manager) GetPeerStats(ctx context.Context) (map[string]PeerStats, error) {
	m.mu.RLock()
	iface := m.cfg.InterfaceName
	m.mu.RUnlock()

	out, err := m.executor.Run(ctx, "wg", "show", iface, "dump")
	if err != nil {
		return nil, fmt.Errorf("failed to run wg show dump: %w", err)
	}

	return ParseWGDump(string(out))
}

// ParseWGDump parses the tab-delimited output of `wg show <iface> dump`
func ParseWGDump(dump string) (map[string]PeerStats, error) {
	lines := strings.Split(dump, "\n")
	stats := make(map[string]PeerStats)
	now := time.Now().Unix()

	// Skip line 0 (interface header line)
	for i := 1; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		// Format: public_key, preshared_key, endpoint, allowed_ips, latest_handshake, transfer_rx, transfer_tx, persistent_keepalive
		if len(fields) < 7 {
			continue
		}

		pubKey := fields[0]
		allowedIPs := fields[3]
		latestHandshake, _ := strconv.ParseInt(fields[4], 10, 64)
		rxBytes, _ := strconv.ParseInt(fields[5], 10, 64)
		txBytes, _ := strconv.ParseInt(fields[6], 10, 64)

		cleanIP := strings.TrimSuffix(allowedIPs, "/32")

		stats[pubKey] = PeerStats{
			PublicKey:       pubKey,
			OverlayIP:       cleanIP,
			LatestHandshake: latestHandshake,
			BytesRx:         rxBytes,
			BytesTx:         txBytes,
			Active:          latestHandshake > 0 && (now-latestHandshake) < 180,
		}
	}

	return stats, nil
}
