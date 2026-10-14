package deploy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSlotInvert(t *testing.T) {
	if SlotBlue.Invert() != SlotGreen {
		t.Errorf("Expected SlotBlue.Invert() to be SlotGreen")
	}
	if SlotGreen.Invert() != SlotBlue {
		t.Errorf("Expected SlotGreen.Invert() to be SlotBlue")
	}
}

func TestTraefikRouteFlipper(t *testing.T) {
	tmpDir := t.TempDir()
	flipper := NewTraefikRouteFlipper(tmpDir)

	err := flipper.FlipRoute("bill-api", "bill.kiwid.io", 8082)
	if err != nil {
		t.Fatalf("Failed to flip Traefik route: %v", err)
	}

	routeFile := filepath.Join(tmpDir, "bill-api.yaml")
	content, err := os.ReadFile(routeFile)
	if err != nil {
		t.Fatalf("Failed to read generated route file: %v", err)
	}

	str := string(content)
	if !strings.Contains(str, "bill-api-router:") {
		t.Errorf("Expected router definition, got: %s", str)
	}
	if !strings.Contains(str, "Host(`bill.kiwid.io`)") {
		t.Errorf("Expected Host rule, got: %s", str)
	}
	if !strings.Contains(str, "http://127.0.0.1:8082") {
		t.Errorf("Expected target port 8082, got: %s", str)
	}
}

func TestHealthProberSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"status":"ok"}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	prober := NewHealthProber()
	ctx := context.Background()

	err := prober.Probe(ctx, server.URL+"/healthz", 3*time.Second, 100*time.Millisecond)
	if err != nil {
		t.Fatalf("Expected healthcheck probe to pass, got error: %v", err)
	}
}

func TestHealthProberTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable) // 503 error
	}))
	defer server.Close()

	prober := NewHealthProber()
	ctx := context.Background()

	err := prober.Probe(ctx, server.URL+"/healthz", 300*time.Millisecond, 50*time.Millisecond)
	if err == nil {
		t.Fatalf("Expected healthcheck probe to time out and return error, got nil")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Errorf("Expected timeout error message, got: %v", err)
	}
}
