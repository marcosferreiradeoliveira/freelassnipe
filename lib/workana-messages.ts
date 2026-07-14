import { GoogleGenAI, Type } from '@google/genai';
import { PLATFORM } from './platform-config.ts';
import { detectJobLanguage, getLanguageLabel, type JobLanguage } from './job-language.ts';

export interface InboxThreadSummary {
  projectSlug: string;
  projectName: string;
  threadId: number | string;
  threadUrl: string;
  otherPartyName?: string;
  hasUnread: boolean;
  unreadCount: number;
  lastPostCreated?: string;
}

export interface InboxMessage {
  id: number | string;
  content: string;
  classes: string;
  isUnread: boolean;
  authorName?: string;
  isSelf: boolean;
  isProposal?: boolean;
}

export interface ThreadContext {
  postUrl: string;
  canAddMessage: boolean;
  csrfToken: string | null;
  csrfHeaderKey: string;
  messages: InboxMessage[];
  projectTitle?: string;
  otherPartyName?: string;
  language: JobLanguage;
}

export interface AutoReplyResult {
  scanned: number;
  needingReply: number;
  replied: number;
  skipped: number;
  failed: number;
}

type LogFn = (type: 'info' | 'warning' | 'error' | 'success', message: string, projectId?: string) => void;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(baseMs: number, jitterMs: number) {
  return baseMs + Math.floor(Math.random() * jitterMs);
}

function extractDcstFromCookie(cookie: string): string | null {
  const part = cookie
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('dcstcookieii='));
  return part ? part.slice('dcstcookieii='.length) : null;
}

function decodeHtmlJsonAttr(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\\\//g, '/')
    .replace(/\\u002F/gi, '/');
}

export function extractAuthFromHtml(html: string): {
  csrfToken: string | null;
  csrfHeaderKey: string;
} {
  const decoded = decodeHtmlJsonAttr(html);
  return {
    csrfHeaderKey: decoded.match(/"ajaxCSRFHeaderKey":"([^"]+)"/)?.[1] || 'X-Csrf-Token',
    csrfToken:
      decoded.match(/"ajaxCSRFToken":"([^"]+)"/)?.[1] ||
      html.match(/name="csrf-token"\s+content="([^"]+)"/i)?.[1] ||
      null
  };
}

async function workanaFetch(
  url: string,
  cookie: string,
  options: {
    method?: string;
    csrfToken?: string | null;
    csrfHeaderKey?: string;
    body?: unknown;
    accept?: string;
  } = {}
): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const dcst = extractDcstFromCookie(cookie);
  const headers: Record<string, string> = {
    Cookie: cookie,
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: options.accept || 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: PLATFORM.baseUrl,
    Referer: `${PLATFORM.baseUrl}/inbox`
  };

  if (options.csrfToken) {
    headers[options.csrfHeaderKey || 'X-Csrf-Token'] = options.csrfToken;
  }
  if (dcst) headers['x-dcst'] = dcst;

  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

export async function bootstrapInboxAuth(cookie: string): Promise<{
  csrfToken: string | null;
  csrfHeaderKey: string;
}> {
  const res = await fetch(`${PLATFORM.baseUrl}/inbox`, {
    headers: {
      Cookie: cookie,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });
  const html = await res.text();
  return extractAuthFromHtml(html);
}

function parseRoasterThreads(data: any): InboxThreadSummary[] {
  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  const threads: InboxThreadSummary[] = [];

  for (const item of list) {
    const projectSlug = item.slug || item.projectSlug;
    const projectName = item.name || item.title || projectSlug || 'Projeto';
    const itemThreads = Array.isArray(item.threads) ? item.threads : [];

    if (itemThreads.length === 0 && item.url) {
      threads.push({
        projectSlug: String(projectSlug || ''),
        projectName: String(projectName),
        threadId: item.id || item.threadId || projectSlug,
        threadUrl: item.url.startsWith('http') ? item.url : `${PLATFORM.baseUrl}${item.url}`,
        otherPartyName: item.other_party?.name || item.otherParty?.name,
        hasUnread: Boolean(item.has_unread || item.hasUnread || (item.unreadMessages || 0) > 0),
        unreadCount: Number(item.unreadMessages || item.unread_count || 0),
        lastPostCreated: item.lastPostCreated
      });
      continue;
    }

    for (const thread of itemThreads) {
      const url = thread.url || thread.threadUrl;
      if (!url) continue;
      threads.push({
        projectSlug: String(projectSlug || thread.projectSlug || ''),
        projectName: String(projectName),
        threadId: thread.id || thread.threadId,
        threadUrl: url.startsWith('http') ? url : `${PLATFORM.baseUrl}${url}`,
        otherPartyName: thread.other_party?.name || thread.otherParty?.name,
        hasUnread: Boolean(thread.has_unread || thread.hasUnread || (thread.unreadMessages || 0) > 0),
        unreadCount: Number(thread.unreadMessages || 0),
        lastPostCreated: thread.lastPostCreated || item.lastPostCreated
      });
    }
  }

  return threads;
}

export async function fetchInboxThreads(
  cookie: string,
  csrfToken: string | null,
  csrfHeaderKey: string,
  page = 1
): Promise<InboxThreadSummary[]> {
  const params = new URLSearchParams({
    projectStatus: 'open',
    owner: '0',
    page: String(page)
  });
  const result = await workanaFetch(
    `${PLATFORM.baseUrl}/roaster/search/?${params.toString()}`,
    cookie,
    { csrfToken, csrfHeaderKey }
  );
  if (!result.ok || !result.json) return [];
  return parseRoasterThreads(result.json);
}

function parseMessages(rawMessages: any[]): InboxMessage[] {
  return (rawMessages || []).map((m) => {
    const classes = String(m.classes || '');
    return {
      id: m.id,
      content: String(m.content || '').trim(),
      classes,
      isUnread: Boolean(m.isUnread),
      authorName: m.author?.name,
      isSelf: /\bself\b/i.test(classes),
      isProposal: Boolean(m.isBid || m.isProposal || /bid-proposal/i.test(classes))
    };
  });
}

export async function fetchThreadContext(
  threadUrl: string,
  cookie: string,
  csrfToken: string | null,
  csrfHeaderKey: string
): Promise<ThreadContext | null> {
  const result = await workanaFetch(threadUrl, cookie, {
    csrfToken,
    csrfHeaderKey,
    accept: 'application/json, text/html, */*'
  });

  let initial = result.json?.initial || result.json;
  if (!initial?.messages && result.text.includes('<inbox')) {
    const inboxIdx = result.text.indexOf('<inbox');
    const attr = result.text.slice(inboxIdx).match(/:initial="([^"]+)"/);
    if (attr) {
      try {
        const parsed = JSON.parse(decodeHtmlJsonAttr(attr[1]));
        initial = parsed.messageIndexData || parsed;
      } catch {
        initial = null;
      }
    }
  }

  if (!initial?.postUrl || !Array.isArray(initial.messages)) return null;

  const messages = parseMessages(initial.messages);
  const sampleText = messages.map((m) => m.content).join(' ').slice(0, 2000);

  return {
    postUrl: initial.postUrl,
    canAddMessage: initial.canAddMessage !== false,
    csrfToken,
    csrfHeaderKey,
    messages,
    projectTitle: initial.pageTitle || initial.project?.name || initial.project?.title,
    otherPartyName: initial.otherParty?.name,
    language: detectJobLanguage(initial.pageTitle || '', sampleText)
  };
}

export function findPendingClientMessage(
  messages: InboxMessage[],
  alreadyRepliedIds: Set<string>
): InboxMessage | null {
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (last.isSelf) return null;
  if (!last.content.trim()) return null;
  if (alreadyRepliedIds.has(String(last.id))) return null;
  return last;
}

export async function sendInboxReply(
  cookie: string,
  postUrl: string,
  content: string,
  csrfToken: string | null,
  csrfHeaderKey: string
): Promise<{ ok: boolean; status: number; bodyPreview: string }> {
  const result = await workanaFetch(postUrl, cookie, {
    method: 'POST',
    csrfToken,
    csrfHeaderKey,
    body: {
      message: { content },
      attachments: null,
      upload_favorites: [],
      isFromInbox: 1
    }
  });

  const ok =
    result.ok &&
    Boolean(result.json?.message || result.json?.initial || result.json?.success) &&
    !/\"message\":\"forbidden\"/i.test(result.text);

  return {
    ok: ok || (result.ok && !/forbidden/i.test(result.text)),
    status: result.status,
    bodyPreview: result.text.slice(0, 240)
  };
}

export async function generateShortChatReply(options: {
  apiKey: string;
  model?: string;
  clientMessage: string;
  projectTitle?: string;
  otherPartyName?: string;
  language: JobLanguage;
  recentMessages?: InboxMessage[];
}): Promise<string> {
  const lang = getLanguageLabel(options.language);
  const history = (options.recentMessages || [])
    .slice(-6)
    .map((m) => `${m.isSelf ? 'eu' : 'cliente'}: ${(m.content || '').slice(0, 280)}`)
    .join('\n');

  const ai = new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
  });

  const prompt = `Você responde mensagens de clientes no chat do Workana.

Estilo obrigatório:
- informal
- curto
- sucinto
- frases curtas
- sem bullet points
- sem listas numeradas
- sem blocos longos
- no máximo 3 frases curtas
- sem assinatura
- sem emojis excessivos (0 ou 1 no máximo)
- idioma: ${lang}

Projeto: ${options.projectTitle || 'n/a'}
Cliente: ${options.otherPartyName || 'n/a'}

Histórico recente:
${history || '(vazio)'}

Última mensagem do cliente:
"""
${options.clientMessage}
"""

Escreva só a resposta, nada mais.`;

  const response = await ai.models.generateContent({
    model: options.model || 'gemini-2.5-flash-lite',
    contents: prompt,
    config: {
      systemInstruction:
        'You write ultra-short informal freelance chat replies. No bullet points. No long paragraphs.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          reply: {
            type: Type.STRING,
            description: 'Short informal chat reply, max 3 short sentences, no bullets.'
          }
        },
        required: ['reply']
      }
    }
  });

  const parsed = JSON.parse((response.text || '').trim());
  const reply = String(parsed.reply || '')
    .replace(/^[-*•]\s+/gm, '')
    .replace(/\n{3,}/g, '\n')
    .trim();

  if (!reply) throw new Error('Gemini retornou resposta vazia.');
  return reply.slice(0, 600);
}

export async function runAutoReplyPass(options: {
  cookie: string;
  geminiApiKey: string;
  geminiModel?: string;
  alreadyRepliedIds: Set<string>;
  maxReplies?: number;
  preferUnread?: boolean;
  replyDelayMs?: number;
  replyJitterMs?: number;
  log?: LogFn;
}): Promise<AutoReplyResult & { newRepliedIds: string[] }> {
  const log = options.log || ((type, message) => console.log(`[${type.toUpperCase()}] ${message}`));
  const maxReplies = options.maxReplies ?? 3;
  const preferUnread = options.preferUnread !== false;
  const replyDelayMs = options.replyDelayMs ?? parseInt(process.env.AUTO_REPLY_DELAY_MS || '25000', 10);
  const replyJitterMs = options.replyJitterMs ?? parseInt(process.env.AUTO_REPLY_JITTER_MS || '20000', 10);

  const auth = await bootstrapInboxAuth(options.cookie);
  if (!auth.csrfToken) {
    log('error', '[CHAT] CSRF não encontrado — faça login novamente.');
    return { scanned: 0, needingReply: 0, replied: 0, skipped: 0, failed: 0, newRepliedIds: [] };
  }

  const threads = await fetchInboxThreads(options.cookie, auth.csrfToken, auth.csrfHeaderKey, 1);
  log('info', `[CHAT] Inbox: ${threads.length} conversa(s) aberta(s).`);

  const ordered = [...threads].sort((a, b) => {
    if (preferUnread && a.hasUnread !== b.hasUnread) return a.hasUnread ? -1 : 1;
    return 0;
  });

  let needingReply = 0;
  let replied = 0;
  let skipped = 0;
  let failed = 0;
  const newRepliedIds: string[] = [];

  for (const thread of ordered) {
    if (replied >= maxReplies) break;

    const ctx = await fetchThreadContext(
      thread.threadUrl,
      options.cookie,
      auth.csrfToken,
      auth.csrfHeaderKey
    );

    if (!ctx) {
      skipped++;
      continue;
    }

    if (!ctx.canAddMessage) {
      skipped++;
      continue;
    }

    const pending = findPendingClientMessage(ctx.messages, options.alreadyRepliedIds);
    if (!pending) {
      skipped++;
      continue;
    }

    needingReply++;
    log(
      'info',
      `[CHAT] Msg pendente em "${thread.projectName.slice(0, 40)}" de ${pending.authorName || 'cliente'}.`,
      thread.projectSlug
    );

    try {
      const replyText = await generateShortChatReply({
        apiKey: options.geminiApiKey,
        model: options.geminiModel,
        clientMessage: pending.content,
        projectTitle: ctx.projectTitle || thread.projectName,
        otherPartyName: ctx.otherPartyName || thread.otherPartyName,
        language: ctx.language,
        recentMessages: ctx.messages
      });

      const waitMs = randomDelay(replyDelayMs, replyJitterMs);
      log('info', `[CHAT] Aguardando ${Math.round(waitMs / 1000)}s antes de responder...`);
      await sleep(waitMs);

      const send = await sendInboxReply(
        options.cookie,
        ctx.postUrl,
        replyText,
        auth.csrfToken,
        auth.csrfHeaderKey
      );

      if (!send.ok) {
        failed++;
        log('error', `[CHAT] Falha ao enviar (HTTP ${send.status}): ${send.bodyPreview}`, thread.projectSlug);
        continue;
      }

      replied++;
      newRepliedIds.push(String(pending.id));
      options.alreadyRepliedIds.add(String(pending.id));
      log('success', `[CHAT] Respondido: "${replyText.slice(0, 80)}"`, thread.projectSlug);
    } catch (err: any) {
      failed++;
      log('error', `[CHAT] Erro: ${err.message}`, thread.projectSlug);
    }
  }

  return {
    scanned: ordered.length,
    needingReply,
    replied,
    skipped,
    failed,
    newRepliedIds
  };
}
