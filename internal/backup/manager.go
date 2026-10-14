package backup

import (
	"cmp"
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/antwig2/flarelens/internal/config"
	"github.com/antwig2/flarelens/internal/transport"
)

// BackupMetadata describes an uploaded database snapshot
type BackupMetadata struct {
	Key       string    `json:"key"`
	Bucket    string    `json:"bucket"`
	Timestamp time.Time `json:"timestamp"`
	Tag       string    `json:"tag"`
	NodeID    string    `json:"node_id"`
	Service   string    `json:"service"`
}

// BackupTriggerRequest represents on-demand backup trigger payload
type BackupTriggerRequest struct {
	Tag string `json:"tag"`
}

// RestoreTriggerRequest represents database restore payload
type RestoreTriggerRequest struct {
	Key      string `json:"key"`
	TargetDB string `json:"target_db"`
}

// Manager coordinates zero-disk database backups to Cloudflare R2 and automated cron schedules
type Manager struct {
	dumper     *PostgresDumper
	r2Client   *R2Client
	natsClient *transport.NATSClient
	cfg        *config.Config
	logger     *slog.Logger
	mu         sync.Mutex
}

func NewManager(
	dumper *PostgresDumper,
	r2Client *R2Client,
	natsClient *transport.NATSClient,
	cfg *config.Config,
	logger *slog.Logger,
) *Manager {
	if logger == nil {
		logger = slog.Default()
	}
	return &Manager{
		dumper:     dumper,
		r2Client:   r2Client,
		natsClient: natsClient,
		cfg:        cfg,
		logger:     logger,
	}
}

// CreateBackup streams a pg_dump to Cloudflare R2
func (m *Manager) CreateBackup(ctx context.Context, tag string) (*BackupMetadata, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	bucket := m.cfg.Database.Backup.R2Bucket
	if bucket == "" {
		bucket = "kiwid-backups"
	}

	prefix := cmp.Or(m.cfg.Database.Backup.Prefix, "postgres/prod")
	now := time.Now().UTC()
	safeTag := cmp.Or(tag, "scheduled")

	key := fmt.Sprintf("%s/%s_%s.sql.gz", prefix, now.Format("20060102-150405"), safeTag)

	m.logger.Info("Starting zero-disk streaming backup to Cloudflare R2",
		"bucket", bucket,
		"key", key,
		"tag", safeTag,
	)

	stream, err := m.dumper.StreamDump(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to initiate pg_dump stream: %w", err)
	}
	defer stream.Close()

	if err := m.r2Client.PutObject(ctx, bucket, key, stream, -1, "application/gzip"); err != nil {
		m.logger.Error("Failed to upload database snapshot to R2", "error", err)
		return nil, err
	}

	meta := &BackupMetadata{
		Key:       key,
		Bucket:    bucket,
		Timestamp: now,
		Tag:       safeTag,
		NodeID:    m.cfg.Identity.NodeID,
		Service:   m.cfg.Database.ServiceName,
	}

	m.logger.Info("Database snapshot uploaded successfully to Cloudflare R2",
		"key", key,
		"bucket", bucket,
	)

	// Broadcast backup completion event via NATS
	if m.natsClient != nil && m.natsClient.IsConnected() {
		subject := fmt.Sprintf("kiwid.node.%s.backup.completed", m.cfg.Identity.NodeID)
		_ = m.natsClient.PublishJSON(subject, meta)
	}

	return meta, nil
}

// RestoreBackup streams a snapshot from R2 and applies it to target database
func (m *Manager) RestoreBackup(ctx context.Context, key, targetDB string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	bucket := cmp.Or(m.cfg.Database.Backup.R2Bucket, "kiwid-backups")

	m.logger.Info("Starting database restore from Cloudflare R2",
		"bucket", bucket,
		"key", key,
		"target_db", targetDB,
	)

	stream, err := m.r2Client.GetObject(ctx, bucket, key)
	if err != nil {
		return fmt.Errorf("failed to fetch snapshot from R2: %w", err)
	}
	defer stream.Close()

	if err := m.dumper.Restore(ctx, stream, targetDB); err != nil {
		return fmt.Errorf("failed to restore snapshot into database: %w", err)
	}

	m.logger.Info("Database restored successfully from R2 snapshot", "key", key)
	return nil
}

// ListBackups lists available R2 database snapshots
func (m *Manager) ListBackups(ctx context.Context) ([]S3Object, error) {
	bucket := cmp.Or(m.cfg.Database.Backup.R2Bucket, "kiwid-backups")
	prefix := cmp.Or(m.cfg.Database.Backup.Prefix, "postgres/")

	return m.r2Client.ListObjects(ctx, bucket, prefix)
}

// StartCron launches periodic backup schedule (daily at 02:00 UTC)
func (m *Manager) StartCron(ctx context.Context) {
	if !m.cfg.Database.Backup.Enabled {
		return
	}

	m.logger.Info("Starting automated database backup scheduler",
		"schedule", m.cfg.Database.Backup.Schedule,
		"bucket", m.cfg.Database.Backup.R2Bucket,
	)

	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				now := time.Now().UTC()
				// Run daily at 02:00 UTC
				if now.Hour() == 2 {
					backupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
					_, _ = m.CreateBackup(backupCtx, "daily")
					cancel()
				}
			}
		}
	}()
}
