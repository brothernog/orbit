---
name: unity
description: Fluxo economico para projetos Unity com as ferramentas unity_project, unity_asset, unity_refs e unity_diagnostics da Gaming Planning Dashboard: entender cenas, prefabs e ScriptableObjects sem ler YAML inteiro, checar GUIDs antes de mover ou apagar assets e verificar compilacao e testes pelo log. Use sempre que a pasta tiver ProjectSettings/ProjectVersion.txt e Assets/, ou a tarefa citar Unity, cena .unity, prefab, .meta ou Editor.log.
---

# Unity: consultar estrutura, nao ler YAML

Cenas, prefabs e assets Unity sao YAML verboso: ler o arquivo inteiro gasta milhares de tokens e ainda esconde a estrutura. As ferramentas unity_* fazem o parse localmente (sem IA e sem abrir a engine) e devolvem texto compacto, paginado e com o proximo seletor sugerido. Leia o arquivo bruto so quando a ferramenta disser que algo nao foi interpretado.

## Ordem de consulta

1. `unity_project` uma vez por tarefa: versao do editor, pacotes, render pipeline, input, cenas do build, asmdefs (quais sao de teste), tags/layers e modo de serializacao. Se a serializacao nao for Force Text, avise o usuario: assets binarios nao sao legiveis.
2. `unity_asset path=<cena|prefab|asset>`: hierarquia com `&fileID`, componentes e scripts resolvidos para o `.cs`. Cenas grandes vem com profundidade limitada e `(+N abaixo)`.
3. Aprofunde so o necessario:
   - `object=Pai/Filho` ou `object=&fileID`: subarvore com componentes e nomes de campos; em instancia de prefab, os overrides agrupados pelo componente alvo na origem (`Player · PlayerController: groundMask.m_Bits=0 (Nothing)`).
   - `component=Tipo|&fileID` (+ `object` quando for por tipo) e `property=campo` (aceita `a.b`): valor YAML bruto e exato, com legenda de GUIDs, fileIDs e LayerMask.
   - `find=texto`: acha GameObjects por nome ou tipo de componente sem listar tudo.
   - `.controller`: o padrao ja resume parametros, estados e transicoes com condicoes; `⚠` marca condicao com parametro inexistente. Compare os nomes com `SetTrigger/SetBool/SetFloat` do codigo.
4. Continue paginas com `offset` + `hash` da resposta anterior; hash diferente significa que a fonte mudou: recomece.

Campo ausente no YAML nao e erro: o valor vem do default do script ou da prefab de origem. Override da cena vence o valor da prefab: comportamento diferente so numa cena costuma estar em `object=<instancia>`. O conteudo interno de prefabs instanciadas nao e expandido: abra a prefab de origem com `unity_asset`.

## Editar com seguranca

- Prefira editar C# e ScriptableObjects (.asset simples) a editar YAML de cena/prefab a mao. Mudancas estruturais (adicionar componentes, reparentar, instanciar prefab) sao mais seguras por script de Editor ou pelo proprio editor.
- Se precisar editar YAML, altere so o valor do campo lido por `property`, preservando indentacao, `fileID` e `guid`. Nunca invente ou reescreva GUIDs e fileIDs.
- Nunca apague nem recrie `.meta`. Ao mover ou renomear um asset, mova junto o `.meta` (mesmo nome + `.meta`); o GUID precisa continuar o mesmo. Asset novo sem `.meta` e normal ate o editor importar: nao crie `.meta` manualmente.
- Antes de renomear, mover ou apagar asset ou script: `unity_refs path=<asset> usages=true`. Ela lista arquivos, campos e instancias que citam o GUID e literais C# com o nome do asset (Resources.Load, Addressables, tags). Mover/renomear junto com o `.meta` mantem esses usos; os literais de nome/caminho e pastas `Resources/` precisam ser atualizados a mao. Zero usos nao prova seguranca: strings montadas em codigo e pacotes em Library/PackageCache nao sao verificados.
- Renomear classe MonoBehaviour exige renomear o arquivo `.cs` igual (mesmo `.meta`), senao cenas ficam com "script ausente". `unity_asset` marca `MonoBehaviour(script ausente)`.
- `unity_refs guid=<guid>` traduz GUID de um diff ou erro em caminho; `path=` sem usages mostra o GUID e o que o asset referencia.

## Verificar

Sem abrir o editor, rode em batchmode com log dentro do projeto (Logs/, Library/ e Temp/ nao sao legiveis por estas ferramentas):

- Compilacao/testes EditMode: `<unity> -batchmode -nographics -projectPath . -runTests -testPlatform EditMode -testResults Builds/test-results.xml -logFile Builds/unity-tests.log` (PlayMode: `-testPlatform PlayMode`). Nao use `-quit` junto com `-runTests`.
- Depois: `unity_diagnostics path=Builds/test-results.xml` (totais e falhas com arquivo:linha, erros primeiro) e `unity_diagnostics path=Builds/unity-tests.log` (erros CS, excecoes, avisos nativos como parametro de Animator inexistente e script ausente, pacotes, licenca, build). `detail=<indice>` traz mensagem e pilha; para contexto em volta de `L<linha>` leia so esse intervalo do log em vez de paginar `raw=true`.
- Corrija erros de compilacao primeiro: com `Scripts have compiler errors` os testes nao rodam e um XML existente pode ser de uma execucao anterior.
- "0 testes executados" costuma ser filtro, plataforma errada ou asmdef de teste sem `UNITY_INCLUDE_TESTS`/referencia ao TestRunner.
- Ausencia de diagnostico reconhecido nao prova sucesso: confira o codigo de saida do processo e o XML.
- Editor aberto no mesmo projeto bloqueia o batchmode; peca ao usuario para fechar ou use um worktree (sem Library/, o primeiro import pode levar muitos minutos).

## O que as ferramentas nao fazem

Nao executam a engine, nao leem assets binarios, Library, Temp, Logs, UserSettings nem keystores, nao expandem prefabs aninhadas/variantes nem aplicam defaults de script, nao resolvem GUIDs de pacotes do cache (exceto componentes comuns de UI/TMP/URP/Input System, marcados como pacote) e nao consultam historico de outras execucoes. Cite o que nao foi resolvido em vez de supor.
