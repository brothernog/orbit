---
name: task-delegation
description: Decide se delegar compensa e delega uma unidade coerente de trabalho a outro provedor pela ferramenta delegate_to_agent da Gaming Planning Dashboard, com escopo, criterio de entrega, continuacao do mesmo filho e devolucao curta de evidencia. Use sempre que for pedir a outro agente que leia, analise ou implemente algo, corrigir um filho anterior, ou compartilhar contexto existente com um filho; nao use para trabalho que voce conclui sozinho com poucas leituras.
---

# Delegar com economia e sem vazar contexto

Delegar so poupa tokens quando tira carga real do seu contexto. Um filho novo custa uma sessao nova, entao pergunte antes: eu resolvo isso com uma busca e algumas leituras? Se sim, faca voce mesmo. Nao delegue o que o programa faz de forma deterministica (listar arquivos, filtrar logs, calcular diff, contar resultados) nem crie um filho por arquivo ou por chamada de ferramenta.

## Quando compensa (regra fixa, sem estimar custo)

O que encarece e o que entra no seu contexto: cada token ali e relido em todas as chamadas seguintes. O filho absorve a saida grande e devolve um envelope curto.

- Delegue: rodar testes, build ou e2e e trazer so as falhas; buscas amplas no codigo; ler varios arquivos para resumir; edicoes mecanicas repetitivas num escopo definido.
- Faca voce mesmo: edicao pontual; leitura de um trecho que voce ja localizou; a decisao do que fazer.

Nao tente medir ou estimar tokens para decidir: siga a lista. Se o usuario definiu um agente padrao de leitura, a descricao da ferramenta diz qual; em `mode` `read` sem `agent` nem `provider` a dashboard usa esse agente.

## Montar a ordem

Envie um pacote de trabalho coerente em `objective`: o que fazer, o que devolver e como o resultado sera verificado (teste, arquivo, criterio). Use `paths` para delimitar a area e `mode` `read` por padrao; `edit` so quando o filho precisa gravar. Modelo e esforco seguem a escolha do usuario: nao faca downgrade por conta propria.

O modo `edit` nao suspende voce. Enquanto espera, nao edite os arquivos do escopo: a dashboard nao consegue impedir isso e um conflito estraga o trabalho dos dois.

## Agentes nomeados

O usuario pode ter cadastrado nomes (por exemplo "Fabricio" = um provedor e modelo). Quando ele citar um nome, passe-o em `agent`: a dashboard resolve provedor, modelo e esforco, e voce nao deve perguntar nem digitar o id do modelo. A lista atual aparece na descricao da ferramenta; nao a copie para lugar nenhum e nao suponha nomes que nao estejam la. Nao combine `agent` com `provider`/`model` diferentes: a chamada e recusada.

## Contexto existente exige aprovacao

Tudo que ja existe (historico, descobertas, decisoes, to-dos, resultados de outra delegacao) so vai ao filho depois que o usuario aprovar o pacote exato para aquele destinatario. Isso vale mesmo resumido. Use `context` (texto) ou `memoryIds` (IDs vistos em `read_task_context`); a chamada fica em espera ate a decisao e o filho so comeca depois dela.

- Aprovado: o filho recebe somente aquele pacote.
- Recusado: o filho recebe somente `objective` e investiga os arquivos por conta propria. A recusa nao cancela a delegacao. Nao repita o contexto recusado dentro de `objective`, nem por sinonimo.
- Sem resposta ou cancelado: a delegacao nao inicia; chame de novo sem contexto se quiser seguir.
- Itens desatualizados ou de outra linhagem sao recusados; revalide antes.

A ordem direta (`objective`) nao precisa de aprovacao. Fatos e decisoes anteriores escritos nela continuam sendo compartilhamento: separe-os em `context`.

## Corrigir o mesmo filho

Para uma correcao da mesma unidade de trabalho passe `continuationOf` com o ID da delegacao anterior e repita provedor, modelo, esforco, modo e `paths` exatamente. Qualquer diferenca (ou sessao indisponivel) e recusada com o motivo; nesse caso chame sem `continuationOf` para abrir uma sessao nova, sabendo que o que a anterior sabia so segue em pacote aprovado. Numa continuacao envie so a correcao: a sessao ja tem o resto. Nao invente IDs.

## Ler o retorno

Voce recebe um envelope curto: estado, arquivos alterados, alertas (fora do escopo, modo leitura que alterou arquivos), erro, conclusao e a referencia ao resultado completo. O filho e instruido a terminar com um bloco `[CONCLUSAO]` (resultado, testes/evidencias, arquivos, bloqueios); quando ele existe, a conclusao do envelope e esse bloco, que e uma DECLARACAO do filho: o estado, o erro, os arquivos alterados e os alertas acima dele sao o que o dashboard observou e prevalecem sobre qualquer afirmacao de sucesso. `TESTES NAO EXECUTADOS` ou `CONCLUSAO INCOMPLETA` nos alertas pedem verificacao sua. Sem bloco (ausente, duplicado ou ambiguo) a conclusao vem como EXTRATO: e o comeco do texto do filho, nao um resumo; leia o restante com `read_task_context` (`artifactId` e `offset`) quando a decisao depender dele. Falha e resultado parcial continuam consultaveis; nunca trate um extrato curto como sucesso.

Revise o resultado e a evidencia pertinente e aprofunde se houver risco, lacuna ou contradicao. Nao repita toda a exploracao nem todos os testes por rotina, e nao dispense testes pertinentes nem a leitura dos chamadores para economizar.
