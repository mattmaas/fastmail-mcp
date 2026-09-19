# Fastmail MCP Server

An MCP server that exposes Fastmail email via JMAP: email actions (list, get, send, draft) and masked-email alias management (create, update, delete). Drafts are written first by default unless you set `FASTMAIL_DRAFT_BY_DEFAULT=false`.

## Requirements

- Node.js 20+
- A Fastmail account with an API token

## Install

```bash
git clone https://github.com/mattmaas/fastmail-mcp.git
cd fastmail-mcp
npm install
npm run build     # compiles TypeScript to dist/
npm start         # node dist/server.js
```

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

| Tool | Description |
|------|-------------|
| `fastmail_get_account` | Account information and session details |
| `fastmail_list_emails` | List inbox or folder messages (filter by folder, unread, search) |
| `fastmail_get_email` | Get one message with a bounded plain-text body |
| `fastmail_send_email` | Send or save-as-draft a message |
| `fastmail_list_masked_emails` | List masked email aliases |
| `fastmail_create_masked_email` | Create a masked email alias |
| `fastmail_update_masked_email` | Enable, disable, or rename an alias |
| `fastmail_delete_masked_email` | Delete an alias |
| `fastmail_mark_email_read` | Mark a message read/unread |
| `fastmail_mark_email_flagged` | Flag/unflag a message |
| `fastmail_list_folders` | List mail folders |
| `fastmail_get_unread_count` | Unread count for a folder |

## Usage

Ask your agent, for example:

- "Show my unread inbox" → `fastmail_list_emails(unreadOnly=true)`
- "Draft a reply to the latest message from Alice" → `fastmail_list_emails(search="Alice")` then `fastmail_send_email(saveDraft=true, ...)`
- "Make a masked alias for this newsletter" → `fastmail_create_masked_email(...)`

## License

MIT
