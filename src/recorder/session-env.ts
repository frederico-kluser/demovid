/**
 * Imports the graphical session's environment out of the compositor's process.
 *
 * This is the single genuinely load-bearing thing the old bash wrapper did.
 * When demovid runs from an agent, a cron job, or any shell that did not
 * inherit the graphical session, `DISPLAY` / `XAUTHORITY` / `XDG_RUNTIME_DIR` /
 * `DBUS_SESSION_BUS_ADDRESS` are absent, and capture dies with
 * `for_each_active_monitor_output_drm failed` — a message that names none of
 * the four things actually missing.
 *
 * It is called once from `src/index.ts`, not from the recorder, because the
 * *browser* needs `DISPLAY` too. A recorder that can see the session while the
 * browser cannot is a recording of nothing.
 *
 * Pure Node over `/proc`, no shell: `pgrep`/`ps` would be a second binary to
 * install and would still need parsing.
 */
import { readdir, readFile } from "node:fs/promises";

/**
 * Compositors in priority order. The first one with a live process wins, so a
 * Wayland compositor is preferred over the Xwayland it spawned — Xwayland's own
 * environ is a subset and lacks `WAYLAND_DISPLAY`.
 */
const COMPOSITORS = ["cosmic-comp", "gnome-shell", "Xorg", "Xwayland"] as const;

/**
 * Only these are copied. An allowlist rather than a merge: the compositor's
 * environ also holds its `PATH`, its `LANG`, and whatever the display manager
 * exported, and inheriting those would silently change how every child of
 * demovid resolves binaries.
 */
export const SESSION_ENV_KEYS = [
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_SEAT",
  "DISPLAY",
  "XAUTHORITY",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
] as const;

export interface SessionEnvResult {
  /** Keys actually written into `process.env`, with their values. */
  applied: Record<string, string>;
  /** `"gnome-shell (pid 2412)"`, or null when no compositor was readable. */
  source: string | null;
}

/**
 * Field 22 of `/proc/<pid>/stat`, in clock ticks since boot.
 *
 * Parsed after the LAST `)` on purpose: field 2 is the executable name in
 * parentheses and may itself contain parentheses or spaces, so splitting the
 * whole line on whitespace mis-indexes every field after it.
 */
async function startTime(pid: number): Promise<number> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    // After the `)` the first field is state (field 3), so field 22 is index 19.
    return Number(tail[19] ?? 0);
  } catch {
    return 0;
  }
}

async function comm(pid: number): Promise<string | null> {
  try {
    return (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
  } catch {
    return null;
  }
}

/** Parse a NUL-delimited `/proc/<pid>/environ` blob into a map. */
function parseEnviron(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of buf.toString("utf8").split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    out.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return out;
}

async function livePids(): Promise<number[]> {
  const entries = await readdir("/proc").catch(() => [] as string[]);
  const pids: number[] = [];
  for (const e of entries) {
    const n = Number(e);
    if (Number.isInteger(n) && n > 0) pids.push(n);
  }
  return pids;
}

/**
 * Find the newest process matching the highest-priority compositor name.
 *
 * "Newest" matters after a compositor restart, where the stale process may
 * still be visible for a moment and carries a dead `DISPLAY`.
 */
async function findCompositor(): Promise<{ pid: number; name: string } | null> {
  const pids = await livePids();
  const named = await Promise.all(pids.map(async (pid) => ({ pid, name: await comm(pid) })));

  for (const wanted of COMPOSITORS) {
    const matches = named.filter((p) => p.name === wanted);
    if (matches.length === 0) continue;
    if (matches.length === 1) {
      const only = matches[0];
      if (only) return { pid: only.pid, name: wanted };
      continue;
    }
    const withStart = await Promise.all(
      matches.map(async (m) => ({ pid: m.pid, started: await startTime(m.pid) })),
    );
    withStart.sort((a, b) => b.started - a.started);
    const newest = withStart[0];
    if (newest) return { pid: newest.pid, name: wanted };
  }
  return null;
}

/**
 * Copy the session env into `process.env`, without clobbering anything the
 * caller set deliberately.
 *
 * Never throws: on a machine with no compositor (a container, a CI box) the
 * right outcome is "applied nothing" and a later, more specific failure from
 * whatever actually needed `DISPLAY`.
 */
export async function importSessionEnv(): Promise<SessionEnvResult> {
  const applied: Record<string, string> = {};
  let source: string | null = null;

  const found = await findCompositor();
  if (found) {
    const buf = await readFile(`/proc/${found.pid}/environ`).catch(() => null);
    if (buf) {
      source = `${found.name} (pid ${found.pid})`;
      const env = parseEnviron(buf);
      for (const key of SESSION_ENV_KEYS) {
        const current = process.env[key];
        if (current !== undefined && current !== "") continue;
        const value = env.get(key);
        if (value === undefined || value === "") continue;
        process.env[key] = value;
        applied[key] = value;
      }
    }
  }

  // The wrapper did this unconditionally, and it is right to: a session that
  // exports no XDG_RUNTIME_DIR still has one at the conventional path, and
  // PipeWire will not connect without it.
  const runtime = process.env["XDG_RUNTIME_DIR"];
  if (runtime === undefined || runtime === "") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const fallback = `/run/user/${uid}`;
    process.env["XDG_RUNTIME_DIR"] = fallback;
    applied["XDG_RUNTIME_DIR"] = fallback;
  }

  return { applied, source };
}
