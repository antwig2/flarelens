package main

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/antwig2/flarelens/internal/backup"
	"github.com/antwig2/flarelens/internal/config"
	"github.com/antwig2/flarelens/internal/deploy"
	"github.com/antwig2/flarelens/internal/docker"
	"github.com/antwig2/flarelens/internal/flags"
	"github.com/antwig2/flarelens/internal/heartbeat"
	"github.com/antwig2/flarelens/internal/mesh"
	"github.com/antwig2/flarelens/internal/system"
	"github.com/antwig2/flarelens/internal/transport"
	"github.com/nats-io/nats.go"
)

var (
	Version = "2.1.0"
	Commit  = "none"
	Date    = "unknown"
	BuiltBy = "unknown"
)

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "-version" || os.Args[1] == "-v") {
		fmt.Printf("FlareLens Host Agent v%s (commit: %s, built at: %s, built by: %s)\n", Version, Commit, Date, BuiltBy)
		os.Exit(0)
	}

	// Subcommand: backup (Runs on-demand streaming database backup directly to Cloudflare R2)
	if len(os.Args) > 1 && os.Args[1] == "backup" {
		cfg, err := config.Load(os.Args[2:])
		if err != nil {
			fmt.Fprintf(os.Stderr, "Configuration error: %v\n", err)
			os.Exit(1)
		}
		logger := initLogger(cfg.Telemetry.LogLevel)
		dumper := backup.NewPostgresDumper(
			cfg.Database.Mode,
			cfg.Database.ServiceName,
			cfg.Database.Host,
			cfg.Database.Port,
			cmp.Or(cfg.Database.User, os.Getenv("PGUSER")),
			cmp.Or(cfg.Database.Database, os.Getenv("PGDATABASE")),
		)
		r2Client := backup.NewR2Client(
			cfg.Database.Backup.R2Endpoint,
			cfg.Database.Backup.R2AccessKeyID,
			cfg.Database.Backup.R2SecretAccessKey,
		)
		backupMgr := backup.NewManager(dumper, r2Client, nil, cfg, logger)
		fmt.Printf("Starting zero-disk streaming backup of %s (%s) to Cloudflare R2 (%s)...\n",
			cfg.Database.Database, cfg.Database.ServiceName, cfg.Database.Backup.R2Bucket)
		meta, err := backupMgr.CreateBackup(context.Background(), "manual_cli")
		if err != nil {
			fmt.Fprintf(os.Stderr, "❌ Backup failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("✅ Backup successfully streamed to Cloudflare R2!\n• Key: %s\n• Bucket: %s\n• Timestamp: %s\n",
			meta.Key, meta.Bucket, meta.Timestamp.Format(time.RFC3339))
		os.Exit(0)
	}

	// 1. Load configuration (Precedence: CLI Flags > ENV > Config File > Defaults)
	cfg, err := config.Load(os.Args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			os.Exit(0)
		}
		fmt.Fprintf(os.Stderr, "Configuration error: %v\n", err)
		os.Exit(1)
	}

	// 2. Setup structured logging
	logger := initLogger(cfg.Telemetry.LogLevel)
	slog.SetDefault(logger)

	logger.Info("Starting FlareLens Host Agent",
		"version", Version,
		"node_id", cfg.Identity.NodeID,
		"hostname", cfg.Identity.Hostname,
		"provider", cfg.Identity.Provider,
		"region", cfg.Identity.Region,
		"tags", cfg.Identity.Tags,
		"dev_mode", cfg.DevMode,
	)

	if cfg.ConfigFile != "" {
		logger.Info("Loaded configuration file", "path", cfg.ConfigFile)
	}

	// Protect agent daemon from Linux kernel OOM killer (Section 17.1)
	system.ProtectFromOOM(logger)

	// 3. Initialize host metrics sampler and Docker inspector
	sampler := system.NewSampler()
	inspector := docker.NewInspector(cfg.Docker.Socket)

	// Check initial Docker availability
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := inspector.Ping(ctx); err != nil {
		logger.Warn("Docker daemon not reachable via socket", "socket", cfg.Docker.Socket, "error", err)
	} else {
		logger.Info("Connected to Docker Engine", "socket", cfg.Docker.Socket)
	}

	// 4. Initialize Blue/Green deployment engine
	dockerRunner := deploy.NewDockerRunner(cfg.Docker.Socket)
	healthProber := deploy.NewHealthProber()
	traefikFlipper := deploy.NewTraefikRouteFlipper("/etc/traefik/dynamic")

	// 5. Connect to NATS Event Fabric (Embedded or Client mode)
	natsClient := transport.NewNATSClient(cfg.NATS.URL, cfg.NATS.AuthToken, logger)
	deployOrchestrator := deploy.NewOrchestrator(dockerRunner, healthProber, traefikFlipper, natsClient, cfg.Identity.NodeID, logger)

	// 6. Initialize Database Backup Engine (Zero-Disk Cloudflare R2 streaming)
	dumper := backup.NewPostgresDumper(
		cfg.Database.Mode,
		cfg.Database.ServiceName,
		cfg.Database.Host,
		cfg.Database.Port,
		cmp.Or(cfg.Database.User, os.Getenv("PGUSER")),
		cmp.Or(cfg.Database.Database, os.Getenv("PGDATABASE")),
	)
	r2Client := backup.NewR2Client(
		cfg.Database.Backup.R2Endpoint,
		cfg.Database.Backup.R2AccessKeyID,
		cfg.Database.Backup.R2SecretAccessKey,
	)
	backupMgr := backup.NewManager(dumper, r2Client, natsClient, cfg, logger)

	// Hook pre-deploy database snapshot guardrail into deploy orchestrator
	deployOrchestrator.SetPreDeployHook(func(hookCtx context.Context, tag string) error {
		_, hookErr := backupMgr.CreateBackup(hookCtx, tag)
		return hookErr
	})

	// Hook automated snapshot rollback in case of migration failure
	deployOrchestrator.SetRollbackHook(func(hookCtx context.Context, tag string) error {
		return backupMgr.RestoreLatestMatchingTag(hookCtx, tag, "")
	})

	// Start automated cron scheduler for backups
	backupMgr.StartCron(ctx)

	// 7. Initialize in-memory Feature Flags Store
	flagStore := flags.NewStore(logger)

	// 8. Initialize WireGuard Mesh Engine (Embedded Overlay Network)
	var meshMgr *mesh.Manager
	if cfg.Mesh.Enabled {
		meshPrivKey, meshPubKey, err := mesh.LoadOrGenerateKeypair(cfg.Mesh.KeyPath)
		if err != nil {
			logger.Warn("Failed to load or generate WireGuard keypair", "error", err)
		} else {
			meshCfg := mesh.Config{
				Enabled:        true,
				InterfaceName:  cfg.Mesh.Interface,
				ListenPort:     cfg.Mesh.Port,
				KeyPath:        cfg.Mesh.KeyPath,
				PublicEndpoint: cfg.Mesh.Endpoint,
				Subnet:         "10.42.0.0/16",
			}
			meshMgr = mesh.NewManager(meshCfg, meshPrivKey, meshPubKey, nil, logger)

			// Async registration with Cloudflare Worker Mesh Control Plane
			go func() {
				if cfg.ControlPlane.Endpoint == "" {
					return
				}
				regURL := fmt.Sprintf("%s/api/v1/control/mesh/register", strings.TrimRight(cfg.ControlPlane.Endpoint, "/"))
				payload := map[string]any{
					"node_id":     cfg.Identity.NodeID,
					"name":        cfg.Identity.Hostname,
					"public_key":  meshPubKey,
					"endpoint":    cfg.Mesh.Endpoint,
					"listen_port": cfg.Mesh.Port,
				}
				bodyBytes, _ := json.Marshal(payload)
				req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, regURL, bytes.NewReader(bodyBytes))
				if err != nil {
					return
				}
				req.Header.Set("Content-Type", "application/json")
				if cfg.ControlPlane.EnrollToken != "" {
					req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", cfg.ControlPlane.EnrollToken))
				}
				client := &http.Client{Timeout: 10 * time.Second}
				resp, err := client.Do(req)
				if err != nil {
					logger.Warn("WireGuard mesh control plane registration skipped or failed", "error", err)
					return
				}
				defer resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					var regResp mesh.MeshRegisterResponse
					if err := json.NewDecoder(resp.Body).Decode(&regResp); err == nil {
						logger.Info("Mesh node registered with control plane",
							"overlay_ip", regResp.Peer.OverlayIP,
							"subnet", regResp.Subnet,
							"peers_count", len(regResp.Peers),
						)
						meshCfg.OverlayIP = regResp.Peer.OverlayIP
						meshMgr = mesh.NewManager(meshCfg, meshPrivKey, meshPubKey, nil, logger)
						if err := meshMgr.InitInterface(context.Background()); err != nil {
							logger.Warn("WireGuard interface init warning (requires kernel module & CAP_NET_ADMIN)", "error", err)
						} else {
							_ = meshMgr.SyncPeers(context.Background(), regResp.Peers)
						}
					}
				}
			}()
		}
	}

	if cfg.NATS.Mode == "embedded" || cfg.DevMode {
		embedOpts := transport.EmbeddedOptions{
			DontListen: cfg.DevMode, // In dev mode, run 100% in-process with zero open ports!
			Port:       cfg.NATS.EmbeddedTCPPort,
			WSPort:     cfg.NATS.EmbeddedPort,
			AuthToken:  cfg.NATS.AuthToken,
		}
		if err := natsClient.StartEmbedded(ctx, embedOpts); err != nil {
			logger.Error("Failed to start embedded NATS server", "error", err)
		} else {
			registerCommandListeners(natsClient, deployOrchestrator, backupMgr, flagStore, meshMgr, cfg, logger)
		}
	} else {
		if err := natsClient.Connect(ctx); err != nil {
			logger.Warn("Initial NATS connection failed; will retry in background",
				"url", cfg.NATS.URL,
				"error", err,
			)
		} else {
			registerCommandListeners(natsClient, deployOrchestrator, backupMgr, flagStore, meshMgr, cfg, logger)
		}
	}
	defer natsClient.Close()

	// 5. Initialize telemetry reporter & enroll node
	reporter := heartbeat.NewReporter(cfg, sampler, inspector, natsClient, Version, logger)
	if err := reporter.Enroll(ctx); err != nil {
		logger.Warn("Node enrollment warning", "error", err)
	}

	// 6. Launch background telemetry heartbeat loop (every 15s)
	go reporter.StartHeartbeatLoop(ctx)

	// 7. Handle OS Signals (Graceful shutdown & SIGHUP hot reload on Unix)
	waitForShutdown(cancel, logger, func() {
		if reloaded, err := config.Load(os.Args[1:]); err == nil {
			cfg = reloaded
			logger.Info("Configuration reloaded successfully", "log_level", cfg.Telemetry.LogLevel)
		} else {
			logger.Error("Failed to reload configuration", "error", err)
		}
	})
}

func initLogger(levelStr string) *slog.Logger {
	var level slog.Level
	switch strings.ToLower(levelStr) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}

	handler := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: level,
	})
	return slog.New(handler)
}

func registerCommandListeners(
	nc *transport.NATSClient,
	orchestrator *deploy.Orchestrator,
	backupMgr *backup.Manager,
	flagStore *flags.Store,
	meshMgr *mesh.Manager,
	cfg *config.Config,
	logger *slog.Logger,
) {
	nodeID := cfg.Identity.NodeID

	// 1. Target node reboot command
	rebootSubj := fmt.Sprintf("kiwid.node.%s.reboot", nodeID)
	_, _ = nc.Subscribe(rebootSubj, func(msg *nats.Msg) {
		logger.Warn("Received remote reboot command via NATS", "subject", msg.Subject)
		go func() {
			logger.Warn("Initiating coordinated host reboot sequence (15s connection drain window)...")
			time.Sleep(15 * time.Second)
			logger.Warn("Executing system reboot now")
			executeSystemReboot(logger)
		}()
	})

	// 2. Target node dynamic config update (OTA Hot Reload)
	configSubj := fmt.Sprintf("kiwid.node.%s.config.update", nodeID)
	_, _ = nc.Subscribe(configSubj, func(msg *nats.Msg) {
		logger.Info("Received OTA dynamic configuration update via NATS", "subject", msg.Subject)
	})

	// 3. Fleet-wide feature flag updates (Sub-50ms instant broadcast)
	flagSubj := "kiwid.fleet.all.flags"
	_, _ = nc.Subscribe(flagSubj, func(msg *nats.Msg) {
		logger.Debug("Received fleet feature flag broadcast", "subject", msg.Subject)
		_ = flagStore.UpdateFromJSON(msg.Data)
	})

	// 4. GitOps & Zero-Downtime Blue/Green Deploy Trigger (Single Node & Fleet Multi-Node Rollout)
	handleDeploy := func(msg *nats.Msg) {
		var req deploy.DeployRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			logger.Error("Malformed deploy request payload", "error", err)
			return
		}

		// Filter if targeted
		if req.NodeID != "" && req.NodeID != "all" && req.NodeID != "all-prod" && req.NodeID != nodeID {
			return
		}

		logger.Info("Received deploy command via NATS",
			"service", req.Service,
			"image", req.Image,
			"deployment_id", req.DeploymentID,
			"subject", msg.Subject,
		)

		// Execute Blue/Green rollout asynchronously
		go func(r deploy.DeployRequest, replySubject string) {
			resp := orchestrator.Deploy(context.Background(), r)

			statusSubj := fmt.Sprintf("kiwid.node.%s.deploy.status", nodeID)
			_ = nc.PublishJSON(statusSubj, resp)

			if replySubject != "" {
				_ = nc.PublishJSON(replySubject, resp)
			}

			// Report deployment outcome to Cloudflare Worker Control Plane
			if cfg.ControlPlane.Endpoint != "" {
				reportHTTPStatus(
					fmt.Sprintf("%s/api/v1/control/deploy/status", cfg.ControlPlane.Endpoint),
					cfg.ControlPlane.EnrollToken,
					map[string]any{
						"deployment_id": resp.DeploymentID,
						"service":       resp.Service,
						"status":        resp.Status,
						"active_slot":   resp.ActiveSlot,
						"active_port":   resp.ActivePort,
						"message":       resp.Message,
						"duration_ms":   resp.DurationMS,
					},
					logger,
				)
			}
		}(req, msg.Reply)
	}

	deploySubj := fmt.Sprintf("kiwid.node.%s.deploy", nodeID)
	_, _ = nc.Subscribe(deploySubj, handleDeploy)
	_, _ = nc.Subscribe("kiwid.fleet.all.deploy", handleDeploy)
	_, _ = nc.Subscribe("kiwid.fleet.prod.deploy", handleDeploy)

	// 5. On-Demand Database Backup Trigger
	backupSubj := fmt.Sprintf("kiwid.node.%s.backup", nodeID)
	_, _ = nc.Subscribe(backupSubj, func(msg *nats.Msg) {
		var req backup.BackupTriggerRequest
		_ = json.Unmarshal(msg.Data, &req)

		logger.Info("Received on-demand database backup request via NATS", "tag", req.Tag)

		go func(tag string, replySubject string) {
			meta, err := backupMgr.CreateBackup(context.Background(), tag)
			statusSubj := fmt.Sprintf("kiwid.node.%s.backup.status", nodeID)
			if err != nil {
				_ = nc.PublishJSON(statusSubj, map[string]any{"status": "failed", "error": err.Error(), "tag": tag})
				if replySubject != "" {
					_ = nc.PublishJSON(replySubject, map[string]any{"status": "failed", "error": err.Error()})
				}
				return
			}
			_ = nc.PublishJSON(statusSubj, map[string]any{"status": "success", "metadata": meta})
			if replySubject != "" {
				_ = nc.PublishJSON(replySubject, map[string]any{"status": "success", "metadata": meta})
			}
		}(req.Tag, msg.Reply)
	})

	// 6. Database Restore Trigger
	restoreSubj := fmt.Sprintf("kiwid.node.%s.backup.restore", nodeID)
	_, _ = nc.Subscribe(restoreSubj, func(msg *nats.Msg) {
		var req backup.RestoreTriggerRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			logger.Error("Malformed restore request payload", "error", err)
			return
		}

		logger.Info("Received database restore request via NATS", "key", req.Key, "target_db", req.TargetDB)

		go func(r backup.RestoreTriggerRequest, replySubject string) {
			err := backupMgr.RestoreBackup(context.Background(), r.Key, r.TargetDB)
			statusSubj := fmt.Sprintf("kiwid.node.%s.backup.restore.status", nodeID)
			restoreStatus := "completed"
			errMsg := ""
			if err != nil {
				restoreStatus = "failed"
				errMsg = err.Error()
				_ = nc.PublishJSON(statusSubj, map[string]any{"status": "failed", "error": err.Error(), "key": r.Key})
				if replySubject != "" {
					_ = nc.PublishJSON(replySubject, map[string]any{"status": "failed", "error": err.Error()})
				}
			} else {
				_ = nc.PublishJSON(statusSubj, map[string]any{"status": "success", "key": r.Key, "target_db": r.TargetDB})
				if replySubject != "" {
					_ = nc.PublishJSON(replySubject, map[string]any{"status": "success", "key": r.Key})
				}
			}

			// Report restore status to Cloudflare Worker Control Plane
			if cfg.ControlPlane.Endpoint != "" {
				reportHTTPStatus(
					fmt.Sprintf("%s/api/v1/control/backup/status", cfg.ControlPlane.Endpoint),
					cfg.ControlPlane.EnrollToken,
					map[string]any{
						"node_id": nodeID,
						"key":     r.Key,
						"status":  restoreStatus,
						"error":   errMsg,
					},
					logger,
				)
			}
		}(req, msg.Reply)
	})

	// 7. Backup Listing Query
	listSubj := fmt.Sprintf("kiwid.node.%s.backup.list", nodeID)
	_, _ = nc.Subscribe(listSubj, func(msg *nats.Msg) {
		if msg.Reply == "" {
			return
		}
		go func(replySubject string) {
			objs, err := backupMgr.ListBackups(context.Background())
			if err != nil {
				_ = nc.PublishJSON(replySubject, map[string]any{"error": err.Error()})
				return
			}
			_ = nc.PublishJSON(replySubject, map[string]any{"backups": objs, "count": len(objs)})
		}(msg.Reply)
	})

	// 8. Ephemeral PR Preview Teardown Trigger
	handleTeardown := func(msg *nats.Msg) {
		var req deploy.TeardownRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			logger.Error("Malformed teardown request payload", "error", err)
			return
		}

		if req.NodeID != "" && req.NodeID != "all" && req.NodeID != nodeID {
			return
		}

		logger.Info("Received PR preview teardown command via NATS",
			"service", req.Service,
			"pr_number", req.PRNumber,
			"subject", msg.Subject,
		)

		go func(r deploy.TeardownRequest, replySubject string) {
			err := orchestrator.TeardownPreview(context.Background(), r)
			statusSubj := fmt.Sprintf("kiwid.node.%s.preview.teardown.status", nodeID)
			statusPayload := map[string]any{
				"service":   r.Service,
				"pr_number": r.PRNumber,
				"status":    "destroyed",
			}
			if err != nil {
				statusPayload["status"] = "failed"
				statusPayload["error"] = err.Error()
			}
			_ = nc.PublishJSON(statusSubj, statusPayload)
			if replySubject != "" {
				_ = nc.PublishJSON(replySubject, statusPayload)
			}
		}(req, msg.Reply)
	}

	teardownSubj := fmt.Sprintf("kiwid.node.%s.preview.teardown", nodeID)
	_, _ = nc.Subscribe(teardownSubj, handleTeardown)
	_, _ = nc.Subscribe("kiwid.fleet.all.preview.teardown", handleTeardown)

	// 9. Dynamic WireGuard Mesh Peer Sync
	if meshMgr != nil {
		syncHandler := func(msg *nats.Msg) {
			var peers []mesh.Peer
			if err := json.Unmarshal(msg.Data, &peers); err == nil && len(peers) > 0 {
				logger.Info("Received dynamic mesh peer broadcast via NATS", "peers_count", len(peers))
				if err := meshMgr.SyncPeers(context.Background(), peers); err != nil {
					logger.Warn("Failed to sync WireGuard mesh peers", "error", err)
				}
			}
		}
		_, _ = nc.Subscribe("flarelens.fleet.all.mesh.peers", syncHandler)
		_, _ = nc.Subscribe("kiwid.fleet.all.mesh.peers", syncHandler)
		nodeMeshSubj := fmt.Sprintf("flarelens.node.%s.mesh.sync", nodeID)
		_, _ = nc.Subscribe(nodeMeshSubj, syncHandler)
	}

	logger.Info("NATS command listeners registered",
		"reboot_subject", rebootSubj,
		"config_subject", configSubj,
		"flag_subject", flagSubj,
		"deploy_subject", deploySubj,
		"backup_subject", backupSubj,
		"restore_subject", restoreSubj,
		"list_subject", listSubj,
		"teardown_subject", teardownSubj,
	)
}

func reportHTTPStatus(url string, token string, payload any, logger *slog.Logger) {
	if url == "" {
		return
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	go func() {
		client := &http.Client{Timeout: 10 * time.Second}
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", token))
		}
		resp, err := client.Do(req)
		if err != nil {
			logger.Warn("Failed to report HTTP status to control plane", "url", url, "error", err)
			return
		}
		_ = resp.Body.Close()
	}()
}
