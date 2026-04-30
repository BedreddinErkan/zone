"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZONE_TOOLS = void 0;
/**
 * Tool definitions for `client.responses.create` (Responses API).
 * Shape: { type: "function", name, description, parameters } - NOT nested under `function`.
 */
exports.ZONE_TOOLS = [
    {
        type: "function",
        name: "run_command",
        strict: true,
        description: "Run a shell command in the repo directory. Use for: npm test, npm run build, git status, checking if files exist, etc.",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "The command to run" },
                cwd: {
                    type: ["string", "null"],
                    description: "Working directory; pass JSON null to use the repository root (repoPath).",
                },
            },
            required: ["command", "cwd"],
            additionalProperties: false,
        },
    },
    {
        type: "function",
        name: "read_file",
        strict: true,
        description: "Read the contents of a file in the repo.",
        parameters: {
            type: "object",
            properties: {
                filePath: { type: "string", description: "Relative path from repo root" },
            },
            required: ["filePath"],
            additionalProperties: false,
        },
    },
    {
        type: "function",
        name: "list_files",
        strict: true,
        description: "List files in a directory",
        parameters: {
            type: "object",
            properties: {
                dirPath: { type: "string", description: "Relative path from repo root" },
                pattern: {
                    type: ["string", "null"],
                    description: "Glob pattern (e.g. **/*.ts); pass JSON null for default **/*.",
                },
            },
            required: ["dirPath", "pattern"],
            additionalProperties: false,
        },
    },
    {
        type: "function",
        name: "apply_patch",
        strict: true,
        description: "Apply a targeted FIND/REPLACE patch to an EXISTING file. " +
            "ALWAYS use this instead of write_file when the file already exists. " +
            "Format the patch argument as one or more blocks: " +
            "--- FIND ---\n<exact lines verbatim from read_file>\n--- REPLACE ---\n<replacement lines>\n\n" +
            "intent controls line-count enforcement:\n" +
            "  'add' (default) - REPLACE must have >= lines than FIND (insertion-only guard active).\n" +
            "  'modify' - REPLACE may have any number of lines (use when editing existing code).\n" +
            "  'delete' - REPLACE may be shorter than FIND (use when removing duplicate/wrong lines).\n\n" +
            "For intent='add': REPLACE must contain every FIND line plus your new lines - nothing more.\n" +
            "Do NOT include other existing lines from the file in REPLACE beyond the FIND anchor.\n" +
            "Keep FIND small (1-5 lines around the insertion point).",
        parameters: {
            type: "object",
            properties: {
                filePath: {
                    type: "string",
                    description: "Relative path from repo root to the file to patch",
                },
                patch: {
                    type: "string",
                    description: "One or more --- FIND --- / --- REPLACE --- blocks. " +
                        "For intent='add': REPLACE = FIND lines + your new additions only. " +
                        "For intent='modify'/'delete': REPLACE may differ in line count from FIND.",
                },
                intent: {
                    type: ["string", "null"],
                    description: "Patch intent: 'add' (default, insertion-only guard on), " +
                        "'modify' (editing lines, guard off), " +
                        "'delete' (removing lines, guard off). " +
                        "Pass null to use the default 'add' behaviour.",
                },
                scope: {
                    type: ["object", "null"],
                    description: "Scope (optional). USE ONLY when ALL of the following are true:\n" +
                        "- The FIND string appears multiple times in the file AND you need to disambiguate which occurrence.\n" +
                        "- The target location is inside a NAMED function or class declaration (e.g., function getUser(), class UserService, async function updateLead()).\n\n" +
                        "DO NOT use scope when:\n" +
                        "- The FIND string is a unique import statement, top-level export, or appears only once in the file.\n" +
                        "- The target is inside an arrow-function const (e.g., const handleClick = () => {}).\n" +
                        "- The target is inside a default export (e.g., export default function Page()). Default exports register with kind export_default, NOT as a named function.\n" +
                        "- The target is inside a React component or callback whose name is just a variable binding.\n\n" +
                        "When in doubt, OMIT scope. The patch will still be precise if the FIND string is sufficiently unique.",
                    properties: {
                        symbolName: {
                            type: "string",
                            description: 'Identifier to locate (e.g. "createAppointment"). ' +
                                'Use "__default__" for anonymous default exports.',
                        },
                        symbolKind: {
                            type: ["string", "null"],
                            enum: ["function", "arrow", "method", "class", "export_default", "any", null],
                            description: 'Narrows the search to this kind of symbol. Default: "any". ' +
                                "Pass null to use default.",
                        },
                        className: {
                            type: ["string", "null"],
                            description: "Pass the class name when symbolKind is 'method' and the method " +
                                "name might collide across classes. Pass null to skip.",
                        },
                    },
                    required: ["symbolName", "symbolKind", "className"],
                    additionalProperties: false,
                },
            },
            required: ["filePath", "patch", "intent", "scope"],
            additionalProperties: false,
        },
    },
    {
        type: "function",
        name: "write_file",
        strict: true,
        description: "Write content to a file. Use ONLY for creating NEW files that do not exist yet. " +
            "For modifying existing files use apply_patch instead - " +
            "write_file is blocked when new content is significantly shorter than the original.",
        parameters: {
            type: "object",
            properties: {
                filePath: { type: "string", description: "Relative path from repo root" },
                content: { type: "string", description: "Full file content to write" },
            },
            required: ["filePath", "content"],
            additionalProperties: false,
        },
    },
    {
        type: "function",
        name: "search_in_files",
        strict: true,
        description: "Search for a string pattern across repo files",
        parameters: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "String to search for" },
                fileGlob: {
                    type: ["string", "null"],
                    description: "Which files to search (e.g. **/*.js); pass JSON null for default **/*.",
                },
            },
            required: ["pattern", "fileGlob"],
            additionalProperties: false,
        },
    },
    {
        type: "function",
        name: "find_references",
        strict: true,
        description: "Find all files that import a specific symbol from a source file. " +
            "Uses the project's import graph (AST-based), not text search. " +
            "Use this for cross-file refactors (rename, signature change, etc.) to ensure " +
            "you find every callsite. More accurate than search_in_files for symbols.",
        parameters: {
            type: "object",
            properties: {
                sourceFile: {
                    type: "string",
                    description: "Relative path from repo root to the file that EXPORTS the symbol (e.g., 'src/services/user.ts')",
                },
                symbolName: {
                    type: "string",
                    description: "The exported symbol name (function, class, const, etc.) to find consumers for. " +
                        "Aliased imports are also resolved.",
                },
            },
            required: ["sourceFile", "symbolName"],
            additionalProperties: false,
        },
    },
];
//# sourceMappingURL=toolDefinitions.js.map