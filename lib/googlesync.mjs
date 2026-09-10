import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';
import { isSheet, syncSheetFile } from './googlesync_sheet.mjs';
import {
    isText, syncTextFile, isNative, textMode, extensionFor,
    DOC_MIME, fetchText, writeText,
} from './googlesync_text.mjs';

// A API pública de conversão continua saindo daqui, para quem importa só o
// pacote não precisar conhecer a divisão interna dos módulos.
export { parseTsv, readWorkbook, isSheet } from './googlesync_sheet.mjs';
export { isText, resolveFormat } from './googlesync_text.mjs';

/**
 * Sincroniza o Google Drive com o disco local, guiado por um spec JSON.
 *
 * Este módulo decide O QUE e QUANDO sincronizar (manifesto, renomeio, prune).
 * O COMO — baixar e converter — fica nos módulos por tipo:
 *   googlesync_sheet.mjs → planilhas (TSV/JSON, nativas e xlsx enviados)
 *   googlesync_text.mjs  → textos (Google Docs, .txt/.md enviados)
 *
 * Cada entrada do spec é um alvo:
 *   { type: 'folder', id, dest, pattern?, mimeTypes?, recursive?, text? }
 *   { type: 'sheet',  id, format: 'tsv' | 'json', sheetName?, name?, dest? }
 *   { type: 'text',   id, format: 'txt' | 'md', name?, dest? }
 *
 * O manifesto (data/manifest.json) guarda o modifiedTime de cada arquivo já
 * baixado, então execuções seguintes só transferem o que mudou.
 */

/** Escopos necessários — só leitura. Exportado para quem monta o próprio auth. */
export const SCOPES = [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/spreadsheets.readonly',
];

const FOLDER_MIME = 'application/vnd.google-apps.folder';

// A raiz é o projeto que CHAMA, não o pacote. Instalado via npm, este arquivo
// mora em node_modules/@bynigri/googlesync/lib/ — resolver contra __dirname
// gravaria o manifesto e os downloads lá dentro, e o próximo `npm install`
// levaria tudo embora. Daí o padrão ser process.cwd().
export const DEFAULT_MANIFEST = path.join('data', 'manifest.json');

function resolveRoot(rootDir) {
    return path.resolve(rootDir ?? process.cwd());
}


// --- manifest helpers ---
async function loadManifest(manifestPath) {
    try {
        const raw = await fs.readFile(manifestPath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}

async function saveManifest(manifestPath, manifest) {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}


/**
 * Auth é responsabilidade de quem chama: a biblioteca não lê variável de
 * ambiente nem arquivo de credencial.
 *
 * Passe um GoogleAuth (ou qualquer client da googleapis) pronto; passe `null`
 * — ou omita — para as Application Default Credentials, que é o caso do Cloud
 * Run, onde a service account do runtime já está no ambiente.
 */
export function defaultAuth() {
    return new google.auth.GoogleAuth({ scopes: SCOPES });
}

export function driveClient(auth) {
    return google.drive({ version: 'v3', auth: auth ?? defaultAuth() });
}

export function sheetsClient(auth) {
    return google.sheets({ version: 'v4', auth: auth ?? defaultAuth() });
}


/**
 * Lista o conteúdo de uma pasta. O ID precisa vir entre aspas simples na
 * query, senão a API responde 400. Pagina até o fim: files.list devolve no
 * máximo 100 itens por página.
 */
async function listFolderContents(drive, folderId, { recursive = false } = {}) {
    const files = [];
    let pageToken;

    do {
        const response = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
            pageSize: 1000,
            pageToken,
        });
        files.push(...(response.data.files ?? []));
        pageToken = response.data.nextPageToken;
    } while (pageToken);

    if (!recursive) return files;

    // Desce nas subpastas e devolve tudo achatado, com o caminho relativo em
    // `subPath` para preservar a estrutura no destino.
    const out = [];
    for (const file of files) {
        if (file.mimeType !== FOLDER_MIME) {
            out.push(file);
            continue;
        }
        const children = await listFolderContents(drive, file.id, { recursive });
        out.push(...children.map((c) => ({
            ...c,
            subPath: path.join(file.name, c.subPath ?? ''),
        })));
    }
    return out;
}



async function downloadBinary(drive, fileId, destPath) {
    const response = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'arraybuffer' },
    );
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, Buffer.from(response.data));
}


// --- sync de um alvo do tipo 'folder' ---
async function syncFolder(drive, spec, manifest, nextManifest, stats, rootDir) {
    const dest = path.resolve(rootDir, spec.dest ?? path.join('public', 'assets', 'images'));
    const files = await listFolderContents(drive, spec.id, { recursive: spec.recursive });

    const re = spec.pattern ? new RegExp(spec.pattern) : null;
    const allowed = spec.mimeTypes?.length ? new Set(spec.mimeTypes) : null;

    // O que fazer com os Google Docs da pasta: ignore (padrão), plain ou markdown.
    const exportMime = textMode(spec.text);

    for (const file of files) {
        if (file.mimeType === FOLDER_MIME) continue;
        if (re && !re.test(file.name)) continue;
        if (allowed && !allowed.has(file.mimeType)) continue;

        // Nativo do Workspace não tem bytes para baixar: o alt=media responde
        // 403. Só o Docs pode virar texto, e só se o spec pedir.
        const comoTexto = isNative(file.mimeType)
            && file.mimeType === DOC_MIME
            && exportMime;

        if (isNative(file.mimeType) && !comoTexto) {
            console.log(`  · ${file.name} (nativo, ignorado)`);
            stats.skipped++;
            continue;
        }

        // Exportado como texto, o arquivo ganha extensão; o nome no Drive não tem.
        const nomeLocal = comoTexto
            ? `${file.name}.${extensionFor(exportMime)}`
            : file.name;
        const destPath = path.join(dest, file.subPath ?? '', nomeLocal);
        const relPath = path.relative(rootDir, destPath);
        const prev = manifest[file.id];
        // Confere o disco também: manifesto sem arquivo (apagado à mão) rebaixa.
        const onDisk = await fs.access(destPath).then(() => true, () => false);

        // Renomear no Drive NÃO mexe no modifiedTime, então a comparação de data
        // sozinha diria "sem alterações" e o arquivo ficaria com o nome antigo.
        // O caminho guardado no manifesto é o que denuncia a troca de nome.
        const renamed = Boolean(prev?.path && prev.path !== relPath);

        if (prev && prev.modifiedTime === file.modifiedTime && onDisk && !renamed) {
            nextManifest[file.id] = prev;
            stats.unchanged++;
            continue;
        }

        const motivo = renamed ? `renomeado de ${path.basename(prev.path)}`
            : prev ? 'atualizado'
            : 'novo';

        // Um arquivo problemático custa um arquivo, não a pasta inteira.
        try {
            if (comoTexto) {
                const texto = await fetchText(drive, file, exportMime);
                await writeText(
                    texto, path.basename(nomeLocal, `.${extensionFor(exportMime)}`),
                    exportMime, path.dirname(path.relative(rootDir, destPath)), rootDir,
                );
            }
            else {
                await downloadBinary(drive, file.id, destPath);
            }
        }
        catch (err) {
            // Só depois de baixar é que se pode dizer que baixou.
            console.error(`  ✗ ${file.name}: ${err.message}`);
            stats.failed++;
            if (prev) nextManifest[file.id] = prev;
            continue;
        }
        console.log(`  ↓ ${nomeLocal} (${motivo})`);

        // Sem isso o arquivo antigo sobra na pasta. Como families.js escolhe a
        // imagem pelo prefixo do índice com um find(), a sobra pode ser servida
        // no lugar da nova — o prune não pega, porque o id continua no manifesto.
        if (renamed) {
            await fs.unlink(path.join(rootDir, prev.path)).catch(() => {});
            console.log(`    ✕ ${path.basename(prev.path)} (nome antigo)`);
        }

        nextManifest[file.id] = {
            name: file.name,
            modifiedTime: file.modifiedTime,
            path: path.relative(rootDir, destPath),
        };
        stats.downloaded++;
    }
}


// --- sync de um alvo de arquivo único ('sheet' ou 'text') ---
// A orquestração (manifesto, renomeio, "mudou?") é a mesma para os dois; só a
// conversão muda, e ela mora nos módulos googlesync_sheet/googlesync_text.
async function syncFile(drive, sheets, spec, manifest, nextManifest, stats, rootDir) {
    const meta = await drive.files.get({
        fileId: spec.id,
        fields: 'id, name, mimeType, modifiedTime',
    });
    const file = meta.data;

    // O tipo pedido no spec tem que bater com o que o arquivo é de fato.
    const tipo = spec.type === 'text' ? 'text' : 'sheet';
    const combina = tipo === 'text' ? isText(file.mimeType) : isSheet(file.mimeType);
    if (!combina) {
        console.warn(`  ! ${file.name} não é ${tipo} (${file.mimeType}) — ignorado`);
        stats.failed++;
        return;
    }

    const name = spec.name ?? spec.sheetName ?? file.name;

    // A extensão de saída depende do formato, e quem sabe disso é cada módulo.
    // Aqui só precisamos do caminho para detectar renomeio, então perguntamos.
    const format = spec.format ?? (tipo === 'text' ? '' : 'tsv');

    // Uma mesma planilha pode aparecer várias vezes no spec (uma por aba), por
    // isso a chave do manifesto combina id + aba + formato.
    const key = `${file.id}:${spec.sheetName ?? ''}:${format}`;
    const prev = manifest[key];
    const onDisk = prev?.path
        ? await fs.access(path.resolve(rootDir, prev.path)).then(() => true, () => false)
        : false;

    // Mudar `name`/`dest` no spec (ou o nome no Drive, quando o spec não fixa
    // um) muda o destino sem mexer no modifiedTime. Sem reparar nisso o arquivo
    // antigo fica no destino e vira uma entrada fantasma para quem varre a pasta.
    const destDir = path.relative(rootDir, path.resolve(rootDir, spec.dest ?? 'data'));
    const renamed = Boolean(
        prev?.path && (path.dirname(prev.path) !== destDir || prev.name !== name),
    );

    if (prev && prev.modifiedTime === file.modifiedTime && onDisk && !renamed) {
        nextManifest[key] = prev;
        stats.unchanged++;
        console.log(`  — ${name} (sem alterações)`);
        return;
    }

    const motivo = renamed ? `renomeado de ${path.basename(prev.path)}`
        : prev ? 'atualizado'
        : 'novo';
    console.log(`  ↓ ${name} (${motivo})`);

    const { outPath: written, count } = tipo === 'text'
        ? await syncTextFile(drive, file, spec, name, rootDir)
        : await syncSheetFile(drive, sheets, file, spec, name, rootDir);

    // Só apaga o antigo depois de gravar o novo — e nunca o próprio arquivo
    // que acabou de ser escrito (o nome pode ter mudado só de extensão).
    if (renamed) {
        const antigo = path.resolve(rootDir, prev.path);
        if (antigo !== written) {
            await fs.unlink(antigo).catch(() => {});
            console.log(`    ✕ ${path.basename(prev.path)} (nome antigo)`);
        }
    }

    nextManifest[key] = {
        name,
        modifiedTime: file.modifiedTime,
        path: path.relative(rootDir, written),
    };
    stats.downloaded++;
    console.log(`    ${count} linhas → ${path.relative(rootDir, written)}`);
}


/**
 * Executa a sincronização descrita pelo spec.
 *
 * `auth`   GoogleAuth pronto; `null`/ausente usa as Application Default
 *          Credentials (Cloud Run). A biblioteca não lê .env nem chave de disco.
 * `prune`  remove os arquivos que saíram do Drive.
 *
 * Devolve as estatísticas da rodada; `downloaded + removed > 0` significa que
 * algo mudou em disco.
 */
export async function googleSync(syncspec, {
    auth = null, prune = false, rootDir, manifestPath,
} = {}) {
    const specs = Array.isArray(syncspec) ? syncspec : [syncspec];
    if (!specs.length) throw new Error('Spec de sincronização vazio.');

    const root = resolveRoot(rootDir);
    const manifestFile = path.resolve(root, manifestPath ?? DEFAULT_MANIFEST);

    // `auth` nulo/ausente → ADC (Cloud Run).
    const drive = driveClient(auth);
    const sheets = sheetsClient(auth);

    const manifest = await loadManifest(manifestFile);
    const nextManifest = {};
    const stats = { downloaded: 0, unchanged: 0, removed: 0, skipped: 0, failed: 0 };

    for (const spec of specs) {
        if (!spec?.id) {
            console.warn('  ! entrada sem "id" — ignorada');
            stats.failed++;
            continue;
        }

        console.log(`\n▸ ${spec.type ?? 'folder'} ${spec.sheetName ?? spec.id}`);
        try {
            if (spec.type === 'sheet' || spec.type === 'text') {
                await syncFile(drive, sheets, spec, manifest, nextManifest, stats, root);
            }
            else {
                await syncFolder(drive, spec, manifest, nextManifest, stats, root);
            }
        }
        catch (err) {
            console.error(`  ✗ falhou: ${err.message}`);
            stats.failed++;
            // Preserva as entradas antigas deste alvo: sem elas, o prune
            // apagaria arquivos locais só porque a chamada falhou.
            for (const [key, entry] of Object.entries(manifest)) {
                if (!(key in nextManifest)) nextManifest[key] = entry;
            }
        }
    }

    if (prune) {
        for (const [key, entry] of Object.entries(manifest)) {
            if (key in nextManifest || !entry.path) continue;
            console.log(`  ✕ ${entry.name} (removido do Drive)`);
            await fs.unlink(path.join(root, entry.path)).catch(() => {});
            stats.removed++;
        }
    }
    else {
        // Sem prune, mantém o histórico para não rebaixar tudo na próxima vez.
        for (const [key, entry] of Object.entries(manifest)) {
            if (!(key in nextManifest)) nextManifest[key] = entry;
        }
    }

    await saveManifest(manifestFile, nextManifest);
    return stats;
}
