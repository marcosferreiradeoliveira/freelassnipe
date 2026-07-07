import { Project, ProjectStatus, SystemLog } from '../src/types';
import { runSubmitWorker, SubmitWorkerResult } from './submit-proposals.ts';

export interface AutopilotOptions {
  batchSize?: number;
  generateDelayMs?: number;
  generateJitterMs?: number;
  submitDelayMs?: number;
  submitJitterMs?: number;
  generateProject: (projectId: string) => Promise<unknown>;
  getEligibleProjects: () => Array<{ id: string; title: string }>;
  log?: (type: SystemLog['type'], message: string, projectId?: string) => void;
}

export interface AutopilotResult {
  selected: number;
  generated: number;
  generateFailed: number;
  submitted: number;
  submitFailed: number;
  projectIds: string[];
  submitResult?: SubmitWorkerResult;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(baseMs: number, jitterMs: number) {
  return baseMs + Math.floor(Math.random() * jitterMs);
}

export async function runAutopilotBatch(options: AutopilotOptions): Promise<AutopilotResult> {
  const log = options.log || ((type, message) => console.log(`[${type.toUpperCase()}] ${message}`));
  const batchSize = options.batchSize ?? parseInt(process.env.AUTOPILOT_BATCH_SIZE || '10', 10);
  const generateDelayMs = options.generateDelayMs ?? parseInt(process.env.AUTOPILOT_GENERATE_DELAY_MS || '2500', 10);
  const generateJitterMs = options.generateJitterMs ?? parseInt(process.env.AUTOPILOT_GENERATE_JITTER_MS || '3500', 10);
  const submitDelayMs = options.submitDelayMs ?? parseInt(process.env.AUTOPILOT_SUBMIT_DELAY_MS || '45000', 10);
  const submitJitterMs = options.submitJitterMs ?? parseInt(process.env.AUTOPILOT_SUBMIT_JITTER_MS || '45000', 10);

  const targets = options.getEligibleProjects().slice(0, batchSize);

  if (targets.length === 0) {
    log('warning', '[AUTOPILOT] Nenhum projeto novo ("seen") disponível. Rode uma varredura primeiro.');
    return {
      selected: 0,
      generated: 0,
      generateFailed: 0,
      submitted: 0,
      submitFailed: 0,
      projectIds: []
    };
  }

  log('info', `[AUTOPILOT] Selecionados ${targets.length} projetos para geração + envio.`);

  let generated = 0;
  let generateFailed = 0;
  const queuedIds: string[] = [];

  for (let i = 0; i < targets.length; i++) {
    const project = targets[i];
    log('info', `[AUTOPILOT] (${i + 1}/${targets.length}) Gerando proposta: ${project.title.substring(0, 50)}...`, project.id);

    try {
      await options.generateProject(project.id);
      generated++;
      queuedIds.push(project.id);
      log('success', `[AUTOPILOT] Proposta pronta para #${project.id}.`, project.id);
    } catch (err: any) {
      generateFailed++;
      log('error', `[AUTOPILOT] Falha ao gerar #${project.id}: ${err.message}`, project.id);
    }

    if (i < targets.length - 1) {
      const waitMs = randomDelay(generateDelayMs, generateJitterMs);
      log('info', `[AUTOPILOT] Pausa de ${Math.round(waitMs / 1000)}s antes da próxima geração...`);
      await sleep(waitMs);
    }
  }

  if (queuedIds.length === 0) {
    log('warning', '[AUTOPILOT] Nenhuma proposta gerada. Envio cancelado.');
    return {
      selected: targets.length,
      generated,
      generateFailed,
      submitted: 0,
      submitFailed: 0,
      projectIds: []
    };
  }

  log('info', `[AUTOPILOT] Iniciando envio de ${queuedIds.length} propostas (intervalo anti-detecção: ~${Math.round(submitDelayMs / 1000)}-${Math.round((submitDelayMs + submitJitterMs) / 1000)}s)...`);

  const submitResult = await runSubmitWorker({
    forceSubmit: true,
    projectIds: queuedIds,
    delayBetweenSubmitsMs: submitDelayMs,
    delayJitterMs: submitJitterMs,
    log
  });

  log(
    'success',
    `[AUTOPILOT] Concluído. Geradas: ${generated}, Enviadas: ${submitResult.processed}, Falhas envio: ${submitResult.failed}.`
  );

  return {
    selected: targets.length,
    generated,
    generateFailed,
    submitted: submitResult.processed,
    submitFailed: submitResult.failed,
    projectIds: queuedIds,
    submitResult
  };
}
