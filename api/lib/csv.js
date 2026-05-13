// Минимальный RFC 4180 парсер без зависимостей.
// Поддерживает кавычки, удвоенные кавычки в кавычках, \r\n и \n, BOM, ; и , как разделители.
// Авто-детект разделителя по первой строке.

function parseCsv(text) {
  if (!text || typeof text !== 'string') return [];
  // Срезаем BOM (UTF-8 with BOM, частый случай для CSV из Excel/1C)
  text = text.replace(/^﻿/, '');

  // Auto-detect разделителя — ; (типично для RU Excel) или ,
  const firstLine = text.split(/\r?\n/)[0] || '';
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const sep = semicolons > commas ? ';' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === sep) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(field); rows.push(row);
      row = []; field = ''; i++; continue;
    }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// Нормализация телефона: только цифры, 8XXX → 7XXX
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);
  return digits.length >= 10 ? digits : null;
}

// Парсит сумму: "1 234,56" → 1234.56, "1234.56" → 1234.56, "1234" → 1234
function parseAmount(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  const s = String(raw).replace(/\s+/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Парсит дату из разных форматов: YYYY-MM-DD, DD.MM.YYYY, DD/MM/YYYY
function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // ISO YYYY-MM-DD (и YYYY-MM-DDTHH:MM:SS)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  // RU DD.MM.YYYY (и DD.MM.YYYY HH:MM)
  const ruMatch = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (ruMatch) {
    const [, dd, mm, yyyy, hh = '0', min = '0'] = ruMatch;
    const year = yyyy.length === 2 ? '20' + yyyy : yyyy;
    const d = new Date(`${year}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}T${hh.padStart(2,'0')}:${min.padStart(2,'0')}:00`);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Try Date constructor as fallback
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = { parseCsv, normalizePhone, parseAmount, parseDate };
