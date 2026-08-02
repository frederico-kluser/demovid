/**
 * Pull Plannotator in on install, so `npx demovid` can show the plan in a
 * browser instead of the terminal.
 *
 * Plannotator is not on npm — it is a compiled binary distributed by a shell
 * installer — so it cannot be an npm dependency, optional or otherwise. This is
 * the closest honest equivalent: run the official installer, in the one mode
 * that installs nothing but the binary.
 *
 * ## Rules this script obeys, all of them load-bearing
 *
 * - **It always exits 0.** An `npx demovid` that fails because an OPTIONAL
 *   reviewer did not install would be a worse tool than one that never had a
 *   reviewer. Every failure path below is a printed line and a clean exit.
 * - **`--minimal`.** The installer's default mode also writes skills, hooks and
 *   slash commands into the user's Claude / Codex / OpenCode / Gemini config.
 *   demovid needs the binary and has no business editing another tool's
 *   configuration on the way past. `--non-interactive` keeps the wizard away.
 * - **No shell, no pipe.** The documented incantation is `curl … | bash`, which
 *   this project forbids for the reason `src/exec.ts` gives. The script is
 *   fetched to a temp file and handed to `bash` as an argv entry, so nothing is
 *   interpolated into a command line — and the downloaded bytes are on disk to
 *   inspect if anything ever goes wrong.
 * - **Opt-out, and it is checked first.** `DEMOVID_SKIP_PLANNOTATOR=1` means
 *   this script does nothing at all, including no network access.
 */
import { spawn } from "node:child_process";
import { access, constants, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALLER_URL = "https://plannotator.ai/install.sh";
const DOWNLOAD_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 180_000;

const note = (line) => process.stderr.write(`[demovid] ${line}\n`);

/** PATH lookup in pure Node — same reason as `which()` in `src/exec.ts`. */
async function onPath(bin) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const ok = await access(join(dir, bin), constants.X_OK).then(
      () => true,
      () => false,
    );
    if (ok) return true;
  }
  return false;
}

async function main() {
  if (process.env.DEMOVID_SKIP_PLANNOTATOR) return;

  // Windows gets nothing from a bash installer, and demovid's capture stack is
  // X11-only anyway.
  if (process.platform !== "linux" && process.platform !== "darwin") return;

  if (await onPath("plannotator")) return;
  if (!(await onPath("bash"))) return;

  note("instalando o Plannotator (revisão do plano no navegador, opcional)");
  note(`  pule com DEMOVID_SKIP_PLANNOTATOR=1 · instalador: ${INSTALLER_URL}`);

  let script;
  try {
    const res = await fetch(INSTALLER_URL, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    script = await res.text();
  } catch (err) {
    note(`  não consegui baixar o instalador (${err.message}) — seguindo sem ele.`);
    note(`  o demovid funciona normal; a aprovação do plano fica no terminal.`);
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "demovid-plannotator-"));
  const file = join(dir, "install.sh");
  try {
    await writeFile(file, script, "utf8");
    const code = await new Promise((resolve) => {
      const child = spawn("bash", [file, "--minimal", "--non-interactive"], {
        stdio: ["ignore", "inherit", "inherit"],
        detached: true,
      });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* já morreu */
        }
        finish(null);
      }, INSTALL_TIMEOUT_MS);
      child.on("error", () => finish(null));
      child.on("exit", (c) => finish(c));
    });

    if (code === 0 && (await onPath("plannotator"))) {
      note("  Plannotator instalado — o plano será apresentado no navegador.");
    } else if (code === 0) {
      // The installer puts the binary in ~/.local/bin, which is not on every
      // PATH. Saying so beats reporting a success the operator cannot use.
      note("  instalado, mas `plannotator` não está no PATH.");
      note("  adicione ~/.local/bin ao PATH para usar a revisão no navegador.");
    } else {
      note("  a instalação não completou — a aprovação do plano fica no terminal.");
    }
  } catch {
    note("  a instalação não completou — a aprovação do plano fica no terminal.");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Nothing below this line may reject: npm treats a non-zero postinstall as a
// failed install of demovid itself.
main().then(
  () => process.exit(0),
  () => process.exit(0),
);
