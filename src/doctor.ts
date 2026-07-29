/**
 * `demovid doctor` — checks every external dependency before a recording can
 * possibly work, and reports what it found rather than what it assumed.
 *
 * Written first, on purpose: every failure mode this catches was a real one hit
 * while researching this project (no `rec` on PATH, Wayland instead of X11,
 * an OpenAI key present but out of quota, a capture already running).
 */
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./exec.js";

export interface DoctorOptions {
  /** Faz UMA chamada faturável mínima para provar que há saldo, não só chave válida. */
  deep?: boolean;
  verbose?: boolean;
}

type Level = "ok" | "warn" | "fail";
interface Check {
  name: string;
  level: Level;
  detail: string;
}

const MARK: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗" };

async function exists(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/**
 * PATH lookup in pure Node. Deliberately NOT `sh -c "command -v"` — that would
 * be a shell, which AGENTS.md forbids, and `command` is a shell builtin so it
 * cannot be exec'd directly anyway.
 */
async function which(bin: string): Promise<string | null> {
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (!dir) continue;
    const p = join(dir, bin);
    if (await exists(p)) return p;
  }
  return null;
}

/** Candidate Chromium-family browsers, in the order we would pick them. */
export const BROWSER_CANDIDATES = [
  "/usr/bin/brave-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
];

/** Resolve which browser to drive. `DEMOVID_BROWSER` wins if set. */
export async function resolveBrowser(): Promise<string | null> {
  const override = process.env["DEMOVID_BROWSER"];
  if (override) return (await exists(override)) ? override : null;
  for (const c of BROWSER_CANDIDATES) if (await exists(c)) return c;
  return null;
}

export async function doctor(opts: DoctorOptions = {}): Promise<boolean> {
  const checks: Check[] = [];
  const push = (name: string, level: Level, detail: string) => checks.push({ name, level, detail });

  // ── rec ────────────────────────────────────────────────────────────────────
  const recPath = await which("rec");
  if (!recPath) {
    push("rec", "fail", "não está no PATH — rode ~/Projects/rec/install.sh");
  } else {
    let gsr = "backend desconhecido";
    try {
      const { stdout } = await run("gpu-screen-recorder", ["--version"]);
      gsr = `gpu-screen-recorder ${stdout.trim()}`;
    } catch {
      gsr = "gpu-screen-recorder AUSENTE (é o backend do rec)";
    }
    push("rec", gsr.includes("AUSENTE") ? "fail" : "ok", `${recPath} · ${gsr}`);
  }

  // Uma captura já rodando faz o `rec` recusar iniciar (bin/rec:142).
  try {
    const { stdout } = await run("pgrep", ["-f", "gpu-screen-recorder -w"]);
    if (stdout.trim()) {
      push("captura em curso", "fail", `já há gravação rodando (pid ${stdout.trim().split("\n").join(", ")}) — pare com \`recstop\``);
    } else {
      push("captura em curso", "ok", "nenhuma");
    }
  } catch {
    push("captura em curso", "ok", "nenhuma");
  }

  // ── sessão gráfica ─────────────────────────────────────────────────────────
  const sessionType = process.env["XDG_SESSION_TYPE"] ?? "(indefinido)";
  const display = process.env["DISPLAY"] ?? "(indefinido)";
  if (sessionType === "x11") {
    push("sessão gráfica", "ok", `x11 · DISPLAY=${display} — captura de janela é nativa, sem portal`);
  } else if (sessionType === "wayland") {
    push(
      "sessão gráfica",
      "warn",
      "wayland — captura de janela cai no portal do sistema (popup). Testado só em X11.",
    );
  } else {
    push("sessão gráfica", "warn", `${sessionType} — o rec importa o env da sessão sozinho, mas não deu pra confirmar`);
  }

  // ── áudio: o monitor do sink é o que capta a narração ──────────────────────
  try {
    const { stdout } = await run("pactl", ["get-default-sink"]);
    const sink = stdout.trim();
    push("áudio", "ok", `sink padrão ${sink} → captura por ${sink}.monitor (som do PC, sem microfone)`);
  } catch {
    push("áudio", "fail", "pactl não respondeu — sem isso a narração não é capturada");
  }

  // ── browser ────────────────────────────────────────────────────────────────
  const browser = await resolveBrowser();
  if (browser) {
    push("browser", "ok", `${browser} (Chromium-family → CDP disponível)`);
  } else {
    push(
      "browser",
      "fail",
      "nenhum browser Chromium encontrado. Firefox não serve: sem CDP não há eventos confiáveis de mouse nem Emulation.*",
    );
  }

  const xdotool = await which("xdotool");
  push(
    "xdotool",
    xdotool ? "ok" : "fail",
    xdotool ?? "ausente — é como descobrimos o id da janela do browser para o `rec --window-id`",
  );

  // ── ffmpeg ─────────────────────────────────────────────────────────────────
  try {
    const { stdout } = await run("ffmpeg", ["-version"]);
    push("ffmpeg", "ok", stdout.split("\n")[0]?.replace(/\s+Copyright.*/, "") ?? "ok");
  } catch {
    push("ffmpeg", "fail", "ausente — usado para o pós de áudio e a normalização de loudness");
  }

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  //
  // Chave VÁLIDA e chave COM SALDO são coisas diferentes, e é fácil confundir:
  // `/v1/models` é gratuito e responde 200 mesmo com a quota zerada. Só uma
  // chamada faturável distingue — por isso ela fica atrás de `--deep`, e sem a
  // flag o relatório diz o que sabe, não o que gostaria de saber.
  const key = process.env["OPENAI_API_KEY"];
  if (!key) {
    push("OPENAI_API_KEY", "fail", "ausente — necessária para script, refine e voice");
  } else {
    try {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401) {
        push("OPENAI_API_KEY", "fail", "rejeitada (401) — chave inválida ou revogada");
      } else if (!res.ok) {
        push("OPENAI_API_KEY", "warn", `HTTP ${res.status} ao checar`);
      } else if (!opts.deep) {
        push(
          "OPENAI_API_KEY",
          "ok",
          `válida (${key.slice(0, 7)}…). Saldo NÃO verificado — /v1/models é gratuito. Use --deep.`,
        );
      } else {
        // Uma sílaba de TTS: custa frações de centavo e responde de verdade.
        const probe = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "coral", input: "oi", response_format: "mp3" }),
          signal: AbortSignal.timeout(30_000),
        });
        if (probe.ok) {
          push("OPENAI_API_KEY", "ok", `válida e COM saldo — TTS respondeu ${(await probe.arrayBuffer()).byteLength} bytes`);
        } else {
          const body = await probe.text();
          const insufficient = body.includes("insufficient_quota");
          push(
            "OPENAI_API_KEY",
            "fail",
            insufficient
              ? "válida mas SEM SALDO — recarregue em platform.openai.com/settings/organization/billing"
              : `TTS recusou (HTTP ${probe.status}): ${body.slice(0, 160)}`,
          );
        }
      }
    } catch (e) {
      push("OPENAI_API_KEY", "warn", `não deu pra checar: ${(e as Error).message}`);
    }
  }

  // ── relatório ──────────────────────────────────────────────────────────────
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const line = `  ${MARK[c.level]} ${c.name.padEnd(width)}  ${c.detail}`;
    console.error(line);
  }

  const fails = checks.filter((c) => c.level === "fail");
  const warns = checks.filter((c) => c.level === "warn");
  console.error("");
  if (fails.length === 0) {
    console.error(`[demovid] ambiente pronto${warns.length ? ` (${warns.length} aviso${warns.length > 1 ? "s" : ""})` : ""}.`);
  } else {
    console.error(`[demovid] ${fails.length} problema${fails.length > 1 ? "s" : ""} bloqueante${fails.length > 1 ? "s" : ""}: ${fails.map((f) => f.name).join(", ")}`);
  }
  if (opts.verbose) console.error(`[demovid] node ${process.version} · plataforma ${process.platform}`);

  return fails.length === 0;
}
