import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * Tool definitions for `client.chat.completions.create`.
 * Shape: { type: "function", function: { name, description, parameters } } - nested under `function`.
 */
export const ZONE_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "run_command",
      strict: true,
      description:
        "Run a shell command in the repo directory. Use for: npm test, npm run build, git status, checking if files exist, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run" },
          cwd: {
            type: ["string", "null"],
            description:
              "Working directory; pass JSON null to use the repository root (repoPath).",
          },
        },
        required: ["command", "cwd"],
        additionalProperties: false,
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
      name: "kill_background",
      strict: true,
      description:
        "Send a signal to a background process and wait for it to exit. Default SIGTERM with SIGKILL escalation after 2s.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["handle", "signal"],
        properties: {
          handle: { type: "string", description: "Handle returned by run_command_background." },
          signal: {
            type: ["string", "null"],
            enum: ["SIGTERM", "SIGKILL", null],
            description: "null = SIGTERM with SIGKILL escalation.",
          },
        },
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
      name: "list_background",
      strict: true,
      description:
        "List all background processes for the current run with their handles, labels, commands, and statuses. Useful if you've lost track of what's running.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: [],
        properties: {},
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
      name: "read_background_output",
      strict: true,
      description:
        "Read accumulated stdout+stderr from a background process. Pass `since_offset` from a previous read to get only new output. The first call should pass null. Returns at most max_bytes (default 8192). If the process exited, eof is true and exit_code is set.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["handle", "since_offset", "max_bytes"],
        properties: {
          handle: { type: "string" },
          since_offset: {
            type: ["integer", "null"],
            description:
              "Pass the new_offset from the previous read. null = read recent buffer (last 8192 bytes by default).",
          },
          max_bytes: {
            type: ["integer", "null"],
            description: "Max bytes to return. null = 8192. Cap 65536.",
          },
        },
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
      name: "run_command_background",
      strict: true,
      description:
        "Spawn a long-running command (dev server, watcher, file syncer) and return a handle immediately. Use this for processes that don't terminate on their own — `npm run dev`, `pytest --watch`, `next dev`. For one-shot commands (build, test once, lint), use `run_command` instead. Poll the output with `read_background_output`. Always `kill_background` when done — but processes are also auto-killed at run end. Poll sparingly: every 2–3 iterations, not every iteration.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["command", "cwd", "label"],
        properties: {
          command: { type: "string", description: "Shell command to spawn." },
          cwd: {
            type: ["string", "null"],
            description:
              "Working directory relative to repo root, or null for repo root.",
          },
          label: {
            type: ["string", "null"],
            description:
              "Short human-readable name (e.g. 'dev-server'). Optional, helps with list_background.",
          },
        },
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
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
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      strict: true,
      description: "List files in a directory",
      parameters: {
        type: "object",
        properties: {
          dirPath: { type: "string", description: "Relative path from repo root" },
          pattern: {
            type: ["string", "null"],
            description:
              "Glob pattern (e.g. **/*.ts); pass JSON null for default **/*.",
          },
        },
        required: ["dirPath", "pattern"],
        additionalProperties: false,
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      strict: true,
      description:
        "Apply targeted FIND/REPLACE substitutions to an EXISTING file. " +
        "Always use this instead of write_file when the file already exists.\n\n" +

        "## Universal contract (applies to ALL intents)\n" +
        "Each block performs ONE local substitution: the file region matching FIND is replaced verbatim by REPLACE. " +
        "Nothing else changes. There are no implicit edits, no cross-references between blocks.\n\n" +

        "REPLACE must be the literal text you want to appear in place of FIND. " +
        "It must NOT contain code copied from elsewhere in the file. " +
        "If you need to change two separated regions, use TWO blocks (see multi-block example below) - never compress two edits into one block.\n\n" +

        "Keep FIND small and unique: 1-5 lines around the change point. " +
        "Copy FIND verbatim from read_file output (whitespace and line endings matter).\n\n" +

        "## Format\n" +
        "--- FIND ---\n<exact lines from the file>\n--- REPLACE ---\n<replacement lines>\n\n" +
        "Multiple blocks in one patch arg are allowed and encouraged when several locations in the same file need editing - they apply in order, atomically.\n\n" +

        "## intent parameter\n" +
        "  'add'    - inserting new code. REPLACE must contain every FIND line plus your additions, in order.\n" +
        "  'modify' - editing existing code. REPLACE replaces FIND verbatim; line counts may differ.\n" +
        "  'delete' - removing code. REPLACE may be shorter than FIND, including empty.\n" +
        "intent controls line-count guards only. The 'one local substitution' rule above applies regardless.\n\n" +

        "## Examples\n\n" +

        "### Example 1 - single edit (intent='modify')\n" +
        "Goal: rename a function in its declaration.\n" +
        "--- FIND ---\n" +
        "export const hasClerkEnv = () =>\n" +
        "--- REPLACE ---\n" +
        "export const isClerkConfigured = () =>\n\n" +

        "### Example 2 - TWO edits in one file (multi-block, intent='modify')\n" +
        "Goal: rename an import AND its callsite in the same file. " +
        "Use TWO blocks. Do NOT collapse them into one block.\n" +
        "--- FIND ---\n" +
        "import { hasClerkEnv } from \"@/lib/env\";\n" +
        "--- REPLACE ---\n" +
        "import { isClerkConfigured } from \"@/lib/env\";\n" +
        "--- FIND ---\n" +
        "  if (!hasClerkEnv()) {\n" +
        "--- REPLACE ---\n" +
        "  if (!isClerkConfigured()) {\n\n" +

        "### Anti-example - DO NOT DO THIS\n" +
        "Wrong: compressing the import edit and the callsite edit into a single block.\n" +
        "--- FIND ---\n" +
        "import { hasClerkEnv } from \"@/lib/env\";\n" +
        "--- REPLACE ---\n" +
        "import { isClerkConfigured } from \"@/lib/env\";\n\n" +
        "  if (!isClerkConfigured()) {\n" +
        "This is invalid because REPLACE contains a line (the if-statement) that is NOT a substitution of the FIND content - it lives elsewhere in the file. The patch will be rejected and the file reverted.\n\n" +

        "### Example 3 - insertion (intent='add')\n" +
        "Goal: add a new export below an existing one.\n" +
        "--- FIND ---\n" +
        "export const hasClerkSecretKey = () =>\n" +
        "  Boolean(readEnv(\"CLERK_SECRET_KEY\"));\n" +
        "--- REPLACE ---\n" +
        "export const hasClerkSecretKey = () =>\n" +
        "  Boolean(readEnv(\"CLERK_SECRET_KEY\"));\n\n" +
        "export const hasClerkUrl = () =>\n" +
        "  Boolean(readEnv(\"CLERK_URL\"));",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Relative path from repo root to the file to patch",
          },
          patch: {
            type: "string",
            description:
              "One or more --- FIND --- / --- REPLACE --- blocks. " +
              "Each block does exactly one local substitution. " +
              "Use multiple blocks (concatenated in the same patch string) when several locations need editing - never compress unrelated edits into a single block.",
          },
          intent: {
            type: ["string", "null"],
            description:
              "Patch intent: 'add' (default, insertion-only guard on), " +
              "'modify' (editing lines, guard off), " +
              "'delete' (removing lines, guard off). " +
              "Pass null to use the default 'add' behaviour.",
          },
          scope: {
            type: ["object", "null"],
            description:
              "Scope (optional). USE ONLY when ALL of the following are true:\n" +
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
                description:
                  'Identifier to locate (e.g. "createAppointment"). ' +
                  'Use "__default__" for anonymous default exports.',
              },
              symbolKind: {
                type: ["string", "null"],
                enum: ["function", "arrow", "method", "class", "export_default", "any", null],
                description:
                  'Narrows the search to this kind of symbol. Default: "any". ' +
                  "Pass null to use default.",
              },
              className: {
                type: ["string", "null"],
                description:
                  "Pass the class name when symbolKind is 'method' and the method " +
                  "name might collide across classes. Pass null to skip.",
              },
            },
            required: ["symbolName", "symbolKind", "className"],
            additionalProperties: false,
          },
        },
        required: ["filePath", "patch", "intent", "scope"],
        additionalProperties: false,
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      strict: true,
      description:
        "Write content to a file. Use ONLY for creating NEW files that do not exist yet. " +
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
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
      name: "search_in_files",
      strict: true,
      description: "Search for a string pattern across repo files",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "String to search for" },
          fileGlob: {
            type: ["string", "null"],
            description:
              "Which files to search (e.g. **/*.js); pass JSON null for default **/*.",
          },
        },
        required: ["pattern", "fileGlob"],
        additionalProperties: false,
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
      name: "find_references",
      strict: true,
      description:
        "Find all files that import a specific symbol from a source file. " +
        "Uses the project's import graph (AST-based), not text search. " +
        "Use this for cross-file refactors (rename, signature change, etc.) to ensure " +
        "you find every callsite. More accurate than search_in_files for symbols.",
      parameters: {
        type: "object",
        properties: {
          sourceFile: {
            type: "string",
            description:
              "Relative path from repo root to the file that EXPORTS the symbol (e.g., 'src/services/user.ts')",
          },
          symbolName: {
            type: "string",
            description:
              "The exported symbol name (function, class, const, etc.) to find consumers for. " +
              "Aliased imports are also resolved.",
          },
        },
        required: ["sourceFile", "symbolName"],
        additionalProperties: false,
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
      name: "update_memory",
      strict: true,
      description:
        "Save a project-specific convention or lesson you've learned that would be useful in future Zone sessions on this repo. " +
        "Use sparingly — only for non-obvious things specific to THIS project that you couldn't infer from package.json, tsconfig, or directory structure. " +
        "Examples of good entries: 'API routes all live in src/api/server.ts', 'We use shadcn/ui for components'. " +
        "Examples of bad entries: 'This is a TypeScript project' (obvious from tsconfig.json), 'Files are in src/' (obvious from listing). " +
        "At most one call per session — pick the single most valuable convention if any.",
      parameters: {
        type: "object",
        properties: {
          entry: {
            type: "string",
            description:
              "The convention to remember. One sentence, max 200 characters. Phrase it as actionable guidance.",
            maxLength: 200,
          },
          reason: {
            type: "string",
            description:
              "Brief explanation of why this isn't obvious from the repo structure alone. Used for logging only, not stored.",
          },
        },
        required: ["entry", "reason"],
        additionalProperties: false,
      } as Record<string, unknown>,
    },
  },
];
