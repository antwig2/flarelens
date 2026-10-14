package deploy

import (
	"fmt"
	"os"
	"path/filepath"
)

// TraefikRouteFlipper updates Traefik's dynamic file provider routing atomically
type TraefikRouteFlipper struct {
	dynamicDir string
}

func NewTraefikRouteFlipper(dynamicDir string) *TraefikRouteFlipper {
	if dynamicDir == "" {
		dynamicDir = "/etc/traefik/dynamic"
	}
	return &TraefikRouteFlipper{
		dynamicDir: dynamicDir,
	}
}

// FlipRoute atomically points Traefik domain traffic to the target port
func (t *TraefikRouteFlipper) FlipRoute(service, domain string, targetPort int) error {
	if err := os.MkdirAll(t.dynamicDir, 0755); err != nil {
		return fmt.Errorf("failed to create traefik dynamic config directory: %w", err)
	}

	content := fmt.Sprintf(`http:
  routers:
    %s-router:
      rule: "Host(%s)"
      service: "%s-svc"
      entryPoints:
        - "websecure"
  services:
    %s-svc:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:%d"
`, service, fmt.Sprintf("`%s`", domain), service, service, targetPort)

	finalPath := filepath.Join(t.dynamicDir, fmt.Sprintf("%s.yaml", service))
	tmpPath := filepath.Join(t.dynamicDir, fmt.Sprintf("%s.yaml.tmp", service))

	// Write to temporary file first
	if err := os.WriteFile(tmpPath, []byte(content), 0644); err != nil {
		return fmt.Errorf("failed to write temporary traefik route file: %w", err)
	}

	// Atomic rename ensures Traefik inotify picks up complete valid YAML instantly
	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to atomically rename traefik route: %w", err)
	}

	return nil
}
