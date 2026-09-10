import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { googleSync } from '../lib/googlesync.mjs';

// Prova que nada é gravado dentro do pacote: com rootDir apontando para um
// diretório temporário, o manifesto e os arquivos caem lá — era exatamente
// isso que quebrava quando a raiz era resolvida contra __dirname.
test('grava manifesto e saída sob rootDir, não dentro do pacote', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-'));

    // Um spec sem "id" falha cedo, sem tocar na rede, mas ainda percorre todo
    // o caminho de gravação do manifesto.
    const stats = await googleSync([{ type: 'folder' }], { rootDir: root });

    assert.equal(stats.failed, 1);
    const manifesto = path.join(root, 'data', 'manifest.json');
    assert.deepEqual(JSON.parse(await fs.readFile(manifesto, 'utf8')), {});

    // E o manifesto ficou sob root, não sob o cwd de quem rodou o teste: se a
    // raiz voltasse a ser resolvida contra __dirname, este caminho não existiria.
    assert.equal(path.relative(root, manifesto), path.join('data', 'manifest.json'));

    await fs.rm(root, { recursive: true, force: true });
});

test('manifestPath customizado é respeitado', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-'));
    await googleSync([{ type: 'folder' }], { rootDir: root, manifestPath: 'var/estado.json' });
    await fs.access(path.join(root, 'var', 'estado.json')); // lança se faltar
    await fs.rm(root, { recursive: true, force: true });
});
