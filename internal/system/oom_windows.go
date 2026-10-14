//go:build windows

package system

import "log/slog"

// ProtectFromOOM is a no-op on Windows.
func ProtectFromOOM(logger *slog.Logger) {}
