import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const REPO_PATH = process.env.JARVIS_HOST_REPO_PATH;
const PORT = process.env.PORT || 8082;

if (!REPO_PATH) {
  console.error("deploy-agent: JARVIS_HOST_REPO_PATH is required — refusing to start.");
  process.exit(1);
}

const COMPOSE_FILE = `${REPO_PATH}/docker-compose.yml`;

// Fixed, parameterless command sequence — the whole point of this service
// is zero injectable surface: the request body is never read, there is no
// way to make it run anything other than exactly this. See
// docs/architecture.md's "Self-deploy" section for why raw Docker-socket
// access lives only here, narrowly, and never on the orchestrator itself.
async function redeploy() {
  const log = [];
  const run = async (cmd, args) => {
    log.push(`$ ${cmd} ${args.join(" ")}`);
    const { stdout, stderr } = await exec(cmd, args, { cwd: REPO_PATH });
    if (stdout) log.push(stdout.trim());
    if (stderr) log.push(stderr.trim());
  };
  await run("git", ["-C", REPO_PATH, "pull"]);
  await run("docker", ["compose", "-f", COMPOSE_FILE, "build", "orchestrator"]);
  await run("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "orchestrator"]);
  return log.join("\n");
}

let lastRedeploy = null; // { startedAt, finishedAt, ok, log } — see GET /internal/last-redeploy

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/internal/redeploy") {
    // Responds before actually running anything: step 3 above restarts the
    // orchestrator container that (via the approved redeploy-jarvis
    // script) is the one calling this endpoint, so that caller's process
    // may not survive long enough to receive a response describing the
    // outcome. GET /internal/last-redeploy is how anyone — human or a
    // later JARVIS chat turn — checks what actually happened.
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "started" }));

    const startedAt = new Date().toISOString();
    redeploy()
      .then((log) => {
        lastRedeploy = { startedAt, finishedAt: new Date().toISOString(), ok: true, log };
        console.log("deploy-agent: redeploy succeeded\n" + log);
      })
      .catch((err) => {
        // execFile's rejection carries .stdout/.stderr from the failed
        // command alongside the usual Error fields — surface all of it.
        const log = [err?.message, err?.stdout, err?.stderr].filter(Boolean).join("\n");
        lastRedeploy = { startedAt, finishedAt: new Date().toISOString(), ok: false, log };
        console.error("deploy-agent: redeploy failed\n" + log);
      });
    return;
  }

  if (req.method === "GET" && req.url === "/internal/last-redeploy") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(lastRedeploy ?? { status: "no redeploy has been triggered yet" }));
    return;
  }

  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => console.log(`deploy-agent: listening on :${PORT}, repo ${REPO_PATH}`));
