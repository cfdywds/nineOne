//go:build windows

package api

import "testing"

func TestLocalDiskStatsReturnsPositiveValuesOnWindows(t *testing.T) {
	stats, err := localDiskStats(t.TempDir())
	if err != nil {
		t.Fatalf("localDiskStats: %v", err)
	}
	if stats.AvailableBytes <= 0 {
		t.Fatalf("AvailableBytes = %d, want positive", stats.AvailableBytes)
	}
	if stats.CapacityBytes <= 0 {
		t.Fatalf("CapacityBytes = %d, want positive", stats.CapacityBytes)
	}
}
