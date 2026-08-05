import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const READ_ONLY_TOOLS = [
  "read_file",
  "list_files",
  "search_in_files",
  "find_references",
] as const;

/** Tool set for plan-mode investigation: read-only tools + run_command for build/test/repro.
 *  Excludes apply_patch, write_file, and run_command_background. */
export const INVESTIGATION_TOOLS = [
  ...READ_ONLY_TOOLS,
  "run_command",
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
      description:
        "Run a one-shot shell command in the repo. stdout AND stderr are captured together and truncated to head 100 + tail 50 lines with a [exit_code=N] header. Run BARE commands — do NOT add 2>&1, pipes (| head), or redirects; they are redundant (output is already captured) and block auto-approval. Use for: npm run build, npm test, npx tsc --noEmit, git status. Do not repeat successful output in prose.",
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
        "Live plan sidebar. Call FIRST for any 2+ step task. Skip for true one-shot requests only.",
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
          include_ignored: {
            type: ["boolean", "null"],
            description:
              "true = also list build/VCS dirs (node_modules, .next, dist, …) and .gitignore'd paths. Default (null/false) excludes them.",
          },
        },
        required: ["dirPath", "pattern", "include_ignored"],
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
        "Patch an EXISTING file (write_file for new files). Format:\n" +
        "--- FIND ---\n<verbatim lines, unique>\n--- REPLACE ---\n<new content>\n\n" +
        "FIND must match exactly — re-read if unsure. " +
        "N edits to a file → ONE call with N blocks; all blocks apply atomically.",
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
              "Same-file edits (rename, codemod): emit ALL blocks in ONE call — never split same-file edits across multiple apply_patch calls. " +
              "Never compress unrelated edits into a single block. " +
              "All replacement content, including additions above the matched lines, goes inside `--- REPLACE ---`; nothing may precede `--- FIND ---`.",
          },
          intent: {
            type: ["string", "null"],
            enum: ["add", "modify", "delete", null],
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
      name: "multi_edit",
      strict: true,
      description:
        "Exact-string find/replace in ONE call: one find/replace pair applied across all listed files. " +
        "Use for renames, codemods, or editing a region within a single large file (call once per region — " +
        "each call reads staged content, so successive calls see prior edits). " +
        "Supply find/replace strings and the file list — " +
        "the tool reads each file fully and replaces all occurrences atomically via staging. " +
        "wholeWord (default true) adds \\b boundaries — protects compound identifiers. " +
        "Returns per-file replacement counts; count=0 for a file means find was not present.",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "Relative paths from repo root.",
          },
          find: {
            type: "string",
            description: "Exact string to find (not a regex).",
          },
          replace: {
            type: "string",
            description: "Replacement string.",
          },
          wholeWord: {
            type: ["boolean", "null"],
            description:
              "true (default): only match at identifier boundaries (\\b) — safe for symbol renames. " +
              "false: literal substring replace-all.",
          },
        },
        required: ["files", "find", "replace", "wholeWord"],
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
        "Regex search across files. Prefer over read_file for symbols or usage. " +
        "Modes: content (default), files_with_matches, count. Supports literal, case_insensitive, glob, context_lines. Max 500 matches.",
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
          include_ignored: {
            type: ["boolean", "null"],
            description:
              "true = also search build/VCS dirs (node_modules, .next, dist, …) and .gitignore'd paths. Default excludes them.",
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
        "Delegate to subagent. worker: multi-file impl (read+write). " +
        "explore: read-only investigation (file:line findings). " +
        "Only for non-trivial tasks.",
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
  // Phase AS / X.0: audit-gated tool, now in ZONE_TOOLS for unified tool array.
  // Exposed to the LLM in all modes. In investigation mode it records a
  // scope-revision proposal. In execute/patch mode, under ZONE_PLAN_REPLAN=1
  // (medium/complex tiers), it triggers an adaptive replan; otherwise no-op.
  {
    type: "function",
    function: {
      name: "suggest_scope_change",
      description:
        "Signal wrong-sizing (under_scope/over_scope), e.g. a must-edit file outside scope. Only call with concrete findings.",
      parameters: {
        type: "object",
        required: ["reason", "type", "revised_plan_summary"],
        properties: {
          reason: {
            type: "string",
            description: "1–3 sentence justification grounded in concrete findings (from investigation, or from what execution revealed).",
          },
          type: {
            type: "string",
            enum: ["under_scope", "over_scope", "mixed"],
            description: "Kind of mismatch found.",
          },
          missing_files: {
            type: "array",
            items: { type: "string" },
            description: "Files the plan omits but that are required. Populate for under_scope / mixed.",
          },
          unnecessary_files: {
            type: "array",
            items: { type: "string" },
            description: "Files the plan includes but that are uninvolved. Populate for over_scope / mixed.",
          },
          revised_plan_summary: {
            type: "string",
            description: "Short summary of the revised plan.",
          },
        },
        additionalProperties: false,
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
      name: "run_command_readonly",
      strict: true,
      description:
        "Execute a read-only shell command from a strict whitelist (test runners, type checks, lint, read-only git/filesystem inspection). Use this to reproduce failing tests, see actual error messages, run typecheck, or inspect git state. Output truncated to head 100 + tail 50 lines. Timeout: 120s. Blocked: file mutations, network mutations, package installs, shell substitution, chain operators, sudo. For file contents or line ranges, use read_file(lineRange) — not sed/awk.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The command to run. Must match a whitelist prefix (e.g. 'npx vitest run path/to/test.ts', 'tsc --noEmit', 'git diff'). No shell substitution, no chain operators.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      strict: true,
      description:
        "Ask the user one blocking question and wait. Only when the answer changes what you build and the repo cannot tell you. See ASK_USER in the system prompt for when not to.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The question, written so it can be answered in a sentence. Include the concrete options and the default you will take if the user declines.",
          },
        },
        required: ["question"],
        additionalProperties: false,
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
      name: "revert_patch",
      strict: true,
      description:
        "Undo a file's changes from this run, restoring it to pre-run state. Only valid for files you modified in this run.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path of the file to revert.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      } as Record<string, unknown>,
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      strict: true,
      description:
        "Fetch the content of a URL and return it as readable text. HTML pages are stripped to their text content. Use for reading documentation, release notes, or any publicly accessible page. Only http:// and https:// URLs are supported; private/internal addresses are blocked for security.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch (must use http:// or https://).",
          },
        },
        required: ["url"],
        additionalProperties: false,
      } as Record<string, unknown>,
    },
  },
];
