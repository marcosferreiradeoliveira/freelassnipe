/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export enum ProjectStatus {
  SEEN = 'seen',
  GENERATING = 'generating',
  PENDING_REVIEW = 'pending_review',
  SENT = 'sent',
  FAILED = 'failed'
}

export interface Project {
  id: string; // The 99Freelas project ID or a parsed unique slug
  title: string;
  description: string;
  skills: string[];
  budget: string;
  bidsCount: number;
  url: string;
  status: ProjectStatus;
  generatedProposal?: string;
  suggestedPrice?: number;
  suggestedTime?: number; // In days
  timestamp: string; // ISO String
  isExclusive?: boolean; // Projeto premium/exclusivo no 99freelas
  clientMessages?: string[]; // Mensagens/perguntas do cliente detectadas no bid
}

export type LogType = 'info' | 'warning' | 'error' | 'success';

export interface SystemLog {
  id: string;
  timestamp: string;
  type: LogType;
  message: string;
  projectId?: string;
}

export interface SystemConfig {
  geminiApiKey: string;
  geminiModel: string;
  freelasEmail: string;
  freelasPassword: string;
  freelasSessionCookie: string;
  playwrightHeadless: boolean;
  autoSubmit: boolean;
  maxProposalsPerDay: number;
  blacklistKeywords: string[];
  whitelistKeywords: string[];
  whitelistEnabled: boolean;
}
