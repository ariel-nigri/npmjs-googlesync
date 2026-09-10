# @bynigri/googlesync

Sincroniza pastas e planilhas do Google Drive para arquivos locais, guiado por
um spec JSON. Somente leitura, via **service account** — sem fluxo OAuth, sem
navegador, serve para cron e CI.

Um `data/manifest.json` guarda o `modifiedTime` de cada arquivo baixado, então
as execuções seguintes só transferem **o que mudou**.

- **folder** — baixa binários (imagens, PDFs), com filtro por nome e mimeType
- **sheet** — exporta uma planilha para TSV ou JSON, escolhendo a aba
- **text** — exporta um Google Docs para Markdown ou texto puro, e copia
  `.txt`/`.md` enviados

Lê tanto Google Sheets nativas quanto `.xlsx`/`.xlsm` **enviadas** ao Drive
(essas o `files.export` recusa com 403; o parser embutido resolve).

## Instalação

```bash
npm install git+ssh://git@github.com/bynigri/googlesync.git
```

Só `googleapis` é dependência. `dotenv` é **opcional** e serve apenas ao CLI,
para ler o `.env`; a biblioteca não o usa.

## Configuração

1. **Crie uma service account** no Google Cloud e baixe a chave JSON. Guarde-a
   na raiz do projeto e **coloque no `.gitignore`**:

   ```
   .service-account-creds.json
   .env
   ```

2. **`.env` na raiz do projeto** (usado pelo CLI; como biblioteca, veja
   [Uso como biblioteca](#uso-como-biblioteca)):

   ```
   GOOGLESYNC_ACCOUNT_FILE=.service-account-creds.json
   GOOGLESYNC_SPEC_FILE=syncparams.json
   ```

   | Variável | Efeito |
   |---|---|
   | `GOOGLESYNC_ACCOUNT_FILE` | chave da service account, relativa à raiz. **Ausente → usa o principal local**, que no Cloud Run/GCE é a service account do runtime |
   | `GOOGLESYNC_SPEC_FILE` | spec padrão, quando não vier na linha de comando |

   Ambas valem só para o CLI — a biblioteca recebe o `auth` de quem chama.

3. **Compartilhe a pasta/planilha com o e-mail da service account**
   (`...iam.gserviceaccount.com`), acesso de leitura.
   *Este é o passo que todo mundo esquece* — sem ele o sync não dá erro:
   simplesmente devolve zero arquivos, porque a conta não enxerga nada.

4. **Ative a Drive API** no projeto do Cloud. A **Sheets API** só é necessária
   se você usar `sheetName` numa planilha **nativa** do Google.

## Uso pela linha de comando

```bash
npx runsync                    # roda ./syncparams.json
npx runsync --dry-run          # lista os alvos, não baixa nada
npx runsync --only sheet       # ou --only folder
npx runsync --id 1AbC...       # um alvo só
npx runsync --prune            # apaga o que saiu do Drive
npx runsync outro.json         # outro spec
npx runsync --root ../app      # outra raiz de projeto
```

| Opção | Efeito |
|---|---|
| `--prune` | apaga os arquivos locais que saíram do Drive |
| `--only <tipo>` | só os alvos deste tipo (`folder` ou `sheet`) |
| `--id <id>` | só os alvos com este id do Drive |
| `--root <dir>` | raiz para os caminhos do spec (padrão: diretório atual) |
| `--manifest <arq>` | manifesto, relativo à raiz (padrão: `data/manifest.json`) |
| `--dry-run` | mostra os alvos sem baixar nada |
| `-h, --help` | ajuda |

Sai com **código 1** se algum alvo falhar, para o cron/CI perceber.
**Sempre rode `--dry-run` primeiro** num spec novo.

Como script no `package.json` do seu projeto:

```json
{ "scripts": { "sync": "runsync", "sync:check": "runsync --dry-run" } }
```

## Uso como biblioteca

A biblioteca **não lê `.env` nem variável de ambiente, e não depende de
`dotenv`**. Quem chama entrega o `auth` pronto — ou `null` para as Application
Default Credentials.

```js
import { google } from 'googleapis';
import { googleSync, SCOPES } from '@bynigri/googlesync';

// Chave de service account em disco:
const auth = new google.auth.GoogleAuth({
    keyFile: '/caminho/da/chave.json',
    scopes: SCOPES,
});

const stats = await googleSync(spec, {
    auth,                            // null/omitido → ADC (Cloud Run)
    prune: false,                    // apaga o que saiu do Drive
    rootDir: process.cwd(),          // raiz dos caminhos do spec
    manifestPath: 'data/manifest.json',
});
// { downloaded, unchanged, removed, failed }
// downloaded + removed > 0  →  algo mudou em disco
```

No Cloud Run (ou GCE/GKE), onde a service account do runtime já está no
ambiente, basta omitir:

```js
await googleSync(spec, { rootDir: '/app' });   // usa ADC
```

Os caminhos do spec e o manifesto são resolvidos contra **`rootDir`**, que por
padrão é `process.cwd()` — a raiz de quem chama, nunca a pasta do pacote dentro
de `node_modules`.

Também exportados: `SCOPES`, `defaultAuth()`, `readWorkbook(buffer, sheetName?)`
(xlsx → TSV), `parseTsv(text)` (TSV → registros), `driveClient(auth?)`,
`sheetsClient(auth?)`.

## O spec

Um array de alvos. Todo alvo precisa de `id` (o ID do arquivo/pasta no Drive).
Veja `syncparams.example.json`.

```jsonc
[
  {
    "id": "1AbC...",                  // pasta
    "type": "folder",
    "recursive": true,                // desce nas subpastas, preservando a estrutura
    "dest": "public/assets/images",   // relativo à raiz do projeto
    "pattern": "^[0-9]{1,3}[_-]",     // regex (string!) sobre o NOME do arquivo
    "mimeTypes": ["image/png", "image/jpeg"],
    "text": "ignore"                  // Docs na pasta: ignore|plain|markdown
  },
  {
    "id": "1XyZ...",                  // planilha
    "type": "sheet",
    "format": "tsv",                  // "tsv" (padrão) ou "json"
    "sheetName": "Aba 1",             // opcional; sem ele, a PRIMEIRA aba
    "dest": "data/_incoming",         // opcional; padrão "data"
    "name": "saida"                   // nome do arquivo, sem extensão
  },
  {
    "id": "1DoC...",                  // Google Docs, ou .txt/.md enviado
    "type": "text",
    "format": "md",                   // "md" ou "txt"
    "dest": "data/docs",
    "name": "manual"                  // vira data/docs/manual.md
  }
]
```

### Campos

| Campo | Tipo | Vale para | Descrição |
|---|---|---|---|
| `id` | string | ambos | **obrigatório** — ID do Drive |
| `type` | `folder` \| `sheet` | ambos | padrão `folder` |
| `dest` | string | ambos | destino relativo à raiz; padrão `public/assets/images` (folder) ou `data` (sheet) |
| `recursive` | boolean | folder | desce nas subpastas, preservando a estrutura |
| `pattern` | string | folder | regex sobre o nome — **whitelist** |
| `mimeTypes` | string[] | folder | só estes tipos |
| `text` | `ignore` \| `plain` \| `markdown` | folder | o que fazer com os Google Docs da pasta; padrão `ignore` |
| `format` | `tsv` \| `json` | sheet | padrão `tsv` |
| `format` | `md` \| `txt` | text | padrão: Docs → `md`; enviado → mantém o que é |
| `sheetName` | string | sheet | nome da aba; sem ele, a primeira |
| `name` | string | sheet | nome do arquivo de saída, sem extensão |

### Google Docs dentro de uma pasta

Documento nativo do Workspace (Docs, Sheets, Slides) **não tem bytes para
baixar** — o `alt=media` responde 403. Por isso um alvo `folder` os ignora por
padrão; o campo `text` decide o resto:

| `text` | Efeito |
|---|---|
| `ignore` (padrão) | pula todo nativo, avisando no log (`· nome (nativo, ignorado)`) |
| `plain` | exporta cada **Google Docs** da pasta como `<nome>.txt` |
| `markdown` | exporta cada **Google Docs** da pasta como `<nome>.md` |

```jsonc
{
  "id": "1AbC...",
  "type": "folder",
  "recursive": true,
  "dest": "data/docs",
  "text": "markdown"      // os Docs viram .md; o resto baixa normal
}
```

Vale só para **Docs**: Sheets e Slides nativos continuam ignorados nos três
modos (planilha se sincroniza com um alvo `sheet`, que sabe escolher a aba).
Arquivos `.txt`/`.md` **enviados** não são nativos e sempre baixam como estão,
independente de `text`.

Um arquivo que falha custa só ele mesmo — o restante da pasta continua.

`pattern` é uma string JSON, então as barras invertidas dobram: `"\\d"`, não
`\d`. Prefira `[0-9]` e escape o problema. Ele é uma **whitelist** — o que não
casa é ignorado, que é justamente o que se quer numa pasta cheia de tralha.

> **Regex:** o `-` vai por **último** na classe (`[_-]`), senão vira intervalo.
> E `^[0-9]+[_-]` casa com lixo tipo `01235096-A5EB-…`; limite os dígitos
> (`^[0-9]{1,3}[_-]`) quando a intenção é um índice curto.

## Armadilhas (todas foram encontradas na prática)

- **Nunca sincronize direto por cima de dados vivos.** Faça as planilhas
  pousarem numa pasta de espera (`data/_incoming/`) e compare antes de promover.
  Uma planilha cujo schema mudou (coluna-chave renomeada ou ausente) sobrescreve
  alegremente um arquivo que funcionava e quebra todas as buscas.
- **Cuidado com o que um app que varre diretório considera dado.** Se o app
  lista `data/*.tsv` como conteúdo, o arquivo sincronizado vira uma entrada
  fantasma. Uma **subpasta** é segura quando a varredura não é recursiva; um
  prefixo no nome não é.
- **`files.export` responde 403 em `.xlsx`/`.xlsm` enviados** — só funciona em
  documentos nativos do Google. Para os enviados, a biblioteca baixa o binário
  e lê localmente.
- **Não acrescente uma biblioteca de xlsx.** `xlsx`/SheetJS no npm está parado
  no 0.18.5 com duas vulnerabilidades altas sem correção; `exceljs` quebra em
  workbooks gerados pelo Google (`Cannot read properties of undefined (reading
  'sheets')`), porque o Google grava o `[Content_Types].xml` **por último** no
  zip e o parser dele assume o contrário. Por isso o parser é próprio.
- **Aba nº N ≠ `sheetN.xml`.** O nome da aba aponta para um `r:id`, e só o
  `xl/_rels/workbook.xml.rels` diz qual arquivo é. Confiar na posição **lê a
  aba errada em silêncio**.
- **Renomear no Drive não mexe no `modifiedTime`.** Por isso o manifesto guarda
  o caminho: é ele que denuncia a troca de nome e apaga o arquivo antigo.
- **Um alvo que falhou não dispara prune.** No erro a biblioteca preserva as
  entradas antigas do manifesto — senão um piscar da rede apagaria arquivos.
- **O manifesto também confere o disco.** `modifiedTime` igual mas arquivo
  ausente (apagado à mão) → baixa de novo.
- **Exportação CSV/TSV é só da primeira aba.** Para alcançar outra aba de uma
  planilha **nativa** é preciso a Sheets API — daí o escopo extra. Em xlsx
  enviado, a escolha da aba é feita pelo parser local.

## Organização do código

| Arquivo | Responsabilidade |
|---|---|
| `lib/googlesync.mjs` | **o quê e quando**: percorre o spec, consulta o manifesto, detecta renomeio, faz o prune |
| `lib/googlesync_sheet.mjs` | **como**, planilhas: Sheets API, `files.export` e o parser de xlsx |
| `lib/googlesync_text.mjs` | **como**, textos: `files.export` do Docs e `alt=media` dos enviados |
| `bin/runsync.mjs` | CLI: argumentos, `.env` e montagem do `auth` |

O módulo principal não sabe converter nada, e os de conversão não sabem o que
já foi baixado — é essa fronteira que mantém os dois legíveis.

## Testes

```bash
npm test
```

Cobrem o parser de xlsx contra um workbook que reproduz as armadilhas reais
(célula vazia auto-fechada, sharedStrings, prefixo de namespace, rels fora de
ordem, inteiro gravado como `15.0`) e a resolução de caminhos sob `rootDir`.

## Licença

MIT
