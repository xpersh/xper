# RFC 0005: Arquitectura modular y adaptadores de harness

- Estado: aceptado como dirección arquitectónica
- Fecha: 2026-09-22
- Depende de: [RFC 0001](0001-producto-y-workflow.md), [RFC 0002](0002-configuracion-multimodelo.md), [RFC 0003](0003-observabilidad-y-metricas.md) y [RFC 0004](0004-integracion-con-pi.md)

## Resumen

xper debe conservar un CLI y un dominio independientes del harness que ejecuta
los agentes. Pi será la primera integración, pero OpenCode, Claude Code, Codex
u otros runtimes podrán añadirse mediante adaptadores sin reimplementar el
workflow XP, los perfiles, los gates, los artefactos o las métricas.

La arquitectura seguirá puertos y adaptadores. El core se implementará en Rust
y no importará SDKs ni tipos de ningún harness. Cada integración vivirá fuera
del core, podrá utilizar la tecnología requerida por su host y se comunicará
con xper mediante un protocolo local, versionado y neutral.

## Objetivos

- Mantener el CLI utilizable sin Pi ni otro harness instalado.
- Evitar nombres, tipos y lifecycle específicos de Pi en el dominio.
- Permitir adaptadores escritos en TypeScript, Rust u otros lenguajes.
- Compartir workflow, configuración, persistencia y métricas entre harnesses.
- Negociar capacidades en vez de asumir que todos los runtimes ofrecen las
  mismas funciones.
- Probar el core sin arrancar modelos ni interfaces externas.
- Versionar de forma independiente el core, el protocolo y los adaptadores.

## No objetivos iniciales

- Ofrecer paridad completa entre harnesses desde la primera versión.
- Crear una abstracción universal de todas las funciones de cualquier agente.
- Ocultar al usuario las limitaciones reales del harness seleccionado.
- Ejecutar adaptadores remotos o distribuir el core como servicio de red.
- Mantener varios protocolos específicos para el mismo concepto de dominio.

## Arquitectura

```text
                         +----------------------+
                         |      xper CLI        |
                         | init/doctor/config   |
                         | metrics/inspect      |
                         +----------+-----------+
                                    |
                                    v
+------------------+      +----------------------+      +------------------+
| Adaptador de Pi  |<---->| Protocolo de adapter|<---->|   Core de xper   |
| TypeScript       |      | JSON-RPC / JSONL    |      | Rust             |
+------------------+      +----------------------+      +------------------+
| API y hooks Pi   |                                      | dominio XP      |
| pi-open-agents   |                                      | aplicación      |
| comandos y TUI   |                                      | configuración   |
+------------------+                                      | observabilidad  |
                                                          +--------+---------+
+------------------+                                               |
| Adaptador futuro |                                               v
| OpenCode         |                                      +------------------+
+------------------+                                      | SQLite / files   |
                                                          +------------------+
+------------------+
| Adaptador futuro |
| Claude Code      |
+------------------+

+------------------+
| Adaptador futuro |
| Codex            |
+------------------+
```

El core decide qué debe ocurrir según el workflow. El adaptador decide cómo se
expresa esa intención en el harness concreto.

## Capas del core

La [guía de la arquitectura del core](../architecture.md) concreta estos límites
con el mapa de módulos, los casos de uso de la primera vertical y las reglas
para ampliarlos.

### Dominio

Contiene únicamente conceptos y reglas deterministas:

- Run, phase visit, increment, assignment y attempt.
- Máquina de estados y transiciones.
- Gates, policies, budgets y verdicts.
- Contexts, strategies, model presets y execution profiles.
- Eventos de dominio y contratos de artefactos.

No realiza I/O, no conoce SQLite y no contiene referencias a Pi, OpenCode,
Claude Code, Codex, npm, TUI o procesos.

### Aplicación

Implementa casos de uso sobre el dominio:

- Iniciar, suspender, reanudar y cerrar un run.
- Solicitar y validar una transición.
- Crear assignments y attempts.
- Resolver modelos y fallbacks.
- Ingerir eventos normalizados del harness.
- Evaluar gates y producir órdenes para el adaptador.

Depende de puertos abstractos para persistencia, reloj, identificadores,
workspaces y ejecución de agentes.

### Infraestructura

Implementa los puertos que no pertenecen a un harness:

- SQLite y migraciones.
- Archivos de configuración y precedencia de scopes.
- Repositorio de artefactos.
- Reloj monotónico e identificadores.
- Worktrees y aislamiento de workspace.
- Exportación de métricas.

### Interfaces propias

- CLI no interactivo y comandos de administración.
- TUI independiente basada en Ratatui cuando aporte valor fuera del harness.
- Proceso bridge que mantiene una conversación de protocolo con un adaptador.

## Adaptadores de harness

Un adaptador es una capa anticorrupción. Traduce el modelo nativo del host al
vocabulario de xper y aplica en el host las órdenes del core.

Responsabilidades comunes:

- Identificar la sesión y adjuntarla a un run.
- Declarar capacidades y versiones durante el handshake.
- Activar o representar el agente principal cuando el host lo permita.
- Inyectar contexto efímero de fase.
- Crear, seguir, cancelar y continuar agentes.
- Seleccionar modelos y niveles de razonamiento.
- Aplicar herramientas, permisos y límites soportados.
- Reenviar eventos de turnos, tools, errores y uso.
- Mostrar estado, avisos y solicitudes humanas en la UI nativa.

El adaptador no evalúa gates ni decide transiciones. Si el host exige lógica
local para bloquear una llamada, aplica una decisión previamente obtenida del
core y registra el resultado.

## Negociación de capacidades

Los harnesses no ofrecen las mismas primitivas. Al conectarse, cada adaptador
envía un manifiesto como:

```json
{
  "adapter": "pi",
  "adapterVersion": "0.1.0",
  "protocolVersion": "1",
  "capabilities": {
    "primaryAgent": true,
    "subagents": true,
    "parallelSubagents": false,
    "modelSelection": true,
    "thinkingLevel": true,
    "toolFiltering": true,
    "permissionRules": true,
    "lifecycleEvents": true,
    "usageEvents": true,
    "nativeUi": true,
    "humanApproval": true
  }
}
```

El core valida estas capacidades contra el workflow y el perfil activos:

- Una capacidad obligatoria ausente produce `FAIL` antes del run.
- Una capacidad opcional ausente produce `WARN` y una degradación explícita.
- Ninguna limitación se oculta mediante comportamiento aproximado silencioso.

`xper doctor` utiliza el mismo manifiesto para explicar qué puede ejecutar cada
adaptador.

## Protocolo de adaptador

El límite entre core y adaptador será independiente del lenguaje. La primera
opción propuesta es JSON-RPC bidireccional sobre `stdio`, con mensajes JSONL
para facilitar streaming, diagnóstico y pruebas. La selección definitiva del
transporte se validará con un prototipo antes de congelar la versión 1.

El protocolo debe cubrir al menos:

```text
initialize / capabilities
session.attach / session.detach
run.start / run.resume / run.status
context.get
transition.request
assignment.create
attempt.start / attempt.cancel / attempt.result
event.ingest
profile.resolve
ui.notify / approval.request
shutdown
```

La comunicación es entre pares: el adaptador envía eventos y peticiones al
core, y el core envía órdenes al adaptador. Los mensajes incluyen
`protocolVersion`, correlación, run, assignment y attempt cuando corresponda.

### Compatibilidad

- El protocolo usa versiones explícitas.
- Los campos nuevos son opcionales mientras sea posible.
- Una incompatibilidad se detecta durante el handshake.
- Los errores usan códigos estables y datos estructurados.
- Los tipos se publican como JSON Schema para generar o validar clientes en
  varios lenguajes.
- Las extensiones nativas de cada harness pueden evolucionar sin cambiar el
  dominio.

## Topología de procesos inicial

Para Pi, la propuesta inicial es:

```text
Pi
└── extensión TypeScript de xper
    └── inicia `xper bridge --stdio`
        └── core Rust + SQLite
```

La extensión mantiene el proceso hijo mientras vive la sesión. Si Pi o la
extensión se reinician, un nuevo bridge reconstruye el estado desde SQLite y
los artefactos. Esta topología evita FFI, addons nativos de Node y un daemon
global durante el primer prototipo.

Si más adelante varios harnesses necesitan coordinar simultáneamente el mismo
run, podrá añadirse un modo `xper serve` con socket local. Ese modo no forma
parte del alcance inicial.

## Estructura propuesta del repositorio

```text
xper/
├── Cargo.toml
├── crates/
│   ├── xper-domain/          # entidades, estados, gates y eventos
│   ├── xper-application/     # casos de uso y puertos
│   ├── xper-protocol/        # envelopes, RPC y schemas
│   ├── xper-config/          # scopes, profiles y validación
│   ├── xper-store-sqlite/    # persistencia y migraciones
│   ├── xper-workspaces/      # worktrees y aislamiento
│   ├── xper-observability/   # collector, proyecciones y métricas
│   ├── xper-cli/             # binario xper
│   └── xper-tui/             # vistas Ratatui independientes
├── adapters/
│   ├── pi/                   # paquete/extensión TypeScript
│   ├── opencode/             # futuro
│   ├── claude-code/          # futuro
│   └── codex/                # futuro
├── schemas/                  # JSON Schema versionado del protocolo
├── fixtures/                 # trazas neutrales para contract tests
└── docs/
    └── rfcs/
```

Los directorios de adaptadores futuros indican límites reservados, no módulos
que deban crearse vacíos en el primer commit.

## Reglas de dependencia

```text
domain <- application <- infrastructure/interfaces
                    ^
                    |
             protocol/adapters
```

Reglas obligatorias:

1. `xper-domain` no depende de otros crates de xper ni de librerías de I/O.
2. `xper-application` depende del dominio y define puertos; no importa
   implementaciones.
3. Infraestructura, CLI, TUI y bridge dependen hacia dentro.
4. Los adaptadores dependen del protocolo público, nunca de internals del core.
5. Ningún crate del core importa paquetes de Pi, OpenCode, Claude Code o Codex.
6. Los IDs nativos se guardan como metadata namespaced, no como claves de
   dominio.
7. Los eventos persistidos usan vocabulario xper; el payload nativo es opcional
   y no interviene en las proyecciones principales.
8. Toda función específica de un harness se protege mediante una capability.

Estas reglas se comprobarán en CI mediante la estructura de dependencias y
contract tests.

## Configuración neutral

La configuración común no contiene estructuras específicas de Pi:

```yaml
harness:
  adapter: pi

profile: work

workflow:
  implementation:
    max_attempts: 3
  judgment_day:
    independent_model: true
```

Las opciones nativas viven bajo un namespace explícito:

```yaml
adapters:
  pi:
    primary_agent: xper
    require_pi_open_agents: true
```

Un perfil puede declarar requisitos de capabilities, pero no comandos o tipos
del SDK del harness.

## Persistencia y observabilidad

El esquema de SQLite se mantiene neutral. Puede registrar:

- `adapter_kind` y `adapter_version`.
- Identificador externo de sesión o agente como metadata.
- Capabilities efectivas del run.
- Eventos normalizados y, opcionalmente, referencias a trazas nativas.

No existirán tablas como `pi_sessions` en el modelo principal. Si un adaptador
necesita datos propios, utiliza metadata namespaced o una extensión de esquema
que no sea necesaria para reconstruir el run.

Esto permite comparar, con las cautelas definidas en RFC 0003, ejecuciones del
mismo workflow sobre distintos harnesses.

## Testing

La estrategia de pruebas se divide en:

- **Dominio:** tests puros de estados, gates, políticas y routing.
- **Aplicación:** puertos falsos y reloj determinista.
- **Protocolo:** schemas, compatibilidad y golden messages.
- **Contract tests:** una suite común que debe superar cada adaptador.
- **Adapter tests:** lifecycle y errores específicos del harness.
- **End-to-end:** un número reducido de sesiones reales por combinación
  soportada.

Las fixtures del protocolo no contienen prompts, credenciales ni código de
usuarios.

## Stack tecnológico inicial

| Área | Tecnología | Motivo |
| --- | --- | --- |
| Core y CLI | Rust | Binario multiplataforma, tipos fuertes y control de recursos |
| CLI | `clap` o equivalente | Interfaz declarativa y comprobable |
| Async/process | `tokio` o equivalente | Bridge, streaming y procesos agentes |
| Serialización | `serde` | Contratos JSON y configuración |
| Configuración | YAML deserializado a tipos propios | Legibilidad y validación centralizada |
| Persistencia | SQLite | Local, portable y apto para consultas de métricas |
| TUI independiente | Ratatui | Inspección y métricas fuera del harness |
| Adaptador de Pi | TypeScript | Tecnología requerida por la API de extensiones de Pi |
| Contrato entre lenguajes | JSON-RPC/JSONL + JSON Schema | Portabilidad y contract tests |

Las librerías concretas distintas de Rust, TypeScript, SQLite y Ratatui siguen
siendo elecciones de implementación. Se validarán con spikes antes de fijarlas
como dependencias de largo plazo.

## Seguridad

- El adaptador no envía credenciales al core salvo que un contrato futuro lo
  requiera explícitamente; se prefieren referencias y capacidades.
- El protocolo local valida tamaño, versión y forma de cada mensaje.
- El core trata eventos y metadata del harness como entrada no confiable.
- Las órdenes destructivas continúan sujetas a policies y aprobaciones.
- Cada adaptador documenta su frontera real de permisos y aislamiento.
- `doctor` informa tanto de capacidades funcionales como de degradaciones de
  seguridad.

## Consecuencias

### Positivas

- El CLI y el workflow sobreviven a cambios en Pi.
- Añadir un harness no duplica dominio, métricas ni configuración.
- Cada integración utiliza la tecnología natural de su ecosistema.
- Los adaptadores pueden publicarse y versionarse por separado.
- Las pruebas del core son rápidas y no dependen de proveedores de IA.

### Costes

- Se mantiene un protocolo adicional y compatibilidad entre versiones.
- La integración Pi requiere TypeScript además de Rust.
- Hay más procesos y puntos de diagnóstico que en una extensión monolítica.
- Algunas capacidades no tendrán equivalencia exacta entre harnesses.
- Los contract tests pasan a ser una parte crítica del producto.

## Decisiones pendientes

- Validar JSON-RPC bidireccional sobre `stdio` con la extensión de Pi.
- Elegir las crates concretas de SQLite y configuración.
- Definir la primera versión del catálogo de capabilities.
- Decidir qué comandos pertenecen al CLI y cuáles a la UI nativa del harness.
- Establecer el packaging conjunto del binario Rust y el adaptador TypeScript.
- Determinar cuándo merece la pena incorporar `xper serve`.
