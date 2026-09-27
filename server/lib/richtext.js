// Форматированный текст хранится как HTML. Всё, что приходит от клиента,
// проходит через белый список тегов — иначе это XSS при отображении.
import sanitizeHtml from 'sanitize-html';
import { fail } from './errors.js';

const OPTIONS = {
  allowedTags: ['p', 'br', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li', 'a', 'blockquote', 'code'],
  allowedAttributes: { a: ['href', 'target', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  transformTags: {
    b: 'strong',
    i: 'em',
    strike: 's',
    div: 'p',
    a: (tagName, attribs) => ({
      tagName,
      attribs: { href: attribs.href || '', target: '_blank', rel: 'noopener noreferrer' }
    })
  },
  exclusiveFilter: frame => frame.tag === 'a' && !frame.attribs.href
};

export const MAX_RICH_TEXT_LENGTH = 50_000;

export function sanitizeRich(html) {
  const clean = sanitizeHtml(String(html ?? ''), OPTIONS)
    .replace(/<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/g, '')
    .trim();
  return isRichEmpty(clean) ? '' : clean;
}

// Текст без разметки: для журнала, поиска и проверки «пусто ли поле».
export function richToText(html) {
  return sanitizeHtml(
    String(html ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|blockquote)>/gi, '\n'),
    { allowedTags: [], allowedAttributes: {} }
  )
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isRichEmpty(html) {
  return richToText(html) === '';
}

// Обычный текст (старые клиенты, Intake API) → безопасный HTML.
export function textToRich(text) {
  const value = String(text ?? '').trim();
  if (!value) return '';
  const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<p>' + escaped.replace(/\r?\n/g, '<br>') + '</p>';
}

// Принимает HTML из редактора; если пришёл обычный текст — экранирует его.
export function richFromInput(value) {
  const input = String(value ?? '');
  const html = /<[a-z][\s\S]*>/i.test(input) ? input : textToRich(input);
  const clean = sanitizeRich(html);

  if (clean.length > MAX_RICH_TEXT_LENGTH) {
    fail('Текст слишком длинный.');
  }

  return clean;
}
