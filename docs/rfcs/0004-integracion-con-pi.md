# RFC 0004: Integración con Pi y agente principal

- Estado: aceptado para el primer prototipo
- Fecha: 2026-09-22
- Depende de: [RFC 0001](0001-producto-y-workflow.md), [RFC 0002](0002-configuracion-multimodelo.md) y [RFC 0003](0003-observabilidad-y-metricas.md)
- Relacionado con: [RFC 0005](0005-arquitectura-modular.md)
- Implementación actual: [arquitectura del adaptador Pi](../../adapters/pi/docs/architecture.md)

## Resumen

xper se ejecutará dentro de Pi como el agente principal de la sesión. Para el
primer prototipo utilizará
[`pi-open-agents`](https://pi.dev/packages/pi-open-agents) como capa de agentes
primarios y subagentes. xper aportará encima la máquina de estados XP, los
contratos entre fases, el routing multimodelo, los artefactos y la
observabilidad.

> **Resultado de XP-001:** el spike recomendó usar `pi-open-agents` para
> discovery y activación primaria, y construir un executor propio para las
> delegaciones durables. La decisión explícita para `0.0.1` que sigue acepta
> probar también su tool `subagent`, conservando los límites descubiertos en el
> [informe del spike](../spikes/001-integracion-pi.md).

Esta decisión sustituye la hipótesis inicial de un proceso `xper run` que
controlaba Pi desde fuera. El CLI de xper queda reservado para inicialización,
configuración, diagnóstico, consulta y exportación.

## Decisión para el prototipo 0.0.1 (2026-09-24)

Se mantiene `pi-open-agents@0.1.22` para descubrir y activar el agente
principal. En `0.0.1` también se permitirá usar su tool `subagent` como
ejecutor provisional, para aprender de sesiones reales antes de sustituirlo o
mantenerlo. No se importará su API interna desde la extensión de xper.

Esta decisión acepta dos defectos observados en XP-001: un fallo de un hijo
puede llegar con `event.isError: false`, y una cancelación temprana puede
parecer un final correcto. Por eso `status: done` se registra como **resultado
reportado**, no como éxito verificado. Estos eventos no bastan para aprobar un
gate, cerrar un attempt durable ni inferir una cancelación. El executor propio
propuesto por el spike queda pospuesto hasta disponer de evidencia de uso; el
core sigue independiente del plugin.

El adaptador cuenta por sesión inicios, finales reportados, errores reportados,
discrepancias entre `isError` y `details.isError`, finales sin inicio y
operaciones aún abiertas. `/xper status` muestra estos contadores. Si se define
`XPER_PI_OBSERVATIONS_FILE`, Winston escribe JSONL local con rotación por tamaño
(5 MiB por archivo, cinco archivos en total). Incluye marcas de tiempo, IDs de
correlación, estado reportado, código de salida y señal cuando estén
disponibles. También registra la activación de la sesión y las invocaciones de
`/xper`, sin guardar los argumentos. No registra el task, el prompt ni la salida
del subagente. El archivo es optativo; los contadores funcionan sin él. Si falla
la escritura, la extensión avisa y mantiene esos contadores en memoria.
El campo `testedOpenAgentsVersion` identifica la versión del probe, no
certifica la versión instalada; esa comprobación efectiva pertenece a `doctor`.

En ese prototipo el manifiesto declaraba `subagents: false`: aún no existía
una operación del protocolo con la que xper pudiera crear y controlar un
attempt. La tool de Pi se observaba, pero no era capacidad durable de xper.

Se revisará la decisión antes de usar delegaciones para transiciones
automáticas, al observar discrepancias nuevas o finales sin pareja, y antes de
cambiar las versiones fijadas de Pi o `pi-open-agents`. La tupla probada sigue
siendo Pi `0.85.1` + `pi-open-agents 0.1.22`; falta ejecutar el probe en Windows.

## Revisión para XP-008 (2026-09-26)

Para la primera vertical slice se activa la capacidad `subagents` del bridge.
La tool propia `xper_delegate` crea un assignment `discovery.explorer` y un
Attempt durable, resuelve el rol en el adaptador y ejecuta un Pi hijo por RPC.
Su resultado explícito (`succeeded`, `failed`, `cancelled` o `timed_out`)
determina el estado del Attempt. La tool `subagent` de `pi-open-agents` sigue
disponible para exploración no gobernada por el workflow y sus señales no
pueden aprobar el gate de Discovery. Los comandos, artefactos, gates y eventos
de esta revisión se describen en [XP-008](../tasks/008-vertical-slice.md).

## Decisión

La experiencia principal será:

```text
usuario
   |
   v
sesión de Pi con xper como primary agent
   |
   +-- extensión xper: workflow, gates, estado y métricas
   |
   +-- pi-open-agents: discovery, definiciones y agente primary
   |
   +-- pi-open-agents subagent: ejecución provisional en 0.0.1
   +-- executor xper: Discovery con attempts durables y cancelación explícita
           |
           +-- discovery / define / design / plan
           +-- driver / navigator / verifier
           +-- judgment-day
```

Después de inicializar el proyecto, la sesión se inicia con:

```bash
pi --agent xper
```

En una sesión existente se puede activar con:

```text
/agent xper
```

El coordinador de xper es, por tanto, el agente principal de Pi. Los agentes
especializados son subagentes efímeros materializados cuando una fase o
assignment lo requiere.

## Responsabilidades

### Pi

- Proporcionar la sesión, TUI, proveedores, modelos, credenciales y
  herramientas base.
- Ejecutar los ciclos de agente y exponer eventos de runtime.
- Mantener la experiencia interactiva y la persistencia de conversación.

### pi-open-agents

- Descubrir definiciones globales y de proyecto.
- Activar `xper` como agente `primary`.
- Aplicar modelo, nivel de razonamiento, prompt, herramientas y permisos por
  agente.
- Proporcionar discovery y formato de definiciones de subagentes.
- Ejecutar la tool `subagent` de forma provisional y observable en `0.0.1`.
- Proporcionar selección interactiva y compatibilidad de permisos para usos no
  gobernados por el workflow de xper.

### Adaptador de Pi de xper

- Registrar comandos, tools, hooks y elementos de TUI en Pi.
- Traducir sesiones, modelos, subagentes y eventos de Pi al protocolo de xper.
- Aplicar en Pi las órdenes emitidas por el core.
- Integrarse con `pi-open-agents` sin exponer su API al dominio.
- Detectar capacidades y limitaciones del runtime activo.
- Registrar y ejecutar una delegación estructurada propia cuando se necesiten
  attempts durables, con correlación, error y cancelación explícitos.

### Core de xper

- Gobernar el workflow XP y sus transiciones.
- Construir el contexto mínimo de cada assignment.
- Resolver execution profiles y model presets.
- Evaluar gates, gestionar rework y solicitar decisiones humanas.
- Versionar artefactos y conservar el estado durable.
- Mantener el modelo de observabilidad independiente del harness.

`pi-open-agents` no es la fuente de verdad del workflow. Una conversación o
sesión hija puede desaparecer sin invalidar los artefactos, eventos y estados
ya persistidos por xper.

## Definiciones de agentes

Las definiciones seguirán inicialmente el formato Markdown compatible con
`pi-open-agents`. El agente principal puede existir en:

```text
~/.pi/agent/agents/xper.md   # instalación global
.pi/agents/xper.md           # instalación de proyecto
```

Esquema conceptual:

```yaml
---
name: xper
description: Coordinador de desarrollo basado en Extreme Programming
mode: primary
systemPrompt: replace
permission:
  "*": deny
  read: allow
  grep: allow
  find: allow
  ls: allow
  subagent: allow
allowedAgents:
  - discovery
  - define
  - design
  - breakdown
  - planner
  - driver
  - navigator
  - verifier
  - judgment-day
---
```

Los identificadores de modelo y el nivel de razonamiento no se fijan en la
plantilla del producto. Se resuelven desde el execution profile y el context
activos, y la definición materializada puede incluirlos cuando sea necesario.
Los permisos anteriores son también ilustrativos: el coordinador seguirá el
principio de mínimo privilegio y delegará la modificación del código en los
roles correspondientes.

## Inicialización

`xper init` prepara xper en el proyecto actual. `xper init --global` instala
los recursos reutilizables en el scope del usuario. Ninguno de los dos comandos
inicia una sesión de desarrollo.

El preflight de inicialización debe comprobar, en este orden:

1. Que el ejecutable `pi` existe y responde.
2. Que la versión de Pi es compatible con xper.
3. Que `pi-open-agents` está instalado en el scope efectivo.
4. Que su versión está dentro del rango probado por xper.
5. Que no hay otro gestor de agentes incompatible cargado simultáneamente.
6. Que la definición `xper` es descubrible como agente `primary`.
7. Que los subagentes requeridos existen y sus permisos son válidos.
8. Que los proveedores y modelos referenciados están disponibles.
9. Que el proyecto es de confianza cuando utiliza recursos locales de Pi.
10. Que las rutas de configuración y datos tienen permisos adecuados.

Si falta `pi-open-agents`, la inicialización debe explicar que es una
dependencia necesaria para la primera versión y mostrar:

```bash
pi install npm:pi-open-agents
```

En una terminal interactiva, xper puede ofrecer ejecutar la instalación tras
una confirmación explícita. En ejecución no interactiva debe terminar con un
código de salida distinto de cero y una salida estructurada que identifique la
dependencia ausente. No debe instalar paquetes silenciosamente.

## Doctor

`xper doctor` ejecuta el mismo preflight de forma no destructiva y añade
diagnóstico operacional:

| Comprobación | Fallo | Acción propuesta |
| --- | --- | --- |
| Pi no encontrado | `FAIL` | Instalar Pi y repetir el diagnóstico |
| Pi incompatible | `FAIL` | Instalar una versión soportada |
| `pi-open-agents` ausente | `FAIL` | `pi install npm:pi-open-agents` |
| Extensión incompatible | `FAIL` | Instalar la versión recomendada por xper |
| Gestores de agentes en conflicto | `FAIL` | Desactivar el paquete indicado |
| Agente `xper` ausente | `FAIL` | Reparar mediante `xper init` |
| Subagente opcional ausente | `WARN` | Crear o desactivar la capacidad |
| Modelo o credencial no disponible | `FAIL` o `WARN` | Depende de si existe un fallback válido |
| SQLite no escribible | `WARN` | Corregir permisos; el workflow puede continuar sin métricas |

La salida humana debe incluir causa, evidencia observada y acción concreta. La
salida `--json` debe usar identificadores estables para que pueda consumirse en
CI o en una GUI futura.

Ejemplo conceptual:

```text
PASS  pi                 0.x.y
PASS  pi-open-agents     0.1.22
PASS  primary-agent      xper
PASS  execution-profile  work
WARN  metrics-store      no se pudo abrir; se usará modo degradado
```

La versión mostrada es ilustrativa. La matriz de compatibilidad será parte de
cada release de xper. Dado que `pi-open-agents` todavía es pre-1.0, xper no
presupondrá compatibilidad entre versiones menores sin ejecutar su suite de
integración.

## Desacoplamiento

xper accederá a Pi mediante un adaptador externo TypeScript y un protocolo
versionado. El core no importará tipos de Pi ni de `pi-open-agents`. El contrato
mínimo del adaptador debe cubrir:

- Descubrimiento y activación del agente principal.
- Enumeración y validación de subagentes.
- Creación, seguimiento, cancelación y continuación de attempts.
- Selección de modelo y nivel de razonamiento.
- Aplicación de herramientas y permisos.
- Correlación de sesiones hijas con assignments.
- Recepción de eventos de ciclo de vida y uso.

Esto permite probar primero con `pi-open-agents` y reemplazarlo o soportar otro
backend más adelante sin modificar la máquina de estados ni el esquema de
métricas.

El mismo límite permitirá implementar adaptadores para otros harnesses en sus
tecnologías naturales. La arquitectura general y las reglas de dependencia se
definen en [RFC 0005](0005-arquitectura-modular.md).

## Consecuencias

### Positivas

- La experiencia coincide con el concepto de primary agent de OpenCode.
- xper conserva la TUI, las sesiones y los proveedores de Pi.
- No es necesario implementar desde cero discovery, selección del agente
  primario y formato de definiciones. El lifecycle durable de delegación sí es
  responsabilidad del adaptador de xper.
- Las definiciones pueden compartirse parcialmente con OpenCode.
- El primer prototipo se concentra en workflow XP y observabilidad.

### Riesgos

- `pi-open-agents` es joven y todavía usa versiones pre-1.0.
- Su API o formato puede cambiar.
- Otros gestores de agentes pueden registrar comandos o herramientas en
  conflicto.
- La ejecución de subagentes no sustituye por sí sola el aislamiento mediante
  worktrees o sandboxes.

Las mitigaciones iniciales son fijar una versión probada, validar la instalación
con `doctor`, mantener tests de integración y encapsular la dependencia detrás
del adaptador.

## Alternativas consideradas

- **pi-landstrip:** mayor adopción y aislamiento de procesos, pero incorpora
  sandbox y binarios nativos que amplían considerablemente el alcance inicial.
- **pi-mode-switch:** sencillo para perfiles de modelo, herramientas y skills,
  pero no resuelve por sí solo la orquestación de subagentes.
- **Integración directa con el SDK/RPC de Pi:** ofrece máximo control, pero
  obligaría a reconstruir desde el inicio una experiencia que ya proporciona
  Pi.
- **Plano de control externo con `xper run`:** descartado para la experiencia
  principal porque duplica el lifecycle de Pi y contradice la intención de que
  xper sea el agente principal de la sesión.

## Decisiones pendientes

- Rango exacto de versiones soportadas de Pi y `pi-open-agents`.
- Mecanismo de detección de paquetes en scopes global y de proyecto.
- Nombre y sintaxis definitivos de los comandos `/xper` dentro de Pi.
- Política para actualizar, reparar o desactivar dependencias en conflicto.
- Necesidad de añadir sandboxing mediante `pi-landstrip` u otra solución en una
  fase posterior.
