"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const validatePatchPlan_js_1 = require("./validatePatchPlan.js");
const fileUtils = __importStar(require("../utils/files.js"));
(0, vitest_1.describe)("validatePatchPlan", () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.restoreAllMocks();
    });
    (0, vitest_1.it)("returns error when patch item is missing target path", async () => {
        vitest_1.vi.spyOn(fileUtils, "fileExists").mockResolvedValue(false);
        const result = await (0, validatePatchPlan_js_1.validatePatchPlan)({
            targetPath: "/repo",
            patchPlan: {
                patches: [
                    {
                        path: "",
                        operation: "modify",
                        contentPreview: "test",
                    },
                ],
            },
        });
        (0, vitest_1.expect)(result.isValid).toBe(false);
        (0, vitest_1.expect)(result.issues).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "MISSING_TARGET_PATH",
                level: "error",
            }),
        ]));
    });
    (0, vitest_1.it)("returns error for unsupported operation", async () => {
        vitest_1.vi.spyOn(fileUtils, "fileExists").mockResolvedValue(false);
        const result = await (0, validatePatchPlan_js_1.validatePatchPlan)({
            targetPath: "/repo",
            patchPlan: {
                patches: [
                    {
                        path: "src/test.ts",
                        operation: "delete",
                        contentPreview: "x",
                    },
                ],
            },
        });
        (0, vitest_1.expect)(result.isValid).toBe(false);
        (0, vitest_1.expect)(result.issues).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "UNSUPPORTED_OPERATION",
                level: "error",
            }),
        ]));
    });
    (0, vitest_1.it)("returns warning for empty content preview", async () => {
        vitest_1.vi.spyOn(fileUtils, "fileExists").mockResolvedValue(true);
        const result = await (0, validatePatchPlan_js_1.validatePatchPlan)({
            targetPath: "/repo",
            patchPlan: {
                patches: [
                    {
                        path: "src/test.ts",
                        operation: "modify",
                        contentPreview: "",
                    },
                ],
            },
        });
        (0, vitest_1.expect)(result.issues).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "EMPTY_CONTENT_PREVIEW",
                level: "warning",
            }),
        ]));
    });
    (0, vitest_1.it)("returns warning when multiple patches target the same file", async () => {
        vitest_1.vi.spyOn(fileUtils, "fileExists").mockResolvedValue(true);
        const result = await (0, validatePatchPlan_js_1.validatePatchPlan)({
            targetPath: "/repo",
            patchPlan: {
                patches: [
                    {
                        path: "src/test.ts",
                        operation: "modify",
                        contentPreview: "a",
                    },
                    {
                        path: "src/test.ts",
                        operation: "modify",
                        contentPreview: "b",
                    },
                ],
            },
        });
        (0, vitest_1.expect)(result.issues).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "DUPLICATE_TARGET_PATH",
                level: "warning",
            }),
        ]));
    });
    (0, vitest_1.it)("returns warning when create targets an existing file", async () => {
        vitest_1.vi.spyOn(fileUtils, "fileExists").mockResolvedValue(true);
        const result = await (0, validatePatchPlan_js_1.validatePatchPlan)({
            targetPath: "/repo",
            patchPlan: {
                patches: [
                    {
                        path: "src/existing.ts",
                        operation: "create",
                        contentPreview: "content",
                    },
                ],
            },
        });
        (0, vitest_1.expect)(result.isValid).toBe(true);
        (0, vitest_1.expect)(result.issues).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "CREATE_TARGET_ALREADY_EXISTS",
                level: "warning",
            }),
        ]));
    });
    (0, vitest_1.it)("returns error when modify targets missing file", async () => {
        vitest_1.vi.spyOn(fileUtils, "fileExists").mockResolvedValue(false);
        const result = await (0, validatePatchPlan_js_1.validatePatchPlan)({
            targetPath: "/repo",
            patchPlan: {
                patches: [
                    {
                        path: "src/missing.ts",
                        operation: "modify",
                        contentPreview: "content",
                    },
                ],
            },
        });
        (0, vitest_1.expect)(result.isValid).toBe(false);
        (0, vitest_1.expect)(result.issues).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "MODIFY_TARGET_MISSING",
                level: "error",
            }),
        ]));
    });
    (0, vitest_1.it)("returns error when patch path escapes repository root", async () => {
        vitest_1.vi.spyOn(fileUtils, "fileExists").mockResolvedValue(false);
        const result = await (0, validatePatchPlan_js_1.validatePatchPlan)({
            targetPath: "/repo",
            patchPlan: {
                patches: [
                    {
                        path: "../secret.txt",
                        operation: "modify",
                        contentPreview: "content",
                    },
                ],
            },
        });
        (0, vitest_1.expect)(result.isValid).toBe(false);
        (0, vitest_1.expect)(result.issues).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "PATH_OUTSIDE_REPO",
                level: "error",
            }),
        ]));
    });
    (0, vitest_1.it)("returns error for protected file targets", async () => {
        vitest_1.vi.spyOn(fileUtils, "fileExists").mockResolvedValue(true);
        const result = await (0, validatePatchPlan_js_1.validatePatchPlan)({
            targetPath: "/repo",
            patchPlan: {
                patches: [
                    {
                        path: ".env",
                        operation: "modify",
                        contentPreview: "SECRET=1",
                    },
                ],
            },
        });
        (0, vitest_1.expect)(result.isValid).toBe(false);
        (0, vitest_1.expect)(result.issues).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "TARGETS_PROTECTED_FILE",
                level: "error",
            }),
        ]));
    });
    (0, vitest_1.it)("returns warning for node_modules target", async () => {
        vitest_1.vi.spyOn(fileUtils, "fileExists").mockResolvedValue(true);
        const result = await (0, validatePatchPlan_js_1.validatePatchPlan)({
            targetPath: "/repo",
            patchPlan: {
                patches: [
                    {
                        path: "node_modules/pkg/index.js",
                        operation: "modify",
                        contentPreview: "content",
                    },
                ],
            },
        });
        (0, vitest_1.expect)(result.issues).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "TARGETS_NODE_MODULES",
                level: "warning",
            }),
        ]));
    });
    (0, vitest_1.it)("returns warning for internal agent artifact target", async () => {
        vitest_1.vi.spyOn(fileUtils, "fileExists").mockResolvedValue(true);
        const result = await (0, validatePatchPlan_js_1.validatePatchPlan)({
            targetPath: "/repo",
            patchPlan: {
                patches: [
                    {
                        path: ".agent-patches/test.txt",
                        operation: "modify",
                        contentPreview: "content",
                    },
                ],
            },
        });
        (0, vitest_1.expect)(result.issues).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                code: "TARGETS_AGENT_ARTIFACT",
                level: "warning",
            }),
        ]));
    });
    (0, vitest_1.it)("returns valid when patch plan is clean", async () => {
        vitest_1.vi.spyOn(fileUtils, "fileExists").mockResolvedValue(true);
        const result = await (0, validatePatchPlan_js_1.validatePatchPlan)({
            targetPath: "/repo",
            patchPlan: {
                patches: [
                    {
                        path: "src/feature.ts",
                        operation: "modify",
                        contentPreview: "const x = 1;",
                    },
                ],
            },
        });
        (0, vitest_1.expect)(result.isValid).toBe(true);
        (0, vitest_1.expect)(result.issues).toHaveLength(0);
    });
});
//# sourceMappingURL=validatePatchPlan.test.js.map