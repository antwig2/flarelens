package deploy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DockerRunner manages programmatic Docker container lifecycles via Unix domain socket
type DockerRunner struct {
	client *http.Client
	socket string
}

func NewDockerRunner(socketPath string) *DockerRunner {
	cleanPath := strings.TrimPrefix(socketPath, "unix://")

	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", cleanPath)
		},
	}

	return &DockerRunner{
		client: &http.Client{
			Transport: transport,
			Timeout:   120 * time.Second, // Long timeout for large image pulls
		},
		socket: cleanPath,
	}
}

// PullImage pulls candidate container image from registry
func (r *DockerRunner) PullImage(ctx context.Context, image string) error {
	if strings.HasPrefix(r.socket, "mock") {
		return nil
	}
	u := fmt.Sprintf("http://localhost/images/create?fromImage=%s", url.QueryEscape(image))
	req, err := http.NewRequestWithContext(ctx, "POST", u, nil)
	if err != nil {
		return err
	}

	resp, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to pull image %s: %w", image, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("docker pull returned status %d: %s", resp.StatusCode, string(body))
	}

	// Drain output stream to wait for pull completion
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

type containerCreateConfig struct {
	Image        string                         `json:"Image"`
	Env          []string                       `json:"Env"`
	Labels       map[string]string              `json:"Labels,omitempty"`
	ExposedPorts map[string]struct{}            `json:"ExposedPorts,omitempty"`
	HostConfig   containerHostConfig            `json:"HostConfig"`
}

type containerHostConfig struct {
	PortBindings  map[string][]portBindingEntry `json:"PortBindings,omitempty"`
	NetworkMode   string                        `json:"NetworkMode,omitempty"`
	OomScoreAdj   int                           `json:"OomScoreAdj"`
	RestartPolicy restartPolicy                 `json:"RestartPolicy"`
}

func determineOomScore(serviceName string) int {
	lower := strings.ToLower(serviceName)
	if strings.Contains(lower, "postgres") || strings.Contains(lower, "db") {
		return -900
	}
	if strings.Contains(lower, "redis") || strings.Contains(lower, "dragonfly") {
		return -800
	}
	if strings.Contains(lower, "worker") || strings.Contains(lower, "cron") {
		return 500
	}
	return 0
}

type portBindingEntry struct {
	HostPort string `json:"HostPort"`
}

type restartPolicy struct {
	Name string `json:"Name"`
}

// CreateContainer creates a container with in-memory secrets and port bindings
func (r *DockerRunner) CreateContainer(
	ctx context.Context,
	name string,
	image string,
	envVars []string,
	hostPort, containerPort int,
	network string,
	labels map[string]string,
) (string, error) {
	portKey := fmt.Sprintf("%d/tcp", containerPort)

	cfg := containerCreateConfig{
		Image:  image,
		Env:    envVars,
		Labels: labels,
		ExposedPorts: map[string]struct{}{
			portKey: {},
		},
		HostConfig: containerHostConfig{
			PortBindings: map[string][]portBindingEntry{
				portKey: {
					{HostPort: fmt.Sprintf("%d", hostPort)},
				},
			},
			NetworkMode: network,
			OomScoreAdj: determineOomScore(name),
			RestartPolicy: restartPolicy{
				Name: "always",
			},
		},
	}

	bodyBytes, err := json.Marshal(cfg)
	if err != nil {
		return "", err
	}

	u := fmt.Sprintf("http://localhost/containers/create?name=%s", url.QueryEscape(name))
	req, err := http.NewRequestWithContext(ctx, "POST", u, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("container create request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("container create returned status %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		ID string `json:"Id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}

	return result.ID, nil
}

// StartContainer launches the created container
func (r *DockerRunner) StartContainer(ctx context.Context, containerID string) error {
	u := fmt.Sprintf("http://localhost/containers/%s/start", containerID)
	req, err := http.NewRequestWithContext(ctx, "POST", u, nil)
	if err != nil {
		return err
	}

	resp, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("container start failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotModified {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("container start returned status %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// StopContainer stops a container with graceful drain timeout
func (r *DockerRunner) StopContainer(ctx context.Context, containerID string, timeoutSec int) error {
	if timeoutSec <= 0 {
		timeoutSec = 10
	}
	u := fmt.Sprintf("http://localhost/containers/%s/stop?t=%d", containerID, timeoutSec)
	req, err := http.NewRequestWithContext(ctx, "POST", u, nil)
	if err != nil {
		return err
	}

	resp, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("container stop failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotModified {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("container stop returned status %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// RemoveContainer force removes a stopped or failed container
func (r *DockerRunner) RemoveContainer(ctx context.Context, containerID string) error {
	u := fmt.Sprintf("http://localhost/containers/%s?v=true&force=true", containerID)
	req, err := http.NewRequestWithContext(ctx, "DELETE", u, nil)
	if err != nil {
		return err
	}

	resp, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("container remove failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("container remove returned status %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// FindContainerIDByName looks up an existing container ID by name
func (r *DockerRunner) FindContainerIDByName(ctx context.Context, name string) (string, error) {
	if strings.HasPrefix(r.socket, "mock") {
		return "", nil
	}
	u := fmt.Sprintf("http://localhost/containers/%s/json", url.PathEscape(name))
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return "", err
	}

	resp, err := r.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return "", nil // Not found
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("inspect container status %d", resp.StatusCode)
	}

	var data struct {
		ID string `json:"Id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", err
	}

	return data.ID, nil
}
