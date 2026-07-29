# Release — dois canais no mesmo repositório

O projeto publica em **dois canais isolados**, ambos em
[github.com/aronpc/ai-traffic-lights/releases](https://github.com/aronpc/ai-traffic-lights/releases):

| Canal | Versão | Release do GitHub | Quem recebe |
|---|---|---|---|
| **stable** | `X.Y.Z` | normal (vira o *Latest*) | todo mundo (default) |
| **beta** | `X.Y.Z-beta.N` | marcada como *pre-release* | só quem ligou o toggle nas Preferências |

Publicar no canal beta **não move o *Latest*** e é invisível para quem está no
estável. O script prova isso a cada execução (veja *Garantia de isolamento*).

## Comandos

```bash
npm run release:beta                  # publica X.Y.Z-beta.N (pre-release)
npm run release:beta -- --base 0.8.0  # força a base (default: patch+1 do package.json)
npm run release:beta -- --dry-run     # mostra o que faria, não publica

npm run release:promote              # promove a última beta pra estável
npm run release:promote -- --version 0.7.3
```

Flags extras: `--skip-tests` (pula o gate `npm test`), `--yes` (não pergunta
nada; é o padrão quando `CI` está setada).

Tudo vive em [`scripts/release.sh`](../scripts/release.sh). O workflow
[`.github/workflows/release.yml`](../.github/workflows/release.yml) roda **o mesmo
script** num runner (Actions → *Release* → *Run workflow*), então build local e
build no CI não podem divergir. O workflow é só manual, de propósito: o script
cria a release via `gh` (que cria a tag), e um gatilho por push de tag reagiria
à própria publicação, gerando release duplicada.

## Garantia de isolamento

Não há código novo no app para isso — o isolamento cai do comportamento do
GitHub somado ao do `electron-updater`:

1. O GitHub **omite pre-releases** de `/releases/latest`.
2. Todo build estável roda com `allowPrerelease = false`, e o `GitHubProvider`
   resolve a tag **exatamente** por `/releases/latest`
   (`getLatestTagName`, `electron-updater/out/providers/GitHubProvider.js`).
   Logo, um build estável nunca enxerga uma pre-release.
3. O `electron-updater` **liga `allowPrerelease` sozinho** quando a versão do
   app tem componente de pre-release (`hasPrereleaseComponents`, `AppUpdater.js`).
   Um build `-beta.N` passa a varrer o feed atom e aceita a entrada mais nova,
   beta ou estável (ver *Por que `beta` e não `dev`*).
4. O fallback GitHub-API do app (`src/ipc/update.js`, usado por instalações
   deb/npm/source) também consulta `/releases/latest` — protegido igualmente.

O build do canal beta é **idêntico** ao do estável; só a versão muda
(`-c.extraMetadata.version`, sem tocar no `package.json`). O `electron-builder`
grava `latest-linux.yml` nos dois casos, mas o do canal beta vive **dentro da tag
da pre-release** — e a URL do arquivo é
`/releases/download/<tag>/latest-linux.yml`, inalcançável para quem resolveu a
tag por `/releases/latest`.

Ao final de cada `release:beta` o script relê `/releases/latest` e **falha** se a
tag estável tiver mudado.

## Assets

- **beta:** `ai-traffic-lights-X.Y.Z-beta.N.AppImage` + `latest-linux.yml`.
  Sem `.deb`: o updater do deb é apenas informativo e resolve por
  `/releases/latest`, então uma instalação deb não consegue estar no canal beta.
- **estável:** AppImage + `.deb` + `latest-linux.yml` (os 3 assets de sempre).

## Ciclo completo

```
main/feature ──► release:beta ──► v0.7.3-beta.1 (pre-release)
                     │              testa; achou bug? corrige e roda de novo
                     ├──────────► v0.7.3-beta.2
                     └──────────► v0.7.3-beta.3   ← estabilizou
                                     │
        bump package.json p/ 0.7.3   │
        move [Unreleased] → [0.7.3]  │
        commit chore(release)        ▼
                              release:promote ──► v0.7.3 (Latest)
```

O `promote` **não inventa** as partes editoriais: ele recusa se o
`package.json` não estiver em `X.Y.Z` ou se o `CHANGELOG.md` não tiver a seção
`## [X.Y.Z]`, e diz exatamente o que falta. As notas da release estável saem
dessa seção do CHANGELOG, seguindo a convenção do projeto.

Promova sempre **do mesmo commit** que gerou a última beta testada — assim o
binário estável é código-idêntico ao que foi validado.

## Entrar e sair do canal beta

**Preferências → Atualizações → "Receber versões beta (teste)".** Desligado por
padrão. O build beta usa o **mesmo `appId` e `productName`** do estável, então
substitui a instalação existente e reaproveita a mesma configuração — o teste é
real, não um app paralelo com config em branco.

O toggle grava `updateChannel` (`'stable'` | `'beta'`) e o `main.js`
(`applyUpdateChannel`) traduz para as duas flags que o `electron-updater`
entende. A tradução é pura e testável: `updaterFlags` em `src/settings.js`.

| Toggle | `allowPrerelease` | `allowDowngrade` | Efeito |
|---|---|---|---|
| desligado | `false` | `false` | resolve por `/releases/latest` → só estável |
| ligado | `true` | `false` | pega a entrada mais nova do feed, beta inclusive |
| ligado → desligado | `false` | `true` ¹ | volta para a última estável |

¹ Só quando o app **em execução** é uma pre-release. Voltar de `0.7.4-beta.3`
para `0.7.3` é uma descida em semver; sem `allowDowngrade` o app ficaria preso
no canal beta para sempre. Num app já estável a flag fica desligada, onde só
faria mal.

A troca aplica **ao vivo**: o handler de `save-settings` detecta a mudança de
canal, reaplica as flags, invalida o cache e dispara uma checagem na hora.

### Por que `beta` e não `dev`

O nome do sufixo **não é decorativo**. O `GitHubProvider` trata `alpha` e `beta`
como canais nativos (lista fixa no código) e qualquer outro sufixo como
`isCustomChannel`, que ele **descarta** ao varrer o feed:

```js
const shouldFetchVersion = !currentChannel || ["alpha", "beta"].includes(currentChannel);
const isCustomChannel = hrefChannel !== null && !["alpha", "beta"].includes(String(hrefChannel));
```

Consequência prática para quem está numa pre-release:

| Versão instalada | Recebe estável mais nova? | Recebe próxima pre-release? |
|---|---|---|
| `0.7.4-beta.3` (nativo) | **sim** | sim |
| `0.7.4-dev.3` (custom) | **não** | sim |

Com `beta`, quem entrou no canal acompanha **o que for mais novo** — beta ou
estável. Com um sufixo custom ficaria preso só nas pre-releases, dependendo do
toggle para voltar. Por isso `beta`.

### Requisito de sequência

O toggle só existe a partir da **0.7.3**. Publicar builds beta antes disso não
faz mal a ninguém (continuam invisíveis para o estável), mas para *entrar* no
canal só haveria o download manual do AppImage da página da pre-release.

Corolário: **toda branch que for virar beta precisa conter o toggle**. Uma beta
cortada de uma branch anterior à 0.7.3 tiraria a aba Atualizações de quem a
instalasse, deixando a pessoa sem como sair do canal pela UI.
