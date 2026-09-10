import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook, parseTsv, DEFAULT_MANIFEST } from '../lib/googlesync.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, 'fixture.xlsx'));

// A aba é resolvida pelos rels, não pela posição: "Dados" é a 2ª aba mas
// aponta para worksheets/sheetAlvo.xml via rId3.
test('resolve a aba pelo r:id, não pela ordem', () => {
    const tsv = readWorkbook(fixture, 'Dados');
    assert.equal(tsv.split('\n')[0], 'Nome\tQtd');
});

test('aba padrão é a primeira quando sheetName é omitido', () => {
    assert.match(readWorkbook(fixture), /Outra aba/);
});

test('aba inexistente falha listando as disponíveis', () => {
    assert.throws(() => readWorkbook(fixture, 'Fantasma'), /Primeira, Dados/);
});

test('sharedStrings e entidades XML são decodificados', () => {
    const linhas = readWorkbook(fixture, 'Dados').split('\n');
    assert.equal(linhas[1].split('\t')[0], 'Café & chá');
});

// O bug do `[^>]*`: a célula vazia auto-fechada fazia o match continuar até a
// próxima e trazer o índice cru do sharedString no lugar do texto.
test('célula vazia auto-fechada não engole a célula seguinte', () => {
    const cells = readWorkbook(fixture, 'Dados').split('\n')[2].split('\t');
    assert.equal(cells[0], '');
    assert.equal(cells[1], '');   // coluna B ausente vira vazia
    assert.equal(cells[2], 'Doce'); // r="C3" recolocado na posição certa
});

test('inteiro gravado como 15.0 sai como 15', () => {
    assert.equal(readWorkbook(fixture, 'Dados').split('\n')[1].split('\t')[1], '15');
});

test('parseTsv indexa pelo cabeçalho', () => {
    assert.deepEqual(parseTsv('a\tb\n1\t2\n'), [{ a: '1', b: '2' }]);
});

test('manifesto padrão é relativo, nunca absoluto', () => {
    assert.ok(!path.isAbsolute(DEFAULT_MANIFEST));
});
