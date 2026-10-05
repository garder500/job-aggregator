import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const windows = process.platform === "win32";
const bash = windows ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const shellPath = (value: string) =>
  windows
    ? value
        .replace(/\\/g, "/")
        .replace(
          /^([A-Za-z]):/,
          (_, drive: string) => `/${drive.toLowerCase()}`,
        )
    : value;
describe.skipIf(windows && !existsSync(bash))(
  "Linux operator failure boundaries",
  () => {
    function scenario(mode: string, action = "backup") {
      const root = mkdtempSync(join(tmpdir(), "poste-ops-"));
      const bin = join(root, "bin"),
        state = join(root, "state"),
        log = join(root, "calls");
      mkdirSync(bin);
      mkdirSync(state);
      const script = (name: string, body: string) =>
        writeFileSync(
          join(bin, name),
          `#!/usr/bin/env bash\nset -eu\n${body}\n`,
          { mode: 0o700 },
        );
      if (windows) script("flock", "exit 0");
      script(
        "jq",
        `case "$*" in
      *APP_PASSWORD*) echo a-long-application-password;;
      *SESSION_SECRET*) echo a-session-secret-with-more-than-32-characters;;
      *POSTGRES_PASSWORD*) echo database-secret;;
      *APP_ORIGIN*) echo http://localhost:3001;;
      *BACKUP_AGE_RECIPIENT*) [[ "$MODE" != missing-key ]] && echo age-fixture || true;;
      *S3_BUCKET*) echo test-bucket;;
      *AWS_DEFAULT_REGION*) echo us-east-1;;
      *S3_ENDPOINT_URL*) echo '';;
      *Contents*) :;;
      *) echo fixture;; esac`,
      );
      script(
        "docker",
        `echo "docker $*" >> "$LOG"
      case "$*" in
        *"SELECT count(*) FROM applications"*) echo 0;;
        *pg_dump*) echo fixture-dump;;
        *"--entrypoint tar"*) tar -cf - --files-from /dev/null;;
        *"run --rm --no-deps migrate"*) [[ "$MODE" != migration-failed ]];;
      esac`,
      );
      script(
        "age",
        `output=''; while [[ $# -gt 0 ]]; do if [[ "$1" == -o ]]; then output=$2; shift; fi; shift; done; cat > "$output"`,
      );
      // Checksum uploads must not overwrite the remote archive fixture.
      script(
        "aws",
        `echo "aws $*" >> "$LOG"
      if [[ "$1 $2" == 's3 cp' ]]; then
        suffix=''; [[ "$3" != *.sha256 ]] || suffix=.sha256
        if [[ "$3" == s3://* ]]; then cp "$REMOTE$suffix" "$4"; else cp "$3" "$REMOTE$suffix"; fi
        [[ "$MODE" != upload-failed ]] || exit 1
      fi`,
      );
      const result = spawnSync(
        bash,
        [
          shellPath(resolve("ops/poste")),
          action,
          ...(action === "deploy"
            ? [`ghcr.io/test/poste@sha256:${"a".repeat(64)}`]
            : []),
        ],
        {
          env: {
            ...process.env,
            PATH: `${shellPath(bin)}:${windows ? "/usr/bin:/bin" : process.env.PATH}`,
            POSTE_STATE_DIR: shellPath(state),
            MODE: mode,
            MIN_FREE_KB: mode === "low-space" ? "999999999999" : "1",
            LOG: shellPath(log),
            REMOTE: shellPath(join(root, "remote")),
            POSTE_IMAGE: `ghcr.io/test/poste@sha256:${"b".repeat(64)}`,
          },
          encoding: "utf8",
        },
      );
      const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
      rmSync(root, { recursive: true, force: true });
      return { result, calls };
    }
    it("missing age recipient stops before maintenance", () => {
      const { result, calls } = scenario("missing-key");
      expect(result.status).not.toBe(0);
      expect(calls).not.toContain("UPDATE maintenance");
    }, 30000);
    it("insufficient space stops before maintenance", () => {
      const { result, calls } = scenario("low-space");
      expect(result.status, result.stderr + result.stdout + calls).not.toBe(0);
      expect(calls).not.toContain("UPDATE maintenance");
    }, 30000);
    it("interrupted upload cannot purge or resume", () => {
      const { result, calls } = scenario("upload-failed");
      expect(result.status).not.toBe(0);
      expect(calls).toContain("UPDATE maintenance SET active=true");
      expect(calls).not.toContain("s3 rm");
      expect(calls).not.toContain("active=false");
    }, 30000);
    it("migration failure leaves services suspended", () => {
      const { result, calls } = scenario("migration-failed", "deploy");
      expect(result.status).not.toBe(0);
      expect(calls).toContain("run --rm --no-deps migrate");
      expect(calls).not.toContain("active=false");
    }, 30000);
    it("verified backup resumes only after remote readback", () => {
      const { result, calls } = scenario("success");
      expect(result.status, result.stderr).toBe(0);
      expect(calls.indexOf(".tar.age.verify")).toBeLessThan(
        calls.indexOf("active=false"),
      );
      expect(calls).toContain("VALUES('backup','completed')");
    }, 30000);
  },
);
