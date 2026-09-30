# Teste de economia: desktop x Orbit x Orbit pai + filho

Mede a mesma conversa em tres lugares. **Usa quota real** (3 conversas, ~5 min cada). So com autorizacao do usuario.

| Teste | Onde | Pai | Filho |
|---|---|---|---|
| 1. Desktop | Claude desktop, aba Code, sessao nova | Sonnet 5.5, esforco alto | nenhum (ele pode usar subagentes proprios: contam) |
| 2. App | Orbit (sandbox), delegacao DESLIGADA | Sonnet 5.5, esforco alto | nenhum |
| 3. App pai + filho | Orbit (sandbox), delegacao LIGADA | Sonnet 5.5, esforco alto | Luna (codex / gpt-6-luna), leitura |

Por que esta tarefa: briefing de codigo = ler muitos arquivos para responder pouco. Sozinho, o pai carrega tudo o que leu em
toda mensagem seguinte; com o filho, o historico do pai guarda so a conclusao. Por isso sao 3 mensagens: o ganho aparece nas continuacoes.

## Preparacao (sem custo)

1. Alvo fixo, so leitura: `git worktree add ..\gpd-alvo 88c9eb5` (pasta ja criada se existir).
2. `npm run build && npm run dev:sandbox -- --keep` e anote a pasta de dados impressa (`dados em ...`). Adicione o projeto `gpd-alvo`.
3. Entre um teste e outro espere 10 min (cache de prompt quente favoreceria o segundo). Mesma conta Claude em tudo.
4. Nao mude modelo nem esforco no meio. Se algum teste falhar, anote e repita o teste inteiro.

## Mensagens (copie exatamente; mande a seguinte so quando a anterior terminar)

Mensagem 1 (testes 1 e 2):

```
BRIEFING: sou dev novo neste projeto e nao vou ler o codigo. Leia o que precisar em src/main e me explique o caminho completo de uma mensagem do usuario: do envio no renderer ate a resposta gravada, incluindo quando o pai delega a um filho e quando o usuario precisa aprovar contexto. De 8 a 12 passos com arquivo:linha e os 3 pontos de maior risco. No maximo 20 linhas. Nao edite nada.
```

Mensagem 1 (teste 3): a mesma, com esta frase no fim:

```
Faca a leitura e a investigacao com delegate_to_agent (provider codex, model gpt-6-luna, effort medium, mode read) e responda com base no retorno.
```

Mensagem 2 (todos):

```
Dos 3 riscos, qual e o mais grave? Mostre o trecho exato que o causa e o que aconteceria se ele quebrasse. No maximo 6 linhas, com arquivo:linha.
```

Mensagem 3 (todos):

```
Qual teste automatizado protege esse ponto? Cite o arquivo e o nome do teste; se nenhum cobre, diga. No maximo 3 linhas.
```

## Medicao (sem custo)

- Teste 1: exportar a sessao (menu da sessao > Export, ou pedir ao Claude "exporte a sessao X"), extrair o zip e
  `node scripts/bench/custo-usd.mjs --desktop <pasta extraida>`
- Testes 2 e 3: `node scripts/bench/custo-usd.mjs --db <pasta de dados>\dashboard.db` lista as tarefas; depois `--task <id>` de cada uma.

Cada comando imprime tokens por modelo (entrada nova, cache gravado, cache lido, saida) e o total em US$.

## Leitura honesta dos numeros

- US$ = ESTIMATIVA pelo preco publico da API (tabela em `custo-usd.mjs`). A assinatura cobra quota, nao token: o valor serve para comparar.
- n=1 por teste: e um indicio, nao media. Diferenca pequena (menos de ~15%) pode ser variacao; para afirmar no video, repita os 3.
- Desktop x app compara harnesses diferentes (o desktop carrega plugins, skills e instrucoes do usuario). E o uso real, mas diga isso.
- Qualidade conta: as tres respostas precisam citar arquivos e linhas que existem. Resposta errada invalida a economia.
- Registre no `docs/roadmap.md`: tabela, `claude --version`, `codex --version`, e que foi medicao real.
