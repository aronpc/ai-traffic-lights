# Catálogo de funcionalidades e roadmap

Este documento consolida o que o AI Traffic Lights faz, o que já está
implementado mas ainda não foi lançado e o que existe apenas como intenção.
Ele complementa a [arquitetura](ARCHITECTURE.md), que explica principalmente
como as camadas se relacionam.

**Recorte analisado:** branch `feat/sync-p2p`, commit `83f1252`, em 2026-07-17.
A última versão publicada no repositório é `v0.7.2`; por isso, código presente
nesta branch não é automaticamente uma funcionalidade lançada.

## Legenda de status

| Status | Significado |
|---|---|
| **Lançado** | Está na linha `main`/release `v0.7.2` ou anterior. |
| **Implementado na branch** | Tem código e testes em `feat/sync-p2p`, mas ainda não está em uma release. |
| **Parcial** | Existe parte do caminho, mas a experiência completa não está conectada ou não funciona em todas as plataformas declaradas. |
| **Previsto** | Está explicitamente no roadmap ou há uma fundação de código clara, sem fluxo completo. |

## Visão executiva

| Área | Situação |
|---|---|
| Semáforo por sessão, detecção local, alertas, tray, preferências, uso e launchers | **Lançado** |
| Linux X11/XWayland e macOS Apple Silicon | **Lançado**, com limites de foco e autostart descritos abaixo |
| Sync P2P entre máquinas, painel de transcript e agente headless | **Implementado na branch**, opt-in e ainda não lançado |
| Foco de aba no GNOME Terminal, zellij e tmux | **Previsto** |
| Foco completo de janelas Wayland nativas | **Previsto** |
| Gemini como integração de produto completa | **Parcial**: o hook entende o dialeto, mas registro, instalação e identidade não estão completos |

## 1. Agentes e fontes de dados

### 1.1 Suporte por agente

| Agente/fonte | Sessões e eventos | Uso/cota | Quick Launcher | Status real |
|---|---|---|---|---|
| Claude Code | Hook nativo; ciclo completo, permissões, notificações, erros, modelo e fim de sessão | API OAuth: 5h, 7d e uso extra; fallback local de plano | Sim | **Lançado** |
| Antigravity CLI | Hook com tradução de `PreInvocation`/`PostInvocation` e eventos de tool | Modelo ativo e detecção de cota esgotada em DB local | Sim (`agy`) | **Lançado** |
| Codex | Hook próprio no mesmo contrato, modelo no payload e sonda por `argv` | Rollout JSONL local: janelas primária e secundária | Sim | **Lançado** |
| OpenCode | Plugin in-process: chat, tools, perguntas, permissões, idle, erro e exclusão | Cota GLM quando o provider z.ai está no `auth.json` | Sim | **Lançado** |
| GLM/z.ai | Não é uma sessão/CLI registrada; aparece como backend de uso | API de quota: tokens 5h e MCP mensal, inclusive múltiplas contas | Não | **Lançado como medidor** |
| Gemini CLI | O shell hook traduz `BeforeAgent`, `BeforeTool`, `AfterTool` e `AfterAgent` | Sem coletor | Não | **Parcial, não deve ser anunciado como suporte completo** |

Evidências principais: [registro de agentes](../src/agents.js),
[instalador de hooks](../src/hook-installer.js),
[hook shell](../hooks/traffic-hook.sh),
[plugin OpenCode](../adapters/opencode/ai-traffic-lights.js) e
[coletores de uso](../src/usage.js).

### 1.2 Lacuna específica do Gemini

O `traffic-hook.sh` aceita `AI_TL_AGENT=gemini`, mas o fluxo do produto não o
completa:

- `src/hook-installer.js` não possui alvo Gemini;
- `src/agents.js` não registra `gemini` para identidade, ícone, sonda ou launcher;
- um state file com `agent: "gemini"` cai no agente default, Claude;
- o README público lista quatro agentes e não inclui Gemini, enquanto
  `docs/ARCHITECTURE.md` ainda o apresenta como suportado.

Até esses pontos serem conectados e testados, o código deve ser tratado como
fundação de adapter, não como integração disponível.

## 2. Contrato de sessão e coleta

### 2.1 State files

Adapters escrevem um arquivo por sessão em
`${XDG_DATA_HOME:-~/.local/share}/ai-traffic-lights/state/<session_id>.json`, no
`schema_version: 2`.

O contrato suporta:

- identidade (`agent`, `session_id`, `pid`, e `origin` quando remoto);
- contexto (`cwd`, `model`, `transcript_path`);
- foco (`term_program`, `windowid`, `focus_url`, `tilix_id`);
- multiplexadores (`zellij_session` e, nesta branch, `tmux_session`);
- último evento, timestamp, tool e `notification_type`;
- histórico rolante dos últimos 50 eventos.

Os writers validam `session_id` com `^[A-Za-z0-9._-]+$`, escrevem de forma
atômica (`tmp` + rename), preservam hints de foco ausentes no evento seguinte e
engolem erros para nunca derrubar o agente hospedeiro.

### 2.2 Descoberta de sessões

Há duas fontes que são combinadas:

1. state files observados com `chokidar`;
2. processos interativos ainda sem state file, detectados por `/proc` no Linux
   ou `ps` no macOS.

A sonda reconhece `comm` ou o basename do script no `argv` para CLIs Node e
exige que o pai seja um shell. O merge produz uma linha por processo/sessão e,
na branch P2P, usa `origin:pid||session_id` para impedir colisões entre máquinas.

Também existem:

- cache de quatro segundos para a descoberta de processos;
- varredura a cada cinco segundos;
- remoção de state files quando o PID morreu;
- remoção de temporários órfãos com mais de 60 segundos;
- recuperação de JSON corrompido pelo próximo evento;
- backfill de modelo a partir de transcript, quando disponível;
- migração de dados da antiga pasta `claude-traffic-light`.

Evidências: [coleta](../src/collect.js), [merge](../src/sessions.js) e
[I/O do processo principal](../main.js).

## 3. Máquina de estados

A cor é calculada no renderer, nunca pelo hook. Isso permite reavaliar a
escalada por tempo mesmo sem chegar um evento novo.

| Evento/condição | Estado | Motivo visual |
|---|---|---|
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | Amarelo, processando | 🛠 |
| `SessionStart`, `Stop` recente, `SessionEnd` | Verde, concluído | ✓ |
| `Stop` acima do threshold configurado | Vermelho, aguardando | ⏰ |
| `PermissionRequest` | Vermelho | 🔑 |
| `Question` | Vermelho | ❓ |
| `PostToolUseFailure` | Vermelho | ⚠ |
| `Notification` benigna (`auth_success`, `elicitation_complete`, `elicitation_response`) | Verde | ✓ |
| Outra `Notification`, inclusive tipo ausente/desconhecido | Vermelho | ❓ |
| Evento desconhecido que não seja `Notification` | Verde conservador | sem motivo |
| Vermelho marcado como lido até o evento atual | Cinza | 👁 |

O threshold default é cinco minutos, pode ser 1, 2, 5, 10 ou 15 minutos, ou
ser desativado. A ordem de urgência é vermelho, amarelo, verde e lido. Nesta
branch, linhas de mesmo nível usam ordem estável por origem e identidade, para
não pularem a cada tool call.

Evidência: [máquina de estados](../src/state-machine.js).

## 4. Overlay e interação por sessão

### 4.1 Conteúdo visual

O overlay mostra:

- uma linha por sessão com LED, motivo, marca do agente, nome, modelo, última
  tool/evento e tempo desde a atividade;
- LED agregado e contagem por cor no cabeçalho;
- pior estado no ícone do tray e contagens no tooltip;
- ordenação por urgência;
- onboarding para instalar hooks enquanto nenhuma sessão apareceu;
- empty state e Quick Launcher quando aplicável.

### 4.2 Ações por linha

- **Clique local:** marca vermelho como lido, quando habilitado, e foca o
  terminal após um debounce que não conflita com o duplo-clique.
- **Duplo-clique:** renomeia a sessão; Enter ou blur salvam, Escape cancela.
- **Snooze:** em uma linha vermelha, silencia som/notificação por uma hora sem
  alterar a cor.
- **Clique no subtítulo:** nesta branch abre as últimas mensagens do transcript.
- **Clique remoto:** nesta branch abre o transcript, pois IDs de janela não
  fazem sentido na máquina observadora.

Apelidos são persistidos por `session_id` (PID como fallback). As marcas de
“lido” e o snooze vivem apenas em memória e são perdidos ao reiniciar o app.
Rename é desabilitado para sessões remotas.

### 4.3 Janela

- transparente, frameless e always-on-top;
- fora da barra de tarefas/Alt-Tab quando o window manager respeita os hints;
- altura automática e largura ajustável entre limites seguros;
- posição e largura persistidas;
- posição salva é trazida de volta à tela após mudança de monitores;
- nunca maximiza;
- pode ser recolhida para cabeçalho + rodapé;
- lista normal ou compacta;
- opacidade entre 60% e 100%;
- estado recolhido, modo do rodapé, compactação e opacidade são persistidos;
- relançar o app alterna mostrar/ocultar em vez de abrir uma segunda instância.

Evidências: [renderer](../src/renderer.js), [HTML](../src/index.html),
[estilos](../src/styles.css) e [janela Electron](../main.js).

## 5. Foco de terminal

### Linux

- Valida `windowid` contra a árvore de processos antes de chamar `wmctrl`,
  evitando focar uma janela cujo ID foi reciclado.
- Se o ID salvo não é válido, tenta a primeira janela pertencente ao processo.
- Warp usa `warp://session/<uuid>` para selecionar a aba.
- Tilix usa D-Bus com `TILIX_ID` para selecionar o terminal.
- Hints ausentes no state file podem ser relidos de `/proc/<pid>/environ`.
- No Wayland nativo, o canal de aba é tentado antes do raise; sem canal e sem
  janela XWayland alcançável, o app avisa que não conseguiu focar.

### macOS

- Percorre processos ancestrais com `ps`;
- usa AppleScript/System Events para trazer o processo do terminal à frente;
- possui fallback por aplicação para Warp, iTerm, Terminal.app e Ghostty;
- depende de permissão de Acessibilidade.

### Limites atuais

Não há seleção da aba/pane exata no GNOME Terminal, zellij ou tmux. Também não
há uma solução genérica para ativar janelas Wayland nativas de terceiros.

Evidência: [decisão pura de foco](../src/focus.js) e [execução](../main.js).

## 6. Alertas e notificações

### Sessão em vermelho

- beep Web Audio e notificação nativa ao **transitar** para vermelho;
- não alerta no primeiro render para sessões que já estavam vermelhas;
- nesta branch, a primeira hidratação de um peer também não dispara uma rajada;
- rate limit de 30 segundos por sessão;
- snooze por sessão durante uma hora;
- opção de revelar o overlay oculto sem intenção de roubar foco;
- som pode ser desligado, ter volume ajustado e usar presets `beep`, `double`,
  `chime`, `low` ou arquivo customizado;
- arquivos customizados são copiados para a pasta de dados e só podem ser lidos
  dali pelo renderer.

### Reset de cota

- compara coletas consecutivas em vez de agendar um timer;
- só arma o aviso se o uso passou do threshold configurável (90% por default);
- notifica quando o relógio cruza o reset da janela anteriormente armada;
- evita duplicatas e falsos positivos quando uma API apenas estende `resetAt`;
- pode revelar o overlay oculto.

## 7. Medidores de uso

O rodapé alterna entre medidores e Quick Launcher. Cada limite tem provider,
plano, janela, percentual, barra, reset e informações extras. As cores são
verde abaixo de 70%, âmbar a partir de 70% e vermelha a partir de 90%.

| Fonte | Dados | Estratégia |
|---|---|---|
| Claude | 5h, 7d e crédito extra mensal | OAuth sob demanda; cache de 5 min; fallback de plano local |
| Codex | Janela primária e secundária, normalmente 5h e 7d | Leitura passiva do último `token_count` no rollout do projeto |
| GLM/z.ai | Tokens 5h e MCP mensal | API autenticada; credenciais de processos, ambiente e OpenCode; cache por token de 30 s |
| Antigravity | Modelo ativo; 100% + reset quando a DB recente prova `QUOTA_EXHAUSTED` | Leitura passiva de settings e DB local |

Comportamentos de resiliência:

- Claude só consulta a API no boot, ao revelar/expandir, ou no refresh manual;
- HTTP 429 respeita `Retry-After`, usa fallback de 15 min, backoff de 1,5× e
  teto de uma hora;
- o cooldown Claude é persistido sem armazenar o token;
- o botão de refresh não fura esse cooldown;
- a última leitura boa sobrevive a falhas e reinícios em `usage.json`;
- após quatro minutos sem atualização, a linha fica cinza; após vinte minutos,
  é removida;
- resumos sem percentual são suprimidos quando há uma janela concreta;
- contas GLM duplicadas por credenciais diferentes são deduplicadas por
  conteúdo, plano e reset normalizado.

## 8. Quick Launcher

Detecta executáveis no `PATH`, aceita override por agente em `settings.launchers`
e abre o agente no último diretório de projeto conhecido.

| Plataforma | Terminais |
|---|---|
| Linux | Tilix, GNOME Terminal, Ghostty e template customizado com `{cwd}`/`{cmd}` |
| macOS | Terminal.app, iTerm2, Warp e Ghostty |

O processo é detached; a nova sessão entra no overlay pelo fluxo normal de
hook/state file. Aliases de shell não são detectados automaticamente, pois o
Electron não roda no shell interativo.

## 9. Preferências, tray e idioma

### Preferências live-apply

As mudanças são aplicadas e salvas sem botão “Salvar”:

- threshold/escalada idle;
- atalho global;
- idioma automático, inglês ou português;
- marcar vermelho como lido ao clicar;
- opacidade;
- autostart;
- aviso de reset e seu threshold;
- revelar ao ficar vermelho, ao resetar cota ou ao encontrar update;
- som, volume, preset/arquivo e preview;
- terminal do Quick Launcher e template customizado;
- instalação/remoção de hooks;
- nesta branch, sync, token, nome do nó, porta, compartilhamento e peers.

Dropdowns são customizados, navegáveis por teclado e acompanham o idioma.

### Tray e atalhos

- mostrar/ocultar;
- autostart;
- submenu de launchers detectados;
- instalar/remover hooks;
- abrir preferências;
- checar atualização;
- sair;
- atalho default `Ctrl+Alt+H` e atalho legado de recuperação
  `CommandOrControl+Shift+Alt+L`.

**Limite de plataforma:** o autostart atual cria um arquivo `.desktop` em
`~/.config/autostart`, portanto o caminho está implementado para Linux. Não há
um `LaunchAgent`/login item equivalente no código para macOS, embora o controle
apareça na janela de Preferências.

## 10. Instalação de integrações

- `npm run setup-hook` e a UI usam a mesma lógica;
- cópia estável do hook em `~/.local/share/ai-traffic-lights/bin`;
- instalação idempotente e atualização de caminhos antigos;
- backup do JSON antes de escrever;
- JSON inválido aborta sem sobrescrever;
- remoção cirúrgica por marcador, sem apagar hooks de terceiros;
- plugin OpenCode copiado para `~/.config/opencode/plugin`;
- plugin já instalado é atualizado no boot;
- Codex requer confiança do hook via `/hooks` no CLI;
- `SessionEnd`/`session.deleted` removem o state file; crashes ficam para o
  reaper por PID.

## 11. Atualizações, empacotamento e instalação do app

- Linux: AppImage e `.deb`; o instalador `install.sh` suporta instalação,
  atualização e remoção em x86_64;
- macOS: `.dmg` e `.zip`, com instalador voltado a Apple Silicon;
- AppImage detecta release, baixa automaticamente, mostra progresso e instala
  ao reiniciar/clicar ou ao sair;
- `.deb`, fonte, npm e macOS usam checagem informativa via GitHub e abrem a
  release, sem substituição automática do binário;
- checagem no boot, a cada hora e sob demanda;
- checagem manual notifica “nova versão”, “em dia” ou erro;
- opção de revelar o overlay quando uma nova versão aparece;
- builds Linux usam XWayland e flags de compatibilidade com sandbox e `/dev/shm`.

## 12. Sync P2P multi-máquina — implementado, não lançado

Tudo desta seção existe na branch `feat/sync-p2p`, permanece desligado por
default e ainda não está na release `v0.7.2`.

### 12.1 Sessões remotas

- cada nó pode servir `GET /sessions` e/ou observar uma lista de peers;
- servidor binda no IP Tailscale `100.64.0.0/10` quando detectado, ou apenas em
  `127.0.0.1` como fallback;
- token Bearer é obrigatório e comparado em tempo constante;
- polling normal a cada cinco segundos;
- consulta local ao status do Tailscale a cada dez segundos para evitar fetch
  de peers offline;
- sem Tailscale disponível, usa backoff exponencial de rede até cinco minutos;
- sessões ganham `origin` e badge com o nome da máquina;
- identidade, alertas, snooze e marca de lido são namespaced por origem;
- campos locais de foco são removidos antes do envio;
- primeira conexão de um peer hidrata o estado sem alertar tudo que já estava
  vermelho;
- dentro do mesmo nível de urgência, a ordenação é estável por origem/sessão.

O payload de sessão ainda inclui metadados como `cwd`, `pid`, modelo,
`transcript_path` e histórico de eventos. Conteúdo de prompt só é servido pelo
endpoint separado e opt-in descrito abaixo.

### 12.2 Painel “ver prompt”

- carregamento sob demanda; transcripts nunca fazem parte do polling;
- local lê do disco; remoto chama `GET /transcript`;
- compartilhamento remoto de transcript tem toggle independente e exige que o
  compartilhamento do nó esteja ativo;
- limite solicitado entre 1 e 50 mensagens; a UI pede 20;
- lê no máximo os 2 MiB finais em chunks, sem carregar arquivos enormes;
- agrega blocos de streaming com o mesmo `message.id`;
- mostra apenas texto de `user` e `assistant`, ignorando thinking, tool use e
  tool result;
- trunca cada mensagem em 4.000 caracteres;
- usa `textContent`, evitando injeção de HTML vindo do prompt.

**Limite atual:** a descoberta usada pelo painel procura transcripts apenas em
`~/.claude/projects` e `~/.zclaude/projects`. Apesar do parser ser genérico para
JSONL no formato esperado, a UI ainda não resolve rollouts do Codex nem
transcripts do OpenCode/Antigravity.

### 12.3 Agente headless

`agent.js` reutiliza coleta, rede e transcript sem importar Electron. Ele pode
expor sessões de um servidor sem display, aceita settings do app ou overrides
`ATL_SYNC_*`, encerra limpo em SIGTERM/SIGINT e possui uma unit systemd de
exemplo em [scripts/atl-agent.service](../scripts/atl-agent.service).

### 12.4 Limites e riscos conhecidos do sync

- o transporte da aplicação é HTTP; a confidencialidade de rede depende da
  tailnet/Tailscale e o token continua sendo obrigatório;
- o token é armazenado em texto simples dentro de `settings.json`;
- peers precisam usar nomes de nó únicos; não há validação de colisão de
  `origin`;
- quando um peer fica offline, a última lista recebida não é removida nem
  marcada como stale pelo código atual;
- comentários e a unit systemd ainda descrevem `tailscale serve`/localhost,
  enquanto o código mais recente tenta bind direto no IP da tailnet;
- foco e rename remotos não existem; o clique abre transcript;
- não há descoberta automática de peers, handshake de versão/schema ou UI de
  estado online/offline.

Evidências: [rede](../src/net.js), [identidade](../src/identity.js),
[agente headless](../agent.js), [transcript](../src/transcript.js) e
[integração Electron](../main.js).

## 13. Funcionalidades previstas

### Roadmap explícito

1. **Foco de aba para terminais sem canal nativo**, especialmente GNOME
   Terminal, zellij e tmux.
2. **Foco completo de janela Wayland nativa**, além do fluxo atual via
   XWayland, Warp URI e relançar para alternar visibilidade.

### Fundações presentes, sem entrega completa

- **Attach remoto via tmux:** hook e plugin já capturam `tmux_session`, e os
  comentários citam attach remoto, mas não há botão, comando ou fluxo de
  confirmação que execute esse attach. É um indício técnico, não um compromisso
  formal de roadmap.
- **Gemini completo:** tradução de eventos já existe no hook, mas falta registro,
  instalação, identidade visual, launcher e testes de integração.
- **Publicação do sync P2P:** a implementação está avançada e testada nesta
  branch, porém falta integrar/revisar para release, atualizar docs públicas,
  alinhar a estratégia Tailscale e tratar a expiração de peers.

Não há evidência local suficiente para prometer suporte Windows, descoberta
automática de peers, sincronização por nuvem ou novos agentes além dos citados.
Branches experimentais isoladas também não são tratadas como roadmap sem uma
decisão documentada.

## 14. Persistência e dados locais

Todos os caminhos abaixo ficam em
`${XDG_DATA_HOME:-~/.local/share}/ai-traffic-lights/`, salvo o autostart Linux e
as configurações próprias dos agentes.

| Arquivo/pasta | Conteúdo |
|---|---|
| `state/*.json` | Estado e últimos 50 eventos por sessão |
| `settings.json` | Preferências, launchers e configuração/token de sync |
| `aliases.json` | Apelidos por sessão |
| `window.json` | Posição e largura do overlay |
| `settings-window.json` | Posição da janela de Preferências |
| `usage.json` | Último uso conhecido, para fallback/stale |
| `claude-cooldown.json` | Timestamp e contador do backoff 429; nunca o OAuth token |
| `sounds/alert.*` | Cópia do som customizado |
| `bin/traffic-hook.sh` | Cópia estável do hook instalado |

Credenciais Claude/GLM são lidas das fontes originais quando necessário e não
são copiadas para os state files nem para o cache de uso.

## 15. Qualidade e segurança cobertas pelo código

- renderer isolado com `contextIsolation: true` e `nodeIntegration: false`;
- URLs externas limitadas a HTTP/HTTPS;
- leitura de áudio limitada à pasta de sons do app;
- validação de session ID e escrita atômica nos adapters;
- validação e clamp de settings, porta, peers, volume, opacidade e threshold;
- token P2P obrigatório e comparação resistente a timing/length;
- I/O de adapters e coletores desenhado para falhar sem afetar o agente/UI;
- módulos puros para estado, merge, foco, settings, uso, rede e transcripts;
- suíte `node:test` cobrindo regras de estado, dedup, rename, uso, settings,
  foco, launcher, som, i18n, validação, rede, transcript e agente headless.

## 16. Divergências documentais encontradas

Estas divergências devem ser resolvidas antes de anunciar uma próxima release:

1. `docs/ARCHITECTURE.md` afirma suporte atual a Gemini, mas o fluxo do produto
   não instala nem registra Gemini.
2. Comentários de `src/net.js`, `main.js`, `agent.js` e a unit systemd alternam
   entre servidor localhost atrás de `tailscale serve` e bind direto no IP da
   tailnet; o código executado hoje prefere bind direto.
3. `src/transcript.js` menciona transcripts Codex, mas `fetch-transcript` usa
   `collect.findTranscript`, que só procura diretórios Claude/zclaude.
4. A seção `[Unreleased]` do changelog não descrevia a grande funcionalidade
   P2P já presente na branch.
5. A UI oferece autostart no macOS, mas o backend só implementa `.desktop`
   Linux.
