/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { runSubmitWorker, openLoginBrowser } from './lib/submit-proposals.ts';
import { runAutopilotBatch } from './lib/autopilot.ts';
import { PLATFORM, buildJobsListUrl } from './lib/platform-config.ts';
import {
  fetchWorkanaJobsPageHtml,
  parseWorkanaJobsFromHtml,
  workanaJobToProject
} from './lib/workana-scrape.ts';
import { Project, ProjectStatus, SystemLog, SystemConfig } from './src/types';
import { formatBudgetHint, normalizeSuggestedPrice } from './lib/budget-utils.ts';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3002', 10);
const HMR_PORT = parseInt(process.env.HMR_PORT || '24679', 10);
const DB_FILE = path.join(process.cwd(), 'db.json');

app.use(express.json());

// ==========================================
// DB ENGINE (LIGHTWEIGHT FILE-BASED DATABASE)
// ==========================================
interface DBStructure {
  projects: Project[];
  config: SystemConfig;
  logs: SystemLog[];
}

const DEFAULT_CONFIG: SystemConfig = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
  freelasEmail: process.env.FREELAS_EMAIL || '',
  freelasPassword: process.env.FREELAS_PASSWORD || '',
  freelasSessionCookie: process.env.FREELAS_SESSION_COOKIE || '',
  playwrightHeadless: process.env.PLAYWRIGHT_HEADLESS === 'true',
  autoSubmit: process.env.AUTO_SUBMIT === 'true',
  maxProposalsPerDay: parseInt(process.env.MAX_PROPOSALS_PER_DAY || '10', 10),
  useKeywordFilters: process.env.USE_KEYWORD_FILTERS !== 'false',
  blacklistKeywords: ['design', 'logo', 'video', 'copywriter', 'tradutor', 'artes', 'redigi', 'escrever'],
  whitelistKeywords: ['node', 'python', 'script', 'automação', 'automacao', 'bot', 'scrapper', 'raspar', 'ia', 'gemini', 'chatgpt', 'crawler', 'api', 'backend', 'vps', 'dados', 'integrar', 'integração']
};

function readDB(): DBStructure {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (error) {
    console.error('Error reading DB, using default structure', error);
  }
  const initialDB: DBStructure = {
    projects: [],
    config: DEFAULT_CONFIG,
    logs: []
  };
  writeDB(initialDB);
  return initialDB;
}

function writeDB(data: DBStructure) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error writing DB', error);
  }
}

function addLog(type: SystemLog['type'], message: string, projectId?: string) {
  const db = readDB();
  const newLog: SystemLog = {
    id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    timestamp: new Date().toISOString(),
    type,
    message,
    projectId
  };
  db.logs.unshift(newLog); // New logs at the beginning
  if (db.logs.length > 500) {
    db.logs = db.logs.slice(0, 500); // Caps logs at 500
  }
  writeDB(db);
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// ==========================================
// API ENDPOINTS
// ==========================================

// Get Settings Config
app.get('/api/config', (req, res) => {
  const db = readDB();
  res.json({
    ...DEFAULT_CONFIG,
    ...db.config
  });
});

// Update Settings Config
app.post('/api/config', (req, res) => {
  const db = readDB();
  db.config = { ...db.config, ...req.body };
  writeDB(db);
  addLog('success', 'Configurações de sistema salvas com sucesso.');
  res.json(db.config);
});

// Get Database Projects (somente públicos, sem premium/exclusivos)
app.get('/api/projects', (req, res) => {
  const db = readDB();
  const projects = getPublicProjects(db.projects);
  res.json({
    projects,
    stats: {
      total: projects.length,
      seen: projects.filter(p => p.status === ProjectStatus.SEEN).length,
      generating: projects.filter(p => p.status === ProjectStatus.GENERATING).length,
      pending: projects.filter(p => p.status === ProjectStatus.PENDING_REVIEW).length,
      sent: projects.filter(p => p.status === ProjectStatus.SENT).length,
      failed: projects.filter(p => p.status === ProjectStatus.FAILED).length
    }
  });
});

// Update single project details (manual overrides, proposals rewrite, e.g. from UI)
app.post('/api/projects/:id', (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const index = db.projects.findIndex(p => p.id === id);

  if (index !== -1) {
    db.projects[index] = { ...db.projects[index], ...req.body };
    writeDB(db);
    res.json(db.projects[index]);
  } else {
    res.status(404).json({ error: 'Projeto não localizado no banco.' });
  }
});

// Delete specific project
app.delete('/api/projects/:id', (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const lenBefore = db.projects.length;
  db.projects = db.projects.filter(p => p.id !== id);
  if (db.projects.length !== lenBefore) {
    writeDB(db);
    addLog('info', `Projeto #${id} removido do banco.`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Projeto não localizado.' });
  }
});

// Force reset of database projects
app.post('/api/projects/reset', (req, res) => {
  const db = readDB();
  db.projects = [];
  db.logs = [];
  writeDB(db);
  addLog('info', 'Banco de dados limpo. Execute uma varredura para importar projetos reais do Workana.');
  res.json({ success: true });
});

// Scraper Automation (`/api/scrape`)
const SCRAPE_START_PAGE = PLATFORM.scrapePage;

function getPublicProjects(projects: Project[]): Project[] {
  return projects.filter(p => !p.isExclusive);
}

function parseProjectsFromWorkanaHtml(html: string): Project[] {
  const jobs = parseWorkanaJobsFromHtml(html);
  return jobs
    .filter((job) => !job.isInvite)
    .map((job) => workanaJobToProject(job));
}

interface ScrapeResult {
  success: boolean;
  added: number;
  skipped: number;
  totalCount: number;
  error?: string;
}

let scrapeInProgress = false;
let bgPipelineRunning = false;
let bgGenerationRunning = false;
let bgSubmitRunning = false;

async function runWebScrape(options: { quiet?: boolean } = {}): Promise<ScrapeResult> {
  const quiet = options.quiet === true;

  if (scrapeInProgress) {
    if (!quiet) {
      addLog('warning', 'Varredura já em andamento. Ignorando solicitação duplicada.');
    }
    return {
      success: false,
      added: 0,
      skipped: 0,
      totalCount: readDB().projects.length,
      error: 'busy'
    };
  }

  scrapeInProgress = true;

  try {
    if (!quiet) {
      addLog('info', `Iniciando varredura em ${PLATFORM.name}...`);
    }

    const db = readDB();
    const { whitelistKeywords, blacklistKeywords, useKeywordFilters } = db.config;
    const targetUrl = buildJobsListUrl(SCRAPE_START_PAGE);

    if (!quiet) {
      addLog('info', `Conectando ao catálogo (página ${SCRAPE_START_PAGE}): ${targetUrl}`);
    }

    let html = '';
    try {
      html = await fetchWorkanaJobsPageHtml(SCRAPE_START_PAGE);
    } catch (e: any) {
      addLog('warning', `Erro ao carregar página ${SCRAPE_START_PAGE}: ${e.message}`);
    }

    const allJobs = html ? parseWorkanaJobsFromHtml(html) : [];
    const inviteSkipped = allJobs.filter((job) => job.isInvite).length;
    const parsedProjects = html ? parseProjectsFromWorkanaHtml(html) : [];

    if (!quiet) {
      if (parsedProjects.length > 0) {
        addLog('info', `Página ${SCRAPE_START_PAGE}: ${parsedProjects.length} projetos extraídos (${inviteSkipped} convites ignorados).`);
      } else if (inviteSkipped > 0) {
        addLog('warning', `Página ${SCRAPE_START_PAGE}: ${inviteSkipped} convites exclusivos encontrados e ignorados.`);
      }

      if (parsedProjects.length === 0) {
        addLog('warning', `Nenhum projeto encontrado na página ${SCRAPE_START_PAGE}. Verifique conexão ou mudanças no site.`);
      }
    }

    let addedCount = 0;
    let skippedCount = 0;

    for (const project of parsedProjects) {
      const titleLower = project.title.toLowerCase();
      const descLower = project.description.toLowerCase();

      const hitsBlacklist = useKeywordFilters !== false && blacklistKeywords.some((kw: string) =>
        titleLower.includes(kw.toLowerCase()) || descLower.includes(kw.toLowerCase())
      );

      const hitsWhitelist = whitelistKeywords.some((kw: string) =>
        titleLower.includes(kw.toLowerCase()) || descLower.includes(kw.toLowerCase())
      );

      if (hitsBlacklist) {
        if (!quiet) {
          addLog('warning', `Filtro ativo: Projeto [${project.title.substring(0, 30)}...] rejeitado por palavra-chave restrita.`);
        }
        skippedCount++;
        continue;
      }

      if (useKeywordFilters !== false && whitelistKeywords.length > 0 && !hitsWhitelist) {
        if (!quiet) {
          addLog('warning', `Filtro ativo: Projeto [${project.title.substring(0, 30)}...] ignorado por não conter termos técnicos da whitelist.`);
        }
        skippedCount++;
        continue;
      }

      const exists = db.projects.some(p => p.id === project.id);
      if (!exists) {
        db.projects.unshift(project);
        addedCount++;

        if (db.config.autoSubmit) {
          addLog('info', `[AUTO-PILOT] Detectado em modo Automático. Agendando inteligência para #${project.id}.`);
          project.status = ProjectStatus.GENERATING;
        }
      }
    }

    writeDB(db);

    if (!quiet || addedCount > 0) {
      const prefix = quiet ? '[AUTO-SCRAPE] ' : '';
      addLog('success', `${prefix}Varredura concluída. Novos projetos adicionados: ${addedCount}. Filtrados/Skipped: ${skippedCount}.`);
    }

    if (db.config.autoSubmit && addedCount > 0) {
      void runAutoPipeline();
    }

    return {
      success: true,
      added: addedCount,
      skipped: skippedCount,
      totalCount: db.projects.length
    };
  } catch (error: any) {
    addLog('error', `Falha crítica durante varredura: ${error.message}`);
    return {
      success: false,
      added: 0,
      skipped: 0,
      totalCount: readDB().projects.length,
      error: error.message
    };
  } finally {
    scrapeInProgress = false;
  }
}

function startAutoScrapeLoop() {
  const enabled = process.env.AUTO_SCRAPE !== 'false';
  const intervalMs = parseInt(process.env.SCRAPE_INTERVAL_MS || '30000', 10);

  if (!enabled) {
    console.log('[SERVER] Varredura automática desativada (AUTO_SCRAPE=false).');
    return;
  }

  console.log(`[SERVER] Varredura automática ativa a cada ${intervalMs / 1000}s.`);

  setInterval(() => {
    runWebScrape({ quiet: true }).catch((err) => {
      addLog('error', `Falha na varredura automática: ${err.message}`);
    });
  }, intervalMs);

  setTimeout(() => {
    runWebScrape({ quiet: true }).catch((err) => {
      addLog('error', `Falha na varredura automática inicial: ${err.message}`);
    });
  }, 3000);
}

app.get('/api/scrape', async (req, res) => {
  return await handleWebScrape(req, res);
});
app.post('/api/scrape', async (req, res) => {
  return await handleWebScrape(req, res);
});

async function handleWebScrape(req: any, res: any) {
  const result = await runWebScrape({ quiet: false });

  if (result.error === 'busy') {
    return res.status(429).json({ error: 'Varredura já em andamento.' });
  }

  if (!result.success) {
    return res.status(500).json({ error: result.error });
  }

  res.json({
    success: true,
    added: result.added,
    skipped: result.skipped,
    totalCount: result.totalCount
  });
}

async function triggerBgAutoGenerations(): Promise<void> {
  if (bgGenerationRunning) return;

  const db = readDB();
  if (!db.config.autoSubmit) return;

  const backlog = db.projects.filter(
    (p) => p.status === ProjectStatus.GENERATING || p.status === ProjectStatus.SEEN
  );
  if (backlog.length === 0) return;

  bgGenerationRunning = true;
  try {
    addLog('info', `[AUTO] Gerando ${backlog.length} proposta(s) com Gemini...`);
    for (const project of backlog) {
      try {
        await generateAISingleProject(project.id);
      } catch (e: any) {
        console.error(`Bg generation failed for #${project.id}`, e);
      }
    }
  } finally {
    bgGenerationRunning = false;
  }
}

async function triggerBgAutoSubmit(): Promise<void> {
  if (bgSubmitRunning) return;

  const db = readDB();
  if (!db.config.autoSubmit) return;

  const pending = db.projects.filter(
    (p) => p.status === ProjectStatus.PENDING_REVIEW && Boolean(p.generatedProposal?.trim())
  );
  if (pending.length === 0) return;

  bgSubmitRunning = true;
  try {
    addLog('info', `[AUTO] Enviando ${pending.length} proposta(s) prontas...`);
    await runSubmitWorker({
      forceSubmit: true,
      log: (type, message, projectId) => addLog(type, message, projectId),
      delayBetweenSubmitsMs: parseInt(process.env.AUTOPILOT_SUBMIT_DELAY_MS || '45000', 10),
      delayJitterMs: parseInt(process.env.AUTOPILOT_SUBMIT_JITTER_MS || '45000', 10)
    });
  } finally {
    bgSubmitRunning = false;
  }
}

async function runAutoPipeline(): Promise<void> {
  if (bgPipelineRunning) return;

  const db = readDB();
  if (!db.config.autoSubmit) return;

  bgPipelineRunning = true;
  try {
    await triggerBgAutoGenerations();
    await triggerBgAutoSubmit();
  } finally {
    bgPipelineRunning = false;
  }
}

function startAutoPipelineLoop() {
  const intervalMs = parseInt(process.env.AUTO_PIPELINE_INTERVAL_MS || '20000', 10);

  setInterval(() => {
    runAutoPipeline().catch((err) => {
      addLog('error', `[AUTO] Falha no pipeline automático: ${err.message}`);
    });
  }, intervalMs);
}

// Common core implementation of AISingleProject for API and backgrounds
async function generateAISingleProject(projectId: string): Promise<Project> {
  const db = readDB();
  const project = db.projects.find(p => p.id === projectId);
  
  if (!project) {
    throw new Error(`Projeto #${projectId} não encontrado no banco.`);
  }

  // Idempotency: skip if already has an established proposal
  if (project.generatedProposal && project.status === ProjectStatus.PENDING_REVIEW) {
    addLog('info', `[IDEMPOTÊNCIA] Proposta para #${projectId} já existe em cache. Ignorando chamada Gemini.`, projectId);
    return project;
  }

  // Verify technical/automation scope before spending Gemini tokens
  const titleLower = project.title.toLowerCase();
  const descLower = project.description.toLowerCase();
  const { whitelistKeywords, blacklistKeywords, geminiApiKey, geminiModel, useKeywordFilters } = db.config;

  if (useKeywordFilters !== false) {
    const passesScope = whitelistKeywords.some((kw: string) => 
      titleLower.includes(kw.toLowerCase()) || descLower.includes(kw.toLowerCase())
    );
    
    if (!passesScope) {
      project.status = ProjectStatus.FAILED;
      writeDB(db);
      addLog('warning', `[FILTRO IA COM ESCASSEZ] Projeto #${projectId} abortado antes de chamar o Gemini: Fora de escopo tech/automação.`, projectId);
      throw new Error('Projeto abortado: Sem correspondência de escopo técnico.');
    }
  }

  // Update status to generating
  project.status = ProjectStatus.GENERATING;
  writeDB(db);

  const activeApiKey = geminiApiKey || process.env.GEMINI_API_KEY;
  if (!activeApiKey) {
    project.status = ProjectStatus.FAILED;
    writeDB(db);
    addLog('error', `Falha de autenticação: GEMINI_API_KEY em branco. Forneça a chave nas Configurações.`, projectId);
    throw new Error('Chave de API do Gemini não configurada!');
  }

  addLog('info', `Enviando briefing de #${projectId} para análise do Gemini (${geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite'})...`, projectId);

  try {
    const ai = new GoogleGenAI({
      apiKey: activeApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });

    const promptText = `
Você é um Engenheiro de Software Freelancer Full Stack altamente experiente, especialista em automações de sistemas, web scrapers, bots e APIs Web.
Analise a seguinte oportunidade listada no Workana e crie uma carta de apresentação estratégica para envio de proposta.

TÍTULO DO PROJETO: "${project.title}"
ORÇAMENTO INFORMADO: "${project.budget}"
${formatBudgetHint(project.budget)}
HABILIDADES EXIGIDAS: ${project.skills.join(', ')}
DESCRIÇÃO COMPLETA DO CLIENTE:
"""
${project.description}
"""

Instruções para a Proposta (proposal):
1. Aja como freelancer profissional que entende as dores específicas do projeto.
2. Seja DIRETO — sem introduções genéricas ou floreios de marketing. Máximo de 3-4 parágrafos curtos.
3. Demonstre competência listando brevemente as tecnologias ideais (ex: Playwright/Puppeteer para automação web).
4. Sugira preço (suggestedPrice) em USD compatível com o orçamento do cliente. O valor DEVE ser >= ao mínimo da faixa informada (ou USD/h mínimo em projetos por hora). Prefira um valor dentro da faixa, próximo ao meio ou topo quando fizer sentido.
5. Use a mesma língua do briefing (normalmente português do Brasil).

Retorne estritamente em JSON:
{
  "proposal": "texto da carta de apresentação",
  "suggestedPrice": valor numérico em USD (ex: 150),
  "suggestedTime": dias estimados de entrega
}
`;

    const activeModel = geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

    const response = await ai.models.generateContent({
      model: activeModel,
      contents: promptText,
      config: {
        systemInstruction: "Aja como um freelancer especialista focado em criar cartas de apresentação de alto engajamento, assertivas e técnicas no Workana.",
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            proposal: {
              type: Type.STRING,
              description: "Proposta técnica de fechamento escrita em parágrafos diretos e profissionais focados na dor do projeto."
            },
            suggestedPrice: {
              type: Type.NUMBER,
              description: "Valor numérico recomendado em USD sugerido para o bid (ex: 150)."
            },
            suggestedTime: {
              type: Type.INTEGER,
              description: "Número de dias para finalização do projeto (ex: 5)."
            }
          },
          required: ["proposal", "suggestedPrice", "suggestedTime"]
        }
      }
    });

    const responseText = response.text || '';
    const result = JSON.parse(responseText.trim());
    const normalizedPrice = normalizeSuggestedPrice(result.suggestedPrice, project.budget);

    // Refresh DB and apply results to prevent overwritten states
    const postDb = readDB();
    const projIndex = postDb.projects.findIndex(p => p.id === projectId);
    
    if (projIndex !== -1) {
      postDb.projects[projIndex].generatedProposal = result.proposal;
      postDb.projects[projIndex].suggestedPrice = normalizedPrice.price;
      postDb.projects[projIndex].suggestedTime = result.suggestedTime;
      postDb.projects[projIndex].status = ProjectStatus.PENDING_REVIEW;
      
      writeDB(postDb);
      if (normalizedPrice.adjusted && normalizedPrice.reason) {
        addLog('warning', `[PREÇO] ${normalizedPrice.reason}`, projectId);
      }
      addLog('success', `Proposta Sniper para #${projectId} gerada com sucesso! Preço sugerido: $${normalizedPrice.price} USD, Prazo: ${result.suggestedTime} dias.`, projectId);
      return postDb.projects[projIndex];
    } else {
      throw new Error("Projeto desapareceu durante processamento Gemini.");
    }
  } catch (error: any) {
    const errorDb = readDB();
    const projIndex = errorDb.projects.findIndex(p => p.id === projectId);
    if (projIndex !== -1) {
      errorDb.projects[projIndex].status = ProjectStatus.FAILED;
      writeDB(errorDb);
    }
    addLog('error', `Erro ao processar chamada IA do Gemini para #${projectId}: ${error.message}`, projectId);
    throw error;
  }
}

// AI Proposal Generation (`POST /api/generate`)
app.post('/api/generate', async (req, res) => {
  const { projectId } = req.body;
  if (!projectId) {
    return res.status(400).json({ error: 'Parâmetro `projectId` é obrigatório.' });
  }

  try {
    const updatedProject = await generateAISingleProject(projectId);
    res.json({
      success: true,
      proposal: updatedProject.generatedProposal,
      suggestedPrice: updatedProject.suggestedPrice,
      suggestedTime: updatedProject.suggestedTime,
      status: updatedProject.status
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Logs Endpoint
app.get('/api/logs', (req, res) => {
  const db = readDB();
  res.json(db.logs);
});

// Manual Run Worker — envio real via Playwright
app.post('/api/worker/run', async (req, res) => {
  try {
    const result = await runSubmitWorker({
      forceSubmit: true,
      log: (type, message, projectId) => addLog(type, message, projectId)
    });
    res.json(result);
  } catch (error: any) {
    addLog('error', `Falha no orquestrador: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Abre browser visível para login manual — salva sessão no perfil persistente
app.post('/api/auth/login', async (req, res) => {
  try {
    addLog('info', `Iniciando login manual no ${PLATFORM.name} (perfil persistente)...`);
    const result = await openLoginBrowser((type, message) => addLog(type, message));
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: any) {
    addLog('error', `Falha no login: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/auto-mode/status', (_req, res) => {
  const db = readDB();
  res.json({
    enabled: db.config.autoSubmit === true,
    pipelineRunning: bgPipelineRunning,
    generating: bgGenerationRunning,
    submitting: bgSubmitRunning,
    scraping: scrapeInProgress,
    backlog: {
      seen: db.projects.filter((p) => p.status === ProjectStatus.SEEN).length,
      generating: db.projects.filter((p) => p.status === ProjectStatus.GENERATING).length,
      pending: db.projects.filter((p) => p.status === ProjectStatus.PENDING_REVIEW).length
    }
  });
});

app.post('/api/auto-mode/toggle', (req, res) => {
  const db = readDB();
  const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : !db.config.autoSubmit;
  db.config.autoSubmit = enabled;
  writeDB(db);

  if (enabled) {
    addLog('info', '[AUTO] Modo automático ATIVADO — varredura contínua, geração IA e envio de propostas.');
    void runAutoPipeline();
  } else {
    addLog('info', '[AUTO] Modo automático DESATIVADO.');
  }

  res.json({ enabled: db.config.autoSubmit });
});

let autopilotRunning = false;

// Autopilot: 10 primeiros "seen" → gerar → fila → enviar com pausas
app.post('/api/autopilot/run', (req, res) => {
  if (autopilotRunning) {
    return res.status(429).json({ error: 'Autopilot já em execução. Acompanhe os logs.' });
  }

  autopilotRunning = true;
  const batchSize = parseInt(req.body?.batchSize || process.env.AUTOPILOT_BATCH_SIZE || '10', 10);

  res.json({
    success: true,
    message: `Autopilot iniciado para até ${batchSize} projetos. Acompanhe o terminal.`
  });

  void (async () => {
    try {
      await runAutopilotBatch({
        batchSize,
        generateProject: (projectId) => generateAISingleProject(projectId),
        getEligibleProjects: () => {
          const db = readDB();
          return getPublicProjects(db.projects)
            .filter((p) => p.status === ProjectStatus.SEEN)
            .map((p) => ({ id: p.id, title: p.title }));
        },
        log: (type, message, projectId) => addLog(type, message, projectId)
      });
    } catch (error: any) {
      addLog('error', `[AUTOPILOT] Falha crítica: ${error.message}`);
    } finally {
      autopilotRunning = false;
    }
  })();
});

app.get('/api/autopilot/status', (_req, res) => {
  res.json({ running: autopilotRunning });
});

// Serve Frontend SPA
// Vite middleware for development
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { port: HMR_PORT },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] workana-sniper executando em http://localhost:${PORT}`);
    startAutoScrapeLoop();
    startAutoPipelineLoop();
  });
}

startServer();
