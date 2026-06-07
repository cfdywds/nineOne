import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("PowerShell launcher uses root data config and serves built frontend", () => {
  const scriptPath = path.join(repoRoot, "start.ps1");
  assert.equal(existsSync(scriptPath), true);

  const script = readFileSync(scriptPath, "utf8");
  assert.match(script, /VIDEO_CONFIG/);
  assert.match(script, /data[\\/]+config\.yaml/);
  assert.match(script, /VIDEO_FRONTEND_DIR/);
  assert.match(script, /npm run build/);
  assert.match(script, /go run \.\/cmd\/server/);
  assert.match(script, /WorkingDirectory\s+\$BackendDir/);
});

test("PowerShell launcher falls back to the bundled Go toolchain", () => {
  const scriptPath = path.join(repoRoot, "start.ps1");
  assert.equal(existsSync(scriptPath), true);

  const script = readFileSync(scriptPath, "utf8");
  assert.match(script, /Resolve-ToolCommand/);
  assert.match(script, /\.tools[\\/]+go1\.26\.3[\\/]+go[\\/]+bin[\\/]+go\.exe/);
  assert.match(script, /FilePath\s+\$GoCommand/);
});

test("PowerShell launcher captures frontend build stderr without native command errors", () => {
  const scriptPath = path.join(repoRoot, "start.ps1");
  assert.equal(existsSync(scriptPath), true);

  const script = readFileSync(scriptPath, "utf8");
  assert.doesNotMatch(script, /npm run build 2>&1\s*\|\s*Tee-Object/);
  assert.match(script, /\$BuildShell\s*=\s*\$env:ComSpec/);
  assert.match(script, /\$BuildOutput\s*=\s*&\s*\$BuildShell\s+\/d\s+\/s\s+\/c/);
  assert.match(script, /\$BuildExitCode\s*=\s*\$LASTEXITCODE/);
});

test("batch launcher delegates to the PowerShell launcher", () => {
  const scriptPath = path.join(repoRoot, "start.bat");
  assert.equal(existsSync(scriptPath), true);

  const script = readFileSync(scriptPath, "utf8");
  assert.match(script, /powershell(?:\.exe)?/i);
  assert.match(script, /-ExecutionPolicy Bypass/i);
  assert.match(script, /start\.ps1/i);
});
