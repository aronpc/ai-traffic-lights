# Sincronização multi-máquina (beta)

> 🧪 **Feature beta.** A sincronização só aparece em builds do canal beta
> (`0.x.x-beta.N`). Em **Preferências → Atualizações**, ative *Receber versões
> beta* para recebê-la. Na versão estável a aba **Sincronização** não existe.

O sync P2P faz o seu overlay mostrar os semáforos dos agentes rodando em
**outras máquinas** da sua rede Tailscale como se fossem sessões locais. Cada
linha remota ganha um badge com o nome da máquina de origem.

**O que é sincronizado:** apenas o **estado** das sessões (cor, modelo, última
tool, timestamp) — **não** arquivos, configurações nem o terminal em si. Prompts
só cruzam a rede se você ativar explicitamente o compartilhamento de transcripts
(opt-in, veja abaixo).

## Como funciona

Cada nó é simétrico:

- **Servidor** (se você ativar *Compartilhar minhas sessões*): publica um
  endpoint `GET /sessions` com o seu estado, acessível pelos peers.
- **Cliente** (se você listar peers): faz poll de `/sessions` deles a cada 5 s e
  mescla no seu overlay, marcando a `origin` de cada linha.

O tráfego é **HTTP puro na porta do app**, bindado no IP da sua tailnet
(`100.x`) — não usa `tailscale serve`. A segurança vem do WireGuard E2E do
próprio Tailscale somado a um **Bearer token** compartilhado, comparado em tempo
constante. Sem token, nada sobe.

## Pré-requisitos

1. **Tailscale** instalado e conectado em **todas** as máquinas (`tailscale up`).
   Sem ele o servidor cai para `127.0.0.1` (só esta máquina) e os peers não se
   alcançam.
2. **Versão beta** do ATL em todas as máquinas (o sync não existe na estável).
3. O ATL rodando em cada máquina que vai participar.

## Tailscale — preparando a rede

O sync usa o **Tailscale** como transporte: ele cria uma rede privada
ponto-a-ponto entre as suas máquinas (IPs `100.x`) sobre WireGuard, sem abrir
portas no roteador nem expor nada à internet pública. Cada ATL binda o servidor
**direto** no IP da sua tailnet, na porta do app — por isso todas as máquinas
precisam estar na **mesma tailnet**.

> Não usa `tailscale serve`: aquele exporia HTTPS na `:443`, e a URL não casaria
> com a porta HTTP do ATL. A confiança vem do WireGuard E2E + o token do sync.

### Instalar

- **Linux** (script oficial, qualquer distro) ou o pacote da sua distribuição:
  ```bash
  curl -fsSL https://tailscale.com/install.sh | sh
  ```
- **macOS**: app em <https://tailscale.com/download/mac> ou
  `brew install --cask tailscale`.

### Conectar cada máquina

```bash
sudo tailscale up
```

Isso abre o navegador para autenticar. Na primeira máquina você cria/entra na
sua tailnet; nas demais, autorize cada uma no admin console do Tailscale.
Repita em **todas** as máquinas que vão participar do sync.

### Descobrir o IP/nome de cada peer

- `tailscale ip -4` → o IP `100.x` **desta** máquina (é o `host` que o outro lado
  vai listar em *Máquinas que eu observo*).
- `tailscale status` → tabela com todos os peers, seus IPs, nomes e quem está
  online (é exatamente isto que o poller do ATL consulta para só tentar rede em
  quem está alcançável).

Se o **MagicDNS** estiver ligado no admin console do Tailscale, você pode usar o
**hostname** da máquina em vez do IP (ex.: `notebook`) — mais fácil de ler e não
muda se o IP variar.

### Observações

- **ACLs:** por padrão o Tailscale permite todo o tráfego entre máquinas da
  mesma tailnet. Se a sua tem regras de firewall (Access Controls), garanta que
  a porta do sync (`47474` por padrão) está liberada entre os nós.
- **Sem Tailscale:** se o binário `tailscale` não for encontrado, o ATL degrada
  o servidor para `127.0.0.1` (só esta máquina enxerga) e os peers não se
  alcançam — instale o Tailscale para sincronizar entre máquinas.

## Configurando (Preferências → Sincronização)

Os campos vivem em `~/.local/share/ai-traffic-lights/settings.json`
(sub-objeto `sync`) e aplicam ao vivo. **Tudo começa desligado por padrão.**

| Campo | O que faz |
|---|---|
| **Ativar sincronização** | Chave-mestra. Liga cliente e servidor. Sem ela, nada acontece. |
| **Token compartilhado** | Senha única, **idêntica em todas as máquinas**. Obrigatória. |
| **Nome desta máquina** | Rótulo que aparece no badge das suas sessões nos peers. Default: hostname. |
| **Porta** | `47474` por convenção — **a mesma em todos os nós**. |
| **Compartilhar minhas sessões** | Liga o servidor (`/sessions`). Precisa estar on para os peers te verem. |
| **Permitir ver meus prompts** | (Opcional) Libera `GET /transcript` — só ative se confiar nos peers. Exige *Compartilhar*. |
| **Permitir attach remoto** | (Opcional) Libera `/pty` — abre um shell/attach no seu terminal a partir de outra máquina (= exec remoto). Exige *Compartilhar*. |
| **Máquinas que eu observo** | Um por linha: `host` ou `nome host`. O `host` é o IP ou nome Tailscale do peer (ex.: `100.64.0.2` ou `notebook`). |

### Receita mínima (A e B se observando)

Em **ambas** as máquinas, com o mesmo token e a porta `47474`:

1. Ative **Ativar sincronização** e **Compartilhar minhas sessões** (assim cada
   um serve seu próprio estado).
2. Em A, liste B em *Máquinas que eu observo*; em B, liste A.
3. Pronto — em ~5 s as sessões do outro lado aparecem com o badge do nó.

> ⚠️ O `host` precisa casar com o que o Tailscale reporta: IPv4, IPv6, hostname
> curto, MagicDNS FQDN ou `host:porta` funcionam. Se o peer estiver offline — ou
> se `tailscale status --json` falhar — o ATL falha fechado: não envia o token,
> não busca transcripts e não abre PTY até a identidade voltar a ser confirmada.

## Segurança

- **Token** obrigatório e comparado em tempo constante (hash SHA-256 dos dois
  lados) — não vaza nem o tamanho. Token vazio = tudo recusado.
- O token fica em **texto plano** no `settings.json`. Use uma rede confiável
  (Tailscale) e não reutilize senhas importantes.
- A confidencialidade em trânsito depende da tailnet (WireGuard E2E); o HTTP do
  app não é criptografado por si só.
- **Ver prompts** e **attach remoto** são permissões adicionais e vêm desligadas.
- Antes de enviar o Bearer token, o cliente valida o host e confirma que IPv4,
  IPv6 ou nome consta como peer online no status da tailnet. Falha de status não
  degrada para rede comum: poll, transcript e PTY permanecem bloqueados.

## Servidor sem display (headless)

Uma máquina sem interface (servidor de CI, NAS) pode participar só servindo
sessões via `agent.js`, sem Electron:

- Usa as settings do app ou overrides `ATL_SYNC_*`.
- Encerra limpo em `SIGTERM`/`SIGINT`.
- Há uma unit systemd de exemplo em `scripts/atl-agent.service`.

## Solução de problemas

- **O peer não aparece / a lista está vazia**
  - Mesmo **token** e mesma **porta** (`47474`) nos dois lados?
  - **Compartilhar minhas sessões** ativo no peer? (Sem isso, o servidor dele
    nem sobe.)
  - O peer está **online no Tailscale** (`tailscale status`)? O poller só tenta
    rede em quem o Tailscale diz online.
  - O `host` que você digitou casa com o nome/IP que o Tailscale reporta?
- **A aba Sincronização não existe nas Preferências** — você está numa build
  **estável**. Ative o canal beta em *Preferências → Atualizações*.
- **Clique numa sessão remota** — abre o painel de transcript (se liberado),
  nunca foca um terminal que não é desta máquina.

## Limites atuais

- Sem **descoberta automática** de peers — a lista é informada manualmente.
- Sem handshake de versão/schema entre nós de versões muito diferentes.
- Peers precisam de nomes de nó únicos (sem validação de colisão de `origin`).
- O sync é **beta**: interface, protocolo e caminhos podem mudar antes do
  lançamento estável.

Veja também: [Catálogo de funcionalidades](FUNCIONALIDADES.md) (seção 12) e
[Arquitetura](ARCHITECTURE.md). _(em inglês)_
