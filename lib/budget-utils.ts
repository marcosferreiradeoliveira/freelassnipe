export interface BudgetRange {
  min?: number;
  max?: number;
  isHourly: boolean;
  raw: string;
}

function parseMoneyToken(token: string): number | undefined {
  const cleaned = token.trim().replace(/[^\d.,-]/g, '');
  if (!cleaned) return undefined;

  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)) {
    return Number.parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
  }

  if (cleaned.includes(',') && cleaned.includes('.')) {
    if (cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',')) {
      return Number.parseFloat(cleaned.replace(/,/g, ''));
    }
    return Number.parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
  }

  if (cleaned.includes(',')) {
    return Number.parseFloat(cleaned.replace(',', '.'));
  }

  const normalized = cleaned.replace(/\./g, '');
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : undefined;
}

export function parseBudgetRange(budget: string): BudgetRange {
  const raw = budget.trim();
  const isHourly = /\/\s*(hora|hour|hr)\b/i.test(raw);

  const rangeMatch = raw.match(/([\d.,]+)\s*[-–—]\s*([\d.,]+)/);
  if (rangeMatch) {
    return {
      min: parseMoneyToken(rangeMatch[1]),
      max: parseMoneyToken(rangeMatch[2]),
      isHourly,
      raw
    };
  }

  const singleMatch = raw.match(/([\d.,]+)/);
  if (singleMatch) {
    const value = parseMoneyToken(singleMatch[1]);
    return { min: value, max: value, isHourly, raw };
  }

  return { isHourly, raw };
}

export function normalizeSuggestedPrice(
  suggestedPrice: number | undefined,
  budget: string
): { price?: number; adjusted: boolean; reason?: string } {
  const range = parseBudgetRange(budget);

  if (!range.min) {
    return { price: suggestedPrice, adjusted: false };
  }

  const unit = range.isHourly ? 'USD/h' : 'USD';

  if (!suggestedPrice || suggestedPrice <= 0) {
    return {
      price: range.min,
      adjusted: true,
      reason: `Preço ausente; usando mínimo da faixa (${range.min} ${unit}).`
    };
  }

  if (suggestedPrice < range.min) {
    return {
      price: range.min,
      adjusted: true,
      reason: `Preço $${suggestedPrice} abaixo do mínimo ($${range.min}); ajustado para ${range.min} ${unit}.`
    };
  }

  return { price: suggestedPrice, adjusted: false };
}

export function formatBudgetHint(budget: string): string {
  const range = parseBudgetRange(budget);
  if (!range.min && !range.max) return 'Orçamento aberto / a combinar.';

  const unit = range.isHourly ? 'USD/h' : 'USD';
  if (range.min && range.max && range.min !== range.max) {
    return `Faixa: ${range.min} - ${range.max} ${unit}. Nunca sugira valor abaixo de ${range.min} ${unit}.`;
  }

  return `Valor mínimo: ${range.min} ${unit}.`;
}
