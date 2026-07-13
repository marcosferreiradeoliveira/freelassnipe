export type JobLanguage = 'pt' | 'es' | 'en';

const LANGUAGE_LABELS: Record<JobLanguage, string> = {
  pt: 'português do Brasil',
  es: 'español',
  en: 'English'
};

function scorePatterns(text: string, patterns: RegExp[]): number {
  return patterns.reduce((sum, pattern) => {
    const matches = text.match(pattern);
    return sum + (matches?.length || 0);
  }, 0);
}

export function detectJobLanguage(
  title: string,
  description: string,
  slug?: string
): JobLanguage {
  const text = `${title} ${description} ${slug || ''}`.toLowerCase();

  const ptScore = scorePatterns(text, [
    /\b(você|voce|não|nao|desenvolvimento|desenvolvedor|aplicativo|integração|integracao|orçamento|habilidades|também|tambem|preciso|proposta|sistema|solução|solucao)\b/g,
    /ção\b/g,
    /ções\b/g,
    /[ãõ]/g
  ]);

  const esScore = scorePatterns(text, [
    /\b(necesito|desarrollo|desarrollador|configuración|configuracion|información|informacion|años|anos|también|tambien|está|esta|busco|proyecto|añadir|anadir|aplicación|aplicacion|integración|integracion|presupuesto|habilidades|solución|solucion)\b/g,
    /¿/g,
    /¡/g,
    /ción\b/g
  ]);

  const enScore = scorePatterns(text, [
    /\b(looking for|we need|we are|development|developer|project|requirements|would|should|our team|experience with|budget|skills|application|integration|solution|please|hello)\b/g,
    /\b(the|and|with|for|this|that|your|our)\b/g
  ]);

  if (esScore > ptScore && esScore >= enScore && esScore >= 2) return 'es';
  if (enScore > ptScore && enScore > esScore && enScore >= 3) return 'en';
  if (ptScore >= esScore) return 'pt';
  if (esScore > 0) return 'es';
  return 'pt';
}

export function getLanguageLabel(language: JobLanguage): string {
  return LANGUAGE_LABELS[language];
}

export function getProposalLanguageInstruction(language: JobLanguage): string {
  return `Escreva TODA a proposta (proposal) em ${LANGUAGE_LABELS[language]}.`;
}

export function resolveProjectLanguage(
  project: { title: string; description: string; language?: JobLanguage; url?: string }
): JobLanguage {
  if (project.language) return project.language;
  const slug = project.url?.match(/\/job\/([^/?#]+)/)?.[1];
  return detectJobLanguage(project.title, project.description, slug);
}
