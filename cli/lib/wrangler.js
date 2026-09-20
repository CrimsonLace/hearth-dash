import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

function spawnCmd(cmd, args, opts) {
  if (process.platform === "win32") {
    const full = [cmd, ...args].map((a) => a.includes(" ") ? `"${a}"` : a).join(" ");
    return spawn(full, [], { ...opts, shell: true });
  }
  return spawn(cmd, args, opts);
}

export function execWrangler(args, cwd, stdinData) {
  return new Promise((resolve) => {
    const proc = spawnCmd("npx", ["wrangler", ...args], {
      cwd, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    if (stdinData) { proc.stdin.write(stdinData); proc.stdin.end(); }
    else { proc.stdin.end(); }
    proc.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }));
  });
}

export function execCommand(command, args, cwd) {
  return new Promise((resolve) => {
    const proc = spawnCmd(command, args, {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('close', (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }));
  });
}

export function parseD1CreateOutput(output) {
  const combined = output.stdout + "\n" + output.stderr;
  const match = combined.match(/database_id\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}

export function parseDeployOutput(output) {
  const combined = output.stdout + "\n" + output.stderr;
  const match = combined.match(/https:\/\/[^\s)]+\.workers\.dev/);
  return match ? match[0] : null;
}

export async function checkWranglerAuth(cwd) {
  const result = await execWrangler(["whoami"], cwd);
  if (result.code !== 0) return false;
  const combined = result.stdout + result.stderr;
  return !combined.includes("Not logged in") && !combined.includes("not authenticated");
}

export async function wranglerLogin(cwd) {
  return new Promise((resolve) => {
    const proc = spawnCmd("npx", ["wrangler", "login"], { cwd, stdio: "inherit" });
    proc.on("close", (code) => resolve(code === 0));
  });
}

export async function setSecret(name, value, cwd) {
  return execWrangler(["secret", "put", name], cwd, value + "\n");
}

export async function executeSchema(dbName, schemaPath, cwd) {
  const result = await execWrangler(["d1", "execute", dbName, "--remote", "--file=" + schemaPath], cwd);
  if (result.code === 0) return { ok: true };
  const sql = readFileSync(schemaPath, "utf-8");
  const statements = sql.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const stmt of statements) {
    const r = await execWrangler(["d1", "execute", dbName, "--remote", "--command", stmt + ";"], cwd);
    if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout };
  }
  return { ok: true };
}

export function parseAppliedMigrations(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error('Could not parse the remote migration ledger response.', { cause: error });
  }
  const envelopes = Array.isArray(parsed) ? parsed : [parsed];
  if (!envelopes.length || envelopes.some(item => !item || typeof item !== 'object' || !Array.isArray(item.results))) {
    throw new Error('The remote migration ledger response had an unexpected shape.');
  }
  const rows = envelopes.flatMap(item => item.results);
  if (rows.some(row => !row || typeof row.version !== 'string' || !row.version)) {
    throw new Error('The remote migration ledger response contained an invalid version.');
  }
  return new Set(rows.map(row => row.version));
}

export function pendingMigrationFiles(files, applied) {
  return files
    .filter(file => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(file))
    .sort()
    .filter(file => !applied.has(basename(file, '.sql')));
}

export async function applyPendingMigrations({ files, applied, applyFile, record }) {
  const pending = pendingMigrationFiles(files, applied);
  for (const file of pending) {
    const version = basename(file, '.sql');
    const result = await applyFile(file);
    if (!result.ok) return { ok: false, version, error: result.error || 'migration failed', applied: [] };
    const recorded = await record(version);
    if (!recorded.ok) return { ok: false, version, error: recorded.error || 'could not record migration', applied: [] };
  }
  return { ok: true, applied: pending.map(file => basename(file, '.sql')) };
}

export async function runMigrations(dbName, migrationsDir, cwd) {
  const ledger = await execWrangler([
    'd1', 'execute', dbName, '--remote', '--command',
    "CREATE TABLE IF NOT EXISTS hearth_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));",
  ], cwd);
  if (ledger.code !== 0) return { ok: false, error: ledger.stderr || ledger.stdout };

  const listed = await execWrangler([
    'd1', 'execute', dbName, '--remote', '--command',
    'SELECT version FROM hearth_migrations ORDER BY version;', '--json',
  ], cwd);
  if (listed.code !== 0) return { ok: false, error: listed.stderr || listed.stdout };

  let applied;
  try {
    applied = parseAppliedMigrations(listed.stdout);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not read the remote migration ledger.' };
  }

  const files = readdirSync(migrationsDir);
  return applyPendingMigrations({
    files,
    applied,
    applyFile: file => executeSchema(dbName, join(migrationsDir, file), cwd),
    async record(version) {
      const escaped = version.replaceAll("'", "''");
      const result = await execWrangler([
        'd1', 'execute', dbName, '--remote', '--command',
        `INSERT INTO hearth_migrations (version) VALUES ('${escaped}');`,
      ], cwd);
      return result.code === 0 ? { ok: true } : { ok: false, error: result.stderr || result.stdout };
    },
  });
}

export function hasRequiredSchemaTables(output, requiredTables) {
  try {
    const parsed = JSON.parse(output);
    const envelopes = Array.isArray(parsed) ? parsed : [parsed];
    const names = new Set(envelopes.flatMap(item => item?.results || []).map(row => row.name));
    return requiredTables.every(name => names.has(name));
  } catch {
    return false;
  }
}

export function hasRequiredOAuthCsrfColumns(output) {
  try {
    const parsed = JSON.parse(output);
    const envelopes = Array.isArray(parsed) ? parsed : [parsed];
    const columns = new Map(envelopes.flatMap(item => item?.results || []).map(row => [row.name, row]));
    const token = columns.get('token');
    const fingerprint = columns.get('request_fingerprint');
    const expires = columns.get('expires_at');
    return columns.size === 3
      && String(token?.type).toUpperCase() === 'TEXT' && Number(token?.pk) === 1
      && String(fingerprint?.type).toUpperCase() === 'TEXT' && Number(fingerprint?.notnull) === 1
      && String(expires?.type).toUpperCase() === 'INTEGER' && Number(expires?.notnull) === 1;
  } catch {
    return false;
  }
}

export async function verifySecuritySchema(dbName, cwd) {
  const requiredTables = ['rate_limits', 'oauth_csrf_tokens'];
  const quoted = requiredTables.map(name => `'${name.replaceAll("'", "''")}'`).join(', ');
  const query = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${quoted}) ORDER BY name;`;
  const tables = await execWrangler(['d1', 'execute', dbName, '--remote', '--command', query, '--json'], cwd);
  if (tables.code !== 0 || !hasRequiredSchemaTables(tables.stdout, requiredTables)) return false;
  const columns = await execWrangler([
    'd1', 'execute', dbName, '--remote', '--command', 'PRAGMA table_info(oauth_csrf_tokens);', '--json',
  ], cwd);
  return columns.code === 0 && hasRequiredOAuthCsrfColumns(columns.stdout);
}

export async function provisionAfterVerifiedSchema({ applySchema, verifySchema, provisionWorker, onSchemaVerified = () => {} }) {
  const schemaResult = await applySchema();
  if (!schemaResult.ok) return { ok: false, stage: 'schema', schemaResult };
  const schemaVerified = await verifySchema();
  if (!schemaVerified) return { ok: false, stage: 'verification', schemaResult };
  onSchemaVerified();
  const provisionResult = await provisionWorker();
  return { ok: provisionResult.code === 0, stage: 'provision', schemaResult, provisionResult };
}

export async function listD1Databases(cwd) {
  const result = await execWrangler(["d1", "list", "--json"], cwd);
  if (result.code !== 0) return [];
  try { return JSON.parse(result.stdout); } catch { return []; }
}

export async function listKvNamespaces(cwd) {
  const result = await execWrangler(['kv', 'namespace', 'list'], cwd);
  if (result.code !== 0) return [];
  try { return JSON.parse(result.stdout); } catch { return []; }
}

export function parseKvCreateOutput(output) {
  const combined = output.stdout + '\n' + output.stderr;
  const toml = combined.match(/id\s*=\s*"([a-f0-9]{32})"/i);
  if (toml) return toml[1];
  const json = combined.match(/"id"\s*:\s*"([a-f0-9]{32})"/i);
  return json ? json[1] : null;
}
