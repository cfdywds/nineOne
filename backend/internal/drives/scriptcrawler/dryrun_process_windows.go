//go:build windows

package scriptcrawler

import "os/exec"

func configureDryRunProcess(cmd *exec.Cmd) {}

func killDryRunProcess(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}
