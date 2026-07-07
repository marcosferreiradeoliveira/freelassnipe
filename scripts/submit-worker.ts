/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { runSubmitWorker } from './lib/submit-proposals.ts';
import { Project, ProjectStatus, SystemLog } from '../src/types';

dotenv.config();

// Determine paths relative to root
const rootPath = process.cwd();
const DB_FILE = path.join(rootPath, 'db.json');

// Logs utility matching server-side schema
function writeLog(type: 'info' | 'warning' | 'error' | 'success', message: string, projectId?: string) {
  const timestamp = new Date().toISOString();
  console.log(`[${type.toUpperCase()}] [${timestamp}] ${message}`);

  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      const db = JSON.parse(raw);
      
      const newLog: SystemLog = {
        id: `worker_log_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        timestamp,
        type,
        message: `[WORKER EXECUTOR] ${message}`,
        projectId
      };
      
      db.logs.unshift(newLog);
      if (db.logs.length > 500) {
        db.logs = db.logs.slice(0, 500);
      }
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('Failed to append log to DB file:', err);
  }
}

// MAIN OPERATIONAL CRON LOOP
async function runWorker() {
  writeLog('info', 'Iniciando ciclo de envio autônomo do Sniper Worker...');

  const result = await runSubmitWorker({
    log: (type, message, projectId) => writeLog(type, message, projectId)
  });

  writeLog('info', `Fim do ciclo. Enviadas: ${result.processed}, Falhas: ${result.failed}, Pendentes: ${result.totalPending}.`);
}

// Enable direct node execution
runWorker().catch(err => {
  console.error('Critical Fatal Error in script run:', err);
});
