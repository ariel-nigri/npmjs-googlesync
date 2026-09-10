import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';

/**
 * O "como" das planilhas: baixar, converter e gravar. Quem decide o que e
 * quando sincronizar é o googlesync.mjs.
 *
 * Nativa do Google + `sheetName` → API do Sheets, que endereça a aba.
 * Nativa sem `sheetName`        → files.export (só a PRIMEIRA aba).
 * Enviada (xlsx/xlsm)           → baixa o binário e lê localmente, porque
 *                                 files.export responde 403 nesses arquivos.
 */

export const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

// Planilhas enviadas (xlsx/xlsm) não são documentos nativos: files.export
// responde 403 nelas. Para essas, baixamos o binário e lemos aqui.
export const XLSX_MIMES = new Set([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel.sheet.macroenabled.12',
    'application/vnd.ms-excel',
]);

/** Reconhece o que este módulo sabe converter. */
export function isSheet(mimeType) {
    return mimeType === SHEET_MIME || XLSX_MIMES.has(mimeType);
}

export function parseTsv(text) {
    const lines = text.replace(/\r/g, '').trimEnd().split('\n');
    if (!lines.length || lines[0] === '') return [];

    const headers = lines[0].split('\t').map((h) => h.trim());
    return lines.slice(1).map((line) => {
        const values = line.split('\t');
        return Object.fromEntries(headers.map((h, i) => [h, (values[i] ?? '').trim()]));
    });
}

function toTsv(rows) {
    return rows.map((cells) => cells.map((c) => String(c ?? '')).join('\t')).join('\n');
}


/**
 * Lê as entradas de um zip pelo End of Central Directory.
 *
 * As bibliotecas de xlsx que testamos assumem uma ordem específica das
 * entradas e quebram com os arquivos gerados pelo Google, que gravam o
 * [Content_Types].xml no fim. Ler o índice central evita essa suposição.
 * Devolve { nome: Buffer }.
 */
function unzip(buffer) {
    const EOCD = 0x06054b50;
    let eocd = -1;
    // O comentário final tem no máximo 64 KiB; procura de trás para frente.
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i--) {
        if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('zip inválido: End of Central Directory não encontrado');

    const total = buffer.readUInt16LE(eocd + 10);
    let ptr = buffer.readUInt32LE(eocd + 16);
    const out = {};

    for (let n = 0; n < total; n++) {
        if (buffer.readUInt32LE(ptr) !== 0x02014b50) break;

        const method = buffer.readUInt16LE(ptr + 10);
        const compSize = buffer.readUInt32LE(ptr + 20);
        const nameLen = buffer.readUInt16LE(ptr + 28);
        const extraLen = buffer.readUInt16LE(ptr + 30);
        const commentLen = buffer.readUInt16LE(ptr + 32);
        const localOff = buffer.readUInt32LE(ptr + 42);
        const name = buffer.toString('utf8', ptr + 46, ptr + 46 + nameLen);

        // O cabeçalho local repete os tamanhos: os dados começam depois dele.
        const lNameLen = buffer.readUInt16LE(localOff + 26);
        const lExtraLen = buffer.readUInt16LE(localOff + 28);
        const start = localOff + 30 + lNameLen + lExtraLen;
        const raw = buffer.subarray(start, start + compSize);

        out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
        ptr += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}

/** "AB12" → 27 (índice 0-based da coluna) */
function colIndex(ref) {
    const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

function decodeXml(s) {
    return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g,
        (_, dec, hex, named) => {
            if (dec) return String.fromCodePoint(+dec);
            if (hex) return String.fromCodePoint(parseInt(hex, 16));
            return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named];
        });
}

/** Concatena o texto de todos os <t> de um trecho (célula inline ou sharedString). */
function xmlText(fragment) {
    const parts = [...fragment.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)];
    return decodeXml(parts.map((m) => m[1]).join(''));
}

/**
 * Lê um xlsx/xlsm já baixado e devolve TSV. Sem `sheetName`, usa a primeira
 * aba. As tags podem vir com prefixo de namespace (`x:sheet`), daí o
 * `(?:\w+:)?` em todos os padrões.
 */
export function readWorkbook(buffer, sheetName) {
    const zip = unzip(buffer);

    const workbook = zip['xl/workbook.xml']?.toString('utf8');
    if (!workbook) throw new Error('xlsx inválido: xl/workbook.xml ausente');

    // A ordem das abas NÃO corresponde a sheet1/sheet2/...: o nome aponta para
    // um r:id, e é o workbook.xml.rels que diz qual arquivo é esse. Confiar na
    // posição faz ler a aba errada em silêncio.
    const rels = zip['xl/_rels/workbook.xml.rels']?.toString('utf8') ?? '';
    const relTarget = {};
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        const id = m[0].match(/\bId="([^"]*)"/)?.[1];
        const target = m[0].match(/\bTarget="([^"]*)"/)?.[1];
        if (id && target) relTarget[id] = target.replace(/^\/?xl\//, '').replace(/^\.\//, '');
    }

    const tabs = [...workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)].map((m) => ({
        name: decodeXml(m[0].match(/\bname="([^"]*)"/)?.[1] ?? ''),
        rid: m[0].match(/\br:id="([^"]*)"/)?.[1],
    }));

    const tab = sheetName ? tabs.find((t) => t.name === sheetName) : tabs[0];
    if (!tab) {
        const nomes = tabs.map((t) => t.name).join(', ');
        throw new Error(`aba "${sheetName}" não encontrada (disponíveis: ${nomes})`);
    }

    const target = relTarget[tab.rid];
    const sheetXml = (target ? zip[`xl/${target}`] : null)?.toString('utf8');
    if (!sheetXml) throw new Error(`xlsx inválido: worksheet de "${tab.name}" ausente`);

    // Tabela de strings compartilhadas: células com t="s" apontam para ela.
    const sharedXml = zip['xl/sharedStrings.xml']?.toString('utf8') ?? '';
    const shared = [...sharedXml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)]
        .map((m) => xmlText(m[1]));

    const rows = [];
    for (const rowMatch of sheetXml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
        const cells = [];
        // A célula vazia é auto-fechada (`<c r="A1" s="32"/>`). Um `[^>]*` nos
        // atributos engole a `/` e faz o match continuar até a PRÓXIMA célula,
        // levando junto o `t="s"` dela — daí sair o índice cru no lugar do
        // texto. Por isso os atributos são lidos aspas-a-aspas.
        for (const cell of rowMatch[1].matchAll(/<(?:\w+:)?c\b((?:[^>"]|"[^"]*")*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
            const attrs = cell[1];
            const body = cell[2] ?? '';
            const at = colIndex(attrs.match(/\br="([A-Z]+\d+)"/)?.[1] ?? 'A1');
            const type = attrs.match(/\bt="([^"]+)"/)?.[1];

            let value = '';
            if (type === 's') {
                const i = Number(body.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1]);
                value = shared[i] ?? '';
            }
            else if (type === 'inlineStr') {
                value = xmlText(body);
            }
            else {
                // Numérica, booleana ou fórmula: <v> guarda o valor calculado.
                value = decodeXml(body.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1] ?? '');
                // O Excel guarda todo número como double, então o inteiro 15
                // vem como "15.0". Corta o ".0" sem tocar em decimais reais
                // nem em textos numéricos longos (que perderiam precisão).
                if (type === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
                else if (/^-?\d+\.0+$/.test(value)) value = value.replace(/\.0+$/, '');
            }

            // Colunas vazias são omitidas no XML; o r="B3" recoloca no lugar.
            while (cells.length < at) cells.push('');
            cells[at] = value;
        }
        rows.push(cells);
    }

    // Tabulação e quebra de linha dentro da célula arruinariam o TSV.
    return toTsv(rows.map((r) => r.map((c) => String(c ?? '').replace(/[\t\r\n]+/g, ' '))));
}

/**
 * Baixa uma planilha e devolve o texto TSV.
 *
 * Nativa do Google + `sheetName` → API do Sheets, que endereça a aba.
 * Nativa sem `sheetName`        → files.export (só a PRIMEIRA aba).
 * Enviada (xlsx/xlsm)           → baixa o binário e lê localmente, porque
 *                                 files.export responde 403 nesses arquivos.
 */
export async function fetchSheet(drive, sheets, file, sheetName) {
    if (XLSX_MIMES.has(file.mimeType)) {
        const response = await drive.files.get(
            { fileId: file.id, alt: 'media' },
            { responseType: 'arraybuffer' },
        );
        return readWorkbook(Buffer.from(response.data), sheetName);
    }

    if (sheetName) {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: file.id,
            range: `'${sheetName.replace(/'/g, "''")}'`,
            valueRenderOption: 'UNFORMATTED_VALUE',
        });
        return toTsv(response.data.values ?? []);
    }

    const response = await drive.files.export(
        { fileId: file.id, mimeType: 'text/tab-separated-values' },
        { responseType: 'text' },
    );
    return String(response.data).replace(/\r/g, '');
}

/**
 * Grava a planilha em data/<nome>.<ext>.
 *
 * format 'tsv'  → TSV cru, que é o formato lido por lib/families.js
 * format 'json' → registros já indexados pelo cabeçalho
 */
export async function writeSheet(text, name, format, dest, rootDir) {
    const dir = path.resolve(rootDir, dest ?? 'data');
    await fs.mkdir(dir, { recursive: true });

    if (format === 'json') {
        const records = parseTsv(text);
        const outPath = path.join(dir, `${name}.json`);
        await fs.writeFile(outPath, JSON.stringify(records, null, 2), 'utf8');
        return { outPath, count: records.length };
    }

    const outPath = path.join(dir, `${name}.tsv`);
    await fs.writeFile(outPath, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    return { outPath, count: Math.max(0, text.trimEnd().split('\n').length - 1) };
}



/**
 * Ponto de entrada do módulo: baixa a planilha, converte e grava.
 * Devolve { outPath, count } — count é o número de linhas de dados.
 */
export async function syncSheetFile(drive, sheets, file, spec, name, rootDir) {
    const format = spec.format ?? 'tsv';
    const text = await fetchSheet(drive, sheets, file, spec.sheetName);
    return writeSheet(text, name, format, spec.dest, rootDir);
}
