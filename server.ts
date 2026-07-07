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
import { Project, ProjectStatus, SystemLog, SystemConfig } from './src/types';

dotenv.config();

const app = express();
const PORT = 3000;
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
  addLog('info', 'Banco de dados limpo. Execute uma varredura para importar projetos reais do 99freelas.');
  res.json({ success: true });
});

// Scraper Automation (`/api/scrape`)
const SCRAPE_CATEGORY = 'web-mobile-e-software';
const SCRAPE_START_PAGE = 4;

const SCRAPE_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/png,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8'
};

function decodeHtmlText(text: string): string {
  const entityMap: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
    atilde: 'ã', otilde: 'õ', ccirc: 'ç', auml: 'ä', ouml: 'ö', uuml: 'ü',
    Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
    Atilde: 'Ã', Otilde: 'Õ', Ccedil: 'Ç'
  };

  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&([a-z]+);/gi, (entity, name) => entityMap[name] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

function buildProjectsPageUrl(page: number): string {
  return `https://www.99freelas.com.br/projects?categoria=${SCRAPE_CATEGORY}&page=${page}`;
}

async function fetchProjectsPageHtml(page: number): Promise<string> {
  const targetUrl = buildProjectsPageUrl(page);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: SCRAPE_FETCH_HEADERS
    });
    const html = await response.text();
    clearTimeout(timeoutId);
    return html;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

function isExclusiveProjectHtml(itemHtml: string): boolean {
  return /flat_project_exclusive|Projeto exclusivo|projeto exclusivo/i.test(itemHtml);
}

function getPublicProjects(projects: Project[]): Project[] {
  return projects.filter(p => !p.isExclusive);
}

function parseProjectsFromHtml(html: string): Project[] {
  if (!html.includes('result-item')) return [];

  const parsedProjects: Project[] = [];
  const projectMatches = html.matchAll(/<li[^>]*class="[^"]*result-item[^"]*"[^>]*data-id="(\d+)"([\s\S]*?)<\/li>/gi);

  for (const match of projectMatches) {
    const fullItemHtml = match[0];
    if (isExclusiveProjectHtml(fullItemHtml)) continue;

    const projectId = match[1];
    const itemHtml = match[2];

    const titleMatch = itemHtml.match(/<h1[^>]*class="title"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;

    const relativeUrl = titleMatch[1];
    if (!relativeUrl.includes('/project/')) continue;

    const descMatch = itemHtml.match(/<div[^>]*class="item-text description formatted-text"[^>]*data-content="([^"]*)"/i);
    const bidsMatch = itemHtml.match(/Propostas:\s*<b>(\d+)<\/b>/i);
    const skillsList: string[] = [];

    for (const skillMatch of itemHtml.matchAll(/<a[^>]*class="habilidade"[^>]*>([\s\S]*?)<\/a>/gi)) {
      skillsList.push(decodeHtmlText(skillMatch[1]));
    }

    parsedProjects.push({
      id: `proj_${projectId}`,
      title: decodeHtmlText(titleMatch[2]),
      description: descMatch ? decodeHtmlText(descMatch[1]) : '',
      skills: skillsList.length > 0 ? skillsList : ['Web Development'],
      budget: 'Combinar',
      bidsCount: bidsMatch ? parseInt(bidsMatch[1], 10) : 0,
      url: `https://www.99freelas.com.br${relativeUrl}`,
      status: ProjectStatus.SEEN,
      timestamp: new Date().toISOString(),
      isExclusive: false
    });
  }

  return parsedProjects;
}

interface ScrapeResult {
  success: boolean;
  added: number;
  skipped: number;
  totalCount: number;
  error?: string;
}

let scrapeInProgress = false;

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
      addLog('info', 'Iniciando varredura em 99Freelas...');
    }

    const db = readDB();
    const { whitelistKeywords, blacklistKeywords } = db.config;
    const targetUrl = buildProjectsPageUrl(SCRAPE_START_PAGE);

    if (!quiet) {
      addLog('info', `Conectando ao catálogo (página ${SCRAPE_START_PAGE} em diante): ${targetUrl}`);
    }

    let html = '';
    try {
      html = await fetchProjectsPageHtml(SCRAPE_START_PAGE);
    } catch (e: any) {
      addLog('warning', `Erro ao carregar página ${SCRAPE_START_PAGE}: ${e.message}`);
    }

    const parsedProjects = html ? parseProjectsFromHtml(html) : [];
    const exclusiveSkipped = html
      ? [...html.matchAll(/<li[^>]*class="[^"]*result-item[^"]*"[^>]*data-id="(\d+)"([\s\S]*?)<\/li>/gi)]
          .filter(m => isExclusiveProjectHtml(m[0])).length
      : 0;

    if (!quiet) {
      if (parsedProjects.length > 0) {
        addLog('info', `Página ${SCRAPE_START_PAGE}: ${parsedProjects.length} projetos públicos extraídos (${exclusiveSkipped} exclusivos ignorados).`);
      } else if (exclusiveSkipped > 0) {
        addLog('warning', `Página ${SCRAPE_START_PAGE}: ${exclusiveSkipped} projetos exclusivos/premium encontrados e ignorados.`);
      }

      if (parsedProjects.length === 0) {
        addLog('warning', `Nenhum projeto real encontrado na página ${SCRAPE_START_PAGE}. Verifique conexão ou mudanças no site.`);
      }
    }

    let addedCount = 0;
    let skippedCount = 0;

    for (const project of parsedProjects) {
      const titleLower = project.title.toLowerCase();
      const descLower = project.description.toLowerCase();

      const hitsBlacklist = blacklistKeywords.some((kw: string) =>
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

      if (whitelistKeywords.length > 0 && !hitsWhitelist) {
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
      triggerBgAutoGenerations();
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

// Background generator runner for automated pilot
async function triggerBgAutoGenerations() {
  const db = readDB();
  const backlog = db.projects.filter(p => p.status === ProjectStatus.GENERATING || (db.config.autoSubmit && p.status === ProjectStatus.SEEN));
  
  if (backlog.length === 0) return;
  
  addLog('info', `[AUTOMÇÃO INTEGRADA] Executando geração em massa com Gemini para ${backlog.length} oportunidades.`);
  
  for (const project of backlog) {
    try {
      await generateAISingleProject(project.id);
    } catch (e: any) {
      console.error(`Bg generic failed for #${project.id}`, e);
    }
  }
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
  const { whitelistKeywords, blacklistKeywords, geminiApiKey, geminiModel } = db.config;

  const passesScope = whitelistKeywords.some((kw: string) => 
    titleLower.includes(kw.toLowerCase()) || descLower.includes(kw.toLowerCase())
  );
  
  if (!passesScope) {
    project.status = ProjectStatus.FAILED;
    writeDB(db);
    addLog('warning', `[FILTRO IA COM ESCASSEZ] Projeto #${projectId} abortado antes de chamar o Gemini: Fora de escopo tech/automação.`, projectId);
    throw new Error('Projeto abortado: Sem correspondência de escopo técnico.');
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
Por favor, analise a seguinte oportunidade de trabalho listada no 99Freelas e crie uma proposta de orçamento estratégica.

TÍTULO DO PROJETO: "${project.title}"
ORÇAMENTO INFORMADO: "${project.budget}"
HABILIDADES EXIGIDAS: ${project.skills.join(', ')}
DESCRIÇÃO COMPLETA DO CLIENTE:
"""
${project.description}
"""

Instruções para a Proposta ( proposal ):
1. Deve agir como um freelancer profissional especialista que entende as dores desse problema em específico.
2. Seja DIRETO, focado inteiramente em prover a solução das dores do cliente. EVITE blá-blá-blá, introduções genéricas ("Olá meu caro cliente, espero que este e-mail o encontre bem..."), cumprimentos longos e floreios de marketing. Vá direto ao como você resolveria o projeto dele. No máximo de 3-4 parágrafos curtos.
3. Demonstre competência listando brevemente as tecnologias ideais que você usaria (ex: se for automação web, mencione Playwright/Puppeteer e tratamento de desconexão/perda de sessão).
4. Sugira uma abordagem para o preço sugerido ( suggestedPrice ) e o tempo estimado de conclusão em dias ( suggestedTime ).
5. A linguagem do texto gerado da proposta deve obedecer obrigatoriamente à mesma linguagem do briefing enviado (normalmente português do Brasil).

Retorne os resultados estritamente em formato JSON estruturado com os seguintes campos exatos:
{
  "proposal": "texto da proposta aqui",
  "suggestedPrice": preço numérico sugerido correspondente à faixa de orçamento dele em Reais,
  "suggestedTime": dias estimados de entrega
}
`;

    const activeModel = geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

    const response = await ai.models.generateContent({
      model: activeModel,
      contents: promptText,
      config: {
        systemInstruction: "Aja como um freelancer especialista focado em criar propostas de alto engajamento, assertivas e técnicas no 99Freelas.",
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
              description: "Valor numérico recomendado em Reais BRL sugerido para o bid (ex: 750)."
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

    // Refresh DB and apply results to prevent overwritten states
    const postDb = readDB();
    const projIndex = postDb.projects.findIndex(p => p.id === projectId);
    
    if (projIndex !== -1) {
      postDb.projects[projIndex].generatedProposal = result.proposal;
      postDb.projects[projIndex].suggestedPrice = result.suggestedPrice;
      postDb.projects[projIndex].suggestedTime = result.suggestedTime;
      postDb.projects[projIndex].status = ProjectStatus.PENDING_REVIEW;
      
      writeDB(postDb);
      addLog('success', `Proposta Sniper para #${projectId} gerada com sucesso! Preço sugerido: R$ ${result.suggestedPrice}, Prazo: ${result.suggestedTime} dias.`, projectId);
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
    addLog('info', 'Iniciando login manual no 99Freelas (perfil persistente)...');
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
      server: { middlewareMode: true },
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

  // Bind exclusively to Port 3000 on host 0.0.0.0
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] 99freelas-sniper executando em http://localhost:${PORT}`);
    startAutoScrapeLoop();
  });
}

startServer();
