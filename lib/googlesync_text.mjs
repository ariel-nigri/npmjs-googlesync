import fs from 'fs/promises';
import path from 'path';

/**
 * O "como" dos textos: baixar e gravar Google Docs e arquivos de texto
 * enviados. Quem decide o que e quando sincronizar é o googlesync.mjs.
 *
 * São dois caminhos diferentes na API, e é por isso que isto é um módulo e
 * não uma chamada só:
 *
 *   Google Docs (nativo)  → files.export, escolhendo text/plain ou text/markdown
 *   .txt/.md enviados     → files.get(alt=media), o binário cru; o export
 *                           responde 403 em arquivo que não é nativo
 */

export const DOC_MIME = 'application/vnd.google-apps.document';

// Arquivos de texto enviados ao Drive: baixados crus, sem conversão.
export const TEXT_MIMES = new Set([
    'text/plain',
    'text/markdown',
    'text/x-markdown',
]);

/**
 * Formatos aceitos no spec → mime de export do Drive.
 * `md` e `markdown` são apelidos: a API só conhece text/markdown.
 */
const FORMATS = {
    txt: 'text/plain',
    text: 'text/plain',
    'text/plain': 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    'text/markdown': 'text/markdown',
};

const EXTENSION = {
    'text/plain': 'txt',
    'text/markdown': 'md',
};

/** Prefixo de todo documento nativo do Workspace (Docs, Sheets, Slides…). */
export const NATIVE_PREFIX = 'application/vnd.google-apps.';

export function isNative(mimeType) {
    return Boolean(mimeType?.startsWith(NATIVE_PREFIX));
}

/**
 * Modos do campo `text` num alvo do tipo folder — o que fazer com os Google
 * Docs encontrados dentro da pasta:
 *
 *   ignore    (padrão) pula os nativos; sem isso o alt=media responde 403
 *   plain     exporta como .txt
 *   markdown  exporta como .md
 */
const TEXT_MODES = {
    ignore: null,
    plain: 'text/plain',
    markdown: 'text/markdown',
};

/**
 * Traduz o modo em mime de export. Devolve null quando é para ignorar.
 * Só o Docs é exportável como texto: Sheets e Slides nativos continuam fora.
 */
export function textMode(modo = 'ignore') {
    if (!(modo in TEXT_MODES)) {
        throw new Error(
            `text "${modo}" não vale (use: ${Object.keys(TEXT_MODES).join(', ')})`,
        );
    }
    return TEXT_MODES[modo];
}

/** Extensão de saída para um mime de texto. */
export function extensionFor(mimeType) {
    return EXTENSION[mimeType];
}

/** Reconhece o que este módulo sabe converter. */
export function isText(mimeType) {
    return mimeType === DOC_MIME || TEXT_MIMES.has(mimeType);
}

/**
 * Resolve o formato pedido no spec. Sem `format`, o padrão depende da origem:
 * Docs nativo vira markdown (preserva títulos e listas); arquivo enviado
 * mantém o que já é.
 */
export function resolveFormat(spec, mimeType) {
    if (spec.format) {
        const mime = FORMATS[spec.format.toLowerCase()];
        if (!mime) {
            throw new Error(
                `formato "${spec.format}" não vale para texto `
                + `(use: txt, md)`,
            );
        }
        return mime;
    }
    if (mimeType === DOC_MIME) return 'text/markdown';
    return TEXT_MIMES.has(mimeType) && mimeType !== 'text/plain'
        ? 'text/markdown'
        : 'text/plain';
}

/**
 * Baixa o conteúdo como texto.
 *
 * Nativo  → files.export no mime pedido.
 * Enviado → alt=media, o arquivo como está. Converter .txt em .md (ou o
 *           contrário) seria mentir sobre o conteúdo, então só copiamos.
 */
export async function fetchText(drive, file, mimeType) {
    if (file.mimeType === DOC_MIME) {
        const response = await drive.files.export(
            { fileId: file.id, mimeType },
            { responseType: 'text' },
        );
        return String(response.data).replace(/\r/g, '');
    }

    const response = await drive.files.get(
        { fileId: file.id, alt: 'media' },
        { responseType: 'text' },
    );
    return String(response.data).replace(/\r/g, '');
}

/** Grava em <dest>/<nome>.<txt|md>. */
export async function writeText(text, name, mimeType, dest, rootDir) {
    const dir = path.resolve(rootDir, dest ?? 'data');
    await fs.mkdir(dir, { recursive: true });

    const outPath = path.join(dir, `${name}.${EXTENSION[mimeType]}`);
    await fs.writeFile(outPath, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    return { outPath, count: text.trimEnd() === '' ? 0 : text.trimEnd().split('\n').length };
}

/**
 * Ponto de entrada do módulo: baixa o texto, converte e grava.
 * Devolve { outPath, count } — count é o número de linhas.
 */
export async function syncTextFile(drive, file, spec, name, rootDir) {
    const mimeType = resolveFormat(spec, file.mimeType);
    const text = await fetchText(drive, file, mimeType);
    return writeText(text, name, mimeType, spec.dest, rootDir);
}
