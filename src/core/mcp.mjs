/*
 * MCP integration — pragmatic shim.
 *
 * A full MCP protocol client is not needed to let a workflow call out to
 * Linear/Notion/Figma/GitHub. For now, `.claude/mcp.json` maps each
 * server.tool pair to a shell command template:
 *
 *   {
 *     "linear": {
 *       "create_issue": "linear issue create --title={{title}} --team={{team}}"
 *     },
 *     "github": {
 *       "create_issue": "gh issue create --title={{title}} --body={{body}} --repo={{repo}}"
 *     }
 *   }
 *
 * The `mcp` node kind reads this file, resolves `<server>.<tool>`, substitutes
 * `{{key}}` placeholders with values from `spec.args`, and runs the resulting
 * command. Output is captured on stdout/stderr and returned to downstream
 * nodes. A later pass can swap this out for a real MCP client; the handler
 * surface stays the same.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MCP_FILE = '.claude/mcp.json';

/** Load the mcp config for a repo. Returns {} when the file is missing. */
export function loadMcpConfig(repoRoot) {
  if (!repoRoot) return {};
  const file = path.join(repoRoot, MCP_FILE);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}

/** Resolve a server.tool to a shell command template, or null. */
export function resolveTool(config, server, tool) {
  const entry = config?.[server]?.[tool];
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry.command === 'string') return entry.command;
  return null;
}

/** Interpolate {{key}} tokens with values from args, shell-quoting each. */
export function interpolate(template, args) {
  return String(template).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, key) => {
    const v = args?.[key];
    return v == null ? '' : shellQuote(String(v));
  });
}

function shellQuote(s) {
  if (/^[A-Za-z0-9_.\/@:=-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

/** Shorthand publish targets map to MCP calls. */
export const PUBLISH_TO_MCP = {
  'linear-issue':   { server: 'linear',   tool: 'create_issue' },
  'notion-page':    { server: 'notion',   tool: 'create_page' },
  'figma-comment':  { server: 'figma',    tool: 'post_comment' },
  'github-issue':   { server: 'github',   tool: 'create_issue' },
};
