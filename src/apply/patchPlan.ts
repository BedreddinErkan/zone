export type FilePatch = {
  filePath: string;
  nextContent: string;
};

export type PatchPlan = {
  patches: FilePatch[];
};