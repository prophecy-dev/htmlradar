// The install commands shown once, beside a freshly created API key — the one
// moment the plaintext key exists anywhere outside a hash.
//
// Every string here is the command packages/mcp/README.md documents for that
// client, with the key and this dashboard's address substituted in. The URL is
// not optional: the npm htmlradar-mcp package is upstream's, and without
// HTMLRADAR_API_URL it sends the key to htmlradar.com instead of to us. mcp-install-commands.test.ts
// pins each one character for character, so if the README moves and this does
// not, the test says so instead of a customer finding out.
//
// Pure string assembly, and deliberately so. It runs in the browser next to a
// key that is already in the tab; nothing here sends, stores, or logs anything.

export type McpInstallCommand = {
  /** Stable id, used as the React key and by the test. */
  id: string;
  /** Client name, as the row's heading. */
  client: string;
  /** Where the copied text is meant to be pasted. */
  where: string;
  /** One sentence of context under the block. */
  note: string;
  /** The exact text the copy button puts on the clipboard. */
  code: string;
};

/** The client config JSON — same shape for Claude Desktop and Cursor. */
function serverJson(key: string, apiUrl: string): string {
  return `{
  "mcpServers": {
    "htmlradar": {
      "command": "npx",
      "args": ["-y", "htmlradar-mcp"],
      "env": {
        "HTMLRADAR_API_URL": "${apiUrl}",
        "HTMLRADAR_API_KEY": "${key}"
      }
    }
  }
}`;
}

/**
 * The per-client install commands for one key, simplest path first.
 *
 * @param key A plaintext API key, e.g. hr_live_ followed by 40 hex characters.
 * @param apiUrl This dashboard's origin, e.g. https://radar.prophecyhosting.com.
 */
export function mcpInstallCommands(key: string, apiUrl: string): McpInstallCommand[] {
  return [
    {
      id: 'claude-code-add',
      client: 'Claude Code',
      where: 'terminal',
      note: 'Check it afterwards with claude mcp list.',
      code: `claude mcp add htmlradar -e HTMLRADAR_API_URL=${apiUrl} -e HTMLRADAR_API_KEY=${key} -- npx -y htmlradar-mcp`,
    },
    {
      id: 'cursor',
      client: 'Cursor',
      where: '.cursor/mcp.json',
      note: 'Project-wide in .cursor/mcp.json, or everywhere in ~/.cursor/mcp.json. Restart Cursor afterwards.',
      code: serverJson(key, apiUrl),
    },
    {
      id: 'codex',
      client: 'Codex CLI',
      where: 'terminal',
      note: 'Writes the entry into ~/.codex/config.toml for you.',
      code: `codex mcp add htmlradar --env HTMLRADAR_API_URL=${apiUrl} --env HTMLRADAR_API_KEY=${key} -- npx -y htmlradar-mcp`,
    },
    {
      id: 'claude-desktop',
      client: 'Claude Desktop',
      where: 'claude_desktop_config.json',
      note: 'Settings, then Developer, then Edit Config opens the file; paste this in, then quit and reopen Claude Desktop.',
      code: serverJson(key, apiUrl),
    },
  ];
}

/**
 * Instructions any AI with a shell can follow without installing the MCP
 * server: the API address, the calls, and when to gate a link. The key stays
 * out of it on purpose (this text gets pasted into chats and prompts); the
 * AI reads it from the HTMLRADAR_API_KEY environment variable.
 *
 * @param apiUrl This dashboard's origin, e.g. https://radar.prophecyhosting.com.
 */
export function aiInstructions(apiUrl: string): string {
  return `You can publish HTML as a tracked link through our HTMLRadar server, ${apiUrl}.
Authenticate every call with the header "Authorization: Bearer $HTMLRADAR_API_KEY"
(read the key from that environment variable; never print it or paste it anywhere).

- Publish: POST ${apiUrl}/api/v1/shares with JSON
  {"html": "<the whole HTML document>", "title": "…", "recipient_label": "who it is for",
   "require_email": false}
  The response has "url" (send that to the recipient) and "dashboard_url" (for us).
  Use one call per recipient so each person gets their own link; for more links to the
  same document, POST {"document_id": "…", "recipient_label": "…"} instead of "html".
- Gates: cold outreach and community decks: "require_email": false. RFPs and anything
  sensitive: "require_email": true, "verify_email": true (the reader proves the address
  with a code), optionally "allowed_email_domains": ["acme.com"] or "password".
- Did they read it: GET ${apiUrl}/api/v1/shares/{id}/activity (time per section).
- List: GET ${apiUrl}/api/v1/shares, GET ${apiUrl}/api/v1/documents.
- Update a sent deck: POST ${apiUrl}/api/v1/documents/{id}/replace with {"html": "…"}.
- Turn a link off: POST ${apiUrl}/api/v1/shares/{id}/revoke.

The HTML must be one self-contained file (inline CSS and images, or absolute https URLs),
at most 5 MB. Give each slide or section a heading (h1/h2/h3) so reading time is tracked
per section. Ask me before publishing, replacing or revoking anything.`;
}
