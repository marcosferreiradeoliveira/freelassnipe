import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const DB_FILE = path.join(process.cwd(), 'db.json');
const SESSION_CHECK_URL = 'https://www.99freelas.com.br/dashboard';

export const SESSION_COOKIE_NAMES = ['JSESSIONID', 'kmlicin', 'kmlicn', 'sgcn'] as const;

type LogFn = (type: 'info' | 'warning' | 'error' | 'success', message: string) => void;

let profileLock = false;

function readDatabase() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

function writeDatabase(db: any) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
}

export function getUserDataDir(): string {
  const dir = process.env.PLAYWRIGHT_USER_DATA_DIR || '.99freelas-profile';
  return path.resolve(process.cwd(), dir);
}

export function usePersistentProfile(): boolean {
  return process.env.USE_PERSISTENT_PROFILE !== 'false';
}

export function buildSessionCookieString(
  cookies: Array<{ name: string; value: string }>
): string {
  return SESSION_COOKIE_NAMES.map((name) => cookies.find((c) => c.name === name))
    .filter(Boolean)
    .map((c) => `${c!.name}=${c!.value}`)
    .join('; ');
}

export function parseSessionCookieString(cookieString: string) {
  return cookieString.split(';').map((c) => {
    const [name, ...valParts] = c.trim().split('=');
    return {
      name: name.trim(),
      value: valParts.join('=').trim(),
      domain: 'www.99freelas.com.br',
      path: '/'
    };
  }).filter((c) => c.name && c.value);
}

export async function hasRequiredSessionCookies(context: any): Promise<boolean> {
  const cookies = await context.cookies('https://www.99freelas.com.br');
  return SESSION_COOKIE_NAMES.every((name) =>
    cookies.some((c: { name: string; value: string }) => c.name === name && c.value)
  );
}

function isLoginUrl(url: string): boolean {
  return url.includes('/login') || url.includes('/register');
}

async function withProfileLock<T>(fn: () => Promise<T>): Promise<T> {
  const maxWaitMs = 120000;
  const start = Date.now();

  while (profileLock) {
    if (Date.now() - start > maxWaitMs) {
      throw new Error('Perfil do browser ocupado por outra operação. Tente novamente em instantes.');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  profileLock = true;
  try {
    return await fn();
  } finally {
    profileLock = false;
  }
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    throw new Error('Playwright não instalado. Execute: npm install playwright && npx playwright install chromium');
  }
}

async function detectCloudflareBlock(page: any): Promise<boolean> {
  const turnstileFailed = await page
    .locator('text=/verification failed|verifica[cç][aã]o falhou|challenge/i')
    .first()
    .isVisible()
    .catch(() => false);
  return turnstileFailed;
}

async function launchPersistentContextSafe(
  chromium: any,
  userDataDir: string,
  options: { headless: boolean; forLogin?: boolean },
  log?: LogFn
) {
  const write = log || ((type, message) => console.log(`[${type.toUpperCase()}] ${message}`));
  const channel = process.env.PLAYWRIGHT_CHANNEL || 'chrome';

  const contextOptions: Record<string, unknown> = {
    headless: options.forLogin ? false : options.headless,
    viewport: { width: 1280, height: 720 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation']
  };

  if (options.forLogin || process.env.PLAYWRIGHT_CHANNEL) {
    try {
      write('info', `Abrindo Google Chrome (${channel})...`);
      return await chromium.launchPersistentContext(userDataDir, {
        ...contextOptions,
        channel
      });
    } catch {
      write('warning', `Chrome "${channel}" não encontrado. Instale Google Chrome ou defina PLAYWRIGHT_CHANNEL=chromium. Usando Chromium do Playwright.`);
    }
  }

  return chromium.launchPersistentContext(userDataDir, contextOptions);
}

export async function injectCookiesIntoContext(
  context: any,
  cookieString: string,
  log?: LogFn
): Promise<void> {
  const write = log || ((type, message) => console.log(`[${type.toUpperCase()}] ${message}`));
  const cookies = parseSessionCookieString(cookieString);
  if (cookies.length === 0) return;
  await context.addCookies(cookies);
  write('info', 'Cookies de sessão injetados no browser.');
}

export async function syncSessionToDatabase(
  context: any,
  log?: LogFn
): Promise<boolean> {
  const cookies = await context.cookies('https://www.99freelas.com.br');
  const sessionString = buildSessionCookieString(cookies);

  if (!sessionString.includes('JSESSIONID=')) {
    log?.('warning', 'Perfil ativo, mas JSESSIONID não encontrado.');
    return false;
  }

  if (!sessionString.includes('kmlicin=') || !sessionString.includes('kmlicn=')) {
    log?.('warning', 'Sessão incompleta: faltam cookies kmlicin/kmlicn. Faça login novamente no 99Freelas.');
    return false;
  }

  const db = readDatabase();
  db.config.freelasSessionCookie = sessionString;
  writeDatabase(db);
  log?.('success', 'Cookies completos sincronizados do perfil persistente para o banco.');
  return true;
}

export async function navigateAndCheckSession(page: any, context?: any): Promise<boolean> {
  await page.goto(SESSION_CHECK_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  await page.waitForTimeout(1500);

  if (isLoginUrl(page.url())) {
    return false;
  }

  if (context && !(await hasRequiredSessionCookies(context))) {
    return false;
  }

  return true;
}

export async function ensureLoggedInWithProfile(
  page: any,
  context: any,
  config: any,
  log?: LogFn,
  options: { allowManualLogin?: boolean; loginTimeoutMs?: number } = {}
): Promise<boolean> {
  const write = log || ((type, message) => console.log(`[${type.toUpperCase()}] ${message}`));
  const allowManualLogin = options.allowManualLogin !== false;
  const loginTimeoutMs = options.loginTimeoutMs ?? 180000;

  write('info', 'Verificando sessão autenticada em /dashboard...');

  if (await navigateAndCheckSession(page, context)) {
    await syncSessionToDatabase(context, write);
    write('success', 'Sessão autenticada via perfil persistente.');
    return true;
  }

  if (!allowManualLogin) {
    write('error', 'Sessão expirada ou incompleta. Use "Login no 99Freelas" no dashboard para renovar.');
    return false;
  }

  write('info', 'Faça login no 99Freelas na janela do browser (incluindo captcha se aparecer)...');
  await page.goto('https://www.99freelas.com.br/login', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  if (config.freelasEmail) {
    await page.fill('#email', config.freelasEmail).catch(() => {});
  }
  if (config.freelasPassword) {
    await page.fill('#senha', config.freelasPassword).catch(() => {});
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < loginTimeoutMs) {
    await page.waitForTimeout(2000);

    if (await detectCloudflareBlock(page)) {
      write('error', 'Cloudflare bloqueou o browser automático ("Verification failed"). Faça login no Chrome normal e cole os cookies manualmente no campo acima.');
      return false;
    }

    if (!isLoginUrl(page.url())) {
      const ok = await navigateAndCheckSession(page, context);
      if (ok) {
        await syncSessionToDatabase(context, write);
        write('success', 'Login manual concluído. Sessão salva no perfil persistente.');
        return true;
      }
    }
  }

  write('error', 'Tempo esgotado aguardando login manual no 99Freelas.');
  return false;
}

async function injectCookiesFromConfig(context: any, config: any, log?: LogFn): Promise<boolean> {
  const write = log || ((type, message) => console.log(`[${type.toUpperCase()}] ${message}`));
  const cookieString = config.freelasSessionCookie?.trim();

  if (!cookieString) return false;

  if (!cookieString.includes('kmlicin=') || !cookieString.includes('kmlicn=')) {
    write('error', 'Cookie de sessão incompleto no banco. Copie JSESSIONID, kmlicin, kmlicn e sgcn.');
    return false;
  }

  await injectCookiesIntoContext(context, cookieString, write);

  const page = context.pages()[0] || (await context.newPage());
  if (await navigateAndCheckSession(page, context)) {
    write('success', 'Sessão autenticada via cookies.');
    return true;
  }

  write('error', 'Cookies de sessão inválidos ou expirados.');
  return false;
}

export interface LoginBrowserResult {
  success: boolean;
  message: string;
  sessionCookie?: string;
}

export async function openLoginBrowser(log?: LogFn): Promise<LoginBrowserResult> {
  const write = log || ((type, message) => console.log(`[${type.toUpperCase()}] ${message}`));

  return withProfileLock(async () => {
    const { chromium } = await loadPlaywright();
    const userDataDir = getUserDataDir();
    fs.mkdirSync(userDataDir, { recursive: true });

    write('info', `Abrindo browser com perfil persistente em ${userDataDir}...`);

    const context = await launchPersistentContextSafe(chromium, userDataDir, {
      headless: false,
      forLogin: true
    }, write);

    try {
      const page = context.pages()[0] || (await context.newPage());
      const db = readDatabase();

      if (db.config.freelasSessionCookie?.trim()) {
        await injectCookiesIntoContext(context, db.config.freelasSessionCookie, write);
      }

      if (await navigateAndCheckSession(page, context)) {
        await syncSessionToDatabase(context, write);
        const sessionCookie = readDatabase().config.freelasSessionCookie;
        write('success', 'Sessão ativa no perfil persistente.');
        return { success: true, message: 'Sessão ativa.', sessionCookie };
      }

      const loggedIn = await ensureLoggedInWithProfile(page, context, {
        ...db.config,
        playwrightHeadless: false
      }, write, {
        allowManualLogin: true,
        loginTimeoutMs: 300000
      });

      if (!loggedIn) {
        const cloudflareBlocked = await detectCloudflareBlock(page);
        return {
          success: false,
          message: cloudflareBlocked
            ? 'Cloudflare bloqueou o login automático. Abra www.99freelas.com.br no seu Chrome, faça login, copie os cookies (JSESSIONID, kmlicin, kmlicn, sgcn) e cole no campo acima.'
            : 'Login não concluído. Verifique email/senha e complete o captcha no browser.'
        };
      }

      const sessionCookie = readDatabase().config.freelasSessionCookie;
      return {
        success: true,
        message: 'Login salvo no perfil persistente.',
        sessionCookie
      };
    } finally {
      await context.close();
    }
  });
}

export interface PersistentBrowserSession {
  context: any;
  page: any;
  close: () => Promise<void>;
}

export async function createPersistentBrowserSession(
  config: any,
  log?: LogFn
): Promise<PersistentBrowserSession> {
  const write = log || ((type, message) => console.log(`[${type.toUpperCase()}] ${message}`));

  return withProfileLock(async () => {
    const { chromium } = await loadPlaywright();
    const userDataDir = getUserDataDir();
    fs.mkdirSync(userDataDir, { recursive: true });

    write('info', `Usando perfil persistente: ${userDataDir}`);

    const context = await launchPersistentContextSafe(
      chromium,
      userDataDir,
      { headless: config.playwrightHeadless !== false },
      write
    );

    const page = context.pages()[0] || (await context.newPage());

    return {
      context,
      page,
      close: async () => {
        await context.close();
      }
    };
  });
}

export async function ensureAuthenticated(
  page: any,
  context: any,
  config: any,
  log?: LogFn
): Promise<boolean> {
  const write = log || ((type, message) => console.log(`[${type.toUpperCase()}] ${message}`));

  if (config.freelasSessionCookie?.trim()) {
    await injectCookiesIntoContext(context, config.freelasSessionCookie, write);
  }

  if (usePersistentProfile()) {
    const ok = await ensureLoggedInWithProfile(page, context, config, write, {
      allowManualLogin: config.playwrightHeadless === false,
      loginTimeoutMs: 180000
    });
    if (ok) return true;

    write('warning', 'Perfil/cookies atuais inválidos. Tentando cookies do banco novamente...');
    return injectCookiesFromConfig(context, config, write);
  }

  return injectCookiesFromConfig(context, config, write);
}

export async function revalidateSessionOnPage(page: any, context: any, log?: LogFn): Promise<boolean> {
  const write = log || ((type, message) => console.log(`[${type.toUpperCase()}] ${message}`));
  if (await navigateAndCheckSession(page, context)) {
    return true;
  }
  write('warning', 'Sessão perdida durante o envio.');
  return false;
}
