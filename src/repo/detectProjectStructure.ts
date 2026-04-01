import type { ProjectStructure, RepoFile } from "../types/project.js";

export function detectProjectStructure(files: RepoFile[]): ProjectStructure {
  const filePaths = files.map((file) => file.path.replace(/\\/g, "/"));

  const hasClientFolder = filePaths.some((file) => file.startsWith("client/"));
  const hasServerFolder = filePaths.some((file) => file.startsWith("server/"));

  const isReactApp = filePaths.some(
    (file) =>
      file.endsWith(".jsx") ||
      file.endsWith(".tsx") ||
      file.includes("react") ||
      file.includes("App.")
  );

  const isExpressApp = filePaths.some(
    (file) =>
      file.includes("routes/") ||
      file.includes("controllers/") ||
      file.endsWith("server/index.js") ||
      file.endsWith("server/index.ts")
  );

  const hasServicesPattern = filePaths.some((file) =>
    file.includes("/services/")
  );

  const hasRoutesPattern = filePaths.some((file) =>
    file.includes("/routes/")
  );

  const hasControllersPattern = filePaths.some((file) =>
    file.includes("/controllers/")
  );

  const notes: string[] = [];

  if (hasClientFolder) notes.push("Client folder detected");
  if (hasServerFolder) notes.push("Server folder detected");
  if (isReactApp) notes.push("React-like frontend detected");
  if (isExpressApp) notes.push("Express-like backend detected");
  if (hasServicesPattern) notes.push("Services pattern detected");
  if (hasRoutesPattern) notes.push("Routes pattern detected");
  if (hasControllersPattern) notes.push("Controllers pattern detected");

  return {
    isReactApp,
    isExpressApp,
    hasClientFolder,
    hasServerFolder,
    hasServicesPattern,
    hasRoutesPattern,
    hasControllersPattern,
    notes
  };
}