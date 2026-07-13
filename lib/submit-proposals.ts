import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Project, ProjectStatus, SystemLog } from '../src/types';
import { PLATFORM } from './platform-config.ts';
import { normalizeSuggestedPrice } from './budget-utils.ts';
import {
  extractDcstToken,
  fetchPortfolioItems,
  readBidPageContext,
  submitBidViaApi,
  type WorkanaBidPayload
} from './workana-bid-api.ts';
import {
  createPersistentBrowserSession,
  ensureAuthenticated,
  injectCookiesIntoContext,
  usePersistentProfile
} from './browser-session.ts';


dotenv.config();

const DB_FILE = path.join(process.cwd(), 'db.json');

export interface SubmitWorkerOptions {
  forceSubmit?: boolean;
  projectIds?: string[];
  delayBetweenSubmitsMs?: number;
  delayJitterMs?: number;
  log?: (type: SystemLog['type'], message: string, projectId?: string) => void;
}

export interface SubmitWorkerResult {
  processed: number;
  failed: number;
  totalPending: number;
}

function defaultLog(type: SystemLog['type'], message: string) {
  console.log(`[${type.toUpperCase()}] ${message}`);
}

function readDatabase() {
  if (!fs.existsSync(DB_FILE)) {
    throw new Error(`Database file not found at ${DB_FILE}. Please boot the server first.`);
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

function writeDatabase(db: any) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
}

async function waitForBidForm(page: any) {
  await page.waitForTimeout(1500);
  const formSelectors = [
    'textarea[name="bid[content]"]',
    'textarea[name="bid[message]"]',
    'textarea[name="message"]',
    'textarea[placeholder*="proposta" i]',
    'textarea[placeholder*="proposal" i]',
    '#message'
  ];

  for (const selector of formSelectors) {
    const input = page.locator(selector).first();
    try {
      await input.waitFor({ state: 'visible', timeout: 8000 });
      return input;
    } catch {
      continue;
    }
  }

  return null;
}

function resolveWorkanaUrl(href: string): string {
  if (href.startsWith('http')) return href;
  return `${PLATFORM.baseUrl}${href.startsWith('/') ? href : `/${href}`}`;
}

function normalizeJobUrl(url: string): string {
  const jobMatch = url.match(/\/job\/([^/?#]+)/);
  if (jobMatch) return `${PLATFORM.baseUrl}/job/${jobMatch[1]}`;

  const bidMatch = url.match(/\/messages\/bid\/([^/?#]+)/);
  if (bidMatch) return `${PLATFORM.baseUrl}/job/${bidMatch[1]}`;

  return url;
}

async function dismissPageOverlays(page: any) {
  await page.evaluate(() => {
    for (const selector of ['#workanaChat', '#onetrust-banner-sdk', '.modal.in', '.modal.show']) {
      document.querySelectorAll(selector).forEach((el) => {
        (el as HTMLElement).style.display = 'none';
        (el as HTMLElement).style.pointerEvents = 'none';
      });
    }
  }).catch(() => {});
}

async function openBidForm(page: any, jobUrl: string, log: SubmitWorkerOptions['log']) {
  const write = log || defaultLog;
  const normalizedJobUrl = normalizeJobUrl(jobUrl);

  write('info', `[DISPARADOR] Abrindo página do projeto (${normalizedJobUrl})...`);
  await page.goto(normalizedJobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  await dismissPageOverlays(page);

  const notFound = await page
    .locator('text=/projeto não encontrado|project not found/i')
    .first()
    .isVisible()
    .catch(() => false);
  if (notFound) {
    throw new Error('Projeto não encontrado no Workana (pode ter sido removido ou expirado).');
  }

  const bidButton = page.locator('#bid_button').first();
  if (!(await bidButton.isVisible().catch(() => false))) {
    throw new Error('Botão para abrir o formulário de proposta não encontrado.');
  }

  const href = await bidButton.getAttribute('href').catch(() => null);
  if (!href || href.includes('/signup') || href.includes('/login')) {
    throw new Error(`Sessão inválida. Faça login novamente no ${PLATFORM.name}.`);
  }

  const bidUrl = resolveWorkanaUrl(href);
  write('info', `[DISPARADOR] Abrindo formulário de proposta (${bidUrl})...`);
  await page.goto(bidUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  await page.waitForTimeout(2000);
  await page.locator('bid-index').first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
  if (page.url().includes('/login') || page.url().includes('/signup')) {
    throw new Error(`Sessão inválida. Faça login novamente no ${PLATFORM.name}.`);
  }

  const proposalInput = await waitForBidForm(page);
  if (!proposalInput) {
    throw new Error(`Formulário de proposta não carregou na URL ${page.url()}.`);
  }
}

interface BidConfig {
  toReferenceCurrencyRate: number;
  minimum: number;
  maximum: number;
  workerCurrency: string;
  referenceCurrency: string;
  isHourly: boolean;
}

const DEFAULT_BRL_RATE = 5.123;
const DEFAULT_BRL_MINIMUM = 150;

function fallbackWorkerAmount(suggestedPriceUsd: number | undefined, budget: string): number {
  const normalized = normalizeSuggestedPrice(suggestedPriceUsd, budget);
  const usdAmount = normalized.price || suggestedPriceUsd || 50;
  return Math.max(DEFAULT_BRL_MINIMUM, Math.round(usdAmount * DEFAULT_BRL_RATE));
}

function computeWorkerAmount(
  suggestedPriceUsd: number | undefined,
  bidConfig: BidConfig
): { amount: number; adjusted: boolean; reason?: string } {
  const rate = bidConfig.toReferenceCurrencyRate || 1;
  let amount = Math.round((suggestedPriceUsd || 0) * rate);
  let adjusted = false;
  let reason: string | undefined;

  if (bidConfig.minimum && amount < bidConfig.minimum) {
    reason = `Valor ${bidConfig.workerCurrency}${amount} abaixo do lance mínimo (${bidConfig.workerCurrency}${bidConfig.minimum}); ajustado para o mínimo.`;
    amount = bidConfig.minimum;
    adjusted = true;
  }

  if (bidConfig.maximum && amount > bidConfig.maximum) {
    amount = bidConfig.maximum;
    adjusted = true;
  }

  return { amount, adjusted, reason };
}

async function buildBidPayload(
  page: any,
  project: Project,
  log: SubmitWorkerOptions['log']
): Promise<{ payload: WorkanaBidPayload; postUrl: string; csrfToken: string | null; csrfHeaderKey: string }> {
  const write = log || defaultLog;
  const bidContext = await readBidPageContext(page);
  if (!bidContext?.postUrl) {
    throw new Error('postUrl da proposta não encontrado no formulário Workana.');
  }

  const bidConfig = bidContext.bidConfig;
  let amount: number;
  let minimum = DEFAULT_BRL_MINIMUM;
  let workerCurrency = 'R$';

  if (bidConfig) {
    const computed = computeWorkerAmount(project.suggestedPrice, bidConfig as BidConfig);
    amount = computed.amount;
    minimum = bidConfig.minimum;
    workerCurrency = bidConfig.workerCurrency;
    write(
      'info',
      `[PREÇO] Convertendo $${project.suggestedPrice} ${bidConfig.referenceCurrency} → ${workerCurrency}${amount} (taxa ${bidConfig.toReferenceCurrencyRate}, mín ${workerCurrency}${minimum}).`,
      project.id
    );
    if (computed.reason) {
      write('warning', `[PREÇO] ${computed.reason}`, project.id);
    }
  } else {
    amount = fallbackWorkerAmount(project.suggestedPrice, project.budget);
    write(
      'warning',
      `[PREÇO] Config de lance não lida; usando fallback ${workerCurrency}${amount} (USD $${project.suggestedPrice} × ${DEFAULT_BRL_RATE}, mín ${workerCurrency}${minimum}).`,
      project.id
    );
  }

  const skill = bidContext.skills[0];
  if (!skill) {
    throw new Error('Nenhuma habilidade disponível para este projeto.');
  }

  let portfolioId: string | undefined;
  if (bidContext.portfoliosUrl) {
    const portfolios = await fetchPortfolioItems(page.request, bidContext.portfoliosUrl);
    portfolioId = portfolios[0]?.id;
    if (portfolioId) {
      write(
        'info',
        `[HABILIDADES] Vinculando "${skill.name}" ao portfólio "${portfolios[0]?.title || portfolioId}".`,
        project.id
      );
    } else {
      write('warning', '[HABILIDADES] Portfólio não encontrado via API; enviando só a habilidade.', project.id);
    }
  }

  write(
    'info',
    `[HABILIDADES] Payload API: skill=${skill.slug}, portfolio=${portfolioId || 'n/a'}, texto=${(project.generatedProposal || '').length} chars.`,
    project.id
  );

  const payload: WorkanaBidPayload = {
    message: project.generatedProposal || '',
    amount,
    deliveryDays: project.suggestedTime,
    skills: [{ slug: skill.slug, portfolioId }]
  };

  return {
    payload,
    postUrl: bidContext.postUrl,
    csrfToken: bidContext.csrfToken,
    csrfHeaderKey: bidContext.csrfHeaderKey
  };
}

async function submitBidViaDirectApi(
  page: any,
  project: Project,
  shouldSubmit: boolean,
  log: SubmitWorkerOptions['log']
): Promise<boolean> {
  const write = log || defaultLog;
  const { payload, postUrl, csrfToken, csrfHeaderKey } = await buildBidPayload(page, project, write);
  const browserCookies = await page.context().cookies(PLATFORM.baseUrl);
  const dcstToken = extractDcstToken(browserCookies);

  if (!dcstToken) {
    write(
      'error',
      '[DISPARADOR] Cookie dcstcookieii ausente — não é possível autenticar o POST na Workana. Faça login novamente.',
      project.id
    );
    project.status = ProjectStatus.FAILED;
    return false;
  }

  if (!shouldSubmit) {
    write(
      'warning',
      `[MODO MANUAL] Payload montado para ${postUrl} (envio desativado).`,
      project.id
    );
    project.status = ProjectStatus.PENDING_REVIEW;
    return false;
  }

  const preSubmitDelay = 3000 + Math.floor(Math.random() * 7000);
  write('info', `[DISPARADOR] Aguardando ${Math.round(preSubmitDelay / 1000)}s antes de enviar...`, project.id);
  await page.waitForTimeout(preSubmitDelay);

  write('info', `[DISPARADOR] Enviando proposta via API (${postUrl})...`, project.id);
  const result = await submitBidViaApi(page.request, postUrl, payload, page.url(), csrfToken, {
    csrfHeaderKey,
    dcstToken
  });

  write(
    'info',
    `[DISPARADOR] Resposta API status=${result.status} transport=${result.transport} body=${result.bodyPreview.slice(0, 160)}`,
    project.id
  );

  if (result.ok) {
    write('success', `[DISPARADOR] PROPOSTA ENVIADA: "${project.title}"!`, project.id);
    project.status = ProjectStatus.SENT;
    return true;
  }

  write(
    'error',
    `[DISPARADOR] Envio rejeitado pelo ${PLATFORM.name} (HTTP ${result.status}): ${result.bodyPreview || 'sem detalhe'}.`,
    project.id
  );
  project.status = ProjectStatus.FAILED;
  return false;
}

async function submitSingleProject(
  page: any,
  context: any,
  config: any,
  project: Project,
  shouldSubmit: boolean,
  log: SubmitWorkerOptions['log']
) {
  const write = log || defaultLog;
  const jobUrl = normalizeJobUrl(project.url);

  write('info', `[DISPARADOR] Abrindo projeto Workana: ${jobUrl}`, project.id);

  if (page.url().includes('/login') || page.url().includes('/signup')) {
    if (config.freelasSessionCookie?.trim()) {
      await injectCookiesIntoContext(context, config.freelasSessionCookie, write);
    }
  }

  try {
    await openBidForm(page, jobUrl, write);
  } catch (err: any) {
    write('error', `[DISPARADOR] Erro ao abrir projeto: ${err.message}`, project.id);
    project.status = ProjectStatus.FAILED;
    return false;
  }

  if (page.url().includes('/login') || page.url().includes('/signup')) {
    write('error', `[DISPARADOR] Sessão inválida. Renove o login no ${PLATFORM.name}.`, project.id);
    project.status = ProjectStatus.FAILED;
    return false;
  }

  if (!project.generatedProposal) {
    write('error', `[DISPARADOR] Texto da proposta vazio. Gere com IA antes de enviar.`, project.id);
    project.status = ProjectStatus.FAILED;
    return false;
  }

  try {
    return await submitBidViaDirectApi(page, project, shouldSubmit, write);
  } catch (err: any) {
    write('error', `[DISPARADOR] ${err.message}`, project.id);
    project.status = ProjectStatus.FAILED;
    return false;
  }
}

export async function runSubmitWorker(options: SubmitWorkerOptions = {}): Promise<SubmitWorkerResult> {
  const log = options.log || defaultLog;
  const forceSubmit = options.forceSubmit === true;

  let db = readDatabase();
  let pendingProjects: Project[] = db.projects.filter(
    (p: Project) => p.status === ProjectStatus.PENDING_REVIEW
  );

  if (options.projectIds?.length) {
    const idOrder = options.projectIds;
    pendingProjects = idOrder
      .map((id) => pendingProjects.find((p) => p.id === id))
      .filter((p): p is Project => Boolean(p));
  }

  if (pendingProjects.length === 0) {
    log('info', 'Orquestrador: Fila de submissões pendentes vazia.');
    return { processed: 0, failed: 0, totalPending: 0 };
  }

  log('info', `Orquestrador: Encontradas ${pendingProjects.length} propostas prontas para submissão.`);

  let processed = 0;
  let failed = 0;
  let session: Awaited<ReturnType<typeof createPersistentBrowserSession>> | null = null;
  let legacyBrowser: any = null;

  try {
    let page: any;
    let context: any;

    if (usePersistentProfile()) {
      session = await createPersistentBrowserSession(db.config, log);
      page = session.page;
      context = session.context;
    } else {
      const playwrightModule = await import('playwright');
      const { chromium } = playwrightModule;
      legacyBrowser = await chromium.launch({
        headless: db.config.playwrightHeadless !== false
      });
      context = await legacyBrowser.newContext();
      page = await context.newPage();
    }

    const loggedIn = await ensureAuthenticated(page, context, db.config, log);
    if (!loggedIn) {
      return { processed: 0, failed: pendingProjects.length, totalPending: pendingProjects.length };
    }

    db = readDatabase();

    const shouldSubmit = forceSubmit || db.config.autoSubmit === true;
    let sentToday = db.projects.filter((p: Project) => p.status === ProjectStatus.SENT).length;
    const submitDelayBase = options.delayBetweenSubmitsMs ?? 0;
    const submitDelayJitter = options.delayJitterMs ?? 0;

    for (let i = 0; i < pendingProjects.length; i++) {
      const project = pendingProjects[i];
      if (sentToday >= db.config.maxProposalsPerDay) {
        log('warning', `Limite diário atingido (${db.config.maxProposalsPerDay}/dia).`);
        break;
      }

      const freshProject = readDatabase().projects.find((p: Project) => p.id === project.id) || project;

      try {
        const ok = await submitSingleProject(page, context, db.config, freshProject, shouldSubmit, log);
        project.status = freshProject.status;
        if (ok) {
          processed++;
          sentToday++;
        } else if (freshProject.status === ProjectStatus.FAILED) {
          failed++;
        }
      } catch (err: any) {
        log('error', `[DISPARADOR] Erro ao processar #${project.id}: ${err.message}`, project.id);
        project.status = ProjectStatus.FAILED;
        failed++;
      }

      if (i < pendingProjects.length - 1 && submitDelayBase > 0) {
        const waitMs = submitDelayBase + Math.floor(Math.random() * submitDelayJitter);
        log('info', `[ANTI-BOT] Pausa de ${Math.round(waitMs / 1000)}s antes do próximo envio...`);
        await page.waitForTimeout(waitMs);
      }
    }

    db = readDatabase();
    for (const project of pendingProjects) {
      const liveProj = db.projects.find((p: Project) => p.id === project.id);
      if (liveProj) liveProj.status = project.status;
    }
    writeDatabase(db);

    const totalPending = db.projects.filter((p: Project) => p.status === ProjectStatus.PENDING_REVIEW).length;
    return { processed, failed, totalPending };
  } catch (err: any) {
    log('error', `Playwright indisponível: ${err.message}`);
    return { processed: 0, failed: pendingProjects.length, totalPending: pendingProjects.length };
  } finally {
    if (session) {
      await session.close();
    }
    if (legacyBrowser) {
      await legacyBrowser.close();
    }
  }
}

export { openLoginBrowser } from './browser-session.ts';
