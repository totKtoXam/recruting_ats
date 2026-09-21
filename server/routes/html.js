export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// Строка, безопасная для вставки внутрь JS-строки в <script>.
export function escapeJsString(value) {
  return String(value ?? '').replace(/[^\w .@:/?=&%-]/g, char =>
    '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')
  );
}
