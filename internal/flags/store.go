package flags

import (
	"encoding/json"
	"log/slog"
	"sync"
)

// FeatureFlag defines a client-side feature flag schema
type FeatureFlag struct {
	Key          string   `json:"key"`
	Description  string   `json:"description"`
	Enabled      bool     `json:"enabled"`
	RolloutPct   int      `json:"rollout_pct"`
	Environments []string `json:"environments,omitempty"`
	UpdatedAt    string   `json:"updated_at"`
}

// Store maintains thread-safe in-memory cache of edge feature flags
type Store struct {
	mu     sync.RWMutex
	flags  map[string]FeatureFlag
	logger *slog.Logger
}

func NewStore(logger *slog.Logger) *Store {
	if logger == nil {
		logger = slog.Default()
	}
	return &Store{
		flags:  make(map[string]FeatureFlag),
		logger: logger,
	}
}

// UpdateFromJSON parses incoming NATS broadcast and updates in-memory flags
func (s *Store) UpdateFromJSON(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Check if array or single object
	var single FeatureFlag
	if err := json.Unmarshal(data, &single); err == nil && single.Key != "" {
		s.flags[single.Key] = single
		s.logger.Info("Updated feature flag in memory", "key", single.Key, "enabled", single.Enabled)
		return nil
	}

	var batch []FeatureFlag
	if err := json.Unmarshal(data, &batch); err == nil {
		for _, f := range batch {
			s.flags[f.Key] = f
		}
		s.logger.Info("Updated batch feature flags in memory", "count", len(batch))
		return nil
	}

	return nil
}

// IsEnabled returns true if the flag is enabled in memory
func (s *Store) IsEnabled(key string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	flag, exists := s.flags[key]
	if !exists {
		return false
	}
	return flag.Enabled
}

// GetAll returns a copy of all loaded flags
func (s *Store) GetAll() []FeatureFlag {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]FeatureFlag, 0, len(s.flags))
	for _, f := range s.flags {
		result = append(result, f)
	}
	return result
}
