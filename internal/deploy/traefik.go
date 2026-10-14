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

// SetCanaryRoute sets up Traefik weighted round-robin splitting between active and candidate ports
func (t *TraefikRouteFlipper) SetCanaryRoute(service, domain string, activePort, candidatePort int, candidateWeight int) error {
	if candidateWeight <= 0 {
		return t.FlipRoute(service, domain, activePort)
	}
	if candidateWeight >= 100 {
		return t.FlipRoute(service, domain, candidatePort)
	}

	activeWeight := 100 - candidateWeight

	if err := os.MkdirAll(t.dynamicDir, 0755); err != nil {
		return fmt.Errorf("failed to create traefik dynamic config directory: %w", err)
	}

	content := fmt.Sprintf(`http:
  routers:
    %s-router:
      rule: "Host(%s)"
      service: "%s-wrr"
      entryPoints:
        - "websecure"
  services:
    %s-wrr:
      weighted:
        services:
          - name: "%s-active"
            weight: %d
          - name: "%s-candidate"
            weight: %d
    %s-active:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:%d"
    %s-candidate:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:%d"
`, service, fmt.Sprintf("`%s`", domain), service, service, service, activeWeight, service, candidateWeight, service, activePort, service, candidatePort)

	finalPath := filepath.Join(t.dynamicDir, fmt.Sprintf("%s.yaml", service))
	tmpPath := filepath.Join(t.dynamicDir, fmt.Sprintf("%s.yaml.tmp", service))

	if err := os.WriteFile(tmpPath, []byte(content), 0644); err != nil {
		return fmt.Errorf("failed to write temporary traefik canary route file: %w", err)
	}

	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to atomically rename traefik canary route: %w", err)
	}

	return nil
}

// RemoveRoute removes the dynamic Traefik route file for an ephemeral preview or retired service
func (t *TraefikRouteFlipper) RemoveRoute(service string) error {
	path := filepath.Join(t.dynamicDir, fmt.Sprintf("%s.yaml", service))
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove traefik route file: %w", err)
	}
	return nil
}
