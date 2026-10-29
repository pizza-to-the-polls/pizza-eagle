import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadAttachments, type SlackFile } from "../src/attachments.js";
import type { Config } from "../src/config.js";

/**
 * Unit tests for the Slack attachment download path (issue #34): a photo
 * posted with a mention must reach pi as an @file reference so a vision run
 * (PI_MODEL) can see it. downloadAttachments is best-effort per file — a
 * failed download skips the file and the run proceeds text-only.
 */

const cfg = { slackBotToken: "xoxb-test" } as unknown as Config; // only slackBotToken is read

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;

/** Swap globalThis.fetch for the duration of fn (restored in finally). */
async function withFetch(handler: FetchHandler, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init)) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function pngResponse(bytes: number[] = [0x89, 0x50, 0x4e, 0x47]): Response {
  return new Response(new Uint8Array(bytes), { status: 200 });
}

const IMAGE: SlackFile = {
  id: "F012345",
  name: "screenshot.png",
  filetype: "png",
  mimetype: "image/png",
  url_private: "https://files.slack.com/files-pri/T0-F012345/screenshot.png",
  url_private_download: "https://files.slack.com/files-pri/T0-F012345/download/screenshot.png",
  size: 4,
};

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pe-att-"));
  return dir;
}

test("downloadAttachments: happy path — file written, @file arg uses the basename, bot token authenticates", async () => {
  const dir = workdir();
  try {
    await withFetch(
      (url, init) => {
        assert.equal(
          url,
          "https://files.slack.com/files-pri/T0-F012345/download/screenshot.png",
          "url_private_download is preferred when present",
        );
        assert.equal(init?.headers && new Headers(init.headers).get("Authorization"), "Bearer xoxb-test", "bot token authenticates the private URL");
        return pngResponse();
      },
      async () => {
        const dl = await downloadAttachments(cfg, dir, [IMAGE]);
        assert.equal(dl.paths.length, 1, "one file downloaded");
        assert.equal(dl.args.length, 1, "one @file reference");
        assert.equal(dl.args[0], "@file attachment-F012345-screenshot.png", "arg is the @file basename relative to the workdir");
        assert.ok(dl.paths[0].startsWith(dir), "file lands in the case workdir");
        assert.ok(existsSync(dl.paths[0]), "file exists");
        assert.deepEqual(
          Array.from(readFileSync(dl.paths[0])),
          [0x89, 0x50, 0x4e, 0x47],
          "downloaded bytes are the response body",
        );
        // 0660 — owner+group, world nothing (mirror the workdir's 0770).
        assert.equal(statSync(dl.paths[0]).mode & 0o777, 0o660);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadAttachments: non-OK response is skipped — the run proceeds text-only", async () => {
  const dir = workdir();
  try {
    await withFetch(
      () => new Response("forbidden", { status: 403 }),
      async () => {
        const dl = await downloadAttachments(cfg, dir, [IMAGE]);
        assert.equal(dl.paths.length, 0, "no file written on failure");
        assert.equal(dl.args.length, 0, "no @file reference for a failed download");
        assert.ok(!existsSync(join(dir, "attachment-F012345-screenshot.png")), "no partial file");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadAttachments: file without a download URL is skipped without any fetch", async () => {
  const dir = workdir();
  try {
    let fetchCalled = false;
    await withFetch(
      () => {
        fetchCalled = true;
        return pngResponse();
      },
      async () => {
        const dl = await downloadAttachments(cfg, dir, [
          { id: "F00", name: "pending.png", mimetype: "image/png" }, // pending virus scan, no URL
        ]);
        assert.equal(fetchCalled, false, "no fetch when no URL is available");
        assert.equal(dl.paths.length, 0);
        assert.equal(dl.args.length, 0);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadAttachments: a fetch error is swallowed — the run proceeds text-only", async () => {
  const dir = workdir();
  try {
    await withFetch(
      () => {
        throw new Error("connection reset");
      },
      async () => {
        const dl = await downloadAttachments(cfg, dir, [IMAGE]);
        assert.equal(dl.paths.length, 0, "failed download skipped, not thrown");
        assert.equal(dl.args.length, 0);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadAttachments: multiple files — each gets its own @file arg in prompt order", async () => {
  const dir = workdir();
  try {
    await withFetch(
      () => pngResponse(),
      async () => {
        const dl = await downloadAttachments(cfg, dir, [
          { ...IMAGE, id: "F1", name: "chart.png" },
          { ...IMAGE, id: "F2", name: "diagram.png" },
        ]);
        assert.deepEqual(dl.args, ["@file attachment-F1-chart.png", "@file attachment-F2-diagram.png"]);
        assert.equal(dl.paths.length, 2);
        for (const p of dl.paths) assert.ok(existsSync(p));
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadAttachments: unsafe filenames are sanitized for the workdir path", async () => {
  const dir = workdir();
  try {
    await withFetch(
      () => pngResponse(),
      async () => {
        const dl = await downloadAttachments(cfg, dir, [
          { ...IMAGE, id: "F-9_9", name: "../../evil/../etc passwd.png" },
        ]);
        assert.equal(dl.args[0], "@file attachment-F99-.._.._evil_.._etc_passwd.png", "path junk becomes underscores");
        assert.ok(dl.paths[0].startsWith(dir), "the resolved path never leaves the workdir");
        assert.ok(existsSync(dl.paths[0]));
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadAttachments: empty file list is a no-op", async () => {
  const dl = await downloadAttachments(cfg, mkdtempSync(join(tmpdir(), "pe-att-")), []);
  assert.deepEqual(dl, { args: [], paths: [] });
});

test("downloadAttachments: nameless file falls back to id + filetype extension", async () => {
  const dir = workdir();
  try {
    await withFetch(
      () => pngResponse(),
      async () => {
        // The file must carry a download URL (the nameless case in practice is
        // a Slack upload whose name is empty — the URL is always present).
        const dl = await downloadAttachments(cfg, dir, [
          { id: "F77", filetype: "jpg", url_private: "https://files.slack.com/files-pri/T0-F77/img.jpg" },
        ]);
        assert.equal(dl.args[0], "@file attachment-F77-F77.jpg", "fallback name is the sanitized id + ext");
        assert.ok(existsSync(dl.paths[0]));
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
