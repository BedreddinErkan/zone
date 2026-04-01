export interface RepoFile {
  path: string;
  absolutePath: string;
  extension: string;
  category: "frontend" | "backend" | "shared" | "unknown";
}

export interface ProjectStructure {
  isReactApp: boolean;
  isExpressApp: boolean;
  hasClientFolder: boolean;
  hasServerFolder: boolean;
  hasServicesPattern: boolean;
  hasRoutesPattern: boolean;
  hasControllersPattern: boolean;
  notes: string[];
}