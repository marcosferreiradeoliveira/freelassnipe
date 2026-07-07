import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Project, ProjectStatus, SystemLog } from '../src/types';
import { PLATFORM } from './platform-config.ts';
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

async function openBidForm(page: any, jobUrl: string, log: SubmitWorkerOptions['log']) {
  const write = log || defaultLog;
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  const bidSelectors = [
    '#bid_button',
    'a[href*="/messages"]',
    'button:has-text("Enviar")',
    'a:has-text("proposta")',
    'a:has-text("Proposta")',
    'button:has-text("proposta")'
  ];

  for (const selector of bidSelectors) {
    const el = page.locator(selector).first();
    if (await el.isVisible().catch(() => false)) {
      const href = await el.getAttribute('href').catch(() => null);
      if (href?.includes('/signup')) continue;
      write('info', `[DISPARADOR] Clicando em enviar proposta (${selector})...`);
      await el.click();
      await page.waitForTimeout(2000);
      return;
    }
  }
}

async function fillWorkanaBidForm(page: any, project: Project) {
  const proposalSelectors = [
    'textarea[name="message"]',
    'textarea[name="bid[message]"]',
    '#message',
    'textarea'
  ];

  let proposalInput = null;
  for (const sel of proposalSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      proposalInput = loc;
      break;
    }
  }

  if (!proposalInput) {
    throw new Error('Campo de proposta não encontrado.');
  }

  await proposalInput.fill(project.generatedProposal || '');

  const priceSelectors = [
    'input[name*="amount"]',
    'input[name*="budget"]',
    'input[name*="price"]',
    '#amount',
    'input[type="number"]'
  ];

  if (project.suggestedPrice) {
    for (const sel of priceSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        await loc.fill(String(project.suggestedPrice));
        break;
      }
    }
  }

  const timeSelectors = [
    'input[name*="delivery"]',
    'input[name*="deadline"]',
    'input[name*="days"]',
    'select[name*="delivery"]'
  ];

  if (project.suggestedTime) {
    for (const sel of timeSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        const tag = await loc.evaluate((el: Element) => el.tagName.toLowerCase()).catch(() => 'input');
        if (tag === 'select') {
          await loc.selectOption(String(project.suggestedTime)).catch(() => {});
        } else {
          await loc.fill(String(project.suggestedTime));
        }
        break;
      }
    }
  }
}

async function confirmWorkanaModals(page: any) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.waitForTimeout(1000);
    const confirm = page.locator('button:has-text("Confirmar"), button:has-text("Enviar"), input[type="submit"]').first();
    if (await confirm.isVisible().catch(() => false)) {
      const text = await confirm.innerText().catch(() => '');
      if (/cancelar|voltar/i.test(text)) continue;
    }
    const modalOk = page.locator('.modal:visible button.btn-primary, .modal:visible button.btn-inverse').first();
    if (await modalOk.isVisible().catch(() => false)) {
      await modalOk.click();
    }
  }
}

async function waitForWorkanaSubmissionResult(page: any): Promise<'success' | 'error' | 'pending'> {
  await page.waitForTimeout(3000);

  const successText = await page
    .locator('text=/proposta enviada|proposal sent|sucesso|success/i')
    .first()
    .isVisible()
    .catch(() => false);
  if (successText) return 'success';

  const errorText = await page
    .locator('.alert-danger, .error, .form-error, [class*="error"]')
    .first()
    .innerText()
    .catch(() => '');
  if (errorText.trim()) return 'error';

  if (!page.url().includes('/login') && !page.url().includes('/signup')) {
    const stillOnForm = await page.locator('textarea').first().isVisible().catch(() => false);
    if (!stillOnForm) return 'success';
  }

  return 'pending';
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
  const jobUrl = project.url;

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
    await fillWorkanaBidForm(page, project);
  } catch (err: any) {
    write('error', `[DISPARADOR] ${err.message}`, project.id);
    project.status = ProjectStatus.FAILED;
    return false;
  }

  if (!shouldSubmit) {
    write('warning', `[MODO MANUAL] Formulário preenchido, envio desativado.`, project.id);
    project.status = ProjectStatus.PENDING_REVIEW;
    return false;
  }

  const preSubmitDelay = 3000 + Math.floor(Math.random() * 7000);
  write('info', `[DISPARADOR] Aguardando ${Math.round(preSubmitDelay / 1000)}s antes de enviar...`, project.id);
  await page.waitForTimeout(preSubmitDelay);

  const submitButton = page
    .locator('button[type="submit"], input[type="submit"], button:has-text("Enviar"), button:has-text("Submit")')
    .first();

  if (!(await submitButton.isVisible().catch(() => false))) {
    write('error', `[DISPARADOR] Botão de envio não encontrado.`, project.id);
    project.status = ProjectStatus.FAILED;
    return false;
  }

  write('info', `[DISPARADOR] Enviando proposta ($${project.suggestedPrice}, ${project.suggestedTime} dias)...`, project.id);
  await submitButton.click();
  await confirmWorkanaModals(page);

  const result = await waitForWorkanaSubmissionResult(page);
  if (result === 'success') {
    write('success', `[DISPARADOR] PROPOSTA ENVIADA: "${project.title}"!`, project.id);
    project.status = ProjectStatus.SENT;
    return true;
  }

  write('error', `[DISPARADOR] Proposta não confirmada no ${PLATFORM.name}. Verifique connects e perfil.`, project.id);
  project.status = ProjectStatus.FAILED;
  return false;
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
