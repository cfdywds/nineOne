//go:build windows

package api

import (
	"syscall"
	"unsafe"

	"github.com/video-site/backend/internal/storageusage"
)

var procGetDiskFreeSpaceExW = syscall.NewLazyDLL("kernel32.dll").NewProc("GetDiskFreeSpaceExW")

func localDiskStats(path string) (storageusage.DiskStats, error) {
	pathPtr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return storageusage.DiskStats{}, err
	}
	var availableBytes uint64
	var capacityBytes uint64
	r1, _, callErr := procGetDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(pathPtr)),
		uintptr(unsafe.Pointer(&availableBytes)),
		uintptr(unsafe.Pointer(&capacityBytes)),
		0,
	)
	if r1 == 0 {
		if callErr != syscall.Errno(0) {
			return storageusage.DiskStats{}, callErr
		}
		return storageusage.DiskStats{}, syscall.EINVAL
	}
	return storageusage.DiskStats{
		AvailableBytes: int64(availableBytes),
		CapacityBytes:  int64(capacityBytes),
	}, nil
}
