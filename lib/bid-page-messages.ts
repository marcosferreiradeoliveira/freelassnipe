type PlaywrightPage = {
  evaluate: <T>(fn: (() => T) | string) => Promise<T>;
  goto: (url: string, options?: { waitUntil?: string; timeout?: number }) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
};

function buildMessagePageUrl(projectUrl: string): string {
  const url = new URL(projectUrl);
  url.pathname = url.pathname.replace('/project/', '/project/message/');
  url.search = '';
  return url.toString();
}

export async function extractClientMessagesFromBidPage(page: PlaywrightPage): Promise<string[]> {
  const onBidPage = await page.evaluate<string[]>(`(() => {
    const skipPattern =
      /^(tem dúvidas|faça uma pergunta|perguntas frequentes|como funciona|enviar proposta|sua oferta|duração estimada|oferta final)/i;
    const found = [];

    const pushText = (text) => {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (normalized.length < 12) return;
      if (skipPattern.test(normalized)) return;
      if (/99freelas|taxa de intermediação|oferta final/i.test(normalized) && normalized.length < 80) return;
      found.push(normalized);
    };

    const bidRoot = document.querySelector('.box-project-bid') || document.body;

    const selectors = [
      '.mensagem-cliente',
      '.mensagem-para-freelancers',
      '.comunicado-cliente',
      '.aviso-projeto',
      '.project-client-notice',
      '.box-pergunta-cliente',
      '.box-mensagem-cliente',
      '.box-faq-cliente .formatted-text',
      '.duvidas-projeto .formatted-text',
      '.box-project-bid .alert:not(.alert-info)',
      '.box-project-bid .notice',
      '.box-project-bid .mensagem',
      '.box-project-bid .message-item',
      '.box-project-bid .formatted-text[data-content]',
    ];

    for (const sel of selectors) {
      bidRoot.querySelectorAll(sel).forEach((el) => {
        const dataContent = el.getAttribute('data-content');
        pushText(dataContent ? dataContent.replace(/<[^>]+>/g, ' ') : el.textContent || '');
      });
    }

    bidRoot.querySelectorAll('label, h3, h4, h5, strong').forEach((el) => {
      const label = (el.textContent || '').trim();
      if (!/mensagem|pergunta|comunicado|aviso|atualiza|observa/i.test(label)) return;

      const container = el.closest('div, section, article') || el.parentElement;
      if (!container) return;

      container.querySelectorAll('.formatted-text, .item-text, p, .mensagem-texto').forEach((node) => {
        if (node.contains(el)) return;
        const text = (node.textContent || '').trim();
        if (text && !text.includes(label)) pushText(text);
        else if (text) pushText(text);
      });
    });

    // FAQ do cliente no formulário (não o FAQ genérico do site).
    bidRoot.querySelectorAll('.nnf.box-faq .faq-question').forEach((questionEl) => {
      const question = (questionEl.textContent || '').trim();
      const answerEl = questionEl.nextElementSibling;
      const answer =
        answerEl && answerEl.classList.contains('faq-answer')
          ? (answerEl.textContent || '').trim()
          : '';
      if (question && !/perguntas frequentes/i.test(question)) {
        pushText(answer ? question + ' - ' + answer : question);
      }
    });

    return [...new Set(found)];
  })()`);

  return onBidPage;
}

export async function extractClientMessagesFromMessagePage(
  page: PlaywrightPage,
  projectUrl: string
): Promise<string[]> {
  const messageUrl = buildMessagePageUrl(projectUrl);

  try {
    await page.goto(messageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
  } catch {
    return [];
  }

  return page.evaluate<string[]>(`(() => {
    const found = [];
    const skipPattern = /^(tem dúvidas|faça uma pergunta|enviar mensagem|mensagens do projeto)/i;

    const pushText = (text) => {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (normalized.length < 12 || skipPattern.test(normalized)) return;
      found.push(normalized);
    };

    const selectors = [
      '.message-item',
      '.mensagem-item',
      '.talk-message',
      '.conversation-message',
      '.box-mensagens .formatted-text',
      '.project-message .formatted-text',
      '.item-text.formatted-text',
      '[class*="mensagem"] .formatted-text',
      '[class*="message"] .formatted-text',
    ];

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        pushText(el.textContent || '');
      });
    }

    return [...new Set(found)];
  })()`);
}

export async function collectClientMessagesForProposal(
  page: PlaywrightPage,
  projectUrl: string,
  bidUrl?: string
): Promise<string[]> {
  const bidMessages = await extractClientMessagesFromBidPage(page);
  if (bidMessages.length > 0) return bidMessages;

  const messagePageMessages = await extractClientMessagesFromMessagePage(page, projectUrl);
  if (bidUrl) {
    await page.goto(bidUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
  }
  return messagePageMessages;
}
