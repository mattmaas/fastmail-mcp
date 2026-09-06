/**
 * Fastmail MCP Server
 *
 * MCP server for Fastmail email operations using JMAP.
 * Supports email management, masked emails, calendars, and contacts.
 *
 * Environment Variables:
 * - FASTMAIL_API_TOKEN: Your Fastmail API token (generate in Settings > API tokens)
 * - FASTMAIL_ACCOUNT_ID: (Optional) Specific account ID to use
 * - FASTMAIL_DRAFT_BY_DEFAULT: "false" to send directly when saveDraft is omitted
 *   (default: "true" — see the draft-first policy below)
 * - FASTMAIL_SIGNATURE_NAME: (Optional) Name the agent should sign outgoing mail as
 * - FASTMAIL_FOOTER_HTML: (Optional) Raw HTML appended to every HTML email — e.g. a
 *   small "sent with" badge. Empty/unset means no footer is added.
 *
 * Implementation notes:
 * - initSession() is called eagerly at startup so accountId is always populated
 * - Email/query returns ids only, so it is followed by Email/get for full data
 * - Email "from" is handled as a {name, email} object throughout
 * - Sending uses the correct JMAP flow: Email/set + EmailSubmission/set
 * - saveDraft resolves the real Drafts mailbox id and a real Identity before Email/set
 *
 * ## AGENT EMAIL POLICY (read before calling fastmail_send_email):
 *
 * DEFAULT BEHAVIOR — save as draft unless the context clearly implies otherwise:
 *   - New contacts, sensitive topics, negotiations, legal/financial matters → ALWAYS draft
 *   - Routine follow-ups to established contacts → agent discretion, draft preferred
 *   - Explicit instruction to "send" → send directly
 *   - Time-sensitive automated alerts where the owner is unavailable → send directly
 *
 * IDENTITY POLICY:
 *   - Mail is sent as the account's own Fastmail identity. An agent must never sign
 *     as an AI, bot, or assistant, and must never invent a sender identity.
 *   - If FASTMAIL_SIGNATURE_NAME is set, sign off as that name; otherwise sign off
 *     naturally for the account owner, and include title/company only when the
 *     context calls for it.
 *   - Any machine-authorship marker belongs in FASTMAIL_FOOTER_HTML, not in the body.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Optional: name the agent should sign outgoing mail as (surfaced to the model).
const SIGNATURE_NAME = process.env.FASTMAIL_SIGNATURE_NAME ?? "";

// ============================================================================
// Configuration & Client
// ============================================================================

const FASTMAIL_API_TOKEN = process.env.FASTMAIL_API_TOKEN;
const FASTMAIL_ACCOUNT_ID_ENV = process.env.FASTMAIL_ACCOUNT_ID;

if (!FASTMAIL_API_TOKEN) {
  console.error("❌ Missing required environment variable:");
  console.error("   FASTMAIL_API_TOKEN - Your Fastmail API token (generate in Settings > API tokens)");
  process.exit(1);
}

// JMAP capabilities to request in every call
const JMAP_USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
];

class FastmailClient {
  private baseUrl = "https://api.fastmail.com";
  private auth: string;
  private _accountId: string | null = null;
  private _jmapUrl: string | null = null;
  private _sessionInitialized = false;
  private _initPromise: Promise<void> | null = null;

  constructor() {
    this.auth = FASTMAIL_API_TOKEN!;
  }

  // ── Public accessor (exposes accountId for tools and tests) ───────────────
  get accountId(): string | null {
    return FASTMAIL_ACCOUNT_ID_ENV || this._accountId;
  }

  get jmapUrl(): string | null {
    return this._jmapUrl;
  }

  get sessionInitialized(): boolean {
    return this._sessionInitialized;
  }

  // ── Raw HTTP helper ────────────────────────────────────────────────────────
  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Bearer ${this.auth}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Fastmail API error (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  // ── Session init ──────────────────────────────────────────────────────────
  /**
   * Fetches the JMAP Session object and caches accountId + apiUrl.
   * Safe to call multiple times – subsequent calls are no-ops.
   * Thread-safe: concurrent calls coalesce onto the same promise.
   */
  async initSession(): Promise<void> {
    if (this._sessionInitialized) return;

    // Coalesce concurrent init calls
    if (this._initPromise) {
      return this._initPromise;
    }

    this._initPromise = (async () => {
      const session = await this.request<{
        primaryAccounts: Record<string, string>;
        accounts: Record<string, { name: string; isPersonal: boolean }>;
        apiUrl: string;
        downloadUrl: string;
        uploadUrl: string;
        eventSourceUrl: string;
      }>("/jmap/session");

      // Fastmail returns primaryAccounts keyed by capability
      // The mail account is under "urn:ietf:params:jmap:mail"
      const mailCapabilityKey = "urn:ietf:params:jmap:mail";
      const resolvedAccountId =
        FASTMAIL_ACCOUNT_ID_ENV ||
        session.primaryAccounts?.[mailCapabilityKey] ||
        Object.keys(session.accounts || {})[0];

      if (!resolvedAccountId) {
        throw new Error("Could not resolve Fastmail accountId from session");
      }

      this._accountId = resolvedAccountId;
      this._jmapUrl = session.apiUrl.replace(/\/$/, "");
      this._sessionInitialized = true;
    })();

    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  // ── Low-level JMAP request ─────────────────────────────────────────────────
  /**
   * Sends a raw JMAP request. Does NOT inject accountId automatically.
   * Callers are responsible for including accountId in each method's args.
   */
  async jmapRequest<T>(methodCalls: Array<[string, Record<string, unknown>, string]>): Promise<T> {
    if (!this._sessionInitialized) {
      await this.initSession();
    }

    const response = await fetch(this._jmapUrl!, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.auth}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        using: JMAP_USING,
        methodCalls,          // JMAP spec: [methodName, arguments, clientId]
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Fastmail JMAP error (${response.status}): ${errorText}`);
    }

    const result = await response.json() as {
      methodResponses: Array<[string, unknown, string]>;
    };

    if (!result.methodResponses || result.methodResponses.length === 0) {
      throw new Error("No methodResponses in JMAP response");
    }

    const [methodName, responseData] = result.methodResponses[0];

    // JMAP error responses have methodName "error"
    if (methodName === "error") {
      const err = responseData as { type: string; description?: string };
      throw new Error(`JMAP error [${err.type}]: ${err.description || "unknown"}`);
    }

    return responseData as T;
  }

  // ── High-level call (injects accountId) ────────────────────────────────────
  /**
   * Convenience wrapper: injects accountId into each method's arguments.
   * Returns the first methodResponse's data.
   */
  async call<T>(
    methodName: string,
    args: Record<string, unknown> = {},
    clientId = "r0"
  ): Promise<T> {
    if (!this._sessionInitialized) {
      await this.initSession();
    }

    const accountId = this.accountId;
    if (!accountId) throw new Error("Fastmail session not initialized");

    return this.jmapRequest<T>([[methodName, { ...args, accountId }, clientId]]);
  }

  /**
   * Multi-method call – returns all methodResponses (not just the first).
   */
  async callMulti(
    methods: Array<[string, Record<string, unknown>]>
  ): Promise<Array<[string, unknown, string]>> {
    if (!this._sessionInitialized) {
      await this.initSession();
    }

    const accountId = this.accountId;
    if (!accountId) throw new Error("Fastmail session not initialized");

    const methodCalls = methods.map(
      ([name, args], i): [string, Record<string, unknown>, string] => [
        name,
        { ...args, accountId },
        `r${i}`,
      ]
    );

    if (!this._jmapUrl) throw new Error("JMAP URL not set");

    const response = await fetch(this._jmapUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.auth}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ using: JMAP_USING, methodCalls }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Fastmail JMAP error (${response.status}): ${errorText}`);
    }

    const result = await response.json() as {
      methodResponses: Array<[string, unknown, string]>;
    };

    return result.methodResponses || [];
  }

  // ── Session info (for fastmail_get_account tool) ───────────────────────────
  async getSessionInfo() {
    return this.request<{
      username: string;
      primaryAccounts: Record<string, string>;
      accounts: Record<string, { name: string; isPersonal: boolean }>;
      apiUrl: string;
    }>("/jmap/session");
  }
}

// Singleton client — session is initialized lazily on first call
const client = new FastmailClient();

// ============================================================================
// Types
// ============================================================================

interface EmailAddress {
  name: string;
  email: string;
}

interface EmailSummary {
  id: string;
  subject: string;
  from: EmailAddress | null;
  to: EmailAddress[];
  cc?: EmailAddress[];
  date: string;
  preview: string;
  isUnread: boolean;
  isFlagged: boolean;
  hasAttachment: boolean;
  folderId: string;
}

interface EmailDetail extends EmailSummary {
  bcc?: EmailAddress[];
  textBody?: string;
  htmlBody?: string;
  attachments?: Array<{ id: string; name: string; contentType: string; size: number }>;
}

interface MaskedEmailRecord {
  id: string;
  email: string;
  forDomain?: string;
  description: string;
  state: "pending" | "enabled" | "disabled";
  createdAt: string;
}

// ============================================================================
// Tool Definitions
// ============================================================================

const TOOL_DEFINITIONS = [
  {
    name: "fastmail_get_account",
    description: "Get Fastmail account information and session details.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "fastmail_list_emails",
    description: "List emails from your inbox or other folders. Supports filtering by folder, read status, and search.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", default: "inbox", description: "Folder name (inbox, sent, drafts, trash, spam)" },
        limit: { type: "number", default: 20, description: "Number of emails to return (max 100)" },
        unreadOnly: { type: "boolean", default: false, description: "Only show unread emails" },
        search: { type: "string", description: "Search term to filter emails" }
      },
      additionalProperties: false
    }
  },
  {
    name: "fastmail_get_email",
    description: "Get detailed information about a specific email by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "The email ID" }
      },
      required: ["emailId"],
      additionalProperties: false
    }
  },
  {
    name: "fastmail_send_email",
    description: `Compose and send (or save as draft) an email from the account's own Fastmail identity.

IMPORTANT — DEFAULT TO DRAFT: unless the context clearly implies the email should go out immediately (explicit instruction, routine automated alert, or an established-contact follow-up), save it as a draft so a human can review before it sends. Omit saveDraft to use the configured default (draft-first unless FASTMAIL_DRAFT_BY_DEFAULT=false).

Send as the account owner. Never add AI/agent signatures or self-identification; any machine-authorship marker is configured server-side via FASTMAIL_FOOTER_HTML.${SIGNATURE_NAME ? `\n\nSign off as: ${SIGNATURE_NAME}.` : ""}`,
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
        cc: { type: "array", items: { type: "string" }, description: "CC recipients" },
        bcc: { type: "array", items: { type: "string" }, description: "BCC recipients" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body (plain text)" },
        htmlBody: { type: "string", description: "Email body (HTML). The configured FASTMAIL_FOOTER_HTML, if any, is appended as a footer." },
        from: { type: "string", description: "From address (optional, uses default identity if not specified)" },
        saveDraft: { type: "boolean", description: "If true, save to Drafts folder for human review instead of sending. Default preference is true — only set false when immediate send is clearly appropriate." }
      },
      required: ["to", "subject"],
      additionalProperties: false
    }
  },
  {
    name: "fastmail_list_masked_emails",
    description: "List all masked email addresses (privacy-focused aliases).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "fastmail_create_masked_email",
    description: "Create a new masked email address for privacy protection.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "The masked email address to create (e.g., 'myname@domain.com')" },
        description: { type: "string", description: "Description for this masked email" },
        forDomain: { type: "string", description: "Domain to create the masked email for (optional)" }
      },
      required: ["email", "description"],
      additionalProperties: false
    }
  },
  {
    name: "fastmail_update_masked_email",
    description: "Update a masked email (enable, disable, or change description).",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "The masked email ID" },
        state: { type: "string", enum: ["enabled", "disabled", "pending"], description: "New state for the masked email" },
        description: { type: "string", description: "New description (optional)" }
      },
      required: ["emailId", "state"],
      additionalProperties: false
    }
  },
  {
    name: "fastmail_delete_masked_email",
    description: "Delete a masked email address.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "The masked email ID to delete" }
      },
      required: ["emailId"],
      additionalProperties: false
    }
  },
  {
    name: "fastmail_mark_email_read",
    description: "Mark an email as read or unread.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "The email ID" },
        read: { type: "boolean", default: true, description: "Mark as read (true) or unread (false)" }
      },
      required: ["emailId"],
      additionalProperties: false
    }
  },
  {
    name: "fastmail_mark_email_flagged",
    description: "Flag or unflag an email (star).",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "The email ID" },
        flagged: { type: "boolean", default: true, description: "Flag (true) or unflag (false)" }
      },
      required: ["emailId"],
      additionalProperties: false
    }
  },
  {
    name: "fastmail_list_folders",
    description: "List all email folders.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "fastmail_get_unread_count",
    description: "Get unread email count for inbox or a specific folder.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", default: "inbox", description: "Folder name (default: inbox)" }
      },
      additionalProperties: false
    }
  }
];

// ============================================================================
// Helpers
// ============================================================================

function parseAddresses(raw: string[]): EmailAddress[] {
  return raw.map(e => {
    const match = e.match(/^"?(.+?)"?\s*<(.+)>$/) || e.match(/^(.+?)\s+(.+@.+)$/);
    if (match) return { name: match[1].trim(), email: match[2].trim() };
    return { name: e.split("@")[0], email: e };
  });
}

/** Resolve a folder name (e.g. "inbox") to its JMAP Mailbox id */
async function resolveFolderId(folderName: string): Promise<{ id: string; name: string }> {
  const resp = await client.call<{
    list: Array<{ id: string; name: string; role: string }>;
  }>("Mailbox/get", { properties: ["id", "name", "role"] });

  const lc = folderName.toLowerCase();
  const found = resp.list.find(f =>
    f.name.toLowerCase() === lc ||
    (lc === "inbox" && f.role === "inbox") ||
    (lc === "sent" && f.role === "sent") ||
    (lc === "drafts" && (f.role === "drafts" || f.role === "draft")) ||
    (lc === "trash" && f.role === "trash") ||
    (lc === "spam" && (f.role === "spam" || f.role === "junk"))
  );

  if (!found) throw new Error(`Folder "${folderName}" not found`);
  return found;
}

// ============================================================================
// Tool Handlers
// ============================================================================

async function handleGetAccount() {
  // initSession is idempotent — safe to call here for explicit initialization
  await client.initSession();

  const session = await client.getSessionInfo();

  return {
    username: session.username,
    accountId: client.accountId,
    accounts: Object.entries(session.accounts || {}).map(([id, info]) => ({
      id,
      name: info.name,
      isPersonal: info.isPersonal
    })),
    primaryAccounts: session.primaryAccounts,
    jmapApiUrl: session.apiUrl,
    sessionInitialized: client.sessionInitialized,
    note: "JMAP session is initialized and ready. accountId is cached."
  };
}

async function handleListEmails(args: {
  folder?: string;
  limit?: number;
  unreadOnly?: boolean;
  search?: string;
}) {
  const folder = await resolveFolderId(args.folder || "inbox");

  // Step 1: Email/query — returns a list of matching email IDs
  const queryResp = await client.call<{
    ids: string[];
    total: number;
    position: number;
  }>("Email/query", {
    filter: {
      inMailbox: folder.id,
      ...(args.unreadOnly ? { notKeyword: "$seen" } : {}),
      ...(args.search ? { text: args.search } : {}),
    },
    sort: [{ property: "receivedAt", isAscending: false }],
    limit: Math.min(args.limit ?? 20, 100),
    calculateTotal: true,
  });

  if (!queryResp.ids || queryResp.ids.length === 0) {
    return { emails: [], folder: folder.name, folderId: folder.id, total: 0 };
  }

  // Step 2: Email/get — fetch actual email data for those IDs
  const getResp = await client.call<{
    list: Array<{
      id: string;
      subject?: string;
      from?: EmailAddress[];
      to?: EmailAddress[];
      cc?: EmailAddress[];
      receivedAt?: string;
      sentAt?: string;
      preview?: string;
      keywords?: Record<string, boolean>;
      hasAttachment?: boolean;
      mailboxIds?: Record<string, boolean>;
    }>;
    notFound: string[];
  }>("Email/get", {
    ids: queryResp.ids,
    properties: [
      "id", "subject", "from", "to", "cc", "receivedAt", "sentAt",
      "preview", "keywords", "hasAttachment", "mailboxIds"
    ],
  });

  const emails: EmailSummary[] = (getResp.list || []).map(e => ({
    id: e.id,
    subject: e.subject || "(No Subject)",
    from: e.from?.[0] ?? null,
    to: e.to ?? [],
    cc: e.cc ?? [],
    date: e.receivedAt || e.sentAt || "",
    preview: (e.preview ?? "").substring(0, 200),
    isUnread: !(e.keywords?.["$seen"]),
    isFlagged: !!(e.keywords?.["$flagged"]),
    hasAttachment: e.hasAttachment ?? false,
    folderId: folder.id,
  }));

  return {
    emails,
    folder: folder.name,
    folderId: folder.id,
    total: queryResp.total,
    returned: emails.length,
    note: "Use 'id' with fastmail_get_email for full body content"
  };
}

async function handleGetEmail(args: { emailId: string }): Promise<EmailDetail> {
  const resp = await client.call<{
    list: Array<{
      id: string;
      subject?: string;
      from?: EmailAddress[];
      to?: EmailAddress[];
      cc?: EmailAddress[];
      bcc?: EmailAddress[];
      receivedAt?: string;
      sentAt?: string;
      preview?: string;
      bodyValues?: Record<string, { value: string; isTruncated: boolean }>;
      textBody?: Array<{ partId: string; type: string }>;
      htmlBody?: Array<{ partId: string; type: string }>;
      keywords?: Record<string, boolean>;
      hasAttachment?: boolean;
      attachments?: Array<{ blobId: string; name?: string; type?: string; size?: number }>;
      mailboxIds?: Record<string, boolean>;
    }>;
    notFound: string[];
  }>("Email/get", {
    ids: [args.emailId],
    properties: [
      "id", "subject", "from", "to", "cc", "bcc",
      "receivedAt", "sentAt", "preview",
      "bodyValues", "textBody", "htmlBody",
      "keywords", "hasAttachment", "attachments", "mailboxIds"
    ],
    fetchTextBodyValues: true,
    fetchHTMLBodyValues: true,
    maxBodyValueBytes: 65536,
  });

  if (!resp.list || resp.list.length === 0) {
    throw new Error(`Email ${args.emailId} not found`);
  }

  const e = resp.list[0];

  // Extract body text from bodyValues using textBody/htmlBody part references
  const textPartId = e.textBody?.[0]?.partId;
  const htmlPartId = e.htmlBody?.[0]?.partId;
  const textBody = textPartId ? e.bodyValues?.[textPartId]?.value : undefined;
  const htmlBody = htmlPartId ? e.bodyValues?.[htmlPartId]?.value : undefined;

  return {
    id: e.id,
    subject: e.subject || "(No Subject)",
    from: e.from?.[0] ?? null,
    to: e.to ?? [],
    cc: e.cc ?? [],
    bcc: e.bcc ?? [],
    date: e.receivedAt || e.sentAt || "",
    preview: (e.preview ?? "").substring(0, 500),
    textBody,
    htmlBody,
    isUnread: !(e.keywords?.["$seen"]),
    isFlagged: !!(e.keywords?.["$flagged"]),
    hasAttachment: e.hasAttachment ?? false,
    folderId: Object.keys(e.mailboxIds || {})[0] ?? "",
    attachments: e.attachments?.map(a => ({
      id: a.blobId,
      name: a.name || "attachment",
      contentType: a.type || "application/octet-stream",
      size: a.size ?? 0,
    })),
  };
}

// ── Optional HTML footer (e.g. a small "sent with <tool>" badge) ─────────────
// Configure with FASTMAIL_FOOTER_HTML. Unset/empty means no footer is appended.
// Example:
//   FASTMAIL_FOOTER_HTML='<div style="margin-top:24px;padding-top:12px;
//     border-top:1px solid #f0f0f0;text-align:right;font:9px system-ui;
//     color:#888;opacity:0.5;">sent with fastmail-mcp</div>'
const FOOTER_HTML = process.env.FASTMAIL_FOOTER_HTML ?? "";

// Draft-first by default; set FASTMAIL_DRAFT_BY_DEFAULT=false to send when
// saveDraft is omitted. An explicit saveDraft argument always wins.
const DRAFT_BY_DEFAULT =
  (process.env.FASTMAIL_DRAFT_BY_DEFAULT ?? "true").toLowerCase() !== "false";

async function handleSendEmail(args: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body?: string;
  htmlBody?: string;
  from?: string;
  saveDraft?: boolean;
}) {
  const accountId = client.accountId;
  if (!accountId) throw new Error("Fastmail session not initialized");

  // Resolve Drafts mailbox ID (required — mailboxIds cannot be empty in JMAP)
  const mailboxResp = await client.call<{
    list: Array<{ id: string; name: string; role?: string }>;
  }>("Mailbox/get", { properties: ["id", "name", "role"] });

  const draftsMailbox = mailboxResp.list.find(
    f => f.role === "drafts" || f.role === "draft" || f.name.toLowerCase() === "drafts"
  );
  if (!draftsMailbox) throw new Error("Could not find Drafts mailbox");

  // Get sending identity
  const identityResp = await client.call<{
    list: Array<{ id: string; name: string; email: string }>;
  }>("Identity/get", {});

  if (!identityResp.list || identityResp.list.length === 0) {
    throw new Error("No sending identity found on this Fastmail account");
  }
  const identity = args.from
    ? (identityResp.list.find(i => i.email === args.from) ?? identityResp.list[0])
    : identityResp.list[0];

  // Build body parts
  const toAddresses = parseAddresses(args.to);
  const ccAddresses = args.cc ? parseAddresses(args.cc) : [];
  const bccAddresses = args.bcc ? parseAddresses(args.bcc) : [];

  const bodyValues: Record<string, { value: string; charset: string; headers: Record<string, string> }> = {};
  const textBody: Array<{ partId: string; type: string }> = [];
  const htmlBody: Array<{ partId: string; type: string }> = [];

  if (args.body) {
    bodyValues["1"] = { value: args.body, charset: "utf-8", headers: {} };
    textBody.push({ partId: "1", type: "text/plain" });
  }

  // HTML body: append the configured footer, if any
  const rawHtml = args.htmlBody
    ?? (args.body ? `<pre style="font-family:inherit;white-space:pre-wrap;">${args.body.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</pre>` : "<p>(No body)</p>");
  bodyValues["2"] = { value: rawHtml + FOOTER_HTML, charset: "utf-8", headers: {} };
  htmlBody.push({ partId: "2", type: "text/html" });

  if (!args.body && !args.htmlBody) {
    bodyValues["1"] = { value: "(No body)", charset: "utf-8", headers: {} };
    textBody.push({ partId: "1", type: "text/plain" });
  }

  const emailCreate: Record<string, unknown> = {
    mailboxIds: { [draftsMailbox.id]: true },
    subject: args.subject,
    to: toAddresses,
    cc: ccAddresses,
    bcc: bccAddresses,
    from: [{ name: identity.name, email: identity.email }],
    bodyValues,
    textBody: textBody.length > 0 ? textBody : undefined,
    htmlBody: htmlBody.length > 0 ? htmlBody : undefined,
    keywords: { "$draft": true },
  };

  // ── DRAFT MODE (default preference) ─────────────────────────────────────────
  const saveAsDraft = args.saveDraft ?? DRAFT_BY_DEFAULT;
  if (saveAsDraft) {
    // Only Email/set — no EmailSubmission, stays in Drafts for review
    const draftResp = await client.call<{
      created?: Record<string, { id: string }>;
      notCreated?: Record<string, { type: string; description: string }>;
    }>("Email/set", { create: { draft1: emailCreate } });

    if (draftResp?.notCreated?.["draft1"]) {
      const err = draftResp.notCreated["draft1"];
      throw new Error(`Failed to save draft: [${err.type}] ${err.description}`);
    }

    return {
      success: true,
      mode: "draft",
      message: "Email saved to Drafts for review — open Fastmail to review and send",
      emailId: draftResp?.created?.["draft1"]?.id,
      to: args.to,
      subject: args.subject,
    };
  }

  // ── SEND MODE (immediate) ────────────────────────────────────────────────────
  const responses = await client.callMulti([
    ["Email/set", { create: { draft1: emailCreate } }],
    ["EmailSubmission/set", {
      create: {
        sub1: {
          emailId: "#draft1",
          identityId: identity.id,
        }
      },
      onSuccessDestroyEmail: ["#sub1"],
    }],
  ]);

  const emailSetResp = responses[0]?.[1] as {
    created?: Record<string, { id: string }>;
    notCreated?: Record<string, { type: string; description: string }>;
  };

  if (emailSetResp?.notCreated?.["draft1"]) {
    const err = emailSetResp.notCreated["draft1"];
    throw new Error(`Failed to create email: [${err.type}] ${err.description}`);
  }

  const subResp = responses[1]?.[1] as {
    created?: Record<string, { id: string }>;
    notCreated?: Record<string, { type: string; description: string }>;
  };

  if (subResp?.notCreated?.["sub1"]) {
    const err = subResp.notCreated["sub1"];
    throw new Error(`Failed to submit email: [${err.type}] ${err.description}`);
  }

  return {
    success: true,
    mode: "sent",
    message: "Email sent successfully",
    emailId: emailSetResp?.created?.["draft1"]?.id,
    submissionId: subResp?.created?.["sub1"]?.id,
    to: args.to,
    subject: args.subject,
  };
}

async function handleListMaskedEmails() {
  const resp = await client.call<{
    list: Array<{
      id: string;
      email: string;
      forDomain?: string;
      description: string;
      state: string;
      createdAt: string;
    }>;
    notFound: string[];
  }>("MaskedEmail/get", {});

  const maskedEmails: MaskedEmailRecord[] = (resp.list || []).map(m => ({
    id: m.id,
    email: m.email,
    forDomain: m.forDomain,
    description: m.description,
    state: m.state as MaskedEmailRecord["state"],
    createdAt: m.createdAt,
  }));

  return {
    maskedEmails,
    totalCount: maskedEmails.length,
    enabledCount: maskedEmails.filter(m => m.state === "enabled").length,
    note: "Use 'id' with fastmail_update_masked_email to enable/disable/delete"
  };
}

async function handleCreateMaskedEmail(args: {
  email: string;
  description: string;
  forDomain?: string;
}) {
  const resp = await client.call<{
    created?: Record<string, { id: string; email: string }>;
    notCreated?: Record<string, { type: string; description: string }>;
  }>("MaskedEmail/set", {
    create: {
      k1: {
        email: args.email,
        description: args.description,
        state: "enabled",
        ...(args.forDomain && { forDomain: args.forDomain }),
      }
    }
  });

  if (resp.notCreated?.["k1"]) {
    const err = resp.notCreated["k1"];
    throw new Error(`Failed to create masked email: [${err.type}] ${err.description}`);
  }

  return {
    success: true,
    message: `Masked email created: ${resp.created?.["k1"]?.email ?? args.email}`,
    maskedEmail: {
      id: resp.created?.["k1"]?.id,
      email: resp.created?.["k1"]?.email ?? args.email,
    },
    note: "The masked email is active and will forward to your inbox"
  };
}

async function handleUpdateMaskedEmail(args: {
  emailId: string;
  state: string;
  description?: string;
}) {
  const update: Record<string, unknown> = { state: args.state };
  if (args.description) update.description = args.description;

  const resp = await client.call<{
    updated?: Record<string, unknown>;
    notUpdated?: Record<string, { type: string; description: string }>;
  }>("MaskedEmail/set", {
    update: { [args.emailId]: update }
  });

  if (resp.notUpdated?.[args.emailId]) {
    const err = resp.notUpdated[args.emailId];
    throw new Error(`Failed to update masked email: [${err.type}] ${err.description}`);
  }

  return {
    success: true,
    message: `Masked email updated to state: ${args.state}`,
    note: args.state === "disabled"
      ? "Emails to this masked address will be blocked"
      : "The masked email is now active"
  };
}

async function handleDeleteMaskedEmail(args: { emailId: string }) {
  const resp = await client.call<{
    destroyed?: string[];
    notDestroyed?: Record<string, { type: string; description: string }>;
  }>("MaskedEmail/set", {
    destroy: [args.emailId]
  });

  if (resp.notDestroyed?.[args.emailId]) {
    const err = resp.notDestroyed[args.emailId];
    throw new Error(`Failed to delete masked email: [${err.type}] ${err.description}`);
  }

  return {
    success: true,
    message: "Masked email permanently deleted"
  };
}

async function handleMarkEmailRead(args: { emailId: string; read?: boolean }) {
  const read = args.read !== false; // default true
  const update = read
    ? { "keywords/$seen": true }
    : { "keywords/$seen": null };

  await client.call("Email/set", {
    update: { [args.emailId]: update }
  });

  return { success: true, message: `Email marked as ${read ? "read" : "unread"}` };
}

async function handleMarkEmailFlagged(args: { emailId: string; flagged?: boolean }) {
  const flagged = args.flagged !== false; // default true
  const update = flagged
    ? { "keywords/$flagged": true }
    : { "keywords/$flagged": null };

  await client.call("Email/set", {
    update: { [args.emailId]: update }
  });

  return { success: true, message: `Email ${flagged ? "flagged" : "unflagged"}` };
}

async function handleListFolders() {
  const resp = await client.call<{
    list: Array<{
      id: string;
      name: string;
      role?: string;
      parentId?: string;
      totalEmails?: number;
      unreadEmails?: number;
      sortOrder?: number;
    }>;
  }>("Mailbox/get", {
    properties: ["id", "name", "role", "parentId", "totalEmails", "unreadEmails", "sortOrder"]
  });

  const folders = (resp.list || [])
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999))
    .map(f => ({
      id: f.id,
      name: f.name,
      role: f.role || "custom",
      parentId: f.parentId,
      totalEmails: f.totalEmails ?? 0,
      unreadEmails: f.unreadEmails ?? 0,
    }));

  return { folders, totalFolders: folders.length };
}

async function handleGetUnreadCount(args: { folder?: string }) {
  const folderName = args.folder || "inbox";
  const folder = await resolveFolderId(folderName);

  const resp = await client.call<{
    list: Array<{ id: string; unreadEmails: number }>;
  }>("Mailbox/get", {
    ids: [folder.id],
    properties: ["id", "unreadEmails"]
  });

  const unread = resp.list?.[0]?.unreadEmails ?? 0;
  return {
    folder: folder.name,
    folderId: folder.id,
    unreadCount: unread,
    note: unread > 0
      ? `You have ${unread} unread email${unread > 1 ? "s" : ""}`
      : "You're all caught up!"
  };
}

// ============================================================================
// MCP Server
// ============================================================================

const server = new Server(
  { name: "fastmail", version: "1.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    let result: unknown;

    switch (name) {
      case "fastmail_get_account":
        result = await handleGetAccount();
        break;
      case "fastmail_list_emails":
        result = await handleListEmails(args as Parameters<typeof handleListEmails>[0]);
        break;
      case "fastmail_get_email":
        result = await handleGetEmail(args as { emailId: string });
        break;
      case "fastmail_send_email":
        result = await handleSendEmail(args as Parameters<typeof handleSendEmail>[0]);
        break;
      case "fastmail_list_masked_emails":
        result = await handleListMaskedEmails();
        break;
      case "fastmail_create_masked_email":
        result = await handleCreateMaskedEmail(args as Parameters<typeof handleCreateMaskedEmail>[0]);
        break;
      case "fastmail_update_masked_email":
        result = await handleUpdateMaskedEmail(args as Parameters<typeof handleUpdateMaskedEmail>[0]);
        break;
      case "fastmail_delete_masked_email":
        result = await handleDeleteMaskedEmail(args as { emailId: string });
        break;
      case "fastmail_mark_email_read":
        result = await handleMarkEmailRead(args as { emailId: string; read?: boolean });
        break;
      case "fastmail_mark_email_flagged":
        result = await handleMarkEmailFlagged(args as { emailId: string; flagged?: boolean });
        break;
      case "fastmail_list_folders":
        result = await handleListFolders();
        break;
      case "fastmail_get_unread_count":
        result = await handleGetUnreadCount(args as { folder?: string });
        break;
      default:
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
          isError: true
        };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[fastmail] Error in ${name}:`, error);
    return {
      content: [{ type: "text", text: JSON.stringify({ error, tool: name }, null, 2) }],
      isError: true
    };
  }
});

// Start server
async function main() {
  // Eagerly init session so the first tool call never waits on auth
  try {
    await client.initSession();
    console.error("✅ Fastmail JMAP session initialized");
  } catch (err) {
    // Non-fatal — session will retry lazily on first tool call
    console.error("⚠️  Fastmail session pre-init failed (will retry on first call):", err);
  }

  await server.connect(new StdioServerTransport());
  console.error("✅ Fastmail MCP server v1.1.0 running");
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
