---
name: godot
description: Fluxo economico para projetos Godot 4 no Orbit (godot_project, godot_scene, godot_diagnostics): entender o projeto sem ler cenas inteiras, editar .tscn/.gd com seguranca e verificar pelo log nativo. Use em qualquer tarefa numa pasta com project.godot quando o organizador tem Godot ativo.
---

# Godot: perguntar antes de ler

As ferramentas `godot_*` leem os arquivos da pasta localmente, sem executar a engine e sem chamada de IA. Cada resposta e um indice curto, paginado (`offset` + `hash`), e diz o que NAO foi resolvido. Use-as antes de abrir arquivos inteiros: uma cena .tscn media custa milhares de tokens; o indice dela custa algumas centenas.

## Ordem recomendada

1. `godot_project` uma vez por tarefa: versao declarada, cena principal, autoloads e presets de exportacao. Nao repita se nada mudou.
2. `godot_scene` com `path` para o indice da cena: nos, tipos, scripts, instancias, conexoes e referencias. Desca so o necessario:
   - `node` = subarvore (`.` = raiz, `Player/Sprite` = caminho);
   - `resource` = sub_resource por ID ou `main` em .tres;
   - `node`/`resource` + `property` = valor bruto daquela propriedade, paginado.
3. `godot_diagnostics` com o log nativo (arquivo `.log` gerado com `--log-file`): erros agrupados com repeticoes; `detail` = um item completo; `raw` = log paginado.
4. So entao abra trechos com a leitura por intervalo, na linha que o indice apontou.

## Editar com seguranca

- Prefira mudar scripts `.gd` e recursos `.tres` pequenos; em `.tscn`, edite so a secao/propriedade apontada pelo indice e preserve `id`, `uid`, `load_steps` e a ordem das secoes.
- Nao edite `.godot/`, `.import/` nem `export_credentials.cfg`; eles sao cache ou segredo e as ferramentas os recusam.
- Heranca, instancias e valores padrao da engine nao aparecem no arquivo: se a propriedade nao esta declarada, ela vem de la. Nao invente o valor.
- Ao mover/renomear uma cena ou script, procure as referencias `res://` antes (busca textual) e atualize-as no mesmo passo.

## Verificar

- Compilar/analisar um script: `godot --headless --path . --check-only --script res://caminho.gd` (o painel "Godot local" do Orbit prepara esse comando para revisao humana).
- Rodar com log: `--log-file logs/x.log` e depois `godot_diagnostics path=logs/x.log`. Ausencia de erro reconhecido nao prova que o jogo funciona; exit 0 tambem nao.
- Registre o que verificou com `test_evidence` quando disponivel.

## O que as ferramentas nao fazem

Nao executam o Godot, nao resolvem UID sem caminho, nao leem cenas binarias (.scn/.res) nem `user://`, e nao consultam o historico de comandos do dashboard.
