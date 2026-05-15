import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const READ_ONLY_TOOLS = [
  "read_file",
  "list_files",
  "search_in_files",
  "find_references",
] as const;

export const CHAT_TOOLS = READ_ONLY_TOOLS.filter(
  (toolName) => toolName === "read_file" || toolName === "list_files"
);

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
      // P3: output reduction - command results are already returned by the tool.
      description:
        "Run a shell command in the repo directory. Use for: npm test, npm run build, git status, checking if files exist, etc. Do not repeat successful command output in assistant prose.",
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
      name: "TodoWrite",
      strict: true,
      description:
        "Plan tracker shown to the user as a live sidebar. Call FIRST for any 2+ step task (incl. verification/builds). Skip only for true one-shot requests.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["todos"],
        properties: {
          todos: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              additionalProperties: false,
required: ["id", "content", "description", "status"],
              properties: {
                id: {
                  type: "string",
                  description: "Stable id you choose. Reuse across calls to update.",
                },
                content: {
                  type: "string",
                  description: "Short title (≤80 chars).",
                },
                description: {
                  type: ["string", "null"],
                  description: "Optional one-sentence detail.",
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed", "skipped"],
                },
              },
            },
          },
        },
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
        "Read stdout+stderr from a background process. Pass since_offset from the previous read (or null on first call). Returns up to max_bytes (default 8192). eof=true when the process exited.",
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
        "Spawn a long-running command (npm run dev, watchers, next dev) and return a handle. Use run_command for one-shot commands. Poll with read_background_output; kill_background when done.",
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
      description:
        "Read a file. ≤10K chars: full content (no line numbers — safe to copy into apply_patch FIND). " +
        ">10K: numbered head + outline + tail — use lineRange: [start, end] for the specific region you want to read or patch.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Path relative to repo root, e.g. 'src/llm/agentLoop.ts'.",
          },
          lineRange: {
            type: ["array", "null"],
            description:
              "Optional [startLine, endLine] 1-indexed inclusive. Use for focused reads of large files.",
            items: { type: "integer" },
            minItems: 2,
            maxItems: 2,
          },
        },
        required: ["filePath", "lineRange"],
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
        "FIND/REPLACE substitutions on an EXISTING file (use write_file only for new files). " +
        "Each block: --- FIND --- <verbatim lines, 1-5, unique in file> --- REPLACE --- <new lines>. " +
        "REPLACE is the literal text replacing FIND — never copy in code from elsewhere; for two separated edits use TWO blocks. " +
        "Anti-example: putting an import-line edit AND its callsite edit in one block is rejected because REPLACE then contains a line that wasn't in FIND. " +
        "Multi-block patches apply atomically in order. " +
        "intent: 'add' (REPLACE = FIND + additions, default), 'modify' (REPLACE replaces FIND, line counts may differ), 'delete' (REPLACE shorter than FIND, may be empty).",
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
              "Optional, pass null by default. Use ONLY when FIND occurs multiple times AND the target is inside a NAMED function/class. Do NOT use for unique FIND strings, arrow-function consts, default exports, or React components.",
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
      strict: false,
      description:
        "Search for a regex pattern across files in the repo. Prefer this over read_file when locating a symbol, finding usages, or checking presence of a pattern. " +
        "Supports regex (default) or literal mode, case_insensitive, glob filtering, and output_mode (content | files_with_matches | count). " +
        "Returns matches with line numbers and context. Max 500 matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern (or literal string when literal=true)" },
          fileGlob: {
            type: ["string", "null"],
            description: "File glob filter (e.g. **/*.ts); null = all files.",
          },
          literal: {
            type: ["boolean", "null"],
            description: "true = treat pattern as literal string (no regex). Default false.",
          },
          case_insensitive: {
            type: ["boolean", "null"],
            description: "true = case-insensitive match. Default false.",
          },
          multiline: {
            type: ["boolean", "null"],
            description: "true = enable multiline regex (^ and $ match line boundaries). Default false.",
          },
          output_mode: {
            type: ["string", "null"],
            enum: ["content", "files_with_matches", "count", null],
            description: "content (default) = matches with context; files_with_matches = file list only; count = per-file match counts.",
          },
          context_lines: {
            type: ["integer", "null"],
            description: "Lines of context before/after each match. Default 2. Max 10.",
          },
          glob: {
            type: ["string", "null"],
            description: "Alias for fileGlob.",
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
      name: "verify_visual",
      strict: true,
      description:
        "Screenshot a URL on the user's local dev server, AFTER UI changes. Skip for backend, types, configs, refactors. Cap: 5 per run.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description: "Path on the dev server, e.g. '/', '/login', '/#section-id' (hash anchor scrolls to and captures a specific section).",
          },
          description: {
            type: ["string", "null"],
            description:
              "Brief description of what you expect to see, e.g. 'Submit button should be disabled when form invalid'.",
          },
          viewport: {
            type: ["object", "null"],
            additionalProperties: false,
            properties: {
              width: { type: "integer" },
              height: { type: "integer" },
            },
            required: ["width", "height"],
            description: "Optional viewport size. Default 1280x720.",
          },
          waitFor: {
            type: ["string", "null"],
            description: "Optional CSS selector to wait for before screenshotting, e.g. '.feed-loaded'.",
          },
        },
        required: ["path", "description", "viewport", "waitFor"],
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
      name: "find_references",
      strict: true,
      description:
        "Find all files that import a specific symbol (AST-based, resolves aliases). More accurate than search_in_files for cross-file refactors.",
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
      name: "Task",
      description:
        "Delegate a bounded subtask to an isolated subagent. Returns a structured summary; detailed work hidden from your context. " +
        "worker = bounded multi-file implementation (read+write, no commands). " +
        "explore = read-only investigation, returns file:line findings + summary. " +
        "Only use when the task is non-trivial; see the TASK SUBAGENTS section in the system prompt for the dispatch criteria.",
      parameters: {
        type: "object",
        properties: {
          subagent_type: {
            type: "string",
            enum: ["worker", "explore"],
            description:
              "'worker' for implementation tasks (file edits). " +
              "'explore' for read-only investigation (find, read, summarize — no writes).",
          },
          description: {
            type: "string",
            description:
              "A clear, self-contained description of the subtask. The " +
              "subagent does not see your conversation history, so include " +
              "all necessary context. Specify expected outcome explicitly.",
          },
        },
        required: ["subagent_type", "description"],
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
        "Save a non-obvious project convention for future Zone sessions. Use sparingly — only for things you couldn't infer from package.json/tsconfig/structure. Good: 'API routes live in src/api/server.ts'. Bad: 'This is a TypeScript project'. At most one call per session.",
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

/**
 * Phase AS: audit-only tool available during investigateScope() runs.
 * Not in ZONE_TOOLS — only presented to the LLM when allowedTools includes
 * "suggest_scope_change" (i.e. AUDIT_ALLOWED_TOOLS).
 */
export const AUDIT_ONLY_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "suggest_scope_change",
      description:
        "Propose narrowing or expanding the approved plan after investigation reveals scope mismatch. Only call when findings show the original plan is materially wrong-sized.",
      parameters: {
        type: "object",
        required: ["reason", "type", "revised_plan_summary"],
        properties: {
          reason: {
            type: "string",
            description: "1–3 sentence justification grounded in investigation findings.",
          },
          type: {
            type: "string",
            enum: ["under_scope", "over_scope", "mixed"],
            description: "Kind of mismatch found.",
          },
          missing_files: {
            type: "array",
            items: { type: "string" },
            description: "Files the plan omits but investigation shows are required. Populate for under_scope / mixed.",
          },
          unnecessary_files: {
            type: "array",
            items: { type: "string" },
            description: "Files the plan includes but investigation shows are uninvolved. Populate for over_scope / mixed.",
          },
          revised_plan_summary: {
            type: "string",
            description: "Short revised plan to show in the approval card.",
          },
        },
        additionalProperties: false,
      } as Record<string, unknown>,
    },
  },
];
