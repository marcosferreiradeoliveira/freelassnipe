import { GoogleGenAI } from '@google/genai';

export async function generateClientMessageReply(options: {
  apiKey: string;
  model?: string;
  projectTitle: string;
  projectDescription: string;
  clientMessages: string[];
}): Promise<string> {
  const { apiKey, projectTitle, projectDescription, clientMessages } = options;
  const model = options.model || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: { 'User-Agent': 'aistudio-build' }
    }
  });

  const prompt = `
O cliente deixou mensagem(ns) ou pergunta(s) no projeto do 99Freelas. Escreva UMA resposta curta (máximo 4 frases, estilo chat).

PROJETO: "${projectTitle}"
DESCRIÇÃO:
"""
${projectDescription}
"""

MENSAGENS/PERGUNTAS DO CLIENTE:
"""
${clientMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')}
"""

Regras:
- Responda direto, sem "Fala", "Oi" ou saudação.
- Comprove conhecimento técnico com termos concretos (stack, integração, arquitetura).
- Reforce a prova gratuita: pequena entrega sem custo para validar — só passar o WhatsApp.
- Se citar site, use APENAS https://buildai.dev.br (sem paths inventados).
- Uma mensagem só, sem markdown, sem listas, sem preço, sem prazo.
- Máximo ~350 caracteres se possível.

Retorne só o texto da resposta, sem JSON.
`;

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      systemInstruction:
        'Você responde mensagens de clientes no 99Freelas de forma breve, técnica e humana. Uma mensagem curta, sem saudação inicial.'
    }
  });

  let text = (response.text || '').trim();
  if (!text) return '';

  text = text
    .replace(/^["']|["']$/g, '')
    .replace(/https?:\/\/(?:www\.)?buildai\.dev\.br\/[^\s)\]"']*/gi, 'https://buildai.dev.br')
    .replace(/^(?:Fala|Oi|Olá|Ola|E aí|E ai|Hey|Opa)[!,.\s]*(?:tudo bem\??\s*)?/i, '')
    .trim();

  return text;
}
