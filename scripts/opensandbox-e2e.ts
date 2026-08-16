/**
 * OpenSandbox backend e2e (2026-08-16) — exercises the REAL lifecycle server +
 * execd with the production image through `spawnOpenSandbox()`:
 *
 *   1. sentinel round-trip: a node one-liner emits a progress heartbeat, then a
 *      result sentinel; asserts the parsed result, the ro repo mount, env
 *      neutralization, and that the container is gone afterwards.
 *   2. hardening probe: docker-inspects the live sandbox container for
 *      CapDrop=ALL, PidsLimit=512, no-new-privileges, 4GiB memory, 2 CPUs.
 *   3. (optional, SANDBOX_EGRESS_ALLOW set) egress probe: an allowed host
 *      resolves, a denied host does not.
 *
 * Needs OPENSANDBOX_API_KEY / OPENSANDBOX_URL in the environment — run it the
 * way the service gets them (EnvironmentFile), never by pasting the key:
 *
 *   sudo systemd-run --wait --pipe --collect -p EnvironmentFile=/etc/opensandbox/api.env \
 *     --setenv=SANDBOX_BACKEND=opensandbox --working-directory=/root/claude/mission-control \
 *     npx tsx scripts/opensandbox-e2e.ts
 *
 * Exit 0 = all probes passed. Never prints credential values.
 */
import { execFileSync } from "node:child_process";
import { getConfig } from "../src/config.js";
import {
  OUTPUT_END_MARKER,
  OUTPUT_START_MARKER,
} from "../src/runners/container.js";
import { spawnOpenSandbox } from "../src/runners/opensandbox-backend.js";

let live: { kill: () => void } | null = null;
function fail(msg: string): never {
  console.error(`E2E FAIL: ${msg}`);
  // Reap the sandbox we are holding so a failed probe does not leave it to the TTL.
  live?.kill();
  setTimeout(() => process.exit(1), 3000);
  throw new Error(msg);
}

function liveSandboxNames(): string[] {
  return execFileSync(
    "docker",
    ["ps", "--filter", "name=^sandbox-", "--format", "{{.Names}}"],
    {
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter(Boolean);
}

async function main(): Promise<void> {
  const config = getConfig();
  if (!config.opensandboxApiKey)
    fail(
      "OPENSANDBOX_API_KEY not in env (use systemd-run with EnvironmentFile)",
    );
  console.log(
    `backend=${config.sandboxBackend} url=${config.opensandboxUrl} image=${config.heavyRunnerImage}`,
  );
  const before = new Set(liveSandboxNames());

  // ---- 1 + 2: sentinel round-trip with a hardening probe mid-flight ----
  const worker = [
    "node",
    "-e",
    [
      "const fs=require('fs');",
      "const input=JSON.parse(fs.readFileSync(0,'utf8'));",
      `process.stdout.write('${OUTPUT_START_MARKER}'+JSON.stringify({type:'progress'})+'${OUTPUT_END_MARKER}');`,
      "setTimeout(()=>{",
      "  const out={result:JSON.stringify({echo:input.prompt,mcKey:process.env.MC_API_KEY,home:process.env.HOME,cwd:process.cwd(),uid:process.getuid(),repoRo:(()=>{try{fs.accessSync('/root/claude/mission-control/package.json',fs.constants.W_OK);return false;}catch(e){return e.code==='EROFS';}})(),distPresent:fs.existsSync('/root/claude/mission-control/dist/runners/nanoclaw-worker.js')})};",
      `  process.stdout.write('${OUTPUT_START_MARKER}'+JSON.stringify(out)+'${OUTPUT_END_MARKER}');`,
      "}, 15000);",
    ].join(""),
  ];
  const handle = spawnOpenSandbox({
    name: `mc-e2e-${Date.now()}`,
    input: { prompt: "hello-opensandbox" },
    command: worker,
    envVars: { MC_API_KEY: "REAL-SHOULD-BE-NEUTRALIZED", HOME: "/root" },
    volumes: ["/root/claude/mission-control:/root/claude/mission-control:ro"],
    timeoutMs: 120_000,
  });
  live = handle;

  // While the worker sleeps, inspect the live container's host config.
  let inspected = false;
  for (let i = 0; i < 60 && !inspected; i++) {
    await new Promise((r) => setTimeout(r, 500));
    // Skip the egress sidecar (`sandbox-egress-<id>`, NET_ADMIN by design) and
    // the transient execd-archive helper (`sandbox-execd-<uuid>`).
    const fresh = liveSandboxNames().filter(
      (n) => !before.has(n) && !/^sandbox-(egress|execd)-/.test(n),
    );
    if (fresh.length === 0) continue;
    const raw = execFileSync(
      "docker",
      [
        "inspect",
        fresh[0],
        "--format",
        "{{json .HostConfig.CapDrop}} {{.HostConfig.PidsLimit}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{json .HostConfig.SecurityOpt}} {{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}",
      ],
      { encoding: "utf8" },
    ).trim();
    console.log(`inspect ${fresh[0]}: ${raw}`);
    const [capDrop, pids, mem, cpus, secOpt] = raw.split(" ");
    if (!/"ALL"/i.test(capDrop)) fail(`CapDrop is ${capDrop}, expected ALL`);
    if (pids !== "512") fail(`PidsLimit is ${pids}, expected 512`);
    if (mem !== String(4 * 1024 ** 3)) fail(`Memory is ${mem}, expected 4GiB`);
    if (cpus !== String(2e9)) fail(`NanoCpus is ${cpus}, expected 2 CPUs`);
    if (!/no-new-privileges/.test(secOpt))
      fail(`SecurityOpt ${secOpt} lacks no-new-privileges`);
    inspected = true;

    // ---- lateral probes (qa C2): execd must NOT be reachable from other
    // containers — same-bridge direct IP, and cross-bridge via the published
    // host port. Only the host (mission-control) may talk to execd.
    const sid = fresh[0].slice("sandbox-".length);
    const netnsOwner = execFileSync("docker", ["ps", "-q", "--filter", `name=^sandbox-egress-${sid}$`], { encoding: "utf8" }).trim()
      ? `sandbox-egress-${sid}`
      : fresh[0];
    const ip = execFileSync(
      "docker",
      ["inspect", netnsOwner, "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"],
      { encoding: "utf8" },
    ).trim();
    const hostPort = execFileSync("docker", ["port", netnsOwner, "44772"], { encoding: "utf8" })
      .trim()
      .split("\n")[0]
      .split(":")
      .pop();
    const hostIp = execFileSync("sh", ["-c", "ip -o -4 addr show eth0 | awk '{print $4}' | cut -d/ -f1 | head -1"], { encoding: "utf8" }).trim();
    // A DROP shows up as a connect hang → `timeout 5` exits 124 → CLOSED.
    // Any OTHER docker-run failure (image missing, network gone, daemon busy)
    // is a broken harness and FAILS the run instead of passing as CLOSED
    // (qa R2 W-4). A positive control (host:22 from a container) proves the
    // probe can see an open port at all.
    const probe = (network: string, target: string, port: string): string => {
      try {
        return (
          execFileSync(
            "docker",
            [
              "run",
              "--rm",
              "--network",
              network,
              config.heavyRunnerImage,
              "timeout",
              "5",
              "bash",
              "-c",
              `exec 3<>/dev/tcp/${target}/${port} && echo OPEN || echo CLOSED`,
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          ).trim() || "CLOSED"
        );
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 124) return "CLOSED (timeout)";
        fail(
          `lateral probe harness failed (docker run exit ${String(status)}) — not a firewall verdict`,
        );
      }
    };
    if (!ip || !hostPort || !hostIp)
      fail(`lateral probe inputs missing (ip=${ip} hostPort=${hostPort} hostIp=${hostIp})`);
    const control = probe("bridge", hostIp, "22");
    console.log(`lateral positive control ${hostIp}:22 → ${control}`);
    if (control !== "OPEN") fail("positive control failed — probe cannot see an open port; harness broken");
    const sameBridge = probe("bridge", ip, "44772");
    console.log(`lateral same-bridge ${ip}:44772 → ${sameBridge}`);
    const otherNet = execFileSync(
      "sh",
      ["-c", "docker network ls --filter driver=bridge --format '{{.Name}}' | grep -v '^bridge$' | head -1"],
      { encoding: "utf8" },
    ).trim();
    if (!otherNet) fail("no user-defined bridge network to run the cross-bridge probe from");
    const crossBridge = probe(otherNet, hostIp, hostPort);
    console.log(`lateral cross-bridge (${otherNet}) ${hostIp}:${hostPort} → ${crossBridge}`);
    // docker-proxy hairpin: from docker0 to the host IP's published port (INPUT path, R4)
    const hairpin = probe("bridge", hostIp, hostPort);
    console.log(`lateral hairpin (docker0→host) ${hostIp}:${hostPort} → ${hairpin}`);

    if (sameBridge === "OPEN") fail("execd reachable from another container on the same bridge — DOCKER-USER guard incomplete");
    if (hairpin === "OPEN") fail("execd reachable via the docker-proxy hairpin — INPUT guard (R4) missing");
    if (crossBridge === "OPEN") fail("execd reachable via the published port from another docker network — DOCKER-USER guard incomplete");
  }
  if (!inspected) fail("sandbox container never appeared in docker ps");

  const out = await handle.result;
  live = null;
  console.log(`result: ${JSON.stringify(out).slice(0, 400)}`);
  if (out.status !== "success" || !out.result)
    fail(`bad status: ${JSON.stringify(out)}`);
  const parsed = JSON.parse(out.result) as Record<string, unknown>;
  if (parsed.echo !== "hello-opensandbox") fail("input did not round-trip");
  if (parsed.mcKey !== "sandbox-no-control-plane-access")
    fail("MC_API_KEY not neutralized");
  if (parsed.home !== "/root") fail("HOME env not applied");
  if (parsed.cwd !== "/app")
    fail(`cwd is ${String(parsed.cwd)}, expected /app`);
  if (parsed.repoRo !== true) fail("repo mount is writable — expected ro");
  if (parsed.distPresent !== true)
    fail("dist/runners/nanoclaw-worker.js not visible via the ro mount");

  await new Promise((r) => setTimeout(r, 3000));
  const leftover = liveSandboxNames().filter(
    (n) => !before.has(n) && !n.startsWith("sandbox-execd-"),
  );
  if (leftover.length)
    fail(
      `sandbox container(s) still running after result: ${leftover.join(",")}`,
    );
  console.log(
    "PASS 1+2: sentinel round-trip, hardening parity, ro mount, env neutralization, teardown",
  );

  // ---- 3: egress probe (only when an allow-list is configured) ----
  if (config.sandboxEgressAllow.length > 0) {
    const allowed =
      config.sandboxEgressAllow.find((h) => !h.startsWith("*")) ??
      "api.anthropic.com";
    const probe = spawnOpenSandbox({
      name: `mc-e2e-egress-${Date.now()}`,
      input: { prompt: "egress" },
      command: [
        "sh",
        "-c",
        `a=$(getent hosts ${allowed} >/dev/null 2>&1 && echo ok || echo fail); d=$(getent hosts example.org >/dev/null 2>&1 && echo ok || echo fail); printf '%s{"result":"{\\"allowed\\":\\"%s\\",\\"denied\\":\\"%s\\"}"}%s' '${OUTPUT_START_MARKER}' "$a" "$d" '${OUTPUT_END_MARKER}'`,
      ],
      timeoutMs: 120_000,
    });
    live = probe;
    const eo = await probe.result;
    live = null;
    console.log(`egress: ${JSON.stringify(eo).slice(0, 300)}`);
    if (eo.status !== "success" || !eo.result)
      fail("egress probe failed to run");
    const e = JSON.parse(eo.result) as { allowed: string; denied: string };
    if (e.allowed !== "ok") fail(`allowed host ${allowed} did not resolve`);
    if (e.denied !== "fail")
      fail("denied host example.org resolved — egress policy not enforced");
    console.log("PASS 3: egress default-deny with allow-list enforced");
  } else {
    console.log(
      "SKIP 3: SANDBOX_EGRESS_ALLOW not set (egress probe needs an allow-list)",
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`E2E FAIL: ${err instanceof Error ? err.message : String(err)}`);
  live?.kill();
  setTimeout(() => process.exit(1), 3000);
});
