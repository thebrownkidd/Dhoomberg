import { createHmac, createSign, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { basicAuth, httpFetch, postJson, renderMessage } from '../http';
import { AUTH_SCHEMA, authHeaders } from './authn';
import { need, S, type ActionImpl, type ActionMessage, type Ctx, type PluginDef } from './types';

const SEV_EMOJI = { info: ':large_blue_circle:', warning: ':large_yellow_circle:', critical: ':red_circle:' } as const;
const SEV_COLOR = { info: '4fc3f7', warning: 'ffb020', critical: 'ff4d4d' } as const;

const TEST_MSG: ActionMessage = {
  title: 'Dhoomberg connection test',
  body: 'If you can read this, the integration is configured correctly.',
  severity: 'info',
  data: { rule: 'test', instrument: 'SUGAR', price: 0.42 },
};

function row(msg: ActionMessage): (string | number)[] {
  const d = msg.data;
  return [new Date().toISOString(), msg.title, msg.severity, msg.body, String(d.instrument ?? ''), Number(d.price ?? '') || '', String(d.rule ?? '')];
}
const ROW_HEADERS = ['timestamp', 'title', 'severity', 'message', 'instrument', 'price', 'rule'];

function vars(msg: ActionMessage) {
  return { ...msg, ...msg.data, timestamp: new Date().toISOString() };
}

/** Renders a JSON body template: `"{{x}}"` placeholders are string-escaped, bare `{{data}}` becomes the raw data object. */
export function renderJsonTemplate(tpl: string, msg: ActionMessage): string {
  const SENTINEL = '\u0000DATA\u0000';
  const body = renderMessage(String(tpl).replace(/\{\{\s*data\s*\}\}/g, SENTINEL), vars(msg), 'json').split(SENTINEL).join(JSON.stringify(msg.data));
  try { JSON.parse(body); } catch { throw new Error('Rendered body is not valid JSON. Check the template.'); }
  return body;
}

function action(id: string, name: string, category: string, description: string, docsUrl: string, schema: ReturnType<typeof S.obj>, send: (ctx: Ctx, msg: ActionMessage) => Promise<string>): PluginDef {
  const impl: ActionImpl = { send, test: (ctx) => send(ctx, TEST_MSG) };
  return { id, kind: 'action', name, category, description, docsUrl, configSchema: schema, impl, source: 'builtin' };
}

// ── Google service-account JWT (no OAuth redirect needed: share the sheet with the SA email) ──
async function googleToken(saJson: string, scope: string): Promise<string> {
  let sa: { client_email: string; private_key: string; token_uri?: string };
  try { sa = JSON.parse(saJson); } catch { throw new Error('Service account JSON is not valid JSON'); }
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope, aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` });
  const r = await (await httpFetch(sa.token_uri ?? 'https://oauth2.googleapis.com/token', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).json() as { access_token: string };
  return r.access_token;
}

// ── Microsoft Graph client credentials ───────────────────────────────────────
async function graphToken(c: Record<string, any>): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret, scope: 'https://graph.microsoft.com/.default' });
  const r = await (await httpFetch(`https://login.microsoftonline.com/${c.tenantId}/oauth2/v2.0/token`, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).json() as { access_token: string };
  return r.access_token;
}

// ── NetSuite token-based auth (OAuth 1.0a, HMAC-SHA256) ─────────────────────
export function oauth1Header(method: string, url: string, c: { realm: string; consumerKey: string; consumerSecret: string; tokenId: string; tokenSecret: string }, nonce = randomBytes(16).toString('hex'), ts = Math.floor(Date.now() / 1000).toString()): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  const u = new URL(url);
  const params: [string, string][] = [
    ['oauth_consumer_key', c.consumerKey], ['oauth_nonce', nonce], ['oauth_signature_method', 'HMAC-SHA256'],
    ['oauth_timestamp', ts], ['oauth_token', c.tokenId], ['oauth_version', '1.0'],
    ...[...u.searchParams.entries()],
  ];
  const norm = params.map(([k, v]) => [enc(k), enc(v)]).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const base = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(norm)].join('&');
  const sig = createHmac('sha256', `${enc(c.consumerSecret)}&${enc(c.tokenSecret)}`).update(base).digest('base64');
  const oauth = params.filter(([k]) => k.startsWith('oauth_')).concat([['oauth_signature', sig]]);
  return `OAuth realm="${c.realm}", ${oauth.map(([k, v]) => `${k}="${enc(v)}"`).join(', ')}`;
}

export const ACTION_PLUGINS: PluginDef[] = [
  action('slack', 'Slack', 'Messaging', 'Incoming webhook. Create one at api.slack.com/apps → Incoming Webhooks.', 'https://api.slack.com/messaging/webhooks',
    S.obj({ webhookUrl: S.secret('Webhook URL') }, ['webhookUrl']),
    async (ctx, m) => {
      need(ctx.config, 'webhookUrl');
      if (!String(ctx.config.webhookUrl).startsWith('https://hooks.slack.com/')) throw new Error('Slack webhook URLs start with https://hooks.slack.com/');
      await httpFetch(ctx.config.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        text: `${m.title}: ${m.body}`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${SEV_EMOJI[m.severity]} ${m.title}*\n${m.body}` } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `*Dhoomberg* · ${new Date().toUTCString()}` }] },
        ],
      }) });
      return 'Posted to Slack';
    }),
  action('teams', 'Microsoft Teams', 'Messaging', 'Teams Workflows webhook ("Post to a channel when a webhook request is received").', 'https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook',
    S.obj({ webhookUrl: S.secret('Workflow webhook URL') }, ['webhookUrl']),
    async (ctx, m) => {
      need(ctx.config, 'webhookUrl');
      await httpFetch(ctx.config.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        type: 'message',
        attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
          body: [{ type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: m.title, color: m.severity === 'critical' ? 'Attention' : m.severity === 'warning' ? 'Warning' : 'Default' }, { type: 'TextBlock', text: m.body, wrap: true }],
        } }],
      }) });
      return 'Posted to Teams';
    }),
  action('discord', 'Discord', 'Messaging', 'Channel webhook (Server Settings → Integrations → Webhooks).', 'https://discord.com/developers/docs/resources/webhook',
    S.obj({ webhookUrl: S.secret('Webhook URL') }, ['webhookUrl']),
    async (ctx, m) => {
      await httpFetch(ctx.config.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Dhoomberg', embeds: [{ title: m.title, description: m.body, color: parseInt(SEV_COLOR[m.severity], 16), timestamp: new Date().toISOString() }] }) });
      return 'Posted to Discord';
    }),
  action('telegram', 'Telegram', 'Messaging', 'Bot message. Create a bot with @BotFather, then get your chat ID.', 'https://core.telegram.org/bots/api#sendmessage',
    S.obj({ botToken: S.secret('Bot token'), chatId: S.str('Chat ID') }, ['botToken', 'chatId']),
    async (ctx, m) => {
      need(ctx.config, 'botToken', 'chatId');
      await postJson(`https://api.telegram.org/bot${ctx.config.botToken}/sendMessage`, { chat_id: ctx.config.chatId, text: `${m.title}\n\n${m.body}` });
      return 'Sent to Telegram';
    }),
  action('email', 'Email (SMTP)', 'Messaging', 'Any SMTP server: Gmail app password, Outlook, SES, SendGrid, Mailgun …', 'https://nodemailer.com/smtp/',
    S.obj({ host: S.str('SMTP host'), port: S.num('Port', 587), secure: S.bool('Use TLS from the start (port 465)'), user: S.str('Username'), pass: S.secret('Password'), from: S.str('From address'), to: S.str('To (comma-separated)') }, ['host', 'from', 'to']),
    async (ctx, m) => {
      const c = ctx.config;
      need(c, 'host', 'from', 'to');
      const t = nodemailer.createTransport({ host: c.host, port: Number(c.port ?? 587), secure: !!c.secure, auth: c.user ? { user: c.user, pass: c.pass } : undefined });
      const info = await t.sendMail({ from: c.from, to: c.to, subject: `[Dhoomberg] ${m.title}`, text: `${m.body}\n\n${JSON.stringify(m.data, null, 2)}` });
      return `Email accepted: ${info.messageId}`;
    }),
  action('twilio_sms', 'SMS (Twilio)', 'Messaging', 'Text message via Twilio.', 'https://www.twilio.com/docs/sms/api/message-resource',
    S.obj({ accountSid: S.str('Account SID'), authToken: S.secret('Auth token'), from: S.str('From number'), to: S.str('To number(s), comma-separated') }, ['accountSid', 'authToken', 'from', 'to']),
    async (ctx, m) => {
      const c = ctx.config;
      need(c, 'accountSid', 'authToken', 'from', 'to');
      for (const to of String(c.to).split(',').map((s) => s.trim()).filter(Boolean)) {
        await httpFetch(`https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`, {
          method: 'POST', headers: { Authorization: basicAuth(c.accountSid, c.authToken), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: c.from, To: to, Body: `${m.title}: ${m.body}`.slice(0, 1500) }),
        });
      }
      return 'SMS sent';
    }),
  action('webhook', 'Generic webhook', 'Generic', 'POST any JSON to any URL. Works with Zapier, Make, n8n, Power Automate, IFTTT, your own services. Optional HMAC signature.', 'https://en.wikipedia.org/wiki/Webhook',
    S.obj({
      url: S.url('URL'), method: S.oneOf('Method', ['POST', 'PUT', 'PATCH'], 'POST'),
      bodyTemplate: S.text('Body template (JSON)', '{"title": "{{title}}", "message": "{{body}}", "severity": "{{severity}}", "instrument": "{{instrument}}", "price": "{{price}}", "rule": "{{rule}}", "timestamp": "{{timestamp}}", "data": {{data}}}'),
      signingSecret: S.secret('HMAC signing secret (optional)', { description: 'Adds X-Dhoomberg-Signature: sha256=<hex> over the raw body.' }),
      ...AUTH_SCHEMA,
    }, ['url']),
    async (ctx, m) => {
      const c = ctx.config;
      need(c, 'url');
      const body = renderJsonTemplate(c.bodyTemplate, m);
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(await authHeaders(c, ctx.connectionId)) };
      if (c.signingSecret) headers['X-Dhoomberg-Signature'] = `sha256=${createHmac('sha256', c.signingSecret).update(body).digest('hex')}`;
      const r = await httpFetch(c.url, { method: c.method ?? 'POST', headers, body });
      return `Webhook ${r.status}`;
    }),
  action('google_sheets', 'Google Sheets', 'Spreadsheets & databases', 'Appends one row per event. Uses a service account: share the sheet with its email as Editor.', 'https://developers.google.com/sheets/api/guides/values#append_values',
    S.obj({ serviceAccountJson: S.secret('Service account JSON key', { format: 'textarea' }), spreadsheetId: S.str('Spreadsheet ID'), range: S.str('Sheet / range', { default: 'Sheet1!A:G' }) }, ['serviceAccountJson', 'spreadsheetId']),
    async (ctx, m) => {
      const c = ctx.config;
      need(c, 'serviceAccountJson', 'spreadsheetId');
      const token = await googleToken(c.serviceAccountJson, 'https://www.googleapis.com/auth/spreadsheets');
      await postJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(c.spreadsheetId)}/values/${encodeURIComponent(c.range || 'Sheet1!A:G')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { values: [row(m)] }, { headers: { Authorization: `Bearer ${token}` } });
      return 'Row appended to Google Sheet';
    }),
  action('excel_graph', 'Excel (OneDrive / SharePoint)', 'Spreadsheets & databases', `Adds a row to an Excel table via Microsoft Graph (app registration with Files.ReadWrite.All). Table columns: ${ROW_HEADERS.join(', ')}.`, 'https://learn.microsoft.com/en-us/graph/api/tablerowcollection-add',
    S.obj({ tenantId: S.str('Tenant ID'), clientId: S.str('Client ID'), clientSecret: S.secret('Client secret'), userId: S.str('Owner user ID / UPN'), itemId: S.str('Workbook drive item ID'), table: S.str('Table name', { default: 'Table1' }) }, ['tenantId', 'clientId', 'clientSecret', 'userId', 'itemId']),
    async (ctx, m) => {
      const c = ctx.config;
      need(c, 'tenantId', 'clientId', 'clientSecret', 'userId', 'itemId');
      const token = await graphToken(c);
      await postJson(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(c.userId)}/drive/items/${encodeURIComponent(c.itemId)}/workbook/tables/${encodeURIComponent(c.table || 'Table1')}/rows/add`,
        { values: [row(m)] }, { headers: { Authorization: `Bearer ${token}` } });
      return 'Row added to Excel table';
    }),
  action('notion', 'Notion', 'Spreadsheets & databases', 'Creates a page in a database. Share the database with your integration.', 'https://developers.notion.com/reference/post-page',
    S.obj({ token: S.secret('Integration token'), databaseId: S.str('Database ID'), titleProperty: S.str('Title property name', { default: 'Name' }) }, ['token', 'databaseId']),
    async (ctx, m) => {
      const c = ctx.config;
      need(c, 'token', 'databaseId');
      await postJson('https://api.notion.com/v1/pages', {
        parent: { database_id: c.databaseId },
        properties: { [c.titleProperty || 'Name']: { title: [{ text: { content: m.title } }] } },
        children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: m.body.slice(0, 1900) } }] } }],
      }, { headers: { Authorization: `Bearer ${c.token}`, 'Notion-Version': '2022-06-28' } });
      return 'Notion page created';
    }),
  action('airtable', 'Airtable', 'Spreadsheets & databases', `Creates a record. Table needs fields: ${ROW_HEADERS.join(', ')} (missing ones are skipped by typecast).`, 'https://airtable.com/developers/web/api/create-records',
    S.obj({ token: S.secret('Personal access token'), baseId: S.str('Base ID'), table: S.str('Table name or ID') }, ['token', 'baseId', 'table']),
    async (ctx, m) => {
      const c = ctx.config;
      need(c, 'token', 'baseId', 'table');
      const fields = Object.fromEntries(ROW_HEADERS.map((h, i) => [h, row(m)[i]]));
      await postJson(`https://api.airtable.com/v0/${c.baseId}/${encodeURIComponent(c.table)}`, { records: [{ fields }], typecast: true }, { headers: { Authorization: `Bearer ${c.token}` } });
      return 'Airtable record created';
    }),
  action('sap_odata', 'SAP S/4HANA (OData)', 'ERP', 'POSTs to any OData entity set (e.g. a custom CDS/RAP service for purchase requisitions or alerts). Handles the CSRF token handshake.', 'https://help.sap.com/docs/SAP_S4HANA_CLOUD',
    S.obj({
      serviceUrl: S.url('Entity set URL', undefined, { 'x-placeholder': 'https://my-s4.example.com/sap/opu/odata/sap/ZDHOOM_ALERTS_SRV/AlertSet' }),
      bodyTemplate: S.text('Body template (JSON)', '{"Title": "{{title}}", "Message": "{{body}}", "Material": "{{instrument}}", "Price": "{{price}}"}'),
      sapClient: S.str('sap-client (optional)'), ...AUTH_SCHEMA,
    }, ['serviceUrl']),
    async (ctx, m) => {
      const c = ctx.config;
      need(c, 'serviceUrl');
      const url = c.sapClient ? `${c.serviceUrl}${c.serviceUrl.includes('?') ? '&' : '?'}sap-client=${encodeURIComponent(c.sapClient)}` : c.serviceUrl;
      const auth = await authHeaders(c, ctx.connectionId);
      const head = await httpFetch(url, { method: 'GET', headers: { ...auth, 'x-csrf-token': 'fetch', Accept: 'application/json' } });
      const csrf = head.headers.get('x-csrf-token') ?? '';
      const cookies = head.headers.getSetCookie?.().map((s) => s.split(';')[0]).join('; ') ?? '';
      const body = renderJsonTemplate(c.bodyTemplate, m);
      const r = await httpFetch(url, { method: 'POST', body, headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrf, Cookie: cookies } });
      return `SAP OData ${r.status}`;
    }),
  action('netsuite', 'Oracle NetSuite (REST)', 'ERP', 'Creates a record via SuiteTalk REST with token-based authentication.', 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_1540391670.html',
    S.obj({
      accountId: S.str('Account ID', { 'x-placeholder': '1234567_SB1' }), recordType: S.str('Record type', { default: 'customrecord_dhoomberg_alert' }),
      bodyTemplate: S.text('Body template (JSON)', '{"name": "{{title}}", "custrecord_message": "{{body}}", "custrecord_price": "{{price}}"}'),
      consumerKey: S.str('Consumer key'), consumerSecret: S.secret('Consumer secret'), tokenId: S.str('Token ID'), tokenSecret: S.secret('Token secret'),
    }, ['accountId', 'recordType', 'consumerKey', 'consumerSecret', 'tokenId', 'tokenSecret']),
    async (ctx, m) => {
      const c = ctx.config;
      need(c, 'accountId', 'recordType', 'consumerKey', 'consumerSecret', 'tokenId', 'tokenSecret');
      const host = String(c.accountId).toLowerCase().replace(/_/g, '-');
      const url = `https://${host}.suitetalk.api.netsuite.com/services/rest/record/v1/${encodeURIComponent(c.recordType)}`;
      const auth = oauth1Header('POST', url, { realm: String(c.accountId).toUpperCase(), consumerKey: c.consumerKey, consumerSecret: c.consumerSecret, tokenId: c.tokenId, tokenSecret: c.tokenSecret });
      const r = await httpFetch(url, { method: 'POST', body: renderJsonTemplate(c.bodyTemplate, m), headers: { Authorization: auth, 'Content-Type': 'application/json' } });
      return `NetSuite ${r.status}`;
    }),
  action('pagerduty', 'PagerDuty', 'Incident & tickets', 'Triggers an incident via Events API v2.', 'https://developer.pagerduty.com/docs/events-api-v2/trigger-events/',
    S.obj({ routingKey: S.secret('Integration (routing) key') }, ['routingKey']),
    async (ctx, m) => {
      await postJson('https://events.pagerduty.com/v2/enqueue', { routing_key: ctx.config.routingKey, event_action: 'trigger', payload: { summary: `${m.title}: ${m.body}`.slice(0, 1024), source: 'dhoomberg', severity: m.severity === 'critical' ? 'critical' : m.severity === 'warning' ? 'warning' : 'info', custom_details: m.data } });
      return 'PagerDuty event accepted';
    }),
  action('jira', 'Jira', 'Incident & tickets', 'Creates an issue (Jira Cloud).', 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post',
    S.obj({ site: S.str('Site', { 'x-placeholder': 'yourco.atlassian.net' }), email: S.str('Account email'), apiToken: S.secret('API token'), projectKey: S.str('Project key'), issueType: S.str('Issue type', { default: 'Task' }) }, ['site', 'email', 'apiToken', 'projectKey']),
    async (ctx, m) => {
      const c = ctx.config;
      need(c, 'site', 'email', 'apiToken', 'projectKey');
      const r = await postJson<{ key: string }>(`https://${String(c.site).replace(/^https?:\/\//, '')}/rest/api/3/issue`, {
        fields: { project: { key: c.projectKey }, summary: m.title.slice(0, 250), issuetype: { name: c.issueType || 'Task' },
          description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: m.body }] }] } },
      }, { headers: { Authorization: basicAuth(c.email, c.apiToken) } });
      return `Jira issue ${r.key}`;
    }),
];
