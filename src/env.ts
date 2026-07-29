/**
 * Side-effect module. MUST be imported first in `src/index.ts`, before anything
 * that reads `process.env`.
 *
 * `override: true` is deliberate: a stale `OPENAI_API_KEY` exported in the shell
 * profile would otherwise shadow the project `.env`. `quiet: true` suppresses
 * dotenv v17's banner, which would corrupt stdout when a command writes JSON.
 *
 * This module NEVER reads `~/.secrets` — that file is loaded by the shell
 * wrapper. See AGENTS.md § Security.
 */
import { config } from "dotenv";

config({ override: true, quiet: true });
