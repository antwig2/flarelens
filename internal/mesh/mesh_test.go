package mesh

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

type mockExecutor struct {
	mu       sync.Mutex
	commands [][]string
	dumpOut  string
}

func (m *mockExecutor) Run(ctx context.Context, cmd string, args ...string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	call := append([]string{cmd}, args...)
	m.commands = append(m.commands, call)

	if cmd == "wg" && len(args) >= 2 && args[0] == "show" && args[1] == "dump" {
		return []byte(m.dumpOut), nil
	}

	return []byte(""), nil
}

func TestKeypairGeneration(t *testing.T) {
	priv, pub, err := GenerateKeypair()
	if err != nil {
		t.Fatalf("GenerateKeypair failed: %v", err)
	}

	if len(priv) < 40 {
		t.Errorf("Unexpected private key length: %s", priv)
	}
	if len(pub) < 40 {
		t.Errorf("Unexpected public key length: %s", pub)
	}

	derivedPub, err := DerivePublicKey(priv)
	if err != nil {
		t.Fatalf("DerivePublicKey failed: %v", err)
	}

	if derivedPub != pub {
		t.Errorf("Expected derived public key %s to match %s", derivedPub, pub)
	}
}

func TestInitInterfaceAndSyncPeers(t *testing.T) {
	mock := &mockExecutor{}
	priv, pub, _ := GenerateKeypair()
	cfg := Config{
		InterfaceName: "flarelens0",
		ListenPort:    51820,
		OverlayIP:     "10.42.0.1",
	}

	mgr := NewManager(cfg, priv, pub, mock, nil)
	ctx := context.Background()

	// 1. Test Interface Init
	if err := mgr.InitInterface(ctx); err != nil {
		t.Fatalf("InitInterface failed: %v", err)
	}

	// 2. Test SyncPeers
	peers := []Peer{
		{
			ID:        "node-2",
			Name:      "node-fra-02",
			PublicKey: "ABCDEF1234567890ABCDEF1234567890ABCDEF1234=",
			OverlayIP: "10.42.0.2",
			Endpoint:  "159.69.10.5:51820",
			Type:      "node",
		},
		{
			ID:        "client-1",
			Name:      "operator-laptop",
			PublicKey: "XYZXYZ1234567890XYZXYZ1234567890XYZXYZ1234=",
			OverlayIP: "10.42.0.99",
			Type:      "client",
		},
	}

	if err := mgr.SyncPeers(ctx, peers); err != nil {
		t.Fatalf("SyncPeers failed: %v", err)
	}

	// Verify commands run
	mock.mu.Lock()
	defer mock.mu.Unlock()

	foundNodePeer := false
	foundClientPeer := false

	for _, cmd := range mock.commands {
		joined := strings.Join(cmd, " ")
		if strings.Contains(joined, "peer ABCDEF1234567890ABCDEF1234567890ABCDEF1234=") &&
			strings.Contains(joined, "endpoint 159.69.10.5:51820") &&
			strings.Contains(joined, "allowed-ips 10.42.0.2/32") {
			foundNodePeer = true
		}
		if strings.Contains(joined, "peer XYZXYZ1234567890XYZXYZ1234567890XYZXYZ1234=") &&
			strings.Contains(joined, "allowed-ips 10.42.0.99/32") {
			foundClientPeer = true
		}
	}

	if !foundNodePeer {
		t.Errorf("Expected wg set command for node-2 with endpoint and allowed-ips")
	}
	if !foundClientPeer {
		t.Errorf("Expected wg set command for client-1 with allowed-ips")
	}
}

func TestParseWGDump(t *testing.T) {
	nowUnix := time.Now().Unix()
	handshakeRecent := nowUnix - 30 // 30 seconds ago (active)
	handshakeStale := nowUnix - 600 // 10 minutes ago (inactive)

	dump := "privkey\tpubkey\t51820\toff\n" +
		"ABCDEF==\t(none)\t159.69.10.5:51820\t10.42.0.2/32\t" +
		strings.TrimSpace(string(int64ToString(handshakeRecent))) + "\t1048576\t2097152\t25\n" +
		"XYZXYZ==\t(none)\t(none)\t10.42.0.99/32\t" +
		strings.TrimSpace(string(int64ToString(handshakeStale))) + "\t512\t1024\t25\n"

	stats, err := ParseWGDump(dump)
	if err != nil {
		t.Fatalf("ParseWGDump failed: %v", err)
	}

	if len(stats) != 2 {
		t.Fatalf("Expected 2 peers, got %d", len(stats))
	}

	nodeStat, exists := stats["ABCDEF=="]
	if !exists {
		t.Fatalf("Expected stats for ABCDEF==")
	}
	if !nodeStat.Active {
		t.Errorf("Expected node peer with recent handshake to be Active")
	}
	if nodeStat.BytesRx != 1048576 || nodeStat.BytesTx != 2097152 {
		t.Errorf("Unexpected bytes: rx=%d, tx=%d", nodeStat.BytesRx, nodeStat.BytesTx)
	}
	if nodeStat.OverlayIP != "10.42.0.2" {
		t.Errorf("Expected overlay IP 10.42.0.2, got: %s", nodeStat.OverlayIP)
	}

	clientStat, exists := stats["XYZXYZ=="]
	if !exists {
		t.Fatalf("Expected stats for XYZXYZ==")
	}
	if clientStat.Active {
		t.Errorf("Expected client peer with stale handshake to NOT be Active")
	}
}

func int64ToString(n int64) string {
	return strings.TrimSpace(string([]byte{
		byte('0' + (n/1000000000)%10),
		byte('0' + (n/100000000)%10),
		byte('0' + (n/10000000)%10),
		byte('0' + (n/1000000)%10),
		byte('0' + (n/100000)%10),
		byte('0' + (n/10000)%10),
		byte('0' + (n/1000)%10),
		byte('0' + (n/100)%10),
		byte('0' + (n/10)%10),
		byte('0' + (n/1)%10),
	}))
}
