import { Project, ProjectStatus } from '../src/types';
import { buildJobsListUrl, buildJobUrl, slugToProjectId } from './platform-config.ts';

const SCRAPE_FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/png,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8'
};

export interface WorkanaJobResult {
  slug: string;
  title: string;
  description: string;
  skills: Array<{ anchorText: string }>;
  budget: string;
  totalBids: string;
  isInvite?: boolean;
  isUrgent?: boolean;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitleFromHtml(titleHtml: string): string {
  const spanMatch = titleHtml.match(/title="([^"]+)"/i);
  if (spanMatch) return decodeHtmlEntities(spanMatch[1]);
  const text = decodeHtmlEntities(titleHtml);
  return text || 'Projeto Workana';
}

function parseBidsCount(totalBids: string): number {
  const match = totalBids.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function decodeResultsInitialsPayload(raw: string): { results: WorkanaJobResult[] } {
  const jsonText = raw
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  return JSON.parse(jsonText);
}

export function parseWorkanaJobsFromHtml(html: string): WorkanaJobResult[] {
  const match = html.match(/:results-initials='([^']+)'/);
  if (!match) return [];

  try {
    const data = decodeResultsInitialsPayload(match[1]);
    return Array.isArray(data.results) ? data.results : [];
  } catch {
    return [];
  }
}

export async function fetchWorkanaJobsPageHtml(page: number): Promise<string> {
  const targetUrl = buildJobsListUrl(page);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

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

export function workanaJobToProject(job: WorkanaJobResult): Project {
  const title = extractTitleFromHtml(job.title || '');

  return {
    id: slugToProjectId(job.slug),
    title,
    description: decodeHtmlEntities(job.description || ''),
    skills: (job.skills || []).map((s) => s.anchorText).filter(Boolean),
    budget: job.budget || 'A combinar',
    bidsCount: parseBidsCount(job.totalBids || '0'),
    url: buildJobUrl(job.slug),
    status: ProjectStatus.SEEN,
    timestamp: new Date().toISOString(),
    isExclusive: Boolean(job.isInvite)
  };
}
