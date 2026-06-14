import { execFile, spawn } from "node:child_process";

function copyToClipboardLinux(text: string): void {
  try {
    const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        try {
          const fallback = spawn("xclip", ["-selection", "clipboard"], {
            stdio: ["pipe", "ignore", "ignore"],
          });
          fallback.stdin?.write(text);
          fallback.stdin?.end();
        } catch { /* best-effort */ }
      }
    });
    proc.stdin?.write(text);
    proc.stdin?.end();
  } catch { /* best-effort */ }
}

export function copyToClipboard(text: string): void {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      const proc = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
      proc.stdin?.write(text);
      proc.stdin?.end();
    } else if (platform === "win32") {
      const proc = spawn("clip", [], { stdio: ["pipe", "ignore", "ignore"] });
      proc.stdin?.write(text);
      proc.stdin?.end();
    } else {
      copyToClipboardLinux(text);
    }
  } catch { /* best-effort */ }
}

export function openMailtoFeedback(subject: string, body: string): void {
  try {
    const cappedBody = body.length > 1800 ? body.slice(0, 1800) + "…" : body;
    const url =
      "mailto:feedback@zonecli.dev" +
      "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(cappedBody);
    const platform = process.platform;
    const cmd =
      platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url] }
        : platform === "darwin"
          ? { file: "open", args: [url] }
          : { file: "xdg-open", args: [url] };
    execFile(cmd.file, cmd.args, () => undefined);
  } catch { /* best-effort */ }
}
