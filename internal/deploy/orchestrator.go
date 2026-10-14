package deploy

import (
	"cmp"
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/antwig2/flarelens/internal/transport"
)

// PreDeploySnapshotHook defines a callback executed before candidate container staging
type PreDeploySnapshotHook func(ctx context.Context, tag string) error

// Orchestrator executes zero-downtime Blue/Green deployments with automated rollback
type Orchestrator struct {
	runner        *DockerRunner
	prober        *HealthProber
	traefik       *TraefikRouteFlipper
	natsClient    *transport.NATSClient
	logger        *slog.Logger
	preDeployHook PreDeploySnapshotHook

	mu          sync.RWMutex
	activeSlots map[string]Slot
	nodeID      string
}

func NewOrchestrator(
	runner *DockerRunner,
	prober *HealthProber,
	traefik *TraefikRouteFlipper,
	natsClient *transport.NATSClient,
	nodeID string,
	logger *slog.Logger,
) *Orchestrator {
	if logger == nil {
		logger = slog.Default()
	}
	return &Orchestrator{
		runner:      runner,
		prober:      prober,
		traefik:     traefik,
		natsClient:  natsClient,
		logger:      logger,
		activeSlots: make(map[string]Slot),
		nodeID:      nodeID,
	}
}

// SetPreDeployHook registers a pre-deploy backup guardrail hook
func (o *Orchestrator) SetPreDeployHook(hook PreDeploySnapshotHook) {
	o.preDeployHook = hook
}

// Deploy executes the complete 7-step zero-downtime Blue/Green deployment sequence
func (o *Orchestrator) Deploy(ctx context.Context, req DeployRequest) DeployResponse {
	startTime := time.Now()

	o.logger.Info("Starting Blue/Green deployment",
		"service", req.Service,
		"image", req.Image,
		"env", req.Env,
		"domain", req.Domain,
		"pre_deploy_snapshot", req.PreDeploySnapshot,
	)

	// 0. Pre-Deploy Guardrail: Database Snapshot (if requested)
	if req.PreDeploySnapshot && o.preDeployHook != nil {
		o.emitProgress(req, "backup", "Executing pre-deploy database snapshot guardrail...", 5)
		snapshotTag := fmt.Sprintf("pre-deploy-%s", req.Service)
		if err := o.preDeployHook(ctx, snapshotTag); err != nil {
			o.logger.Error("Pre-deploy database snapshot failed! Aborting deployment", "error", err)
			return o.failResponse(req, "Pre-deploy snapshot guardrail failed: "+err.Error(), SlotBlue, startTime)
		}
		o.emitProgress(req, "backup", "Pre-deploy database snapshot verified and stored in Cloudflare R2", 10)
	}

	// 1. Identify active slot and target candidate slot
	o.mu.Lock()
	currentSlot, exists := o.activeSlots[req.Service]
	if !exists {
		// Detect by container presence
		if id, _ := o.runner.FindContainerIDByName(ctx, fmt.Sprintf("%s-green", req.Service)); id != "" {
			currentSlot = SlotGreen
		} else {
			currentSlot = SlotBlue
		}
	}
	candidateSlot := currentSlot.Invert()
	o.mu.Unlock()

	// Determine host ports for slots
	portBlue := cmp.Or(req.HostPortBlue, req.ContainerPort+1)
	portGreen := cmp.Or(req.HostPortGreen, req.ContainerPort+2)

	candidatePort := portGreen
	if candidateSlot == SlotBlue {
		candidatePort = portBlue
	}

	candidateName := fmt.Sprintf("%s-%s", req.Service, candidateSlot)
	prevName := fmt.Sprintf("%s-%s", req.Service, currentSlot)

	o.emitProgress(req, "pulling", fmt.Sprintf("Pulling candidate image: %s", req.Image), 15)

	// 2. Pull candidate container image
	if err := o.runner.PullImage(ctx, req.Image); err != nil {
		o.logger.Error("Deploy failed during image pull", "error", err)
		return o.failResponse(req, "Image pull failed: "+err.Error(), currentSlot, startTime)
	}

	o.emitProgress(req, "starting", fmt.Sprintf("Staging candidate container: %s on port %d", candidateName, candidatePort), 40)

	// 3. Remove stale candidate container if one was lingering from previous failed run
	if oldID, _ := o.runner.FindContainerIDByName(ctx, candidateName); oldID != "" {
		_ = o.runner.RemoveContainer(ctx, oldID)
	}

	// 4. Inject in-memory secrets directly into container environment (zero disk write!)
	envList := make([]string, 0, len(req.Secrets)+3)
	envList = append(envList,
		fmt.Sprintf("DEPLOY_ENV=%s", cmp.Or(req.Env, "production")),
		fmt.Sprintf("DEPLOY_SLOT=%s", candidateSlot),
		fmt.Sprintf("SERVICE_NAME=%s", req.Service),
	)
	for k, v := range req.Secrets {
		envList = append(envList, fmt.Sprintf("%s=%s", k, v))
	}

	network := cmp.Or(req.Network, "kiwid-edge")
	containerID, err := o.runner.CreateContainer(
		ctx,
		candidateName,
		req.Image,
		envList,
		candidatePort,
		req.ContainerPort,
		network,
		map[string]string{
			"kiwid.service": req.Service,
			"kiwid.slot":    string(candidateSlot),
		},
	)
	if err != nil {
		o.logger.Error("Failed to create candidate container", "error", err)
		return o.failResponse(req, "Container creation failed: "+err.Error(), currentSlot, startTime)
	}

	if err := o.runner.StartContainer(ctx, containerID); err != nil {
		_ = o.runner.RemoveContainer(ctx, containerID)
		o.logger.Error("Failed to start candidate container", "error", err)
		return o.failResponse(req, "Container start failed: "+err.Error(), currentSlot, startTime)
	}

	// 5. Healthcheck Probe (Guardrail)
	healthPath := cmp.Or(req.HealthPath, "/healthz")
	probeURL := fmt.Sprintf("http://127.0.0.1:%d%s", candidatePort, healthPath)
	timeout := time.Duration(cmp.Or(req.TimeoutSeconds, 30)) * time.Second

	o.emitProgress(req, "probing", fmt.Sprintf("Probing candidate health at %s (timeout: %s)", probeURL, timeout), 65)

	if err := o.prober.Probe(ctx, probeURL, timeout, 1*time.Second); err != nil {
		// ROLLBACK PATH: Candidate failed health checks!
		o.logger.Warn("Candidate failed health checks! Triggering automatic rollback",
			"candidate", candidateName,
			"error", err,
		)
		o.emitProgress(req, "failed", "Candidate failed healthcheck. Rolling back...", 80)

		// Destroy the unhealthy candidate container
		_ = o.runner.StopContainer(ctx, containerID, 2)
		_ = o.runner.RemoveContainer(ctx, containerID)

		o.emitProgress(req, "failed", fmt.Sprintf("Rolled back. Live traffic remains 100%% on slot: %s", currentSlot), 100)

		return DeployResponse{
			DeploymentID: req.DeploymentID,
			Service:      req.Service,
			Status:       "rolled_back",
			ActiveSlot:   string(currentSlot),
			ActivePort:   o.portForSlot(currentSlot, portBlue, portGreen),
			Message:      fmt.Sprintf("Candidate failed healthcheck: %v. Rolled back to %s.", err, currentSlot),
			DurationMS:   time.Since(startTime).Milliseconds(),
		}
	}

	// 6. SUCCESS PATH: Atomic Traffic Route Switch
	o.emitProgress(req, "flipping", fmt.Sprintf("Candidate healthy! Atomically flipping route %s to %s (port %d)", req.Domain, candidateSlot, candidatePort), 85)

	if req.Domain != "" {
		if err := o.traefik.FlipRoute(req.Service, req.Domain, candidatePort); err != nil {
			o.logger.Error("Failed to flip Traefik route", "error", err)
			// Destroy candidate and rollback
			_ = o.runner.StopContainer(ctx, containerID, 2)
			_ = o.runner.RemoveContainer(ctx, containerID)
			return o.failResponse(req, "Traefik route flip failed: "+err.Error(), currentSlot, startTime)
		}
	}

	// Update active slot
	o.mu.Lock()
	o.activeSlots[req.Service] = candidateSlot
	o.mu.Unlock()

	// 7. Drain and stop old slot
	drainSec := cmp.Or(req.DrainSeconds, 15)
	o.emitProgress(req, "draining", fmt.Sprintf("Draining previous slot %s for %d seconds...", currentSlot, drainSec), 90)

	go func(prevContainerName string, drainTime time.Duration) {
		time.Sleep(drainTime)
		drainCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		if prevID, _ := o.runner.FindContainerIDByName(drainCtx, prevContainerName); prevID != "" {
			_ = o.runner.StopContainer(drainCtx, prevID, 10)
			o.logger.Info("Previous deployment slot stopped after drain period", "container", prevContainerName)
		}
	}(prevName, time.Duration(drainSec)*time.Second)

	o.emitProgress(req, "completed", fmt.Sprintf("Deployment succeeded! Active slot is now %s on port %d", candidateSlot, candidatePort), 100)

	return DeployResponse{
		DeploymentID: req.DeploymentID,
		Service:      req.Service,
		Status:       "success",
		ActiveSlot:   string(candidateSlot),
		ActivePort:   candidatePort,
		Message:      fmt.Sprintf("Successfully deployed %s to slot %s", req.Service, candidateSlot),
		DurationMS:   time.Since(startTime).Milliseconds(),
	}
}

func (o *Orchestrator) portForSlot(s Slot, portBlue, portGreen int) int {
	if s == SlotBlue {
		return portBlue
	}
	return portGreen
}

func (o *Orchestrator) failResponse(req DeployRequest, msg string, currentSlot Slot, startTime time.Time) DeployResponse {
	return DeployResponse{
		DeploymentID: req.DeploymentID,
		Service:      req.Service,
		Status:       "failed",
		ActiveSlot:   string(currentSlot),
		Message:      msg,
		DurationMS:   time.Since(startTime).Milliseconds(),
	}
}

func (o *Orchestrator) emitProgress(req DeployRequest, stage, message string, percent int) {
	progress := DeployProgress{
		DeploymentID: req.DeploymentID,
		Service:      req.Service,
		Stage:        stage,
		Message:      message,
		Percent:      percent,
		Timestamp:    time.Now().UTC(),
	}

	o.logger.Info("Deploy progress",
		"service", req.Service,
		"stage", stage,
		"percent", percent,
		"message", message,
	)

	if o.natsClient != nil && o.natsClient.IsConnected() {
		subject := fmt.Sprintf("kiwid.node.%s.deploy.progress", o.nodeID)
		_ = o.natsClient.PublishJSON(subject, progress)
	}
}
