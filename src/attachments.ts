/**
 * Slack attachment downloads (issue #34): a photo posted with the mention
 * must reach pi, or a vision-capable run (PI_MODEL=or-pizza/z-ai/glm-5v-turbo,
 * see RUNBOOK "Model catalog") never sees it — the Slack event path used to
 * forward only question TEXT.
 *
 * Files land in the case workdir (the only host path the isolated pi run can
 * read) under an `attachment-` prefix and are referenced from the question as
 * `@file <name>` — pi's file-attachment syntax for vision models. The run's
 * cwd IS the case workdir (mounted at /workspace in the container), so the
 * relative name resolves inside every isolation mode.
 *
 * Ephemerality mirrors the credential-staging rule: downloads are per-run
 * scratch. The listener's run-job deletes them in its finally (all modes —
 * success, failure, and early exit), and `npm run backup` tar excludes
 * `attachment-*` so even a mid-run backup never ships one to S3.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

/** The subset of Slack's file object the listener needs (app_mention payload). */
export interface SlackFile {
  id: string;
  name?: string;
  filetype?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
  size?: number;
}

export interface AttachmentDownload {
  /** `@file <name>` references for the question (pi prompt order). */
  args: string[];
  /** Absolute paths of the downloaded files — per-run scratch, delete after. */
  paths: string[];
}

/**
 * Download the event's files into the case workdir and build the @file
 * references for the question. Best-effort per file: a failed download is
 * skipped (with a warning) and the run proceeds text-only — Slack private
 * URLs need the bot token, and files can be missing `url_private` while
 * pending (e.g. a virus scan), so both failures are expected.
 */
export async function downloadAttachments(
  cfg: Config,
  workdir: string,
  files: SlackFile[],
): Promise<AttachmentDownload> {
  const out: AttachmentDownload = { args: [], paths: [] };
  for (const f of files) {
    const url = f.url_private_download ?? f.url_private;
    if (!url) {
      console.warn(`[pizza-eagle] attachment ${f.id} has no download URL — skipping (run proceeds text-only)`);
      continue;
    }
    const ext = f.filetype ? `.${f.filetype.replace(/[^a-zA-Z0-9]/g, "")}` : "";
    const safeId = f.id.replace(/[^a-zA-Z0-9]/g, "");
    const base = f.name?.replace(/[^a-zA-Z0-9._-]/g, "_") || `${safeId}${ext}`;
    const destName = `attachment-${safeId}-${base}`;
    const dest = join(workdir, destName);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${cfg.slackBotToken}` },
      });
      if (!res.ok) {
        console.warn(`[pizza-eagle] attachment ${f.id} download failed: ${res.status}`);
        continue;
      }
      writeFileSync(dest, new Uint8Array(await res.arrayBuffer()));
      // Workdir rule: owner+group, world gets nothing (mirror the workdir's
      // 0770 — the inv user reads it via the pizza-eagle group).
      chmodSync(dest, 0o660);
      out.paths.push(dest);
      // pi resolves @file paths against the run's cwd — the case workdir.
      // Relative name only: the listener's absolute path is meaningless
      // inside the container.
      out.args.push(`@file ${destName}`);
      console.log(`[pizza-eagle] attachment downloaded: ${destName} (${f.size ?? "?"} bytes)`);
    } catch (e) {
      console.warn(`[pizza-eagle] attachment ${f.id} download error: ${(e as Error).message}`);
    }
  }
  return out;
}
