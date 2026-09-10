#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { google } from 'googleapis';
import { googleSync, SCOPES } from '../lib/googlesync.mjs';

/**
 * Executa a sincronização descrita por um arquivo de spec.
 *
 *   npx runsync [spec.json] [opções]
 *
 *   --prune           apaga os arquivos locais que saíram do Drive
 *   --only <tipo>     sincroniza só os alvos deste tipo (folder|sheet|text)
 *   --id <id>         sincroniza só os alvos com este id do Drive
 *   --root <dir>      raiz do projeto (padrão: o diretório atual)
 *   --manifest <arq>  manifesto (padrão: data/manifest.json)
 *   --dry-run         lista o que seria sincronizado, sem baixar nada
 *   --help
 */

// Tudo é resolvido contra o diretório de onde o comando foi chamado, nunca
// contra este arquivo: instalado, ele mora em node_modules/@bynigri/googlesync.
const DEFAULT_SPEC = 'syncparams.json';

/** Carrega o .env da raiz, se dotenv estiver disponível. */
async function loadEnv(envPath) {
    try {
        const dotenv = await import('dotenv');
        (dotenv.default ?? dotenv).config({ path: envPath, quiet: true });
    }
    catch {
        // Sem dotenv: seguimos com as variáveis já exportadas no ambiente.
    }
}

/**
 * Monta o auth a partir do ambiente — responsabilidade do CLI, não da
 * biblioteca.
 *
 * Sem GOOGLESYNC_ACCOUNT_FILE devolve null: aí vale o principal local, que no
 * Cloud Run é a service account do próprio runtime (ADC).
 */
function authFromEnv(root) {
    const keyFile = process.env.GOOGLESYNC_ACCOUNT_FILE;
    if (!keyFile) return null;

    // Um caminho relativo é relativo à raiz do projeto.
    return new google.auth.GoogleAuth({
        keyFile: path.resolve(root, keyFile),
        scopes: SCOPES,
    });
}

const USAGE = `
Uso: runsync [spec.json] [opções]

  spec.json          caminho do spec
                     (padrão: $GOOGLESYNC_SPEC_FILE ou ./syncparams.json)

Opções:
  --prune            apaga os arquivos locais que saíram do Drive
  --only <tipo>      sincroniza só os alvos deste tipo (folder|sheet|text)
  --id <id>          sincroniza só os alvos com este id do Drive
  --root <dir>       raiz para os caminhos do spec (padrão: diretório atual)
  --manifest <arq>   manifesto, relativo à raiz (padrão: data/manifest.json)
  --dry-run          mostra os alvos sem baixar nada
  -h, --help         esta ajuda

Ambiente (.env na raiz do projeto):
  GOOGLESYNC_ACCOUNT_FILE   chave da service account, relativa à raiz. Sem ela
                            usa o principal local (a service account do
                            runtime, no Cloud Run).
  GOOGLESYNC_SPEC_FILE      spec padrão, quando não vier na linha de comando.
`.trim();


function parseArgs(argv) {
    const opts = {
        spec: null, prune: false, only: null, id: null,
        root: null, manifest: null, dryRun: false, help: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '-h':
            case '--help':
                opts.help = true;
                break;
            case '--prune':
                opts.prune = true;
                break;
            case '--dry-run':
                opts.dryRun = true;
                break;
            case '--only':
                opts.only = argv[++i];
                break;
            case '--id':
                opts.id = argv[++i];
                break;
            case '--root':
                opts.root = argv[++i];
                break;
            case '--manifest':
                opts.manifest = argv[++i];
                break;
            default:
                if (arg.startsWith('-')) throw new Error(`Opção desconhecida: ${arg}`);
                if (opts.spec) throw new Error(`Spec já informado: ${opts.spec}`);
                opts.spec = arg;
        }
    }

    if (opts.only && !['folder', 'sheet', 'text'].includes(opts.only)) {
        throw new Error(`--only aceita "folder", "sheet" ou "text", não "${opts.only}"`);
    }
    return opts;
}


async function loadSpec(specPath) {
    let raw;
    try {
        raw = await fs.readFile(specPath, 'utf8');
    }
    catch {
        throw new Error(`Spec não encontrado: ${specPath}`);
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`Spec inválido (${path.basename(specPath)}): ${err.message}`);
    }

    const specs = Array.isArray(parsed) ? parsed : [parsed];
    specs.forEach((spec, i) => {
        if (!spec?.id) throw new Error(`Spec[${i}]: falta o campo "id".`);
        // Falha aqui é melhor do que descobrir o regex quebrado no meio do sync.
        if (spec.pattern) {
            try {
                new RegExp(spec.pattern);
            }
            catch (err) {
                throw new Error(`Spec[${i}]: pattern inválido — ${err.message}`);
            }
        }
    });
    return specs;
}


function describe(spec) {
    const alvo = spec.type === 'text'
        ? `${spec.name ?? '(nome do Drive)'} → `
            + `${spec.dest ?? 'data'}/${spec.name ?? '*'}.${spec.format ?? 'md|txt'}`
        : spec.type === 'sheet'
        ? `${spec.sheetName ?? spec.name ?? '(primeira aba)'} → `
            + `${spec.dest ?? 'data'}/${spec.name ?? spec.sheetName ?? '*'}.${spec.format ?? 'tsv'}`
        : `${spec.dest ?? 'public/assets/images'}${spec.recursive ? ' (recursivo)' : ''}`;
    const filtro = spec.pattern ? `  pattern=${spec.pattern}` : '';
    return `  ${(spec.type ?? 'folder').padEnd(6)} ${spec.id}  ${alvo}${filtro}`;
}


async function main() {
    const opts = parseArgs(process.argv.slice(2));

    if (opts.help) {
        console.log(USAGE);
        return 0;
    }

    const root = path.resolve(opts.root ?? process.cwd());

    // O .env vem da raiz do projeto que chamou. `dotenv/config` leria do cwd,
    // que muda quando se roda o binário de dentro de outra pasta com --root.
    // dotenv é opcional: sem ele vale o que já estiver exportado no ambiente.
    await loadEnv(path.join(root, '.env'));

    // Precedência: argumento na linha de comando > .env > padrão.
    const specPath = path.resolve(
        root,
        opts.spec ?? process.env.GOOGLESYNC_SPEC_FILE ?? DEFAULT_SPEC,
    );
    let specs = await loadSpec(specPath);

    if (opts.only) specs = specs.filter((s) => (s.type ?? 'folder') === opts.only);
    if (opts.id) specs = specs.filter((s) => s.id === opts.id);

    if (!specs.length) {
        console.error('Nenhum alvo corresponde aos filtros informados.');
        return 1;
    }

    console.log(`Spec: ${path.relative(process.cwd(), specPath)} — ${specs.length} alvo(s)`);

    if (opts.dryRun) {
        console.log('\n(dry-run — nada será baixado)\n');
        specs.forEach((s) => console.log(describe(s)));
        return 0;
    }

    const t0 = Date.now();
    const stats = await googleSync(specs, {
        auth: authFromEnv(root),
        prune: opts.prune,
        rootDir: root,
        manifestPath: opts.manifest ?? undefined,
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    const ignorados = stats.skipped ? `${stats.skipped} ignorado(s), ` : '';
    console.log(
        `\n${stats.downloaded} baixado(s), ${stats.unchanged} sem alteração, ` +
        `${ignorados}${stats.removed} removido(s), ${stats.failed} falha(s) — ${secs}s`,
    );

    // Código 1 quando algum alvo falhou, para o cron/CI perceber.
    return stats.failed > 0 ? 1 : 0;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error(`\nErro: ${err.message}`);
        if (process.env.DEBUG) console.error(err.stack);
        process.exit(1);
    });
