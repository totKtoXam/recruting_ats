// Извлечение текста из резюме (PDF, DOCX, DOC) для автозаполнения карточки кандидата.
// Результат — строки с координатами и размером шрифта: по ним парсер отличает
// заголовок с ФИО от основного текста и не склеивает колонки двухколоночных макетов.
import { createRequire } from 'node:module';
import { extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import JSZip from 'jszip';

const require = createRequire(import.meta.url);

// Символы, которые PDF-генераторы вставляют вместо буллетов и пробелов:
// приватная область Unicode, неразрывные и нулевые пробелы, мягкие переносы.
const range = (from, to) => String.fromCharCode(from) + '-' + String.fromCharCode(to);
const JUNK_RE = new RegExp('[' + range(0xe000, 0xf8ff) + String.fromCharCode(0xad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0xfeff) + ']', 'g');
const SPACES_RE = new RegExp('[' + String.fromCharCode(0xa0) + range(0x2000, 0x200a) + String.fromCharCode(0x202f, 0x205f, 0x3000) + ']', 'g');

export function cleanLine(text) {
  return String(text || '')
    .replace(JUNK_RE, '')
    .replace(SPACES_RE, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Строки страницы PDF собираются по координатам: элементы с близким Y — одна строка,
// внутри строки — сортировка по X. Большой горизонтальный зазор помечается табуляцией:
// так соседние колонки не сливаются в одно предложение.
async function pdfPageLines(page) {
  const content = await page.getTextContent();
  const items = content.items
    .filter(item => typeof item.str === 'string' && item.str.trim() !== '')
    .map(item => ({
      str: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width,
      size: Math.abs(item.transform[3]) || Math.abs(item.transform[0]) || item.height || 10
    }));

  items.sort((a, b) => b.y - a.y || a.x - b.x);

  const rows = [];
  for (const item of items) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - item.y) <= Math.max(2, item.size * 0.5)) {
      last.items.push(item);
    } else {
      rows.push({ y: item.y, items: [item] });
    }
  }

  return rows
    .map(row => {
      row.items.sort((a, b) => a.x - b.x);
      let text = '';
      let previousEnd = null;
      for (const item of row.items) {
        if (previousEnd !== null) {
          const gap = item.x - previousEnd;
          if (gap > 20) {
            text += '\t';
          } else if (gap > 1.5 && !text.endsWith(' ') && !item.str.startsWith(' ')) {
            text += ' ';
          }
        }
        text += item.str;
        previousEnd = item.x + item.width;
      }
      return {
        text: cleanLine(text),
        size: Math.round(Math.max(...row.items.map(item => item.size))),
        x: Math.round(row.items[0].x)
      };
    })
    .filter(line => line.text);
}

async function pdfPageLinks(page) {
  const annotations = await page.getAnnotations().catch(() => []);
  return annotations
    .filter(annotation => annotation.subtype === 'Link' && annotation.url)
    .map(annotation => String(annotation.url));
}

async function extractPdf(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const metadata = await pdf.getMetadata().catch(() => ({ info: {} }));
  const pages = [];

  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    pages.push({ lines: await pdfPageLines(page), links: await pdfPageLinks(page) });
  }

  // Если сборка по координатам почти ничего не дала, берём линейное извлечение:
  // у некоторых генераторов координаты элементов недостоверны.
  const layoutChars = pages.reduce((sum, page) => sum + page.lines.reduce((n, line) => n + line.text.length, 0), 0);
  if (layoutChars < 40) {
    const plain = await extractText(pdf, { mergePages: false });
    plain.text.forEach((pageText, index) => {
      if (pages[index] && !pages[index].lines.length) {
        pages[index].lines = String(pageText)
          .split(/\r?\n/)
          .map(text => ({ text: cleanLine(text), size: 10, x: 0 }))
          .filter(line => line.text);
      }
    });
  }

  const info = metadata.info || {};
  return {
    kind: 'pdf',
    pages,
    producer: [info.Producer, info.Creator].filter(Boolean).join(' / ')
  };
}

// Текст DOCX через mammoth, гиперссылки — из document.xml.rels: в тексте абзаца
// адреса нет, там только подпись ссылки («LinkedIn», «Мои репозитории»).
async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  const lines = String(result.value || '')
    .split(/\r?\n/)
    .map(text => ({ text: cleanLine(text), size: 10, x: 0 }))
    .filter(line => line.text);

  let links = [];
  try {
    const zip = await JSZip.loadAsync(buffer);
    const rels = await zip.file('word/_rels/document.xml.rels')?.async('string');
    if (rels) {
      links = [...rels.matchAll(/Target="([^"]+)"[^>]*TargetMode="External"/g)].map(match =>
        match[1].replace(/&amp;/g, '&')
      );
    }
  } catch {
    // Без ссылок можно обойтись: контакты чаще всего есть и в тексте.
  }

  return { kind: 'docx', pages: [{ lines, links }], producer: 'docx' };
}

async function extractDoc(buffer) {
  const WordExtractor = require('word-extractor');
  const document = await new WordExtractor().extract(buffer);
  const lines = String(document.getBody() || '')
    .split(/\r?\n|\r/)
    .map(text => ({ text: cleanLine(text), size: 10, x: 0 }))
    .filter(line => line.text);

  return { kind: 'doc', pages: [{ lines, links: [] }], producer: 'doc' };
}

// Возвращает { kind, pages: [{ lines: [{ text, size, x }], links }], producer, lines, text, links, textChars }.
export async function extractResumeText(buffer, extension) {
  const ext = String(extension || '').toLowerCase();
  const document =
    ext === 'pdf' ? await extractPdf(buffer) : ext === 'docx' ? await extractDocx(buffer) : await extractDoc(buffer);

  const lines = document.pages.flatMap(page => page.lines);
  document.lines = lines;
  document.text = lines.map(line => line.text).join('\n');
  document.textChars = document.text.replace(/\s/g, '').length;
  document.links = [...new Set(document.pages.flatMap(page => page.links))];
  return document;
}
