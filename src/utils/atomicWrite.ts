import * as fs from "node:fs";

export function atomicWriteFileSync(
  filepath: string,
  content: string,
  encoding: BufferEncoding = "utf-8",
): void {
  const tmpPath = `${filepath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, encoding);
    fs.renameSync(tmpPath, filepath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // swallow cleanup failure
    }
    throw err;
  }
}
