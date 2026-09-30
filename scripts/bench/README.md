# Benchmark A x B (curto)

> Antes de gastar quota, veja onde o uso REAL ja gravado esta indo (gratis, so leitura, so numeros):
> `node scripts/bench/onde-gasta.mjs <copia do dashboard.db> [--dias 30]` (pai x filho, provedor, crescimento por mensagem, tarefas que mais gastaram).

Tudo aqui roda no computador do usuario (logins e agentes dele). **Usa quota real**, exceto os relatorios. Rode so com autorizacao do usuario.

A pergunta mais importante vem primeiro: **delegar compensa?** (secao PF). As secoes seguintes comparam duas versoes do app (A x B).

## PF. So o pai x pai + filho (script, ~14 execucoes)

Alvo fixo (so leitura): `git worktree add ..\gpd-alvo 88c9eb5`. Depois, na pasta da branch: `npm ci` e
`node scripts/bench/pai-filho.mjs ..\gpd-alvo --rounds 2 [--out <pasta>]`

Uma conversa de 3 mensagens na MESMA sessao do pai (pergunta que exige ler varios arquivos + 2 continuacoes), rodada assim:
- **P**: delegacao desligada (o pai investiga sozinho);
- **D**: delegacao ligada; a 1a mensagem pede para delegar a investigacao a um filho Claude em leitura.

Rodadas alternadas P, D, P, D; pai e filho Claude Sonnet 5.5, esforco baixo, so leitura (o pai com Read/Grep/Glob: nada muda no alvo).
Sem Electron: CLI real + servidor MCP + logica de delegacao do app, bancos proprios, sem o estado de uma sessao anfitria do Claude Code.
A tabela soma pai + filhos de cada mensagem e a conversa inteira (entrada total e custo relativo estimado).

O que esperar: na 1a mensagem, D quase sempre gasta MAIS (o filho paga o proprio cabecalho). O ganho, se houver, aparece nas continuacoes
(o historico do pai fica so com a conclusao). Com n=2 so uma diferenca grande e confiavel; nao prometa porcentagem.
Qualidade (ficha, pelas respostas em `resultado.json`): cita `consent.ts` (`verifyForDelivery`) e `delegation.ts`; a 1a continuacao fala da
continuacao (`continuationOf`/sessao) com arquivo:linha; a 2a cita um teste real de `consent.test.ts` ou `delegation.test.ts`. Sem inventar.

## A x B: duas versoes do app

Compara a versao **A** com a **B** nas mesmas tarefas, com o mesmo modelo, esforco e conta. Escolha os dois commits que quer comparar
(ex.: A = `88c9eb5`, antes de toda a economia de tokens; B = a branch atual). Custo previsto: cerca de 20 execucoes curtas (Sonnet, esforco baixo).

| Etapa | O que mede | Execucoes |
|---|---|---|
| J. Jarvis | Jarvis enxuto x antigo | 6 chamadas curtas (script) |
| BENCH-1 | delegacao Claude em leitura (ferramentas sem duplicar) | 4 do pai + 4 filhos |
| BENCH-2 (opcional) | troca Codex -> Claude (resposta final no historico) | 4 Codex + 4 Claude |

Regras: rode as rodadas **alternando A, B, A, B**, com o mesmo intervalo entre elas (o cache de prompt dura minutos). Copie as mensagens **exatamente**. Nao desmarque itens nos pedidos de contexto (aprove tudo, nas duas versoes).

## 0. Preparacao (sem custo)

1. Duas pastas do app: `git worktree add ..\gpd-A <commit A>` e `git worktree add ..\gpd-B claude/adoring-wozniak-dfbvea`. Em cada uma: `npm ci` e `npm run build`.
2. Projeto-alvo fixo (so leitura nas tarefas): `git worktree add ..\gpd-alvo 88c9eb5`.
3. Duas copias do banco real (feche o app antes de copiar): `%APPDATA%\gaming-planning-dashboard\dashboard.db` -> `copiaA.db` e `copiaB.db`.
4. Abra cada versao isolada (dados temporarios, o banco real nunca e tocado):
   - em `gpd-A`: `npm run dev:sandbox -- --keep --seed <caminho>\copiaA.db`
   - em `gpd-B`: `npm run dev:sandbox -- --keep --seed <caminho>\copiaB.db`
   Anote a pasta de dados que cada uma imprime (`dados em ...`): o banco do relatorio e `<pasta>\dashboard.db`.
5. Nas duas: adicione o projeto `gpd-alvo`; delegacao ligada; mesma conta Claude.

## J. Jarvis (script, 6 chamadas)

Em `gpd-B`: `node scripts/bench/jarvis.mjs --rounds 3 --out jarvis.json`
Ele alterna o modo antigo (A) e o enxuto (B) com a mesma pergunta e um retrato sintetico, e imprime as respostas para voce comparar.
Se o modo enxuto falhar, anote: o app cairia sozinho no modo antigo, mas o ganho nao vale nesta versao da CLI.
(O texto das instrucoes do A e o atual; difere do antigo em uma frase. Os argumentos da CLI sao exatamente os antigos.)

## BENCH-1: delegacao em leitura (2 rodadas por versao)

Nova tarefa no `gpd-alvo`, pai **Claude Sonnet 5.5, esforco baixo**. Mensagem (exata):

```
BENCH-1: Use delegate_to_agent com provider claude, model claude-sonnet-5-5, effort low, mode read, sem context e sem memoryIds, com a ordem: "Em src/main/workspaceTools.ts, explique em ate 5 linhas como o readToken evita reenviar o mesmo trecho, citando arquivo:linha." Depois responda so com a conclusao do filho.
```

Qualidade: cita `src/main/workspaceTools.ts` e as linhas dos recibos (`issueReceipt`/`readFileRange`), sem inventar.

### BENCH-1 sem o app (so o filho, qualquer maquina com a CLI do Claude)

`node scripts/bench/delegation.mjs <pasta do gpd-alvo> --rounds 2` roda a mesma ordem pela logica de delegacao do app, com o servidor MCP e a CLI
real, mas sem Electron e sem pai: A imita as ferramentas antigas (Read,Grep,Glob + todas as MCP; recibos descartados), B usa as atuais.
Os dois usam o resto do codigo atual (descricoes curtas, sem instrucoes de git): o script isola so ferramentas e recibos. Faz 2 rodadas
por versao, alternadas, e uma continuacao do mesmo filho em cada versao (6 execucoes). Bancos proprios; imprime a tabela e salva `resultado.json`.

## BENCH-2 (opcional): troca de provedor (2 rodadas por versao)

Nova tarefa no `gpd-alvo`. 1a mensagem com **Codex** (modelo e esforco iguais nas duas versoes):

```
BENCH-2: Leia src/main/envelope.ts e explique passo a passo, com detalhes, o que extractConclusion faz.
```

Depois troque para **Claude Sonnet 5.5, esforco baixo** e envie (aprove o contexto inteiro):

```
Qual e o principal risco dessa funcao? Responda em 2 linhas.
```

Qualidade: a resposta do Claude fala de fato de `extractConclusion` (marcadores duplicados/ausentes, campos obrigatorios), coerente com o que o Codex explicou.

## Relatorio (sem custo)

```
node scripts/bench/report.mjs <pasta A>\dashboard.db <pasta B>\dashboard.db jarvis.json
```

So le os dois bancos (modo leitura) e imprime a tabela A x B, com media e faixa (min-max) de cada numero. **"dentro da variacao"** = as faixas se sobrepoem: sem diferenca mensuravel. "—" = o provedor nao informou (nunca vira 0).

Registre no `docs/roadmap.md`: a tabela, as versoes das CLIs (`claude --version`, `codex --version`), a ficha de qualidade abaixo e que foi medicao real.

| Rodada | Versao | Tarefa | Resolveu? | Observacao |
|---|---|---|---|---|
| 1 | A | J / BENCH-1 / BENCH-2 | sim/nao | |
