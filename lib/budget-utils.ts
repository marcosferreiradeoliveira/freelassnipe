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

const PRICE_DISCOUNT_FACTOR = Number.parseFloat(process.env.PRICE_DISCOUNT_FACTOR || '0.7');
const BUDGET_LOW_QUARTILE = Number.parseFloat(process.env.PRICE_BUDGET_LOW_QUARTILE || '0.2');

function competitiveCapUsd(range: BudgetRange): number | undefined {
  if (!range.min) return undefined;
  if (range.max && range.max > range.min) {
    return Math.round(range.min + (range.max - range.min) * BUDGET_LOW_QUARTILE);
  }
  return Math.round(range.min * 1.15);
}

export function normalizeSuggestedPrice(
  suggestedPrice: number | undefined,
  budget: string
): { price?: number; adjusted: boolean; reason?: string } {
  const range = parseBudgetRange(budget);
  const unit = range.isHourly ? 'USD/h' : 'USD';
  const cap = competitiveCapUsd(range);

  if (!range.min) {
    if (!suggestedPrice || suggestedPrice <= 0) {
      return { price: suggestedPrice, adjusted: false };
    }
    const discounted = Math.max(1, Math.round(suggestedPrice * PRICE_DISCOUNT_FACTOR));
    if (discounted === suggestedPrice) {
      return { price: suggestedPrice, adjusted: false };
    }
    return {
      price: discounted,
      adjusted: true,
      reason: `Preço ajustado para valor competitivo ($${discounted} ${unit}, −${Math.round((1 - PRICE_DISCOUNT_FACTOR) * 100)}%).`
    };
  }

  if (!suggestedPrice || suggestedPrice <= 0) {
    const fallback = cap ?? range.min;
    return {
      price: fallback,
      adjusted: true,
      reason: `Preço ausente; usando faixa baixa (${fallback} ${unit}).`
    };
  }

  let price = Math.round(suggestedPrice * PRICE_DISCOUNT_FACTOR);
  if (cap !== undefined) {
    price = Math.min(price, cap);
  }
  price = Math.max(range.min, price);

  const adjusted = price !== suggestedPrice;
  let reason: string | undefined;
  if (adjusted) {
    reason =
      price < suggestedPrice
        ? `Preço $${suggestedPrice} → $${price} ${unit} (competitivo, faixa baixa).`
        : `Preço ajustado para mínimo da faixa (${price} ${unit}).`;
  }

  return { price, adjusted, reason };
}

export function formatBudgetHint(budget: string): string {
  const range = parseBudgetRange(budget);
  if (!range.min && !range.max) return 'Orçamento aberto / a combinar.';

  const unit = range.isHourly ? 'USD/h' : 'USD';
  if (range.min && range.max && range.min !== range.max) {
    const lowTarget = Math.round(range.min + (range.max - range.min) * BUDGET_LOW_QUARTILE);
    return `Faixa: ${range.min} - ${range.max} ${unit}. Sugira valor COMPETITIVO próximo ao mínimo (ideal: ${lowTarget} ${unit} ou até +15% acima do mínimo). Nunca acima de 30% da faixa.`;
  }

  return `Valor mínimo: ${range.min} ${unit}. Sugira preço competitivo, próximo ao mínimo (+10% a +15% no máximo).`;
}
