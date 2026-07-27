/**
 * Small temp-file helpers for worker ffmpeg jobs (trim/assembly): download
 * source media to a local file (fluent-ffmpeg shells out to the ffmpeg
 * binary and needs real file paths, not buffers/streams), write ffmpeg's
 * output back out, then clean up.
 */
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "product-engine-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function writeTempFile(dir: string, name: string, data: Buffer): Promise<string> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, data);
  return filePath;
}

export async function readTempFile(filePath: string): Promise<Buffer> {
  return readFile(filePath);
}
