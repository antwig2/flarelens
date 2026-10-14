package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/antwig2/flarelens/internal/config"
	"github.com/antwig2/flarelens/internal/docker"
	"github.com/antwig2/flarelens/internal/heartbeat"
	"github.com/antwig2/flarelens/internal/system"
	"github.com/antwig2/flarelens/internal/transport"
	"github.com/nats-io/nats.go"
)

const Version = "2.1.0"

func main() {
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

	// 4. Connect to NATS Event Fabric (Embedded or Client mode)
	natsClient := transport.NewNATSClient(cfg.NATS.URL, cfg.NATS.AuthToken, logger)
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
			registerCommandListeners(natsClient, cfg, logger)
		}
	} else {
		if err := natsClient.Connect(ctx); err != nil {
			logger.Warn("Initial NATS connection failed; will retry in background",
				"url", cfg.NATS.URL,
				"error", err,
			)
		} else {
			registerCommandListeners(natsClient, cfg, logger)
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

	// 7. Handle OS Signals (Graceful shutdown & SIGHUP hot reload)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)

	for {
		sig := <-sigChan
		switch sig {
		case syscall.SIGHUP:
			logger.Info("Received SIGHUP, reloading configuration...")
			if reloaded, err := config.Load(os.Args[1:]); err == nil {
				cfg = reloaded
				logger.Info("Configuration reloaded successfully", "log_level", cfg.Telemetry.LogLevel)
			} else {
				logger.Error("Failed to reload configuration", "error", err)
			}

		case syscall.SIGINT, syscall.SIGTERM:
			logger.Info("Received shutdown signal, terminating gracefully...", "signal", sig.String())
			cancel()
			// Brief grace period for active streams to flush
			time.Sleep(500 * time.Millisecond)
			logger.Info("FlareLens Agent stopped")
			return
		}
	}
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

func registerCommandListeners(nc *transport.NATSClient, cfg *config.Config, logger *slog.Logger) {
	nodeID := cfg.Identity.NodeID

	// 1. Target node reboot command
	rebootSubj := fmt.Sprintf("kiwid.node.%s.reboot", nodeID)
	_, _ = nc.Subscribe(rebootSubj, func(msg *nats.Msg) {
		logger.Warn("Received remote reboot command via NATS", "subject", msg.Subject)
		// Coordination logic handled in Phase 6
	})

	// 2. Target node dynamic config update (OTA Hot Reload)
	configSubj := fmt.Sprintf("kiwid.node.%s.config.update", nodeID)
	_, _ = nc.Subscribe(configSubj, func(msg *nats.Msg) {
		logger.Info("Received OTA dynamic configuration update via NATS", "subject", msg.Subject)
	})

	// 3. Fleet-wide feature flag updates
	flagSubj := "kiwid.fleet.all.flags"
	_, _ = nc.Subscribe(flagSubj, func(msg *nats.Msg) {
		logger.Debug("Received fleet feature flag broadcast", "subject", msg.Subject)
	})

	logger.Info("NATS command listeners registered",
		"reboot_subject", rebootSubj,
		"config_subject", configSubj,
		"flag_subject", flagSubj,
	)
}
