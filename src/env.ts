/**
 * Side-effect module. MUST be imported first in `src/index.ts`, before anything
 * that reads `process.env`.
 *
 * `override: true` is deliberate: stale env vars exported in the shell profile
 * would otherwise shadow the project `.env`. `quiet: true` suppresses dotenv
 * v17's banner, which would corrupt stdout when a command writes JSON.
 *
 * Keys loaded from `.env`:
 *  - `DEEPSEEK_API_KEY` — script and commercial (Chat Completions)
 *  - `OPENAI_API_KEY`  — TTS narration (kept separate from script)
 *
 * This module NEVER reads `~/.secrets` — that file is loaded by the shell
 * wrapper. See AGENTS.md § Security.
 */
import { config } from "dotenv";

config({ override: true, quiet: true });
