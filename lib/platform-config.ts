import dotenv from 'dotenv';

dotenv.config();

export const PLATFORM = {
  name: 'Workana',
  baseUrl: 'https://www.workana.com',
  sessionCheckUrl: 'https://www.workana.com/dashboard',
  loginUrl: 'https://www.workana.com/login',
  cookieDomain: 'www.workana.com',
  profileDir: process.env.PLAYWRIGHT_USER_DATA_DIR || '.workana-profile',
  sessionCookieNames: ['workana_session', 'appcookie[wldh]'] as const,
  scrapeCategory: process.env.WORKANA_CATEGORY || 'it-programming',
  scrapeLanguage: process.env.WORKANA_LANGUAGE || 'xx',
  scrapePage: parseInt(process.env.SCRAPE_START_PAGE || '1', 10)
};

export function buildJobsListUrl(page: number): string {
  return `${PLATFORM.baseUrl}/jobs?category=${PLATFORM.scrapeCategory}&language=${PLATFORM.scrapeLanguage}&page=${page}`;
}

export function buildJobUrl(slug: string): string {
  return `${PLATFORM.baseUrl}/job/${slug}`;
}

export function slugToProjectId(slug: string): string {
  const safe = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return `wk_${safe}`;
}
