# Fastmail MCP Server

An MCP server that exposes 13 tools for Fastmail via JMAP. It covers email actions (list, get, send, draft) and masked email alias management (create, delete, update). Drafts are written first by default unless you change FASTMAIL_DRAFT_BY_DEFAULT.

## Requirements

- Node.js 20+
- A Fastmail account with an API token

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FASTMAIL_API_TOKEN` | yes | Fastmail API token |
| `FASTMAIL_ACCOUNT_ID` | no | Account ID; auto-detected when omitted |
| `FASTMAIL_DRAFT_BY_DEFAULT` | no | Set to `false` to send right away instead of saving drafts |
| `FASTMAIL_SIGNATURE_NAME` | no | Name shown in the optional signature |
| `FASTMAIL_FOOTER_HTML` | no | Optional HTML footer added to sent mail |

## MCP Client Configuration

Add this server to your MCP client's config:

```json
{
  "mcpServers": {
    "fastmail": {
      "command": "node",
      "args": ["<path>/fastmail-mcp/dist/server.js"],
      "env": {
        "FASTMAIL_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

## Tools

13 tools cover JMAP email operations (list, get, send, draft), masked email management, and a draft-first safety policy.

## License

MIT
