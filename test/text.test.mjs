import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    isText, resolveFormat, writeText, DOC_MIME,
    isNative, textMode, extensionFor,
} from '../lib/googlesync_text.mjs';

test('reconhece Docs nativo e textos enviados', () => {
    assert.ok(isText(DOC_MIME));
    assert.ok(isText('text/plain'));
    assert.ok(isText('text/markdown'));
    assert.ok(!isText('image/png'));
    assert.ok(!isText('application/vnd.google-apps.spreadsheet'));
});

// A API do Drive só conhece text/markdown; "md" é apelido nosso.
test('formato do spec vira o mime de export do Drive', () => {
    assert.equal(resolveFormat({ format: 'md' }, DOC_MIME), 'text/markdown');
    assert.equal(resolveFormat({ format: 'markdown' }, DOC_MIME), 'text/markdown');
    assert.equal(resolveFormat({ format: 'txt' }, DOC_MIME), 'text/plain');
    assert.equal(resolveFormat({ format: 'MD' }, DOC_MIME), 'text/markdown');
});

test('formato inválido falha dizendo o que vale', () => {
    assert.throws(() => resolveFormat({ format: 'pdf' }, DOC_MIME), /txt, md/);
});

test('sem format: Docs vira md, .txt enviado continua txt', () => {
    assert.equal(resolveFormat({}, DOC_MIME), 'text/markdown');
    assert.equal(resolveFormat({}, 'text/plain'), 'text/plain');
    assert.equal(resolveFormat({}, 'text/markdown'), 'text/markdown');
});

test('grava com a extensão do formato e termina em newline', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-txt-'));

    const md = await writeText('# Título', 'manual', 'text/markdown', 'docs', root);
    assert.equal(path.basename(md.outPath), 'manual.md');
    assert.equal(await fs.readFile(md.outPath, 'utf8'), '# Título\n');

    const txt = await writeText('linha\n', 'leiame', 'text/plain', undefined, root);
    assert.equal(path.relative(root, txt.outPath), path.join('data', 'leiame.txt'));

    await fs.rm(root, { recursive: true, force: true });
});


// --- modo `text` dos alvos do tipo folder ---

test('reconhece nativo do Workspace pelo prefixo', () => {
    assert.ok(isNative('application/vnd.google-apps.document'));
    assert.ok(isNative('application/vnd.google-apps.spreadsheet'));
    assert.ok(isNative('application/vnd.google-apps.presentation'));
    assert.ok(!isNative('text/plain'));
    assert.ok(!isNative('image/png'));
    assert.ok(!isNative(undefined));
});

// O padrão tem que ser ignorar: sem isso o alt=media responde 403 no Doc e
// derruba a pasta inteira.
test('text padrão é ignore', () => {
    assert.equal(textMode(), null);
    assert.equal(textMode('ignore'), null);
});

test('text plain/markdown viram o mime de export', () => {
    assert.equal(textMode('plain'), 'text/plain');
    assert.equal(textMode('markdown'), 'text/markdown');
});

test('text inválido falha listando os modos', () => {
    assert.throws(() => textMode('sim'), /ignore, plain, markdown/);
    assert.throws(() => textMode(true), /não vale/);
});

test('extensão acompanha o mime', () => {
    assert.equal(extensionFor('text/markdown'), 'md');
    assert.equal(extensionFor('text/plain'), 'txt');
});
