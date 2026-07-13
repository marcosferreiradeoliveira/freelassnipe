import { PLATFORM } from './platform-config.ts';

export interface SkillOption {
  slug: string;
  name: string;
}

export interface PortfolioItem {
  id: string;
  title?: string;
}

export interface BidPageContext {
  postUrl: string;
  portfoliosUrl: string | null;
  csrfToken: string | null;
  csrfHeaderKey: string;
  skills: SkillOption[];
  bidConfig: {
    toReferenceCurrencyRate: number;
    minimum: number;
    maximum: number;
    workerCurrency: string;
    referenceCurrency: string;
    isHourly: boolean;
  } | null;
}

export interface WorkanaBidPayload {
  message: string;
  amount: number;
  deliveryDays?: number;
  skills: Array<{ slug: string; portfolioId?: string }>;
}

function decodeHtmlJson(raw: string): unknown {
  const jsonText = raw
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  return JSON.parse(jsonText);
}

function extractJsonAfterMarker(html: string, marker: string, maxLen = 80000): string | null {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  const chunk = html.slice(idx, idx + maxLen);
  const decoded = chunk
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\\\//g, '/');

  const jsonStart = decoded.indexOf('{');
  if (jsonStart === -1) return null;

  let depth = 0;
  for (let i = jsonStart; i < decoded.length; i++) {
    if (decoded[i] === '{') depth++;
    else if (decoded[i] === '}') {
      depth--;
      if (depth === 0) {
        return decoded.slice(jsonStart, i + 1);
      }
    }
  }

  return null;
}

export function parseBidPageContext(html: string): BidPageContext | null {
  const decoded = html
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/');

  const postUrlMatch = decoded.match(/"postUrl":"([^"]+)"/);
  const postUrl = postUrlMatch?.[1];
  if (!postUrl) return null;

  const portfoliosMatch = decoded.match(/"getPortfoliosUrl":"([^"]+)"/);
  const portfoliosUrl = portfoliosMatch?.[1] || null;
  const csrfHeaderKey =
    decoded.match(/"ajaxCSRFHeaderKey":"([^"]+)"/)?.[1] ||
    decoded.match(/ajaxCSRFHeaderKey="([^"]+)"/)?.[1] ||
    'X-Csrf-Token';
  const csrfToken =
    decoded.match(/"ajaxCSRFToken":"([^"]+)"/)?.[1] ||
    decoded.match(/name="csrf-token"\s+content="([^"]+)"/i)?.[1] ||
    null;

  let skills: SkillOption[] = [];
  const skillsJson = extractJsonAfterMarker(html, 'highlightSkillsInitials', 6000);
  if (skillsJson) {
    try {
      const data = JSON.parse(skillsJson) as { skills?: { availableOptions?: SkillOption[] } };
      skills = data.skills?.availableOptions || [];
    } catch {
      skills = [];
    }
  }

  let bidConfig: BidPageContext['bidConfig'] = null;
  const bidAttrMatch = html.match(/:bid="([^"]+)"/);
  if (bidAttrMatch) {
    try {
      const data = decodeHtmlJson(bidAttrMatch[1]) as Record<string, unknown>;
      const bidLimits = data.bidLimits as { minimum?: number; maximum?: number } | undefined;
      bidConfig = {
        toReferenceCurrencyRate: Number(data.toReferenceCurrencyRate) || 5.123,
        minimum: Number(bidLimits?.minimum) || 150,
        maximum: Number(bidLimits?.maximum) || Number.MAX_SAFE_INTEGER,
        workerCurrency: String(data.workerCurrency || 'R$'),
        referenceCurrency: String(data.referenceCurrency || 'USD'),
        isHourly: Boolean(data.isHourly)
      };
    } catch {
      bidConfig = null;
    }
  }

  return { postUrl, portfoliosUrl, csrfToken, csrfHeaderKey, skills, bidConfig };
}

export function extractDcstToken(
  cookies: Array<{ name: string; value: string }> | string | null | undefined
): string | null {
  if (!cookies) return null;

  if (typeof cookies === 'string') {
    const match = cookies
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('dcstcookieii='));
    return match ? match.slice('dcstcookieii='.length) : null;
  }

  return cookies.find((cookie) => cookie.name === 'dcstcookieii' && cookie.value)?.value || null;
}

export async function readBidPageContext(page: any): Promise<BidPageContext | null> {
  const response = await page.request.get(page.url()).catch(() => null);
  if (response?.ok()) {
    const parsed = parseBidPageContext(await response.text());
    if (parsed) return parsed;
  }

  return parseBidPageContext(await page.content());
}

function parsePortfolioId(item: Record<string, unknown>): string | null {
  const candidates = [item.id, item.identifier, item.portfolioId, item.hash, item.slug];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

export async function fetchPortfolioItems(request: any, portfoliosUrl: string): Promise<PortfolioItem[]> {
  const companyMatch = portfoliosUrl.match(/\/portfolios\/(?:of_company\/)?([^/?#]+)/);
  const companyId = companyMatch?.[1];
  const candidateUrls = [
    portfoliosUrl,
    companyId ? `${PLATFORM.baseUrl}/portfolios/${companyId}` : null,
    companyId ? `${PLATFORM.baseUrl}/portfolios/of_company/${companyId}.json` : null
  ].filter(Boolean) as string[];

  for (const url of candidateUrls) {
    const response = await request
      .get(url, {
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        }
      })
      .catch(() => null);

    if (!response?.ok()) continue;

    const contentType = response.headers()['content-type'] || '';
    if (!contentType.includes('json')) continue;

    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!data) continue;

    const portfolios = data.portfolios;
    if (Array.isArray(portfolios)) {
      const items = portfolios
        .map((entry) => {
          const record = entry as Record<string, unknown>;
          const id = parsePortfolioId(record);
          if (!id) return null;
          return {
            id,
            title: typeof record.name === 'string' ? record.name : typeof record.title === 'string' ? record.title : undefined
          };
        })
        .filter(Boolean) as PortfolioItem[];
      if (items.length > 0) return items;
    }

    if (portfolios && typeof portfolios === 'object') {
      const items = Object.entries(portfolios as Record<string, unknown>)
        .map(([key, entry]) => {
          const record = (entry || {}) as Record<string, unknown>;
          const id = parsePortfolioId(record) || key;
          return {
            id,
            title: typeof record.name === 'string' ? record.name : typeof record.title === 'string' ? record.title : undefined
          };
        })
        .filter((item) => item.id);
      if (items.length > 0) return items;
    }
  }

  return [];
}

export function buildBidFormBody(payload: WorkanaBidPayload): URLSearchParams {
  const body = new URLSearchParams();

  body.set('bid[content]', payload.message);
  body.set('bid[amount]', String(payload.amount));

  if (payload.deliveryDays) {
    body.set('bid[deliveryTime]', String(payload.deliveryDays));
  }

  for (const skill of payload.skills) {
    body.set(`skill-${skill.slug}`, skill.slug);
    if (skill.portfolioId) {
      body.append('bid[portfolios][]', skill.portfolioId);
    }
  }

  return body;
}

export function buildBidJsonBody(payload: WorkanaBidPayload) {
  return {
    bid: {
      content: payload.message,
      amount: payload.amount,
      deliveryTime: payload.deliveryDays,
      portfolios: payload.skills.map((skill) => skill.portfolioId).filter(Boolean),
      skills: payload.skills.map((skill) => skill.slug)
    }
  };
}

function isSuccessfulBidResponse(status: number, body: string): boolean {
  if (!status || status < 200 || status >= 300) return false;
  if (/\"message\":\"forbidden\"/i.test(body)) return false;
  if (/\"initial\"\s*:\s*\{/.test(body)) return true;
  return !/inválid|invalid|obrigatóri/i.test(body);
}

export interface SubmitBidResult {
  ok: boolean;
  status: number;
  url: string;
  bodyPreview: string;
  transport: 'form' | 'json';
}

export async function submitBidViaApi(
  request: any,
  postUrl: string,
  payload: WorkanaBidPayload,
  referer: string,
  csrfToken?: string | null,
  options?: { csrfHeaderKey?: string; dcstToken?: string | null }
): Promise<SubmitBidResult> {
  const csrfHeaderKey = options?.csrfHeaderKey || 'X-Csrf-Token';
  const dcstToken = options?.dcstToken || null;

  if (!dcstToken) {
    return {
      ok: false,
      status: 0,
      url: postUrl,
      bodyPreview: 'dcstcookieii ausente — header x-dcst obrigatório para POST Workana.',
      transport: 'form'
    };
  }

  const commonHeaders: Record<string, string> = {
    Referer: referer,
    Origin: PLATFORM.baseUrl,
    'X-Requested-With': 'XMLHttpRequest',
    'x-dcst': dcstToken
  };

  if (csrfToken) {
    commonHeaders[csrfHeaderKey] = csrfToken;
  }

  const formResponse = await request.post(postUrl, {
    headers: {
      ...commonHeaders,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json, text/plain, */*'
    },
    data: buildBidFormBody(payload).toString()
  });

  const formBody = (await formResponse.text().catch(() => '')).slice(0, 500);
  const formOk = isSuccessfulBidResponse(formResponse.status(), formBody);

  if (formOk) {
    return {
      ok: true,
      status: formResponse.status(),
      url: formResponse.url(),
      bodyPreview: formBody,
      transport: 'form'
    };
  }

  const jsonResponse = await request.post(postUrl, {
    headers: {
      ...commonHeaders,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    data: buildBidJsonBody(payload)
  });

  const jsonBody = (await jsonResponse.text().catch(() => '')).slice(0, 500);
  const jsonOk = isSuccessfulBidResponse(jsonResponse.status(), jsonBody);

  return {
    ok: jsonOk,
    status: jsonResponse.status(),
    url: jsonResponse.url(),
    bodyPreview: jsonBody || formBody,
    transport: 'json'
  };
}

export function attachBidPostCapture(page: any): {
  getLastCapture: () => { url: string; method: string; body: string | null; contentType: string } | null;
  dispose: () => void;
} {
  let lastCapture: { url: string; method: string; body: string | null; contentType: string } | null = null;

  const handler = (request: any) => {
    if (request.method() !== 'POST') return;
    const url = request.url();
    if (!/workana\.com/i.test(url)) return;
    if (!/\/messages\//i.test(url)) return;

    const headers = request.headers();
    lastCapture = {
      url: request.url(),
      method: request.method(),
      body: request.postData(),
      contentType: headers['content-type'] || headers['Content-Type'] || ''
    };
  };

  page.on('request', handler);

  return {
    getLastCapture: () => lastCapture,
    dispose: () => page.off('request', handler)
  };
}
