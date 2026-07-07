import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Project, ProjectStatus, SystemLog } from '../src/types';
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

function getBidUrl(projectUrl: string): string {
  const url = new URL(projectUrl);
  url.pathname = url.pathname.replace('/project/', '/project/bid/');
  url.search = '';
  return url.toString();
}

async function confirmBidModals(page: any) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.waitForTimeout(1200);

    const safetyModal = page.locator('.modal.modal-confirmacao-proposta-pergunta');
    if (await safetyModal.isVisible().catch(() => false)) {
      const checkbox = safetyModal.locator('.confirm-action, input[type="checkbox"]').first();
      if (await checkbox.isVisible().catch(() => false)) {
        await checkbox.check();
      }
      await safetyModal.locator('.btn-acao').click();
      continue;
    }

    const feeModal = page.locator('.modal.modal-info-taxa-oferta-final');
    if (await feeModal.isVisible().catch(() => false)) {
      await feeModal.locator('.btn-confirmar').click();
      continue;
    }

    const genericConfirm = page.locator('.modal:visible .btn-acao, .modal:visible button:has-text("Sim")').first();
    if (await genericConfirm.isVisible().catch(() => false)) {
      await genericConfirm.click();
      continue;
    }

    break;
  }
}

async function waitForSubmissionResult(page: any, projectUrl: string): Promise<'success' | 'error' | 'pending'> {
  const projectPath = new URL(projectUrl).pathname;

  try {
    await page.waitForURL(
      (url: URL) => !url.pathname.includes('/project/bid/'),
      { timeout: 20000 }
    );
    if (page.url().includes(projectPath.replace('/project/', '/project/')) || !page.url().includes('/project/bid/')) {
      return 'success';
    }
  } catch {
    // still on bid page
  }

  const errorText = await page.locator('.general-error-msg, .alert-error, .mensagem-erro, .input-error-msg .error-msg').first().innerText().catch(() => '');
  if (errorText.trim()) return 'error';

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
  const bidUrl = getBidUrl(project.url);

  write('info', `[DISPARADOR] Abrindo formulário de proposta: ${bidUrl}`, project.id);
  await page.goto(bidUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  if (page.url().includes('/login') || page.url().includes('/register')) {
    write('warning', `[DISPARADOR] Redirecionado para login. Tentando reautenticar...`, project.id);

    if (config.freelasSessionCookie?.trim()) {
      await injectCookiesIntoContext(context, config.freelasSessionCookie, write);
    }

    await page.goto(bidUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  }

  if (page.url().includes('/login') || page.url().includes('/register')) {
    write('error', `[DISPARADOR] Sessão inválida ao abrir o projeto. Clique em "Login no 99Freelas" e tente novamente.`, project.id);
    project.status = ProjectStatus.FAILED;
    return false;
  }

  const exclusiveBlock = page.locator('text=/projetos exclusivos|aguarde até que ele seja liberado/i');
  if (await exclusiveBlock.count() > 0) {
    write('warning', `[DISPARADOR] Projeto exclusivo — requer plano pago ou aguardar liberação pública.`, project.id);
    project.status = ProjectStatus.FAILED;
    return false;
  }

  try {
    await page.waitForSelector('#proposta', { timeout: 15000 });
  } catch {
    write('error', `[DISPARADOR] Formulário de proposta não encontrado. Projeto encerrado ou indisponível.`, project.id);
    project.status = ProjectStatus.FAILED;
    return false;
  }

  const proposalInput = page.locator('#proposta').first();
  const priceInput = page.locator('#oferta').first();
  const timeInput = page.locator('#duracao-estimada').first();
  const submitButton = page.locator('#btnConcluirEnvioProposta').first();

  if (!project.generatedProposal) {
    write('error', `[DISPARADOR] Texto da proposta vazio. Gere a proposta com IA antes de enviar.`, project.id);
    project.status = ProjectStatus.FAILED;
    return false;
  }

  await proposalInput.fill(project.generatedProposal);

  if (project.suggestedPrice) {
    await priceInput.fill(String(project.suggestedPrice));
    await priceInput.blur();
    await page.waitForTimeout(500);
  }

  if (project.suggestedTime) {
    await timeInput.fill(String(project.suggestedTime));
  }

  const maxLen = await proposalInput.evaluate((el: HTMLTextAreaElement) => el.maxLength).catch(() => 3000);
  if (maxLen > 0 && project.generatedProposal.length > maxLen) {
    project.generatedProposal = project.generatedProposal.slice(0, maxLen);
    await proposalInput.fill(project.generatedProposal);
  }

  if (!shouldSubmit) {
    write('warning', `[MODO MANUAL] Formulário preenchido, envio real desativado (AUTO_SUBMIT=false).`, project.id);
    project.status = ProjectStatus.PENDING_REVIEW;
    return false;
  }

  const preSubmitDelay = 3000 + Math.floor(Math.random() * 7000);
  write('info', `[DISPARADOR] Aguardando ${Math.round(preSubmitDelay / 1000)}s antes de enviar (comportamento humano)...`, project.id);
  await page.waitForTimeout(preSubmitDelay);

  write('info', `[DISPARADOR] Enviando proposta (R$ ${project.suggestedPrice}, ${project.suggestedTime} dias)...`, project.id);
  await submitButton.click();
  await confirmBidModals(page);

  const result = await waitForSubmissionResult(page, project.url);
  if (result === 'success') {
    write('success', `[DISPARADOR] PROPOSTA SUBMETIDA COM SUCESSO para "${project.title}"! Valor: R$ ${project.suggestedPrice}, Prazo: ${project.suggestedTime} dias.`, project.id);
    project.status = ProjectStatus.SENT;
    return true;
  }

  const errMsg = await page.locator('.general-error-msg, .alert-error, .mensagem-erro, .input-error-msg .error-msg').first().innerText().catch(() => '');
  if (errMsg.trim()) {
    write('error', `[DISPARADOR] 99freelas rejeitou a proposta: ${errMsg.trim()}`, project.id);
  } else {
    write('error', `[DISPARADOR] Proposta não confirmada. Marque o checkbox de confirmação ou verifique os campos obrigatórios.`, project.id);
  }
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
