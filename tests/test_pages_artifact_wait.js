const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repo = path.join(__dirname, "..");

function runWithCounts(counts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "range-pages-artifact-"));
  try {
    fs.writeFileSync(path.join(dir, "counts"), counts.join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "counter"), "0\n");
    fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh
test "$1" = api || exit 2
test "$2" = 'repos/example/repo/actions/runs/42/artifacts?per_page=100' || exit 2
index=$(cat "$MOCK_COUNTER")
index=$((index + 1))
echo "$index" > "$MOCK_COUNTER"
value=$(sed -n "${'${index}'}p" "$MOCK_COUNTS")
printf '%s\\n' "${'${value:-0}'}"
`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = spawnSync("bash", ["scripts/wait-for-pages-artifact.sh"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: "fixture",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_RUN_ID: "42",
        MOCK_COUNTER: path.join(dir, "counter"),
        MOCK_COUNTS: path.join(dir, "counts"),
      },
    });
    return { ...result, calls: Number(fs.readFileSync(path.join(dir, "counter"), "utf8")) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("Pages deploy waits until its single artifact is indexed", () => {
  const result = runWithCounts([0, 0, 1]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, 3);
  assert.match(result.stdout, /indexed \(attempt 3\)/);
});

test("Pages deploy refuses duplicate artifacts from a rerun", () => {
  const result = runWithCounts([2]);
  assert.equal(result.status, 1);
  assert.equal(result.calls, 1);
  assert.match(result.stdout, /Expected one github-pages artifact/);
});

test("Pages deploy stops after a bounded lookup timeout", () => {
  const result = runWithCounts([0]);
  assert.equal(result.status, 1);
  assert.equal(result.calls, 12);
  assert.match(result.stdout, /did not become visible/);
});
