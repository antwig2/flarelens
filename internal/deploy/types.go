package deploy

import "time"

// DeployRequest defines a declarative deployment trigger
type DeployRequest struct {
	DeploymentID   string            `json:"deployment_id"`
	Service        string            `json:"service"`          // e.g. "bill-api"
	Image          string            `json:"image"`            // e.g. "ghcr.io/kiwid/bill-api:v1.5.0"
	Env            string            `json:"env"`              // "prod", "uat"
	Domain         string            `json:"domain"`           // e.g. "bill.kiwid.io"
	ContainerPort  int               `json:"container_port"`   // internal port, e.g. 8080
	HostPortBlue   int               `json:"host_port_blue"`   // host port for blue slot, e.g. 8081
	HostPortGreen  int               `json:"host_port_green"`  // host port for green slot, e.g. 8082
	HealthPath     string            `json:"health_path"`      // e.g. "/healthz"
	TimeoutSeconds int               `json:"timeout_seconds"`  // e.g. 30
	DrainSeconds   int               `json:"drain_seconds"`    // e.g. 15
	Secrets           map[string]string `json:"secrets"`          // in-memory env secrets (zero disk write)
	Network           string            `json:"network"`          // docker network, e.g. "kiwid-edge"
	PreDeploySnapshot bool              `json:"pre_deploy_snapshot"`
	NodeID            string            `json:"node_id"`          // target node or "all"
	RunMigrations     bool              `json:"run_migrations"`
	MigrationCmd      string            `json:"migration_cmd"`    // e.g. "migrate up"
	CanaryWeight      int               `json:"canary_weight"`    // percentage of traffic to candidate (e.g. 10 for 10%)
	CanaryDuration    int               `json:"canary_duration"`  // seconds to hold canary before 100% promotion
	IsPreview         bool              `json:"is_preview"`       // ephemeral PR preview environment
	PRNumber          int               `json:"pr_number"`        // GitHub Pull Request number
}

// TeardownRequest defines parameters to tear down an ephemeral PR preview container and route
type TeardownRequest struct {
	Service  string `json:"service"`
	PRNumber int    `json:"pr_number"`
	NodeID   string `json:"node_id"`
}

// DeployProgress reports incremental status during rollout
type DeployProgress struct {
	DeploymentID string    `json:"deployment_id"`
	Service      string    `json:"service"`
	Stage        string    `json:"stage"` // "pulling", "starting", "probing", "flipping", "draining", "completed", "failed"
	Message      string    `json:"message"`
	Percent      int       `json:"percent"`
	Timestamp    time.Time `json:"timestamp"`
}

// DeployResponse represents the final result of a deployment operation
type DeployResponse struct {
	DeploymentID string `json:"deployment_id"`
	Service      string `json:"service"`
	Status       string `json:"status"` // "success", "failed", "rolled_back"
	ActiveSlot   string `json:"active_slot"` // "blue" or "green"
	ActivePort   int    `json:"active_port"`
	Message      string `json:"message"`
	DurationMS   int64  `json:"duration_ms"`
}

// Slot represents Blue or Green deployment slot
type Slot string

const (
	SlotBlue  Slot = "blue"
	SlotGreen Slot = "green"
)

// Invert returns the alternate slot
func (s Slot) Invert() Slot {
	if s == SlotBlue {
		return SlotGreen
	}
	return SlotBlue
}
